/**
 * Global flag definitions for the Linuxify CLI.
 *
 * @module linuxify/cli/flags
 *
 * The CLI's flag surface is split between globals (which apply to every
 * subcommand and may appear before *or* after the subcommand name) and
 * per-subcommand flags (which appear only after the subcommand name). This
 * module centralizes the global flag definitions so the router and each
 * subcommand register them with consistent metadata.
 *
 * The functions in this module do not call `program.option(...)` directly;
 * they return option-spec objects that the router can pass to commander's
 * `program.option()` / `command.option()` calls. Centralizing the metadata
 * keeps the help text and short-flag aliases consistent across every
 * registration site.
 *
 * @packageDocumentation
 */

/**
 * A commander-style option specification. The fields map 1:1 to the arguments
 * of `program.option(flags, description, defaultValue?)`. Each spec is plain
 * data so it can be reused without re-running any commander code.
 */
export interface GlobalFlagSpec {
  /** The commander `flags` string, e.g. `'-v, --verbose'`. */
  readonly flags: string;
  /** The human-readable description shown in `--help`. */
  readonly description: string;
  /** Optional default value. */
  readonly defaultValue?: string | boolean;
}

/**
 * The complete list of global flags accepted by every Linuxify invocation.
 *
 * Order matters: it is the order shown in `--help` output. The list mirrors
 * `cli-specification.md` §3 exactly — flags that appear there but not here
 * are intentional omissions (e.g. `--debug` is treated as a verbose alias
 * for the purposes of this implementation; `--offline` is registered here so
 * subcommands can detect it via `opts.offline`).
 */
export const GLOBAL_FLAGS: readonly GlobalFlagSpec[] = [
  { flags: '-h, --help', description: 'Print help for the subcommand and exit 0.' },
  { flags: '-V, --version', description: 'Print the Linuxify version and exit 0.' },
  { flags: '-v, --verbose', description: 'Increase log verbosity (repeatable: -vv, -vvv).' },
  { flags: '-q, --quiet', description: 'Suppress all non-error output.' },
  { flags: '--no-color', description: 'Disable ANSI color regardless of TTY detection.' },
  { flags: '--config <path>', description: 'Load additional config file (may be repeated).' },
  { flags: '-n, --dry-run', description: 'Plan and print actions without mutating state.' },
  { flags: '-y, --yes', description: 'Answer yes to all interactive prompts (required for CI).' },
  { flags: '--profile <name>', description: 'Select a named profile from config.toml.' },
  { flags: '--distro <name>', description: 'Override the active distro for this invocation only.' },
  { flags: '--json', description: 'Emit machine-readable JSON. Disables color and progress.' },
  { flags: '--no-telemetry', description: 'Disable telemetry for this invocation.' },
  { flags: '--offline', description: 'Refuse any network access (use cached data).' },
  { flags: '--debug', description: 'Enable crash-level diagnostics: stack traces, state dumps.' },
];

/**
 * The subset of global flags that mutate the active distro / profile / config
 * path — i.e. flags whose values the router must consume *before* constructing
 * a {@link CommandContext}. The remaining globals (`--json`, `--quiet`,
 * `--no-color`, `--dry-run`, `--yes`, `--offline`, `--verbose`, `--debug`,
 * `--no-telemetry`) are read by individual commands via the context.
 */
export const CONTEXTUAL_FLAGS = [
  '--config',
  '--profile',
  '--distro',
  '--json',
  '--quiet',
  '--no-color',
  '--offline',
  '--yes',
  '--dry-run',
  '--no-telemetry',
  '--verbose',
  '--debug',
] as const;

/**
 * A `ParsedGlobalFlags` value carries the resolved values for every global
 * flag. The router passes this struct to {@link createCommandContext}.
 */
export interface ParsedGlobalFlags {
  /** `--config <path>` value(s), joined by `:` for the loader's overlay. */
  readonly configPath?: string;
  /** `--profile <name>` value. */
  readonly profile?: string;
  /** `--distro <name>` value. */
  readonly distro?: string;
  /** `--json` flag (true if present). */
  readonly json: boolean;
  /** `--quiet` flag. */
  readonly quiet: boolean;
  /** `--no-color` flag. */
  readonly noColor: boolean;
  /** `--dry-run` flag. */
  readonly dryRun: boolean;
  /** `--yes` flag. */
  readonly yes: boolean;
  /** `--offline` flag. */
  readonly offline: boolean;
  /** `--no-telemetry` flag. */
  readonly noTelemetry: boolean;
  /** `--verbose` flag (count of `-v` repetitions, 0..3). */
  readonly verbose: number;
  /** `--debug` flag. */
  readonly debug: boolean;
}

/**
 * The default `ParsedGlobalFlags` value used when no global flags are present
 * on the command line.
 */
export const DEFAULT_PARSED_FLAGS: ParsedGlobalFlags = {
  json: false,
  quiet: false,
  noColor: false,
  dryRun: false,
  yes: false,
  offline: false,
  noTelemetry: false,
  verbose: 0,
  debug: false,
};

/**
 * Extract a {@link ParsedGlobalFlags} struct from a commander options object.
 *
 * Commander collapses repeated `--verbose` into a numeric count when the
 * option is declared with `-v, --verbose` and the user passes `-vv`. We
 * accept either a boolean (single occurrence) or a number (repeatable) and
 * normalize to a number for downstream consumers.
 *
 * @param opts - The commander `command.opts()` result.
 * @returns A populated {@link ParsedGlobalFlags}.
 */
export function extractGlobalFlags(opts: Record<string, unknown>): ParsedGlobalFlags {
  const verboseRaw = opts.verbose;
  let verbose = 0;
  if (typeof verboseRaw === 'number') {
    verbose = verboseRaw;
  } else if (typeof verboseRaw === 'boolean' && verboseRaw) {
    verbose = 1;
  }
  return {
    configPath: typeof opts.config === 'string' ? opts.config : undefined,
    profile: typeof opts.profile === 'string' ? opts.profile : undefined,
    distro: typeof opts.distro === 'string' ? opts.distro : undefined,
    json: Boolean(opts.json),
    quiet: Boolean(opts.quiet),
    noColor: Boolean(opts.color === false) || Boolean(opts.noColor),
    dryRun: Boolean(opts.dryRun),
    yes: Boolean(opts.yes),
    offline: Boolean(opts.offline),
    noTelemetry: Boolean(opts.telemetry === false) || Boolean(opts.noTelemetry),
    verbose,
    debug: Boolean(opts.debug),
  };
}
