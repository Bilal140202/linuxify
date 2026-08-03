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

  // Ensure essential packages are installed inside the distro (as root).
  // This guarantees Ubuntu uses its OWN Node.js/npm, not Termux's.
  out.info('Ensuring essential packages are installed…');
  try {
    const { exec: execUtil } = await import('../../utils/process.js');
    const ensureResult = await execUtil(
      'proot-distro',
      ['login', distroName, '--', 'bash', '-c',
       'export DEBIAN_FRONTEND=noninteractive; ' +
       'apt-get update -qq 2>/dev/null && ' +
       'apt-get install -y -qq curl git build-essential nodejs npm python3 python3-pip 2>&1 | tail -3'],
      { timeoutMs: 300_000, env: { TERM: 'dumb' } },
    );
    if (ensureResult.exitCode === 0) {
      out.success('  ✓ Packages ready');
    } else {
      out.warn('  Package install had issues — continuing to shell.');
    }
  } catch {
    out.warn('  Could not verify packages — continuing to shell.');
  }

  // Ensure the linuxify user exists.
  try {
    const { exec: execUtil } = await import('../../utils/process.js');
    await execUtil(
      'proot-distro',
      ['login', distroName, '--', 'sh', '-c',
       "id linuxify >/dev/null 2>&1 || " +
       "(echo 'linuxify:x:1000:1000:Linuxify:/home/linuxify:/bin/bash' >> /etc/passwd && " +
       "echo 'linuxify:*:19000:0:99999:7:::' >> /etc/shadow && " +
       "echo 'linuxify:x:1000:' >> /etc/group && " +
       "mkdir -p /home/linuxify && chown 1000:1000 /home/linuxify)"],
      { timeoutMs: 30_000, env: { TERM: 'dumb' } },
    );
  } catch {
    // Non-fatal.
  }

  out.info('');

  // Build the proot-distro login arguments.
  const prootArgs = ['login', distroName, '--user', user];
  if (workdir) {
    prootArgs.push('--cwd', workdir);
  }

  return new Promise<number>((resolve) => {
    const child = spawn('proot-distro', prootArgs, { stdio: 'inherit' });

    child.on('error', (err) => {
      out.error(`Failed to spawn proot-distro: ${err.message}`);
      // Fallback: try root login.
      out.info('  Trying root shell…');
      const rootChild = spawn('proot-distro', ['login', distroName], { stdio: 'inherit' });
      rootChild.on('error', () => {
        resolve(EXIT_CODES.PROOT_ENTER_FAILED);
      });
      rootChild.on('exit', (code) => {
        resolve(code ?? EXIT_CODES.OK);
      });
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
