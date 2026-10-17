/**
 * Process manager — wraps PM2 for managing hosted applications.
 *
 * @module linuxify/hosting/process-manager
 *
 * All operations run inside the proot via `proot-distro login <distro> --`.
 */

import { exec } from '../utils/process.js';
import { logger } from '../utils/log.js';

const PM2_TIMEOUT = 15_000;

export class ProcessManager {
  constructor(private readonly distro: string) {}

  /**
   * Start an application with PM2.
   */
  async start(name: string, startCommand: string, cwd: string): Promise<number> {
    logger.info({ name, distro: this.distro }, 'hosting: starting app with PM2');
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c',
       `cd ${cwd} && pm2 start "${startCommand}" --name ${name} --no-treekill`],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    if (r.exitCode !== 0) {
      logger.error({ stderr: r.stderr.slice(0, 500) }, 'hosting: PM2 start failed');
    }
    return r.exitCode;
  }

  /**
   * Stop an application.
   */
  async stop(name: string): Promise<number> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'pm2', 'stop', name],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    return r.exitCode;
  }

  /**
   * Restart an application.
   */
  async restart(name: string): Promise<number> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'pm2', 'restart', name],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    return r.exitCode;
  }

  /**
   * Remove an application from PM2.
   */
  async remove(name: string): Promise<number> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'pm2', 'delete', name],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    return r.exitCode;
  }

  /**
   * Get status of all PM2 processes.
   */
  async status(): Promise<unknown> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'pm2', 'jlist'],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    if (r.exitCode !== 0) return [];
    try {
      return JSON.parse(r.stdout);
    } catch {
      return [];
    }
  }

  /**
   * Get logs for an application.
   */
  async logs(name: string, lines: number = 50): Promise<string> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'pm2', 'logs', name, '--lines', String(lines), '--nostream'],
      { timeoutMs: PM2_TIMEOUT, env: { TERM: 'dumb' } },
    );
    return r.stdout;
  }

  /**
   * Check if PM2 is installed inside the distro.
   */
  async isInstalled(): Promise<boolean> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'which', 'pm2'],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }

  /**
   * Install PM2 inside the distro.
   */
  async install(): Promise<boolean> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'npm', 'install', '-g', 'pm2'],
      { timeoutMs: 60_000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }
}
