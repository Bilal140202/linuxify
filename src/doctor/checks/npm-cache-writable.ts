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
import type { DoctorCheck, DoctorResult } from '../types.js';

export const npmCacheWritableCheck: DoctorCheck = {
  id: 'npm.cache-writable',
  name: 'npm cache writable',
  category: 'runtime',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that npm cache operations work inside proot (no rename ENOENT errors).',
    why: 'Inside proot, /tmp and ~/.npm may be on different mount points. npm\'s atomic rename between them fails with "syscall rename ENOENT". This is the #1 npm issue inside proot.',
    consequence: '`npm install -g <package>` fails with EPERM or ENOENT. No packages can be installed.',
    fix: 'npm config set cache $HOME/.npm && mkdir -p $HOME/.tmp && export TMPDIR=$HOME/.tmp',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'npm.cache-writable',
      name: 'npm cache writable',
      category: 'runtime',
    };

    try {
      // Test if npm cache rename works by doing a dry-run install.
      const r = await exec('proot-distro', ['login', 'ubuntu', '--user', 'linuxify', '--', 'bash', '-c',
        'npm config get cache 2>/dev/null && echo "---" && test -d $HOME/.npm && echo "cache_exists" || echo "no_cache_dir"'],
        { timeoutMs: 15000, env: { TERM: 'dumb' } },
      );

      if (r.exitCode !== 0) {
        return {
          ...base,
          status: 'warn',
          message: 'Could not check npm cache inside Ubuntu (proot-distro login failed).',
          detail: { exitCode: r.exitCode },
          fixCommand: 'proot-distro login ubuntu --user linuxify -- npm config set cache $HOME/.npm',
          durationMs: Date.now() - start,
        };
      }

      const output = r.stdout.trim();
      const cachePath = output.split('---')[0]?.trim();
      const hasCacheDir = output.includes('cache_exists');

      // Check if TMPDIR is set to a home-relative path (not /tmp).
      const tmpdirCheck = await exec('proot-distro', ['login', 'ubuntu', '--user', 'linuxify', '--', 'echo', '$TMPDIR'], { timeoutMs: 10000 });
      const tmpdir = tmpdirCheck.stdout.trim();
      const tmpdirOk = tmpdir === '' || tmpdir.startsWith('/home/');

      if (cachePath && cachePath.startsWith('/home/') && hasCacheDir && tmpdirOk) {
        return {
          ...base,
          status: 'ok',
          message: `npm cache is at ${cachePath}, TMPDIR is ${tmpdir || '(default)'}.`,
          detail: { cachePath, tmpdir, hasCacheDir },
          durationMs: Date.now() - start,
        };
      }

      // Cache is misconfigured — suggest the fix.
      return {
        ...base,
        status: 'warn',
        message: `npm cache may cause rename errors inside proot. Cache: ${cachePath}, TMPDIR: ${tmpdir || '/tmp'}. Run the fix below.`,
        detail: { cachePath, tmpdir, hasCacheDir, issue: 'proot rename mount-point mismatch' },
        fixCommand: 'proot-distro login ubuntu --user linuxify -- bash -c "npm config set cache $HOME/.npm && mkdir -p $HOME/.tmp && echo \'export TMPDIR=$HOME/.tmp\' >> ~/.bashrc"',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ...base,
        status: 'skip',
        message: `npm cache check skipped: ${(err as Error).message}`,
        detail: { error: (err as Error).message },
        durationMs: Date.now() - start,
      };
    }
  },
};
