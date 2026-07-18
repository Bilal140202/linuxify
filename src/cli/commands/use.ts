/**
 * `linuxify use <distro>` — switch the active distro.
 *
 * @module linuxify/cli/commands/use
 *
 * Updates `state.json#active_distro` and regenerates every launcher so the
 * next `linuxify add` / `run` / `shell` targets the new distro. With
 * `--create`, downloads and provisions the distro if it is not yet present.
 * With `--remove`, deletes a distro from disk (refuses if any installed
 * package depends on it unless `--force` is also given).
 *
 * @packageDocumentation
 */


import { getDistro, listDistros } from '../../distros/index.js';
import { getLauncherGenerator } from '../../launcher/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { DistroError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `use` command.
 */
export async function runUse(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  distroName: string,
): Promise<number> {
  const out = ctx.output;

  if (!distroName) {
    out.error('Usage: linuxify use <distro>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  // Validate the distro name against the registry.
  const available = listDistros().map((d) => d.name);
  let provider;
  try {
    provider = getDistro(distroName);
  } catch (err) {
    if (err instanceof DistroError) {
      out.error(`Unknown distro '${distroName}'. Registered: ${available.join(', ')}.`);
      out.info(`  Try: linuxify distros install ${distroName}`);
      return EXIT_CODES.NOT_FOUND;
    }
    throw err;
  }

  // --remove: delete the distro.
  if (opts.remove) {
    const state = await ctx.stateStore.load();
    const packageCount = state.installed_packages.filter((p) => p.distro === distroName).length;
    if (packageCount > 0 && !opts.force) {
      out.error(
        `Cannot remove '${distroName}': ${packageCount} package(s) are still installed under it.`,
      );
      out.info('  Pass --force to remove anyway (packages will be left orphaned).');
      return EXIT_CODES.STEP_FAILED;
    }
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would remove distro '${distroName}'.`);
      return EXIT_CODES.OK;
    }
    await provider.uninstall();
    out.success(`Distro '${distroName}' removed.`);
    return EXIT_CODES.OK;
  }

  // --create: install the distro if it is not yet present.
  const isInstalled = await provider.isInstalled();
  if (!isInstalled && !opts.create) {
    out.error(`Distro '${distroName}' is not installed.`);
    out.info(`  Try: linuxify use ${distroName} --create`);
    return EXIT_CODES.NOT_FOUND;
  }
  if (!isInstalled && !!(opts.create)) {
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would install distro '${distroName}'.`);
      return EXIT_CODES.OK;
    }
    out.progress(`Installing distro '${distroName}'…`);
    await provider.install({});
  }

  // Update state.active_distro.
  await ctx.stateStore.update((s) => {
    s.active_distro = distroName;
  });
  out.success(`Active distro: ${distroName}`);

  // Regenerate every launcher so the new distro is picked up.
  const state = await ctx.stateStore.load();
  if (state.installed_packages.length > 0) {
    const gen = getLauncherGenerator();
    for (const pkg of state.installed_packages) {
      try {
        await gen.regenerate(pkg.name, state);
      } catch (err) {
        logger.warn(
          { pkg: pkg.name, err: (err as Error).message },
          'failed to regenerate launcher during `linuxify use`',
        );
      }
    }
  }

  return EXIT_CODES.OK;
}

/**
 * Register the `use` command.
 */
export const registerUseCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('use <distro>')
    .description('Switch the active distro recorded in state.json.')
    .option('--create', 'Download and provision the distro if it is not yet present.')
    .option('--remove', 'Delete the distro from disk.')
    .option('--force', 'With --remove, delete even if packages are installed under it.')
    .action(async (distroName: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runUse(opts, ctx, distroName);
      setExit(code);
    });
};
