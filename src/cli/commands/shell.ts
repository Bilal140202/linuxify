/**
 * `linuxify shell` — open an interactive shell inside the active distro.
 *
 * @module linuxify/cli/commands/shell
 *
 * Execs `proot-distro login <distro> --user linuxify` with the user's
 * terminal attached directly. The shell's exit code is propagated verbatim.
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
 * Run the `shell` command.
 */
export async function runShell(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const distroName =
    (typeof opts.distro === 'string' ? opts.distro : undefined) ??
    ctx.flags.distro ??
    ctx.state.active_distro;
  const user = typeof opts.as === 'string' ? opts.as : 'linuxify';
  const workdir = typeof opts.workdir === 'string' ? opts.workdir : undefined;

  if (!distroName) {
    out.error('No active distro. Run `linuxify init` or `linuxify use <distro>`.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  let distroProvider;
  try {
    distroProvider = getDistro(distroName);
  } catch {
    out.error(`Distro '${distroName}' is not registered.`);
    return EXIT_CODES.NOT_FOUND;
  }

  const isInstalled = await distroProvider.isInstalled();
  if (!isInstalled) {
    out.error(`Distro '${distroName}' is not installed.`);
    out.info(`  Try: linuxify use ${distroName} --create`);
    return EXIT_CODES.ENV_NOT_READY;
  }

  // Build the proot-distro login arguments.
  const prootArgs = ['login', distroName, '--user', user];
  if (workdir) {
    prootArgs.push('--cwd', workdir);
  }

  return new Promise<number>((resolve) => {
    const child = spawn('proot-distro', prootArgs, { stdio: 'inherit' });

    child.on('error', (err) => {
      out.error(`Failed to spawn proot-distro: ${err.message}`);
      resolve(EXIT_CODES.PROOT_ENTER_FAILED);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        logger.warn({ signal }, 'shell child killed by signal');
        resolve(signal === 'SIGINT' ? 130 : EXIT_CODES.GENERIC_ERROR);
        return;
      }
      resolve(code ?? EXIT_CODES.OK);
    });

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
 * Register the `shell` command.
 */
export const registerShellCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('shell')
    .description('Open an interactive shell inside the active distro.')
    .option('--distro <name>', 'Override the active distro for this shell.')
    .option('--as <user>', 'Log in as this user (default: linuxify).')
    .option('--workdir <path>', 'Working directory at shell start.')
    .option('--no-bind-home', 'Do not bind-mount the host $HOME.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runShell(opts, ctx);
      setExit(code);
    });
};
