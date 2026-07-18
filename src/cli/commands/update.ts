/**
 * `linuxify update` — refresh the local package index.
 *
 * @module linuxify/cli/commands/update
 *
 * Calls `registryClient.update()` to sync the local clone with the upstream
 * registry, then optionally checks for available package updates and
 * Linuxify self-updates. Does not perform upgrades — use `linuxify upgrade`
 * or `linuxify self-update` for that.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import { LINUXIFY_VERSION } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `update` command.
 */
export async function runUpdate(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const checkOnly = !!(opts.checkOnly);
  const packagesOnly = !!(opts.packages);
  const selfOnly = !!(opts.self);

  if (ctx.flags.offline) {
    out.warn('--offline is set; skipping registry update.');
    return EXIT_CODES.OK;
  }

  // Refresh the package index unless --self is given alone.
  if (!selfOnly) {
    out.progress('Refreshing package index…');
    try {
      await ctx.registry.update();
      out.success('Package index refreshed.');
    } catch (err) {
      if (isLinuxifyError(err)) {
        out.error(err.message);
        return err.exitCode;
      }
      out.error(`Failed to refresh package index: ${(err as Error).message}`);
      return EXIT_CODES.NETWORK_ERROR;
    }
  }

  if (checkOnly && !packagesOnly && !selfOnly) {
    // Just print what's available.
    await printAvailableUpdates(ctx);
    await printSelfUpdate(ctx);
    return EXIT_CODES.OK;
  }

  if (packagesOnly || (!selfOnly && !checkOnly)) {
    await printAvailableUpdates(ctx);
  }

  if (selfOnly || (!packagesOnly && !checkOnly)) {
    await printSelfUpdate(ctx);
  }

  return EXIT_CODES.OK;
}

/**
 * Print packages that have an update available vs. the installed version.
 */
async function printAvailableUpdates(ctx: CommandContext): Promise<void> {
  const out = ctx.output;
  const state = await ctx.stateStore.load();
  if (state.installed_packages.length === 0) {
    return;
  }
  const updates: Array<{ name: string; current: string; latest: string }> = [];
  for (const installed of state.installed_packages) {
    try {
      const pkg = await ctx.registry.getPackage(installed.name);
      if (pkg && pkg.version !== installed.version) {
        updates.push({ name: installed.name, current: installed.version, latest: pkg.version });
      }
    } catch {
      // Skip packages that have left the registry.
    }
  }
  if (updates.length === 0) {
    out.info('All installed packages are up to date.');
    return;
  }
  out.info('Updates available:');
  for (const u of updates) {
    out.info(`  ${u.name}  ${u.current} → ${u.latest}`);
  }
  out.info('Run: linuxify upgrade --all');
}

/**
 * Print whether a Linuxify self-update is available.
 */
async function printSelfUpdate(ctx: CommandContext): Promise<void> {
  const out = ctx.output;
  out.info(`Linuxify ${LINUXIFY_VERSION} (use \`linuxify self-update --check\` for newer versions).`);
}

/**
 * Register the `update` command.
 */
export const registerUpdateCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('update')
    .description('Refresh the local package index and check for updates.')
    .option('--check-only', 'Print what would be updated without applying anything.')
    .option('--packages', 'Only check packages (skip the self-update check).')
    .option('--self', 'Only check Linuxify itself (skip the package check).')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runUpdate(opts, ctx);
      setExit(code);
    });
};
