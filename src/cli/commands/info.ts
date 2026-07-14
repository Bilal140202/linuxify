/**
 * `linuxify info <package>` — print package details.
 *
 * @module linuxify/cli/commands/info
 *
 * Prints the resolved package definition (from the registry cache or the
 * installed state) plus install status, available versions, and declared
 * patches.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `info` command.
 */
export async function runInfo(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName: string,
): Promise<number> {
  const out = ctx.output;

  if (!packageName) {
    out.error('Usage: linuxify info <package>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  let pkg;
  try {
    pkg = await ctx.registry.getPackage(packageName);
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to fetch package info: ${(err as Error).message}`);
    return EXIT_CODES.NETWORK_ERROR;
  }

  const state = await ctx.stateStore.load();
  const installed = state.installed_packages.find((p) => p.name === packageName);

  if (!pkg) {
    if (installed) {
      out.info(`Package '${packageName}' is installed but no longer in the registry.`);
      out.info(`  installed version: ${installed.version}`);
      out.info(`  distro: ${installed.distro}`);
      out.info(`  runtime: ${installed.runtime}@${installed.runtime_version}`);
      return EXIT_CODES.OK;
    }
    out.error(`Package '${packageName}' not found.`);
    out.info(`  Try: linuxify search ${packageName}`);
    return EXIT_CODES.NOT_FOUND;
  }

  if (ctx.output.json) {
    out.printJson({
      schema: 'linuxify.v1',
      package: pkg,
      installed: installed
        ? {
            version: installed.version,
            distro: installed.distro,
            runtime: installed.runtime,
            runtime_version: installed.runtime_version,
            install_date: installed.install_date,
            patches_applied: installed.patches_applied,
          }
        : null,
    });
    return EXIT_CODES.OK;
  }

  out.info(`name:         ${pkg.name}`);
  out.info(`version:      ${pkg.version}`);
  out.info(`runtime:      ${pkg.runtime} >= ${pkg.runtime_min_version}`);
  if (pkg.runtime_max_version) {
    out.info(`              (max: ${pkg.runtime_max_version})`);
  }
  if (pkg.description) out.info(`description:  ${pkg.description}`);
  if (pkg.homepage) out.info(`homepage:     ${pkg.homepage}`);
  if (pkg.license) out.info(`license:      ${pkg.license}`);
  out.info(`launcher:     ${pkg.launcher}`);
  out.info(`patches:      ${pkg.patches.length}`);
  if (pkg.patches.length > 0) {
    for (const p of pkg.patches) {
      out.info(`  ${p.patch_id}  ${p.file}  (${p.type})`);
    }
  }
  if (pkg.compat) {
    out.info(`compat:`);
    if (pkg.compat.min_linuxify) out.info(`  min_linuxify: ${pkg.compat.min_linuxify}`);
    if (pkg.compat.tested_distros?.length) {
      out.info(`  tested_distros: ${pkg.compat.tested_distros.join(', ')}`);
    }
  }
  out.info(`installed:    ${installed ? `yes (${installed.distro}, ${installed.version})` : 'no'}`);

  return EXIT_CODES.OK;
}

/**
 * Register the `info` command.
 */
export const registerInfoCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('info <package>')
    .description('Print resolved package details and install status.')
    .option('--json', 'Emit a linuxify.v1 JSON document.')
    .option('--versions', 'List all known versions (v1.1).')
    .option('--changelog', 'Print the recent changelog (v1.1).')
    .action(async (packageName: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runInfo(opts, ctx, packageName);
      setExit(code);
    });
};
