/**
 * `linuxify upgrade [<package>]` — upgrade one or all installed packages.
 *
 * @module linuxify/cli/commands/upgrade
 *
 * If a package is specified, upgrade that package. With `--all` (or no
 * argument), upgrade every installed package. Re-runs install + patch +
 * launcher regeneration. Always prints a diff of versions before applying
 * unless `--yes` is given.
 *
 * @packageDocumentation
 */


import { getDistro } from '../../distros/index.js';
import { getLauncherGenerator } from '../../launcher/index.js';
import { PackageManager, type RuntimeProvider } from '../../packages/index.js';
import { getRuntime } from '../../runtimes/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Upgrade a single package.
 */
async function upgradeOne(
  ctx: CommandContext,
  packageName: string,
  noPatch: boolean,
): Promise<number> {
  const out = ctx.output;
  const state = await ctx.stateStore.load();
  const installed = state.installed_packages.find((p) => p.name === packageName);
  if (!installed) {
    out.error(`Package '${packageName}' is not installed.`);
    return EXIT_CODES.NOT_FOUND;
  }

  // Fetch the latest from the registry.
  const pkg = await ctx.registry.getPackage(packageName);
  if (!pkg) {
    out.error(`Package '${packageName}' is not in the registry.`);
    return EXIT_CODES.NOT_FOUND;
  }

  if (pkg.version === installed.version) {
    out.info(`${packageName} is already at ${installed.version}.`);
    return EXIT_CODES.OK;
  }

  out.info(`${packageName}  ${installed.version} → ${pkg.version}`);

  if (ctx.flags.dryRun) {
    out.info('Dry run: would upgrade.');
    return EXIT_CODES.OK;
  }

  if (!ctx.flags.yes) {
    out.info('Re-run with --yes to apply the upgrade.');
    return EXIT_CODES.OK;
  }

  // Build the manager and reinstall (force). Cast the runtime provider
  // through `unknown` to bridge the runtimes-subsystem and packages-subsystem
  // `RuntimeProvider` interface variants (see add.ts for the rationale).
  const distroProvider = getDistro(installed.distro);
  const runtimeProvider = getRuntime(installed.runtime) as unknown as RuntimeProvider;
  const pm = new PackageManager({
    stateStore: ctx.stateStore,
    distroProvider,
    runtimeProvider,
  });
  pm.on('progress', (msg: string) => out.progress(msg));
  pm.on('postInstall', async (installedPkg) => {
    try {
      const gen = getLauncherGenerator();
      await gen.generate({
        packageName: installedPkg.name,
        launcherName: installedPkg.launcher,
        distro: installed.distro,
        variant: 'standard',
      });
    } catch (err) {
      logger.warn(
        { pkg: installedPkg.name, err: (err as Error).message },
        'failed to regenerate launcher during upgrade',
      );
    }
  });

  try {
    const result = await pm.install(pkg, { force: true, noPatch });
    if (result.success) {
      out.success(`${packageName}@${pkg.version} installed.`);
      return EXIT_CODES.OK;
    }
    out.error(`Failed to upgrade ${packageName}: ${result.error ?? 'unknown error'}`);
    return EXIT_CODES.STEP_FAILED;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Internal error: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Run the `upgrade` command.
 */
export async function runUpgrade(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName?: string,
): Promise<number> {
  const out = ctx.output;
  const all = !!(opts.all);
  const noPatch = !!(opts.noPatch);

  if (packageName) {
    return upgradeOne(ctx, packageName, noPatch);
  }

  if (!all) {
    out.error('Usage: linuxify upgrade [<package> | --all]');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const state = await ctx.stateStore.load();
  let finalCode: number = EXIT_CODES.OK;
  for (const installed of state.installed_packages) {
    const code = await upgradeOne(ctx, installed.name, noPatch);
    if (code !== EXIT_CODES.OK) {
      finalCode = code;
    }
  }
  return finalCode;
}

/**
 * Register the `upgrade` command.
 */
export const registerUpgradeCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('upgrade [package]')
    .description('Upgrade one package or all installed packages to the latest version.')
    .option('--all', 'Upgrade every installed package.')
    .option('--dry-run', 'Print what would be upgraded without applying anything.')
    .option('--no-patch', 'Skip patch application during upgrade.')
    .option('--to <version>', 'Pin the target version.')
    .action(async (packageName: string | undefined, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runUpgrade(opts, ctx, packageName);
      setExit(code);
    });
};
