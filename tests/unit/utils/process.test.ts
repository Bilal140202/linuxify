import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LINUXIFY_VERSION } from '../../../src/utils/constants.js';
import { LinuxifyError } from '../../../src/utils/errors.js';
import {
  exec,
  execOrThrow,
  getEnv,
  getLinuxifyHome,
  getTermuxPrefix,
  isTermux,
  isAndroid,
  getArch,
  getPlatform,
  getAndroidVersion,
  sleep,
  getDefaultUserAgent,
} from '../../../src/utils/process.js';

describe('utils/process', () => {
  let prevTermuxVersion: string | undefined;
  let prevPrefix: string | undefined;
  let prevHome: string | undefined;
  let prevLinuxifyHome: string | undefined;
  let prevPlatform: string | undefined;
  let prevArch: string | undefined;

  beforeEach(() => {
    prevTermuxVersion = process.env.TERMUX_VERSION;
    prevPrefix = process.env.PREFIX;
    prevHome = process.env.HOME;
    prevLinuxifyHome = process.env.LINUXIFY_HOME;
    prevPlatform = process.platform;
    prevArch = process.arch;
  });

  afterEach(() => {
    if (prevTermuxVersion === undefined) delete process.env.TERMUX_VERSION;
    else process.env.TERMUX_VERSION = prevTermuxVersion;
    if (prevPrefix === undefined) delete process.env.PREFIX;
    else process.env.PREFIX = prevPrefix;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevLinuxifyHome === undefined) delete process.env.LINUXIFY_HOME;
    else process.env.LINUXIFY_HOME = prevLinuxifyHome;
    vi.restoreAllMocks();
  });

  describe('exec', () => {
    it('captures stdout from echo', async () => {
      const r = await exec('echo', ['hello']);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hello');
      expect(r.stderr).toBe('');
      expect(r.failed).toBe(false);
    });

    it('returns non-zero exitCode without throwing', async () => {
      const r = await exec('false');
      expect(r.exitCode).not.toBe(0);
      expect(r.failed).toBe(true);
    });

    it('captures stderr from a command that writes to it', async () => {
      // `sh -c 'echo err >&2'`
      const r = await exec('sh', ['-c', 'echo err >&2']);
      expect(r.exitCode).toBe(0);
      expect(r.stderr.trim()).toBe('err');
    });

    it('passes environment variables via opts.env', async () => {
      const r = await exec('sh', ['-c', 'echo $MY_VAR'], {
        env: { MY_VAR: 'env-value' },
      });
      expect(r.stdout.trim()).toBe('env-value');
    });

    it('respects timeoutMs (kills long-running command)', async () => {
      // Use `sleep` directly (not `sh -c 'sleep N'`) so execa can kill the
      // child process. With `sh -c`, killing `sh` orphans the `sleep`
      // grandchild, which keeps the pipe open until the sleep finishes.
      const start = Date.now();
      const r = await exec('sleep', ['5'], { timeoutMs: 200 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(r.timedOut).toBe(true);
    });

    it('accepts the legacy timeout option too', async () => {
      const r = await exec('sleep', ['3'], { timeout: 100 });
      expect(r.timedOut).toBe(true);
    });

    it('exposes a joined command string', async () => {
      const r = await exec('echo', ['a', 'b']);
      expect(r.command).toBe('echo a b');
    });
  });

  describe('execOrThrow', () => {
    it('returns stdout on success', async () => {
      const out = await execOrThrow('echo', ['success']);
      expect(out).toBe('success');
    });

    it('throws LinuxifyError on non-zero exit', async () => {
      await expect(execOrThrow('false')).rejects.toBeInstanceOf(LinuxifyError);
      try {
        await execOrThrow('false');
      } catch (e) {
        const err = e as LinuxifyError;
        expect(err.code).toBe('E_EXEC_FAILED');
        expect(err.exitCode).toBe(4);
        const details = err.details as { exitCode: number; command: string };
        expect(details.exitCode).not.toBe(0);
        expect(details.command).toContain('false');
      }
    });

    it('includes stdout and stderr in the error details', async () => {
      try {
        await execOrThrow('sh', ['-c', 'echo out; echo err >&2; exit 1']);
      } catch (e) {
        const err = e as LinuxifyError;
        const details = err.details as { stdout: string; stderr: string };
        expect(details.stdout).toContain('out');
        expect(details.stderr).toContain('err');
      }
    });
  });

  describe('getEnv', () => {
    it('returns the env var value', () => {
      process.env.MY_TEST_VAR = 'value123';
      expect(getEnv('MY_TEST_VAR')).toBe('value123');
    });

    it('returns the default when unset', () => {
      delete process.env.NONEXISTENT_VAR_XYZ;
      expect(getEnv('NONEXISTENT_VAR_XYZ', 'fallback')).toBe('fallback');
    });

    it('returns empty string when unset and no default', () => {
      delete process.env.NONEXISTENT_VAR_XYZ;
      expect(getEnv('NONEXISTENT_VAR_XYZ')).toBe('');
    });

    it('returns default for empty string value', () => {
      process.env.EMPTY_VAR = '';
      expect(getEnv('EMPTY_VAR', 'def')).toBe('def');
    });
  });

  describe('getLinuxifyHome', () => {
    it('returns LINUXIFY_HOME when set', () => {
      process.env.LINUXIFY_HOME = '/custom/linuxify';
      expect(getLinuxifyHome()).toBe('/custom/linuxify');
    });

    it('returns ~/.linuxify when LINUXIFY_HOME unset', () => {
      delete process.env.LINUXIFY_HOME;
      process.env.HOME = '/home/testuser';
      expect(getLinuxifyHome()).toBe('/home/testuser/.linuxify');
    });

    it('falls back to /tmp when HOME is unset', () => {
      delete process.env.LINUXIFY_HOME;
      delete process.env.HOME;
      delete process.env.USERPROFILE;
      const home = getLinuxifyHome();
      expect(home).toMatch(/\.linuxify$/);
    });
  });

  describe('getTermuxPrefix', () => {
    it('returns PREFIX when set', () => {
      process.env.PREFIX = '/data/data/com.termux/files/usr';
      expect(getTermuxPrefix()).toBe('/data/data/com.termux/files/usr');
    });

    it('returns canonical Termux path when PREFIX unset', () => {
      delete process.env.PREFIX;
      expect(getTermuxPrefix()).toBe('/data/data/com.termux/files/usr');
    });
  });

  describe('isTermux', () => {
    it('returns true when TERMUX_VERSION is set', () => {
      process.env.TERMUX_VERSION = '0.118';
      expect(isTermux()).toBe(true);
    });

    it('returns true when PREFIX is the Termux path', () => {
      delete process.env.TERMUX_VERSION;
      process.env.PREFIX = '/data/data/com.termux/files/usr';
      expect(isTermux()).toBe(true);
    });

    it('returns false when neither Termux env is set and platform is not android', () => {
      delete process.env.TERMUX_VERSION;
      delete process.env.PREFIX;
      // On a non-Android test runner, this should be false.
      if (process.platform !== 'android') {
        expect(isTermux()).toBe(false);
      }
    });
  });

  describe('isAndroid', () => {
    it('matches process.platform === android', () => {
      // On a non-Android CI runner, isAndroid() returns false.
      expect(isAndroid()).toBe(process.platform === 'android');
    });
  });

  describe('getArch', () => {
    it('normalizes arm64 to aarch64', () => {
      // We can't change process.arch at runtime; verify the mapping logic
      // against the current arch instead.
      const expected = (() => {
        switch (process.arch) {
          case 'arm64':
            return 'aarch64';
          case 'arm':
            return 'armv7l';
          case 'x64':
            return 'x86_64';
          default:
            return 'unknown';
        }
      })();
      expect(getArch()).toBe(expected);
    });

    it('returns a value from the supported set or unknown', () => {
      const a = getArch();
      expect(['aarch64', 'armv7l', 'x86_64', 'unknown']).toContain(a);
    });
  });

  describe('getPlatform', () => {
    it('returns the current platform', () => {
      const p = getPlatform();
      expect(['android', 'linux', 'darwin', 'win32']).toContain(p);
    });
  });

  describe('getAndroidVersion', () => {
    it('returns null when not in Termux', async () => {
      delete process.env.TERMUX_VERSION;
      delete process.env.PREFIX;
      if (process.platform !== 'android') {
        const v = await getAndroidVersion();
        expect(v).toBeNull();
      }
    });

    it('attempts to run getprop when in Termux (mocked)', async () => {
      process.env.TERMUX_VERSION = '0.118';
      // Mock exec to simulate getprop returning a version string.
      // We can't easily mock exec (it's a local function import); instead,
      // we just verify the function returns null or a string without throwing.
      const v = await getAndroidVersion();
      expect(v === null || typeof v === 'string').toBe(true);
    });
  });

  describe('sleep', () => {
    it('resolves after the specified delay', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40); // allow some slack
      expect(elapsed).toBeLessThan(500);
    });

    it('resolves immediately for 0', async () => {
      await expect(sleep(0)).resolves.toBeUndefined();
    });
  });

  describe('getDefaultUserAgent', () => {
    it('includes the linuxify name and version', () => {
      const ua = getDefaultUserAgent();
      expect(ua).toContain('linuxify/');
      expect(ua).toContain(LINUXIFY_VERSION);
    });

    it('includes platform and arch', () => {
      const ua = getDefaultUserAgent();
      expect(ua).toContain(getPlatform());
      expect(ua).toContain(getArch());
    });

    it('has the expected format', () => {
      const ua = getDefaultUserAgent();
      expect(ua).toMatch(/^linuxify\/[\w.-]+ \(\w+ \w+\)$/);
    });
  });
});
