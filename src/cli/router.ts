/**
 * CLI router — the top-level entry point that turns `process.argv` into a
 * dispatched subcommand and an exit code.
 *
 * @module linuxify/cli/router
 *
 * The router is the composition root for the CLI layer: it loads the config,
 * opens the state store, creates the output formatter and every subsystem
 * client (registry, doctor, patcher, plugin system, telemetry), registers
 * every subcommand with commander, parses argv, dispatches to the matching
 * command action, and returns the numeric exit code.
 *
 * The router is the *only* place in the CLI layer that catches top-level
 * errors and translates them into exit codes. Subcommand actions return a
 * `Promise<number>`; the router awaits it and returns the number. If an
 * action throws, the router's catch block inspects the error, picks the
 * right exit code from {@link EXIT_CODES} (or the error's `exitCode` field
 * if it is a {@link LinuxifyError}), prints a friendly message via the
 * {@link Output} instance, and returns the code.
 *
 * @packageDocumentation
 */

import { Command, CommanderError, type OptionValues } from 'commander';

import { LINUXIFY_VERSION } from '../utils/constants.js';
import { EXIT_CODES } from '../utils/constants.js';
import type { LinuxifyError } from '../utils/errors.js';
import { isLinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';

import { registerAllCommands } from './commands/index.js';
import { createCommandContext, type CommandContext } from './context.js';
import { extractGlobalFlags, GLOBAL_FLAGS } from './flags.js';
import { Output } from './output.js';

/**
 * A subcommand action function. Commander hands the action callback the
 * parsed options object plus any positional arguments; we extend the contract
 * to return a `Promise<number>` (the exit code) and to receive the shared
 * {@link CommandContext} as the last argument.
 *
 * The action callback is registered by `registerAllCommands` (see
 * `commands/index.ts`); each command file lives in `commands/<name>.ts`.
 */
export type CommandAction = (
  opts: OptionValues,
  ctx: CommandContext,
  ...args: string[]
) => Promise<number>;

/**
 * The set of error classes commander throws when `exitOverride` is active.
 * `commander.error` and `--help`/`--version` exits both surface as a
 * `CommanderError`; we catch them and return their `exitCode` field instead
 * of crashing.
 */
function isCommanderError(err: unknown): err is CommanderError {
  return err instanceof CommanderError;
}

/**
 * Run the Linuxify CLI against a slice of `process.argv`.
 *
 * The function never calls `process.exit` directly — it returns the exit
 * code so the caller (typically `src/cli/index.ts`) can set
 * `process.exitCode = N` and allow async cleanup to drain. This matches the
 * `no-process-exit` ESLint rule.
 *
 * Steps:
 *  1. Construct a barebones {@link Output} from the global flags so error
 *     rendering works even before the full {@link CommandContext} is built.
 *     (The context's output formatter may differ slightly if config loading
 *     re-resolves the `--json` flag, but in practice the two are identical
 *     because we read the same flag values.)
 *  2. Build the commander program: register globals, set `exitOverride`, and
 *     call {@link registerAllCommands} to attach every subcommand.
 *  3. Parse argv via `program.parseAsync(argv, { from: 'user' })`.
 *  4. If commander threw a `CommanderError` (help, version, bad usage),
 *     return its `exitCode` field directly.
 *  5. If the dispatched action set a result via `program.setExitCode`, return
 *     that. Otherwise return {@link EXIT_CODES.OK}.
 *  6. If the action threw a {@link LinuxifyError}, render it via the output
 *     formatter and return `error.exitCode`.
 *  7. Any other thrown value is rendered as an internal error and returns
 *     {@link EXIT_CODES.GENERIC_ERROR}.
 *
 * @param argv - The arguments to parse (typically `process.argv.slice(2)`).
 * @returns The process exit code.
 */
export async function runCli(argv: string[]): Promise<number> {
  // Pre-scan argv for the global flags that affect output formatting so we
  // can construct an Output instance before commander runs. This lets us
  // render errors during config loading and command registration with the
  // right color/json settings.
  const preFlags = preScanGlobalFlags(argv);
  const earlyOutput = new Output({
    json: preFlags.json,
    quiet: preFlags.quiet,
    noColor: preFlags.noColor,
  });

  // Exit code holder — the dispatched action writes to this; we read it
  // after `parseAsync` resolves. Defaults to OK so a no-op invocation (no
  // subcommand) prints help and exits 0 (matching `git` behavior).
  let exitCode: number = EXIT_CODES.OK;

  // Build the commander program. `exitOverride` makes commander throw
  // instead of calling `process.exit`, which is required by the
  // `no-process-exit` ESLint rule.
  const program = new Command();
  program
    .name('linuxify')
    .description('Run Linux developer tools on Android via Termux + proot.')
    .version(LINUXIFY_VERSION, '-V, --version')
    .exitOverride((err: CommanderError) => {
      // Re-throw so the outer try/catch can pick up the exit code. Help and
      // version invocations land here with `code === 'commander.help'` /
      // `'commander.version'` and `exitCode === 0`.
      throw err;
    });

  // Register global flags on the top-level program so they are accepted
  // before the subcommand name (e.g. `linuxify --json add cline`).
  for (const spec of GLOBAL_FLAGS) {
    if (spec.flags.startsWith('-h') || spec.flags.startsWith('-V, --version')) {
      // Help and version are already registered above via .helpCommand() and
      // .version(); skip the duplicates.
      continue;
    }
    if (spec.defaultValue !== undefined) {
      program.option(spec.flags, spec.description, spec.defaultValue);
    } else {
      program.option(spec.flags, spec.description);
    }
  }

  // Build the command context lazily — we only pay the config-loading cost
  // if a subcommand actually runs. `--help` and `--version` short-circuit
  // before any action is dispatched.
  let ctx: CommandContext | null = null;
  const getCtx = async (): Promise<CommandContext> => {
    if (ctx === null) {
      ctx = await createCommandContext(preFlags);
    }
    return ctx;
  };

  // Register every subcommand. The register function receives the program
  // and the context-builder; each command file is responsible for its own
  // option/argument declarations and for wiring its action callback to call
  // `getCtx()` and return a Promise<number>.
  registerAllCommands(program, getCtx, (code: number) => {
    exitCode = code;
  });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode;
  } catch (err) {
    return handleError(err, earlyOutput);
  }
}

