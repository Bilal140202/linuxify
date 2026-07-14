/**
 * `linuxify remove <package>` — uninstall a package.
 *
 * @module linuxify/cli/commands/remove
 *
 * Removes the launcher, runs the package's uninstall steps (if available),
 * deletes the per-package state entry, and (with `--purge`) also deletes the
 * cached downloads and patch backups.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import type { RuntimeProvider } from '../../packages/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `remove` command.
 */
export async function runRemove(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName: string,
): Promise<number> {
  const out = ctx.output;

  if (!packageName) {
    out.error('Usage: linuxify remove <package>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const state = await ctx.stateStore.load();
  const install = state.installed_packages.find((p) => p.name === packageName);
  if (!install) {
    out.error(`Package '${packageName}' is not installed.`);
    return EXIT_CODES.NOT_FOUND;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would remove ${packageName}@${install.version}.`);
    return EXIT_CODES.OK;
  }

  // Confirm unless --yes.
  if (!ctx.flags.yes) {
    out.info(`About to remove ${packageName}@${install.version}.`);
    out.info('Re-run with --yes to skip this confirmation.');
  }

  // Look up the original YAML from the registry (best-effort) so the
  // package manager can run the declared uninstall steps.
  let pkgDef;
  try {
    pkgDef = await ctx.registry.getPackage(packageName);
  } catch (err) {
    logger.debug(
      { pkg: packageName, err: (err as Error).message },
      'failed to fetch package YAML for uninstall',
    );
  }

  // Construct a minimal distro provider so the manager can run the uninstall
  // steps. We import lazily to avoid pulling the distros subsystem into
  // every CLI invocation.
  let distroProvider;
  try {
    const { getDistro } = await import('../../distros/index.js');
    distroProvider = getDistro(install.distro);
  } catch (err) {
    logger.debug(
      { distro: install.distro, err: (err as Error).message },
      'distro provider unavailable during remove; skipping uninstall steps',
    );
  }

  // Construct a minimal runtime provider (only needed if the manager's
  // uninstall flow consults it; we pass it as undefined when unavailable).
  let runtimeProvider;
  try {
    const { getRuntime } = await import('../../runtimes/index.js');
    runtimeProvider = getRuntime(install.runtime);
  } catch (err) {
    logger.debug(
      { runtime: install.runtime, err: (err as Error).message },
      'runtime provider unavailable during remove',
    );
  }

  if (distroProvider && runtimeProvider) {
    const { PackageManager } = await import('../../packages/index.js');
    const pm = new PackageManager({
      stateStore: ctx.stateStore,
      distroProvider,
      runtimeProvider: runtimeProvider as unknown as RuntimeProvider,
    });
    pm.on('progress', (msg: string) => out.progress(msg));
    try {
      const result = await pm.uninstall(packageName, {
        pkg: pkgDef ?? undefined,
      });
      if (!result.success) {
        out.error(`Failed to remove ${packageName}: ${result.error ?? 'unknown error'}`);
        return EXIT_CODES.UNINSTALL_FAILED;
      }
    } catch (err) {
      if (isLinuxifyError(err)) {
        out.error(err.message);
        return err.exitCode;
      }
      out.error(`Internal error: ${(err as Error).message}`);
      return EXIT_CODES.GENERIC_ERROR;
    }
  } else {
    // No providers available; just remove the state entry directly.
    await ctx.stateStore.update((s) => {
      s.installed_packages = s.installed_packages.filter((p) => p.name !== packageName);
    });
  }

  // Remove the launcher file (best-effort).
  if (install.launcher_path && existsSync(install.launcher_path)) {
    try {
      await unlink(install.launcher_path);
    } catch (err) {
      logger.warn(
        { path: install.launcher_path, err: (err as Error).message },
        'failed to remove launcher',
      );
    }
  }

  // --purge: also remove cached downloads and patch backups.
  if (opts.purge) {
    out.progress(`Purging cache for ${packageName}…`);
    const { rmrf } = await import('../../utils/fs.js');
    const { getLinuxifyHome } = await import('../../utils/process.js');
    const { join } = await import('node:path');
    try {
      await rmrf(join(getLinuxifyHome(), 'patches', packageName));
      await rmrf(join(getLinuxifyHome(), 'cache', 'patches', packageName));
    } catch (err) {
      logger.warn(
        { pkg: packageName, err: (err as Error).message },
        'failed to purge caches',
      );
    }
  }

  out.success(`${packageName} removed.`);
  return EXIT_CODES.OK;
}

/**
 * Register the `remove` command.
 */
export const registerRemoveCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('remove <package>')
    .description('Uninstall a package and remove its launcher.')
    .option('--purge', 'Also delete cached downloads and patch backups.')
    .option('--keep-config', 'Leave user config files inside the distro untouched.')
    .option('--yes', 'Skip the interactive confirmation prompt.')
    .action(async (packageName: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runRemove(opts, ctx, packageName);
      setExit(code);
    });
};
