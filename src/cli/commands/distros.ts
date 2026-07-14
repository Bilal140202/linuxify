/**
 * `linuxify distros` — distro management subcommands.
 *
 * @module linuxify/cli/commands/distros
 *
 * Subcommands:
 *  - `linuxify distros list` — list every registered distro provider.
 *  - `linuxify distros install <name>` — install (download rootfs for) a distro.
 *  - `linuxify distros uninstall <name>` — remove a distro from disk.
 *
 * @packageDocumentation
 */


import { getDistro, listDistros } from '../../distros/index.js';
import { getLauncherGenerator } from '../../launcher/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run `distros list`.
 */
async function runDistrosList(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  const distros = listDistros();
  if (distros.length === 0) {
    out.info('No distros registered.');
    return EXIT_CODES.OK;
  }
  const rows = await Promise.all(
    distros.map(async (d) => {
      let installed: boolean;
      try {
        installed = await d.isInstalled();
      } catch {
        installed = false;
      }
      return {
        name: d.name,
        display: d.displayName,
        version: d.defaultVersion,
        installed: installed ? 'yes' : 'no',
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
 * Run `distros install <name>`.
 */
async function runDistrosInstall(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify distros install <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }
  let provider;
  try {
    provider = getDistro(name);
  } catch {
    out.error(`Unknown distro '${name}'.`);
    out.info('  Run `linuxify distros list` to see registered distros.');
    return EXIT_CODES.NOT_FOUND;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would install distro '${name}'.`);
    return EXIT_CODES.OK;
  }

  out.progress(`Installing distro '${name}'…`);
  try {
    await provider.install({});
    await ctx.stateStore.update((s) => {
      if (!s.installed_distros.some((d) => d.name === name)) {
        s.installed_distros.push({
          name,
          version: provider.defaultVersion,
          installed_at: new Date().toISOString(),
          rootfs_sha256: '',
        });
      }
      if (!s.active_distro) {
        s.active_distro = name;
      }
    });
    out.success(`Distro '${name}' installed.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to install distro: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run `distros uninstall <name>`.
 */
async function runDistrosUninstall(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify distros uninstall <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }
  let provider;
  try {
    provider = getDistro(name);
  } catch {
    out.error(`Unknown distro '${name}'.`);
    return EXIT_CODES.NOT_FOUND;
  }

  // Refuse if any packages are still installed under it.
  const state = await ctx.stateStore.load();
  const packageCount = state.installed_packages.filter((p) => p.distro === name).length;
  if (packageCount > 0) {
    out.error(
      `Cannot uninstall '${name}': ${packageCount} package(s) are still installed under it.`,
    );
    out.info('  Run `linuxify remove <pkg>` for each, then retry.');
    return EXIT_CODES.STEP_FAILED;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would uninstall distro '${name}'.`);
    return EXIT_CODES.OK;
  }

  try {
    await provider.uninstall();
    await ctx.stateStore.update((s) => {
      s.installed_distros = s.installed_distros.filter((d) => d.name !== name);
      if (s.active_distro === name) {
        s.active_distro = s.installed_distros[0]?.name ?? '';
      }
    });

    // Regenerate launchers for any remaining packages (their distro may have
    // been the active one).
    if (state.installed_packages.length > 0) {
      const gen = getLauncherGenerator();
      const fresh = await ctx.stateStore.load();
      for (const pkg of fresh.installed_packages) {
        try {
          await gen.regenerate(pkg.name, fresh);
        } catch (err) {
          logger.warn(
            { pkg: pkg.name, err: (err as Error).message },
            'failed to regenerate launcher during distros uninstall',
          );
        }
      }
    }

    out.success(`Distro '${name}' removed.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to uninstall distro: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run the `distros` command (dispatches to subcommands).
 */
export async function runDistros(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string,
  name?: string,
): Promise<number> {
  switch (subcommand) {
    case 'list':
      return runDistrosList(ctx);
    case 'install':
      return runDistrosInstall(ctx, name ?? '');
    case 'uninstall':
      return runDistrosUninstall(ctx, name ?? '');
    default:
      ctx.output.error(`Unknown distros subcommand: ${subcommand ?? '(none)'}`);
      ctx.output.info('  Available: list, install, uninstall');
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `distros` command with its subcommands.
 */
export const registerDistrosCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const distros = program.command('distros').description('Distro management.');

  distros
    .command('list')
    .description('List every registered distro provider.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runDistros({}, ctx, 'list');
      setExit(code);
    });

  distros
    .command('install <name>')
    .description('Install (download rootfs for) a distro.')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runDistros({}, ctx, 'install', name);
      setExit(code);
    });

  distros
    .command('uninstall <name>')
    .description('Remove a distro from disk.')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runDistros({}, ctx, 'uninstall', name);
      setExit(code);
    });
};