/**
 * Render a thrown error and return the appropriate exit code.
 *
 * Commander errors carry their own `exitCode` (0 for help/version, 1 for
 * usage errors); LinuxifyError instances carry the canonical exit code from
 * {@link EXIT_CODES}; anything else is an internal bug and returns
 * {@link EXIT_CODES.GENERIC_ERROR}.
 *
 * @param err - The thrown value.
 * @param output - The output formatter for rendering human-friendly errors.
 * @returns The exit code.
 */
function handleError(err: unknown, output: Output): number {
  if (isCommanderError(err)) {
    // Commander's own errors (help, version, bad usage) carry an exitCode.
    // Help and version are success paths — always return 0 even if commander
    // internally sets exitCode to 1 for the help action.
    if (err.code === 'commander.help' || err.code === 'commander.version') {
      return EXIT_CODES.OK;
    }
    if (err.message) {
      output.error(err.message);
    }
    return err.exitCode ?? EXIT_CODES.GENERIC_ERROR;
  }

  if (isLinuxifyError(err)) {
    renderLinuxifyError(err, output);
    return err.exitCode;
  }

  // Unknown error: log full details for debugging, render a friendly
  // message, return GENERIC_ERROR.
  logger.error({ err: errToString(err) }, 'unhandled error in CLI dispatch');
  output.error(`Internal error: ${errToString(err)}`);
  output.error('This is a bug. Please file an issue at https://github.com/Bilal140202/linuxify');
  return EXIT_CODES.GENERIC_ERROR;
}

/**
 * Render a {@link LinuxifyError} via the output formatter. The four-part
 * structure (what / why / fix / docs) matches `cli-specification.md` §13.
 *
 * Under `--json`, the structured payload is emitted by the router's JSON
 * error path; here we only render the human-readable form.
 */
