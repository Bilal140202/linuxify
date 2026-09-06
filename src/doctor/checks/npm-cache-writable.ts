/**
 * Doctor check: `npm.cache-writable`.
 *
 * Detects the proot npm rename bug: `npm ERR! syscall rename` when /tmp and
 * ~/.npm are on different mount points inside proot. Every Termux proot user
 * hits this.
 *
 * Fix: sets `npm config set cache $HOME/.npm` and creates `$TMPDIR`.
 */

import { exec } from '../../utils/process.js';
import { getActiveDistro } from '../../utils/distros.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

export const npmCacheWritableCheck: DoctorCheck = {
  id: 'npm.cache-writable',
  name: 'npm cache writable',
  category: 'runtime',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that npm cache operations work inside proot (no rename ENOENT errors).',
    why: 'Inside proot, /tmp and ~/.npm may be on different mount points. npm\'s atomic rename between them fails with "syscall rename ENOENT". This is the #1 npm issue inside proot.',
    consequence: '`npm install -g <package>` fails with EPERM or ENOENT. No packages can be installed.',
    fix: 'proot-distro login <distro> --user linuxify -- bash -c "npm config set cache $HOME/.npm && mkdir -p $HOME/.tmp && echo \'export TMPDIR=$HOME/.tmp\' >> ~/.bashrc"',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'npm.cache-writable',
      name: 'npm cache writable',
      category: 'runtime',
    };

    // Use getActiveDistro instead of hardcoding 'ubuntu'.
    const active = await getActiveDistro(ctx.state.active_distro);
    if (!active) {
      return {
        ...base,
        status: 'skip',
        message: 'No active distro; skipping npm cache check.',
        detail: { source: 'getActiveDistro' },
        durationMs: Date.now() - start,
      };
    }

    try {
      const r = await exec(
        'proot-distro',
        ['login', active, '--user', 'linuxify', '--', 'bash', '-c',
         'npm config get cache 2>/dev/null && echo "---" && echo "${TMPDIR:-}"'],
        { timeoutMs: 15000, env: { TERM: 'dumb' } },
      );

      if (r.exitCode !== 0) {
        return {
          ...base,
          status: 'warn',
          message: `Could not check npm cache inside ${active} (proot-distro login failed).`,
          detail: { exitCode: r.exitCode, distro: active },
          fixCommand: `proot-distro login ${active} --user linuxify -- npm config set cache $HOME/.npm`,
          durationMs: Date.now() - start,
        };
      }

      const parts = r.stdout.split('---');
      const cachePath = parts[0]?.trim();
      const tmpdir = parts[1]?.trim() || '';

      // TMPDIR must be set to a home-relative path to avoid the rename bug.
      // Empty TMPDIR means /tmp is in use, which IS the bug condition.
      const tmpdirOk = tmpdir.startsWith('/home/');

      if (cachePath && cachePath.startsWith('/home/') && tmpdirOk) {
        return {
          ...base,
          status: 'ok',
          message: `npm cache at ${cachePath}, TMPDIR=${tmpdir}.`,
          detail: { cachePath, tmpdir, distro: active },
          durationMs: Date.now() - start,
        };
      }

      return {
        ...base,
        status: 'warn',
        message: `npm cache may cause rename errors inside proot. Cache: ${cachePath}, TMPDIR: ${tmpdir || '/tmp (default — this is the bug!)'}.`,
        detail: { cachePath, tmpdir, distro: active, issue: 'proot rename mount-point mismatch' },
        fixCommand: `proot-distro login ${active} --user linuxify -- bash -c "npm config set cache \\$HOME/.npm && mkdir -p \\$HOME/.tmp && grep -q TMPDIR ~/.bashrc || echo 'export TMPDIR=\\$HOME/.tmp' >> ~/.bashrc"`,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ...base,
        status: 'skip',
        message: `npm cache check skipped: ${(err as Error).message}`,
        detail: { error: (err as Error).message, distro: active },
        durationMs: Date.now() - start,
      };
    }
  },
};
