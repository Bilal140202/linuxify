/**
 * `linuxify add <package>` — install a CLI tool into the active distro.
 *
 * @module linuxify/cli/commands/add
 *
 * Resolves the package definition (from the registry cache or a local YAML),
 * ensures the required runtime is present, runs the install steps, applies
 * compatibility patches (unless `--no-patch`), generates a launcher shim, and
 * records the install in state.
 *
 * @packageDocumentation
 */


import { getDistro } from '../../distros/index.js';
import { getLauncherGenerator } from '../../launcher/index.js';
import {
  PackageManager,
  type DistroProvider,
  type RuntimeProvider,
} from '../../packages/index.js';
import { getRuntime } from '../../runtimes/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { PackageError } from '../../utils/errors.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Resolve the active distro name from the context (preferring the `--distro`
 * flag, falling back to `state.active_distro`, then the config default).
 */
function resolveActiveDistro(ctx: CommandContext): string {
  if (ctx.flags.distro) return ctx.flags.distro;
  if (ctx.state.active_distro) return ctx.state.active_distro;
  return ctx.config.distro.default;
}

/**
 * Run the `add` command.
 */
export async function runAdd(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName: string,
): Promise<number> {
  const out = ctx.output;

  if (!packageName) {
    out.error('Usage: linuxify add <package>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const distroName = resolveActiveDistro(ctx);
  let distroProvider: DistroProvider;
  try {
    distroProvider = getDistro(distroName);
  } catch {
    out.error(`Distro '${distroName}' is not registered.`);
    out.info(`  Try: linuxify use ${distroName} --create`);
    return EXIT_CODES.NOT_FOUND;
  }

  // Fetch the package definition from the registry.
  out.progress(`Looking up '${packageName}' in the registry…`);
  const pkg = await ctx.registry.getPackage(packageName);
  if (!pkg) {
    out.error(`Package '${packageName}' not found in the registry.`);
    out.info(`  Try: linuxify search ${packageName}`);
    return EXIT_CODES.NOT_FOUND;
  }

  // Resolve the runtime. Cast through `unknown` because the runtimes
  // subsystem's `RuntimeProvider` interface uses a slightly different
  // `install` options type than the package manager's local slice; the two
  // are structurally compatible at runtime (both take a string version and
  // distro, with an optional opts object), but TypeScript's structural
  // comparison rejects the empty-vs-non-empty opts object types.
  const runtimeName = typeof opts.runtime === 'string' ? opts.runtime : pkg.runtime;
  let runtimeProvider: RuntimeProvider;
  try {
    runtimeProvider = getRuntime(runtimeName) as unknown as RuntimeProvider;
  } catch {
    out.error(`Runtime '${runtimeName}' is not registered.`);
    return EXIT_CODES.ENV_NOT_READY;
  }

  const force = !!(opts.force);
  const noPatch = !!(opts.noPatch);

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would install ${pkg.name}@${pkg.version} into ${distroName}.`);
    out.info(`  runtime: ${runtimeName}`);
    out.info(`  patches: ${noPatch ? 'skipped' : `${pkg.patches.length} declared`}`);
    return EXIT_CODES.OK;
  }

  // Construct the package manager.
  const pm = new PackageManager({
    stateStore: ctx.stateStore,
    distroProvider,
    runtimeProvider,
  });

  // Forward progress events to the output formatter.
  pm.on('progress', (msg: string) => out.progress(msg));

  // Generate the launcher after a successful install.
  pm.on('postInstall', async (installedPkg) => {
    try {
      const gen = getLauncherGenerator();
      await gen.generate({
        packageName: installedPkg.name,
        launcherName: installedPkg.launcher,
        distro: distroName,
        variant: 'standard',
      });
    } catch (err) {
      logger.warn(
        { pkg: installedPkg.name, err: (err as Error).message },
        'failed to generate launcher after install',
      );
    }
  });

  try {
    const result = await pm.install(pkg, { force, noPatch });
    if (result.success) {
      out.success(`${pkg.name}@${pkg.version} installed.`);
      out.info(`  Run: ${pkg.launcher}`);
      return EXIT_CODES.OK;
    }
    out.error(`Failed to install ${pkg.name}: ${result.error ?? 'unknown error'}`);
    return EXIT_CODES.STEP_FAILED;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      if (err instanceof PackageError && err.code === 'E_PACKAGE_ALREADY_INSTALLED') {
        out.info(`  Try: linuxify add ${packageName} --force`);
        return EXIT_CODES.ALREADY_INSTALLED;
      }
      return err.exitCode;
    }
    out.error(`Internal error: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `add` command.
 */
export const registerAddCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('add <package>')
    .description('Install a CLI tool into the active distro.')
    .option('--version <v>', 'Pin a specific version (default: latest).')
    .option('--runtime <name>', 'Override the runtime declared by the package.')
    .option('--no-patch', 'Install without applying patches.')
    .option('--force', 'Reinstall over an existing install.')
    .option('--ignore-compat', 'Bypass the min_linuxify compat check.')
    .action(async (packageName: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runAdd(opts, ctx, packageName);
      setExit(code);
    });
};
