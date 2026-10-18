/**
 * Doctor check: `hosting.nginx-installed`.
 *
 * @module linuxify/doctor/checks/host-nginx-installed
 *
 * Verifies that nginx is installed inside the active proot-distro (the
 * default web server used by the hosting subsystem). This is the
 * "single dependency" check — without nginx, the hosting subsystem's
 * reverse-proxy / static-serve capabilities don't work.
 *
 * Resolution:
 *  1. Skip if hosting isn't initialized (no point probing nginx before
 *     the user has run `linuxify host init`).
 *  2. Shell into the active proot-distro and run `which nginx`.
 *  3. Return ok / fail based on the exit code.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import { getActiveDistro } from '../../utils/distros.js';
import { exists } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

const HOSTING_SUBDIR = 'hosting';
const HOSTING_CONFIG_FILE = 'config.json';

/**
 * The `hosting.nginx-installed` doctor check. Registered in `checks/index.ts`.
 */
export const hostNginxInstalledCheck: DoctorCheck = {
  id: 'hosting.nginx-installed',
  name: 'nginx installed (hosting)',
  category: 'services',
  profile: ['deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that nginx is installed inside the active proot-distro (the default web server used by the hosting subsystem).',
    why: 'The hosting engine installs nginx during `linuxify host init` to act as the reverse proxy / static-file server for deployed apps. If nginx gets removed (e.g. by an apt-get autoremove that targets a different package), the hosting subsystem silently breaks: requests to deployed apps 404.',
    consequence: '`linuxify host deploy <path>` will succeed (PM2 starts the app) but the app won\'t be reachable via the URL — nginx isn\'t there to proxy.',
    fix: 'linuxify host init',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'hosting.nginx-installed',
      name: 'nginx installed (hosting)',
      category: 'services',
    };

    // Skip if hosting isn't initialized.
    const configPath = join(getLinuxifyHome(), HOSTING_SUBDIR, HOSTING_CONFIG_FILE);
    if (!(await exists(configPath))) {
      return {
        ...base,
        status: 'skip',
        message: 'Hosting not initialized. Run: linuxify host init',
        durationMs: Date.now() - start,
      };
    }

    // No active distro → can't probe nginx.
    const distro = await getActiveDistro(ctx.state.active_distro);
    if (!distro) {
      return {
        ...base,
        status: 'fail',
        message: 'No active proot-distro. Run: linuxify init',
        fixCommand: 'linuxify init',
        durationMs: Date.now() - start,
      };
    }

    const r = await exec(
      'proot-distro',
      ['login', distro, '--', 'which', 'nginx'],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );

    if (r.exitCode !== 0) {
      return {
        ...base,
        status: 'fail',
        message: `nginx is not installed in the '${distro}' proot-distro.`,
        detail: {
          distro,
          exitCode: r.exitCode,
          stderr: r.stderr.slice(0, 200),
        },
        fixCommand: 'linuxify host init',
        fixDocs: 'https://docs.linuxify.dev/25-hosting/init',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `nginx installed in '${distro}' at ${r.stdout.trim()}.`,
      detail: { distro, path: r.stdout.trim() },
      durationMs: Date.now() - start,
    };
  },
};
