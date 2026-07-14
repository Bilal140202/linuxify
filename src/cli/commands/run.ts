/**
 * `linuxify run <package> [-- <args>]` — execute a package inside the proot.
 *
 * @module linuxify/cli/commands/run
 *
 * Looks up the package in state, gets the active distro, builds a proot
 * invocation, and execs the package's launcher with the given arguments.
 * The wrapped tool's exit code is propagated verbatim as long as it is
 * < 125 (per `cli-specification.md` §6).
 *
 * The `--` separator forces all following tokens to be passed through
 * verbatim, which is necessary when the wrapped tool accepts its own flags
 * that collide with Linuxify's.
 *
 * @packageDocumentation
 */

import { spawn } from 'node:child_process';


import { getDistro } from '../../distros/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `run` command.
 *
 * @param opts - Commander options (unused).
 * @param ctx - The shared command context.
 * @param packageName - The package to run.
 * @param args - Arguments to forward to the package's binary.
 * @returns The exit code (the wrapped tool's exit code if it ran).
 */
export async function runRun(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName: string,
  args: string[],
): Promise<number> {
  const out = ctx.output;
  void opts;

  if (!packageName) {
    out.error('Usage: linuxify run <package> [-- <args>]');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const state = await ctx.stateStore.load();
  const install = state.installed_packages.find((p) => p.name === packageName);
  if (!install) {
    out.error(`Package '${packageName}' is not installed.`);
    out.info(`  Try: linuxify add ${packageName}`);
    return EXIT_CODES.NOT_FOUND;
  }

  const distroName = ctx.flags.distro ?? state.active_distro ?? install.distro;
  let distroProvider;
  try {
    distroProvider = getDistro(distroName);
  } catch {
    out.error(`Distro '${distroName}' is not registered.`);
    return EXIT_CODES.ENV_NOT_READY;
  }

  const isInstalled = await distroProvider.isInstalled();
  if (!isInstalled) {
    out.error(`Distro '${distroName}' is not installed.`);
    out.info(`  Try: linuxify use ${distroName} --create`);
    return EXIT_CODES.ENV_NOT_READY;
  }

  // Build the proot invocation. We use `proot-distro login <distro> --user
  // linuxify -- <binary> <args...>` to enter the proot and run the package's
  // binary directly. The binary is resolved by PATH inside the proot.
  //
  // We forward stdio so the user's terminal is connected directly to the
  // child process. Signals (SIGINT, SIGTERM) are forwarded so Ctrl-C kills
  // both the proot and the wrapped tool.
  return new Promise<number>((resolve) => {
    const child = spawn(
      'proot-distro',
      ['login', distroName, '--user', 'linuxify', '--', install.name, ...args],
      { stdio: 'inherit' },
    );

    child.on('error', (err) => {
      out.error(`Failed to spawn proot-distro: ${err.message}`);
      out.info('  Docs: https://linuxify.dev/docs/05-bootstrap/bootstrap-design.html');
      resolve(EXIT_CODES.PROOT_ENTER_FAILED);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        // The child was killed by a signal. We return 130 (INTERRUPTED) for
        // SIGINT, 1 for others — matching the shell convention.
        logger.warn({ signal, pkg: packageName }, 'run child killed by signal');
        resolve(signal === 'SIGINT' ? 130 : EXIT_CODES.GENERIC_ERROR);
        return;
      }
      // Propagate the wrapped tool's exit code verbatim (per spec §6).
      resolve(code ?? EXIT_CODES.OK);
    });

    // Forward signals.
    const sigHandler = (sig: NodeJS.Signals): void => {
      child.kill(sig);
    };
    process.on('SIGINT', sigHandler);
    process.on('SIGTERM', sigHandler);
    process.on('SIGHUP', sigHandler);
    child.on('exit', () => {
      process.off('SIGINT', sigHandler);
      process.off('SIGTERM', sigHandler);
      process.off('SIGHUP', sigHandler);
    });
  });
}

/**
 * Register the `run` command. Commander's `--` separator puts everything
 * after it into the variadic args array; we use `.allowUnknownOption()` so
 * flags belonging to the wrapped tool are forwarded verbatim.
 */
export const registerRunCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('run <package> [args...]')
    .description('Run a package inside the active distro. Use -- to separate Linuxify flags.')
    .allowUnknownOption(true)
    .action(async (packageName: string, ...rest: unknown[]) => {
      // Commander passes the variadic args as the last positional; the
      // options object is the last argument. We extract both.
      const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : [];
      const ctx = await getCtx();
      const code = await runRun({}, ctx, packageName, args);
      setExit(code);
    });
};
