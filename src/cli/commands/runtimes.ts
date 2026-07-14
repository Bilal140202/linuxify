/**
 * `linuxify runtimes` — runtime management subcommands.
 *
 * @module linuxify/cli/commands/runtimes
 *
 * Subcommands:
 *  - `linuxify runtimes list` — list every registered runtime provider.
 *  - `linuxify runtimes install <name> <version>` — install a runtime version.
 *  - `linuxify runtimes use <name> <version>` — set the default version.
 *
 * @packageDocumentation
 */


import { getRuntime, listRuntimes } from '../../runtimes/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run `runtimes list`.
 */
async function runRuntimesList(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  const distro = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distro) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  const runtimes = listRuntimes();
  if (runtimes.length === 0) {
    out.info('No runtimes registered.');
    return EXIT_CODES.OK;
  }

  const rows = await Promise.all(
    runtimes.map(async (r) => {
      const installed = await r.list(distro);
      const def = await r.getDefault(distro);
      return {
        name: r.name,
        display: r.displayName,
        default: def ?? '-',
        installed: installed.map((i) => i.version).join(',') || '-',
      };
    }),
  );

  if (ctx.output.json) {
    out.printJson(rows);
    return EXIT_CODES.OK;
  }
  out.table(rows);
  return EXIT_CODES.OK;
}

/**
 * Run `runtimes install <name> <version>`.
 */
async function runRuntimesInstall(
  ctx: CommandContext,
  name: string,
  version: string,
): Promise<number> {
  const out = ctx.output;
  if (!name || !version) {
    out.error('Usage: linuxify runtimes install <name> <version>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const distro = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distro) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  let provider;
  try {
    provider = getRuntime(name);
  } catch {
    out.error(`Unknown runtime '${name}'.`);
    return EXIT_CODES.NOT_FOUND;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would install ${name}@${version} into ${distro}.`);
    return EXIT_CODES.OK;
  }

  out.progress(`Installing ${name}@${version} into ${distro}…`);
  try {
    await provider.install(version, distro, {
      onProgress: (msg: string) => out.progress(msg),
    });
    out.success(`${name}@${version} installed.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to install runtime: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run `runtimes use <name> <version>`.
 */
async function runRuntimesUse(
  ctx: CommandContext,
  name: string,
  version: string,
): Promise<number> {
  const out = ctx.output;
  if (!name || !version) {
    out.error('Usage: linuxify runtimes use <name> <version>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const distro = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distro) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  let provider;
  try {
    provider = getRuntime(name);
  } catch {
    out.error(`Unknown runtime '${name}'.`);
    return EXIT_CODES.NOT_FOUND;
  }

  try {
    await provider.setDefault(version, distro);
    out.success(`${name}@${version} is now the default in ${distro}.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to set default runtime: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run the `runtimes` command.
 */
export async function runRuntimes(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string,
  name?: string,
  version?: string,
): Promise<number> {
  switch (subcommand) {
    case 'list':
      return runRuntimesList(ctx);
    case 'install':
      return runRuntimesInstall(ctx, name ?? '', version ?? '');
    case 'use':
      return runRuntimesUse(ctx, name ?? '', version ?? '');
    default:
      ctx.output.error(`Unknown runtimes subcommand: ${subcommand ?? '(none)'}`);
      ctx.output.info('  Available: list, install, use');
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `runtimes` command with its subcommands.
 */
export const registerRuntimesCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const runtimes = program.command('runtimes').description('Runtime management.');

  runtimes
    .command('list')
    .description('List every registered runtime provider and installed versions.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runRuntimes({}, ctx, 'list');
      setExit(code);
    });

  runtimes
    .command('install <name> <version>')
    .description('Install a runtime version into the active distro.')
    .action(async (name: string, version: string) => {
      const ctx = await getCtx();
      const code = await runRuntimes({}, ctx, 'install', name, version);
      setExit(code);
    });

  runtimes
    .command('use <name> <version>')
    .description('Set the default version of a runtime in the active distro.')
    .action(async (name: string, version: string) => {
      const ctx = await getCtx();
      const code = await runRuntimes({}, ctx, 'use', name, version);
      setExit(code);
    });
};
