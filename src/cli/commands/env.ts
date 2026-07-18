/**
 * `linuxify env` — print the resolved environment.
 *
 * @module linuxify/cli/commands/env
 *
 * Prints the PATH, runtime versions, distro, and any package-declared env
 * vars that Linuxify would set when running a tool. With `--for-run <pkg>`,
 * simulates the env that `linuxify run <pkg>` would produce. Designed for
 * debugging "why does my tool see `process.platform === android`?".
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import { getLinuxifyHome, getTermuxPrefix } from '../../utils/process.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Build the env vars Linuxify would set when running a tool.
 */
function buildEnv(ctx: CommandContext, packageName?: string): Record<string, string> {
  const env: Record<string, string> = {
    LINUXIFY_HOME: getLinuxifyHome(),
    LINUXIFY_PREFIX: getTermuxPrefix(),
    LINUXIFY_DISTRO: ctx.flags.distro ?? ctx.state.active_distro ?? ctx.config.distro.default,
    LINUXIFY_VERSION: ctx.config.config_schema_version.toString(),
  };

  // Add runtime paths from installed runtimes.
  for (const rt of ctx.state.installed_runtimes) {
    if (rt.is_default) {
      env[`LINUXIFY_RUNTIME_${rt.name.toUpperCase()}`] = rt.path;
    }
  }

  // Add package-declared env vars when --for-run is given.
  if (packageName) {
    const install = ctx.state.installed_packages.find((p) => p.name === packageName);
    if (install) {
      env.LINUXIFY_PACKAGE_NAME = install.name;
      env.LINUXIFY_PACKAGE_VERSION = install.version;
      env.LINUXIFY_RUNTIME = install.runtime;
    }
  }

  return env;
}

/**
 * Run the `env` command.
 */
export async function runEnv(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const forRun = typeof opts.forRun === 'string' ? opts.forRun : undefined;

  // Check environment is initialized.
  if (!ctx.state.active_distro) {
    out.error('Linuxify environment not initialized.');
    out.info('  Try: linuxify init');
    return EXIT_CODES.ENV_NOT_READY;
  }

  // If --for-run is given, check the package is installed.
  if (forRun) {
    const install = ctx.state.installed_packages.find((p) => p.name === forRun);
    if (!install) {
      out.error(`Package '${forRun}' is not installed.`);
      return EXIT_CODES.NOT_FOUND;
    }
  }

  const env = buildEnv(ctx, forRun);

  if (ctx.output.json) {
    out.printJson({
      schema: 'linuxify.v1',
      env,
      active_distro: ctx.state.active_distro,
      for_run: forRun ?? null,
    });
    return EXIT_CODES.OK;
  }

  for (const [key, value] of Object.entries(env)) {
    out.info(`${key}=${value}`);
  }
  return EXIT_CODES.OK;
}

/**
 * Register the `env` command.
 */
export const registerEnvCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('env')
    .description('Print the resolved environment that Linuxify would set when running a tool.')
    .option('--json', 'Emit a linuxify.v1 JSON document.')
    .option('--for-run <package>', 'Simulate the env for `linuxify run <package>`.')
    .option('--diff', 'Compare to the current shell env.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runEnv(opts, ctx);
      setExit(code);
    });
};