function renderLinuxifyError(err: LinuxifyError, output: Output): void {
  output.error(err.message);
  if (err.fixCommand) {
    output.info(`  Try: ${err.fixCommand}`);
  }
  if (err.docsUrl) {
    output.info(`  Docs: ${err.docsUrl}`);
  }
}

/**
 * Convert an unknown caught value to a human-readable string for logging.
 */
function errToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Pre-scan argv for the subset of global flags that affect output formatting
 * (`--json`, `--quiet`, `--no-color`) and the context-building flags
 * (`--config`, `--profile`, `--distro`, `--dry-run`, `--yes`, `--offline`,
 * `--no-telemetry`, `--verbose`, `--debug`). This runs *before* commander
 * parses argv so we can construct an {@link Output} and {@link CommandContext}
 * early.
 *
 * The scan is intentionally simple: it walks argv left-to-right, stopping at
 * the first positional that does not start with `-` (the subcommand name).
 * Flags after the subcommand name are also picked up by commander's normal
 * parse, but we don't need to handle them here because the context is built
 * lazily *after* commander has parsed everything.
 *
 * Wait — the context is built before the action runs (because we need the
 * output formatter), so we *do* need to pick up post-subcommand global
 * flags. The scan below walks the full argv so it captures them.
 */
function preScanGlobalFlags(argv: string[]): {
  json: boolean;
  quiet: boolean;
  noColor: boolean;
  dryRun: boolean;
  yes: boolean;
  offline: boolean;
  noTelemetry: boolean;
  verbose: number;
  debug: boolean;
  configPath?: string;
  profile?: string;
  distro?: string;
} {
  let json = false;
  let quiet = false;
  let noColor = false;
  let dryRun = false;
  let yes = false;
  let offline = false;
  let noTelemetry = false;
  let verbose = 0;
  let debug = false;
  let configPath: string | undefined;
  let profile: string | undefined;
  let distro: string | undefined;

  // Walk argv left-to-right. We do NOT stop at the first positional because
  // global flags may legitimately appear after the subcommand name (per
  // cli-specification.md §3). Subcommand-specific flags like `--force` are
  // ignored here — they don't affect context construction.
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--no-color':
        noColor = true;
        break;
      case '--dry-run':
      case '-n':
        dryRun = true;
        break;
      case '--yes':
      case '-y':
        yes = true;
        break;
      case '--offline':
        offline = true;
        break;
      case '--no-telemetry':
        noTelemetry = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--verbose':
      case '-v':
        verbose++;
        break;
      case '-vv':
        verbose = Math.max(verbose, 2);
        break;
      case '-vvv':
        verbose = Math.max(verbose, 3);
        break;
      case '--config': {
        const next = argv[i + 1];
        if (next) configPath = next;
        i++;
        break;
      }
      case '--profile': {
        const next = argv[i + 1];
        if (next) profile = next;
        i++;
        break;
      }
      case '--distro': {
        const next = argv[i + 1];
        if (next) distro = next;
        i++;
        break;
      }
      default: {
        // Handle `--flag=value` form for the value-bearing flags.
        if (arg.startsWith('--config=')) {
          configPath = arg.slice('--config='.length);
        } else if (arg.startsWith('--profile=')) {
          profile = arg.slice('--profile='.length);
        } else if (arg.startsWith('--distro=')) {
          distro = arg.slice('--distro='.length);
        }
        // Everything else is either a subcommand name, a subcommand flag,
        // or a positional — ignored by the pre-scan.
        break;
      }
    }
  }

  return {
    json,
    quiet,
    noColor,
    dryRun,
    yes,
    offline,
    noTelemetry,
    verbose,
    debug,
    configPath,
    profile,
    distro,
  };
}

/**
 * Re-export of {@link extractGlobalFlags} for tests that want to mirror the
 * router's flag resolution. Not used inside the router itself.
 */
export { extractGlobalFlags };
