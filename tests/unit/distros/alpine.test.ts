/**
 * Unit tests for `src/distros/alpine.ts` (AlpineProvider).
 *
 * Same mocking strategy as `ubuntu.test.ts` (in-memory fs + captured exec
 * calls). The Alpine provider is interesting because:
 *   - Its proot-distro alias is `alpine` (matches its name).
 *   - Its package manager is `apk`, not `apt` — the `update()` command
 *     should run `apk update && apk upgrade`.
 *   - Its min storage is the lowest of the four (800 MB) because the
 *     Alpine rootfs is the smallest (~80 MB extracted).
 *   - The musl libc caveat is documented in the `notes` field but does not
 *     change runtime behavior — the provider delegates to proot-distro
 *     identically to the glibc distros.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — shared with ubuntu.test.ts pattern
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const files = new Map<string, string>();
  const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

  let execImpl: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
    command: string;
  }> = async (cmd, args) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    failed: false,
    timedOut: false,
    command: [cmd, ...args].join(' '),
  });

  const exec = vi.fn(
    async (cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
      execCalls.push({ cmd, args, opts });
      return execImpl(cmd, args, opts);
    },
  );

  const setExecImpl = (fn: typeof execImpl): void => {
    execImpl = fn;
  };

  const ensureDir = vi.fn(async (p: string) => {
    files.set(p, '');
  });
  const exists = vi.fn(async (p: string) => files.has(p));
  const readFile = vi.fn(async (p: string) => {
    if (!files.has(p)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return files.get(p) ?? '';
  });
  const writeFile = vi.fn(async (p: string, data: string) => {
    files.set(p, data);
  });
  const rmrf = vi.fn(async (p: string) => {
    for (const k of Array.from(files.keys())) {
      if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    }
  });

  const sha256File = vi.fn(async () => 'c'.repeat(64));

  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
  };

  return {
    files,
    execCalls,
    exec,
    setExecImpl,
    ensureDir,
    exists,
    readFile,
    writeFile,
    rmrf,
    sha256File,
    logger,
    linuxifyHome: '/tmp/linuxify-test-alpine',
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  getLinuxifyHome: () => mocks.linuxifyHome,
}));

vi.mock('../../../src/utils/fs.js', () => ({
  ensureDir: mocks.ensureDir,
  exists: mocks.exists,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  rmrf: mocks.rmrf,
}));

vi.mock('../../../src/utils/crypto.js', () => ({
  sha256File: mocks.sha256File,
}));

vi.mock('../../../src/utils/log.js', () => ({ logger: mocks.logger }));

// ---------------------------------------------------------------------------
// SUT imports
// ---------------------------------------------------------------------------

import { DistroError } from '../../../src/utils/errors.js';
import { AlpineProvider } from '../../../src/distros/alpine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findCall(cmd: string, argContains?: string): typeof mocks.execCalls[number] | undefined {
  return mocks.execCalls.find(
    (c) => c.cmd === cmd && (argContains === undefined || c.args.some((a) => a.includes(argContains))),
  );
}

// ---------------------------------------------------------------------------

describe('AlpineProvider', () => {
  let provider: AlpineProvider;

  beforeEach(() => {
    mocks.files.clear();
    mocks.execCalls.length = 0;
    mocks.exec.mockClear();
    mocks.ensureDir.mockClear();
    mocks.exists.mockClear();
    mocks.readFile.mockClear();
    mocks.writeFile.mockClear();
    mocks.rmrf.mockClear();
    mocks.sha256File.mockClear();
    mocks.setExecImpl(async (cmd, args) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      failed: false,
      timedOut: false,
      command: [cmd, ...args].join(' '),
    }));
    mocks.linuxifyHome = '/tmp/linuxify-test-alpine';
    provider = new AlpineProvider();
  });

  // -------------------------------------------------------------------------
  // Static config — Alpine specifics
  // -------------------------------------------------------------------------

  describe('static config', () => {
    it('exposes the canonical name and alias', () => {
      expect(provider.name).toBe('alpine');
      expect(provider.displayName).toBe('Alpine 3.20');
    });

    it('uses 3.20 as the default version', () => {
      expect(provider.defaultVersion).toBe('3.20');
    });

    it('supports aarch64, armv7l, and x86_64', () => {
      expect([...provider.supportedArches]).toEqual(['aarch64', 'armv7l', 'x86_64']);
    });

    it('requires only 800 MB of free storage (smallest of the four built-ins)', () => {
      expect(provider.minStorageMb).toBe(800);
    });
  });

  // -------------------------------------------------------------------------
  // install — uses proot-distro alias `alpine`
  // -------------------------------------------------------------------------

  describe('install()', () => {
    it('runs `proot-distro install alpine` (alias matches name)', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout: 'Installed distributions:\n  alpine [/p/alpine]\n',
            stderr: '',
            failed: false,
            timedOut: false,
            command: 'proot-distro list',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          command: [cmd, ...args].join(' '),
        };
      });

      await provider.install({});

      const call = findCall('proot-distro', 'install');
      expect(call).toBeDefined();
      expect(call!.args).toEqual(['install', 'alpine']);
    });

    it('writes the installed marker with the alpine rootfs path', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout: 'Installed distributions:\n  alpine [/path/to/alpine-rootfs]\n',
            stderr: '',
            failed: false,
            timedOut: false,
            command: 'proot-distro list',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          command: [cmd, ...args].join(' '),
        };
      });

      await provider.install({});
      const [markerPath, content] = mocks.writeFile.mock.calls[0]!;
      expect(markerPath).toBe('/tmp/linuxify-test-alpine/distros/alpine/installed');
      const parsed = JSON.parse(content as string) as Record<string, unknown>;
      expect(parsed.rootfsPath).toBe('/path/to/alpine-rootfs');
    });

    it('passes the mirror override via DISTRO_MIRROR_ALPINE env var', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout: 'Installed distributions:\n  alpine [/p]\n',
            stderr: '',
            failed: false,
            timedOut: false,
            command: 'proot-distro list',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          command: [cmd, ...args].join(' '),
        };
      });

      await provider.install({ mirror: 'https://dl-cdn.alpinelinux.org/alpine/' });
      const call = findCall('proot-distro', 'install');
      const env = (call!.opts.env ?? {}) as Record<string, string>;
      expect(env.DISTRO_MIRROR_ALPINE).toBe('https://dl-cdn.alpinelinux.org/alpine/');
    });

    it('throws DistroError E_DISTRO_INSTALL_FAILED on non-zero exit', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'install') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'E: alpine download failed',
            failed: true,
            timedOut: false,
            command: 'proot-distro install alpine',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          command: [cmd, ...args].join(' '),
        };
      });

      await expect(provider.install({})).rejects.toThrow(DistroError);
      try {
        await provider.install({});
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_INSTALL_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // uninstall
  // -------------------------------------------------------------------------

  describe('uninstall()', () => {
    it('runs `proot-distro remove alpine`', async () => {
      await provider.uninstall();
      const call = findCall('proot-distro', 'remove');
      expect(call).toBeDefined();
      expect(call!.args).toEqual(['remove', 'alpine']);
    });
  });

  // -------------------------------------------------------------------------
  // exec — uses alias `alpine`
  // -------------------------------------------------------------------------

  describe('exec()', () => {
    it('composes `proot-distro login alpine --user linuxify -- bash -c <cmd>`', async () => {
      await provider.exec('apk', ['add', 'curl']);
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('login');
      expect(call!.args[1]).toBe('alpine');
      expect(call!.args).toContain('--user');
      expect(call!.args).toContain('linuxify');
      const bashIdx = call!.args.indexOf('bash');
      expect(bashIdx).toBeGreaterThan(-1);
      expect(call!.args[bashIdx - 1]).toBe('--');
      expect(call!.args[bashIdx + 1]).toBe('-c');
      const composed = call!.args[bashIdx + 2] as string;
      expect(composed).toMatch(/apk.*add.*curl/);
    });

    it('returns the captured stdout/stderr/exitCode', async () => {
      mocks.setExecImpl(async () => ({
        exitCode: 0,
        stdout: 'OK',
        stderr: '',
        failed: false,
        timedOut: false,
        command: 'proot-distro login alpine',
      }));
      const result = await provider.exec('apk', ['info']);
      expect(result).toEqual({ stdout: 'OK', stderr: '', exitCode: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // shell — uses alias `alpine`
  // -------------------------------------------------------------------------

  describe('shell()', () => {
    it('composes `proot-distro login alpine --user linuxify`', async () => {
      await provider.shell();
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('login');
      expect(call!.args[1]).toBe('alpine');
      // shell() must NOT append `-- bash -c ...` — proot-distro login
      // defaults to an interactive shell when no `--` trailer is given.
      expect(call!.args).not.toContain('bash');
    });

    it('uses stdio:inherit for interactive use', async () => {
      await provider.shell();
      const call = findCall('proot-distro', 'login');
      expect(call!.opts.stdio).toBe('inherit');
    });
  });

  // -------------------------------------------------------------------------
  // info
  // -------------------------------------------------------------------------

  describe('info()', () => {
    it('throws DistroError E_DISTRO_NOT_INSTALLED when no marker exists', async () => {
      mocks.exists.mockResolvedValue(false);
      await expect(provider.info()).rejects.toThrow(DistroError);
      try {
        await provider.info();
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_NOT_INSTALLED');
      }
    });

    it('returns the marker fields plus disk usage from `du -sm`', async () => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '3.20',
          arch: 'aarch64',
          rootfsPath: '/path/to/alpine-rootfs',
          rootfsSha256: 'c'.repeat(64),
        }),
      );
      mocks.setExecImpl(async (cmd) => {
        if (cmd === 'du') {
          return {
            exitCode: 0,
            stdout: '85\t/path/to/alpine-rootfs\n',
            stderr: '',
            failed: false,
            timedOut: false,
            command: 'du',
          };
        }
        return {
          exitCode: 0,
          stdout: '',
          stderr: '',
          failed: false,
          timedOut: false,
          command: '',
        };
      });

      const info = await provider.info();
      expect(info.name).toBe('alpine');
      expect(info.version).toBe('3.20');
      expect(info.arch).toBe('aarch64');
      expect(info.rootfsPath).toBe('/path/to/alpine-rootfs');
      expect(info.rootfsSha256).toBe('c'.repeat(64));
      expect(info.diskUsageMb).toBe(85);
    });
  });

  // -------------------------------------------------------------------------
  // update — uses apk (NOT apt)
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('runs `apk update && apk upgrade` as root', async () => {
      await provider.update();
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      const userIdx = call!.args.indexOf('--user');
      expect(call!.args[userIdx + 1]).toBe('root');
      const bashIdx = call!.args.indexOf('bash');
      const composed = call!.args[bashIdx + 2] as string;
      expect(composed).toContain('apk update');
      expect(composed).toContain('apk upgrade');
      // Must NOT contain apt — Alpine uses apk.
      expect(composed).not.toContain('apt-get');
    });

    it('throws DistroError E_DISTRO_UPDATE_FAILED when apk exits non-zero', async () => {
      mocks.setExecImpl(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'ERROR: Unable to lock apk database',
        failed: true,
        timedOut: false,
        command: 'proot-distro login alpine',
      }));
      await expect(provider.update()).rejects.toThrow(DistroError);
      try {
        await provider.update();
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_UPDATE_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // snapshot / restore
  // -------------------------------------------------------------------------

  describe('snapshot()', () => {
    beforeEach(() => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '3.20',
          arch: 'aarch64',
          rootfsPath: '/path/to/alpine-rootfs',
          rootfsSha256: 'c'.repeat(64),
        }),
      );
    });

    it('runs `tar --zstd -cpf <out> -C <parent> alpine-rootfs`', async () => {
      await provider.snapshot('pre-update');
      const call = findCall('tar');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('--zstd');
      expect(call!.args).toContain('-cpf');
      const outIdx = call!.args.indexOf('-cpf') + 1;
      expect(call!.args[outIdx]).toMatch(
        /\/tmp\/linuxify-test-alpine\/snapshots\/alpine\/pre-update\.tar\.zst$/,
      );
      const cIdx = call!.args.indexOf('-C');
      expect(call!.args[cIdx + 1]).toBe('/path/to');
      expect(call!.args[cIdx + 2]).toBe('alpine-rootfs');
    });

    it('returns the snapshot tarball path', async () => {
      const result = await provider.snapshot('baseline');
      expect(result).toMatch(/baseline\.tar\.zst$/);
    });
  });

  describe('restore()', () => {
    beforeEach(() => {
      mocks.exists.mockImplementation(async (p: string) => {
        return p.endsWith('.tar.zst') || p.endsWith('/installed');
      });
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '3.20',
          arch: 'aarch64',
          rootfsPath: '/path/to/alpine-rootfs',
          rootfsSha256: 'c'.repeat(64),
        }),
      );
    });

    it('runs `tar --zstd -xpf <snapshot> -C <parent>`', async () => {
      await provider.restore('/tmp/linuxify-test-alpine/snapshots/alpine/snap.tar.zst');
      const call = findCall('tar');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('--zstd');
      expect(call!.args).toContain('-xpf');
      const cIdx = call!.args.indexOf('-C');
      expect(call!.args[cIdx + 1]).toBe('/path/to');
    });

    it('removes the existing rootfs before extracting', async () => {
      await provider.restore('/tmp/snap.tar.zst');
      expect(mocks.rmrf).toHaveBeenCalledWith('/path/to/alpine-rootfs');
    });
  });
});
