/**
 * Unit tests for `src/distros/ubuntu.ts` (UbuntuProvider).
 *
 * All subprocess calls are mocked via `vi.mock('../../../src/utils/process.js')`
 * so no real `proot-distro` is invoked. The tests verify:
 *   - The provider calls `proot-distro install ubuntu` with the right args.
 *   - exec() composes `proot-distro login ubuntu --user linuxify -- bash -c '<cmd>'`.
 *   - shell() composes `proot-distro login ubuntu --user linuxify`.
 *   - uninstall() calls `proot-distro remove ubuntu`.
 *   - info() reads the marker file and returns the expected DistroInfo.
 *   - update() runs `apt-get update && apt-get upgrade -y` as root.
 *   - snapshot() runs `tar --zstd -cpf <out> -C <parent> ubuntu`.
 *   - restore() runs `tar --zstd -xpf <snapshot> -C <parent>`.
 *   - Failures throw DistroError with the appropriate `E_DISTRO_*` code.
 *
 * The filesystem helpers (ensureDir/exists/readFile/writeFile/rmrf) are also
 * mocked with an in-memory Map so tests are deterministic and don't touch
 * the real `~/.linuxify/` directory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared via vi.hoisted so the vi.mock factories can reference them.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  /** In-memory filesystem: path → contents (string for files, undefined for dirs). */
  const files = new Map<string, string>();

  /** Captured exec calls: { cmd, args, opts } in invocation order. */
  const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

  /** Default implementation for exec — returns success with empty output. */
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

  /** Replace the exec implementation (used to simulate proot-distro failures). */
  const setExecImpl = (
    fn: typeof execImpl,
  ): void => {
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
    // Also remove any nested paths under p (mimics recursive rm).
    for (const k of Array.from(files.keys())) {
      if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    }
  });

  const sha256File = vi.fn(async () => 'a'.repeat(64));

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
    // Linuxify home override — tests set this to a tmp path.
    linuxifyHome: '/tmp/linuxify-test-ubuntu',
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
// SUT imports (after mocks are in place)
// ---------------------------------------------------------------------------

import { DistroError } from '../../../src/utils/errors.js';
import { UbuntuProvider } from '../../../src/distros/ubuntu.js';
import { composeShellCommand } from '../../../src/distros/proot-base.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the first captured exec call that matches `cmd` and an arg substring. */
function findCall(cmd: string, argContains?: string): typeof mocks.execCalls[number] | undefined {
  return mocks.execCalls.find(
    (c) => c.cmd === cmd && (argContains === undefined || c.args.some((a) => a.includes(argContains))),
  );
}

/** Return all captured exec calls matching `cmd`. */
function callsTo(cmd: string): typeof mocks.execCalls {
  return mocks.execCalls.filter((c) => c.cmd === cmd);
}

// ---------------------------------------------------------------------------

describe('UbuntuProvider', () => {
  let provider: UbuntuProvider;

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
    mocks.linuxifyHome = '/tmp/linuxify-test-ubuntu';
    provider = new UbuntuProvider();
  });

  // -------------------------------------------------------------------------
  // Static config
  // -------------------------------------------------------------------------

  describe('static config', () => {
    it('exposes the canonical name and alias', () => {
      expect(provider.name).toBe('ubuntu');
      expect(provider.displayName).toBe('Ubuntu 24.04 LTS');
    });

    it('uses 24.04 as the default version', () => {
      expect(provider.defaultVersion).toBe('24.04');
    });

    it('supports aarch64, armv7l, and x86_64', () => {
      expect([...provider.supportedArches]).toEqual(['aarch64', 'armv7l', 'x86_64']);
    });

    it('requires at least 1500 MB of free storage', () => {
      expect(provider.minStorageMb).toBe(1500);
    });
  });

  // -------------------------------------------------------------------------
  // isInstalled
  // -------------------------------------------------------------------------

  describe('isInstalled()', () => {
    it('returns false when the installed marker is absent', async () => {
      mocks.exists.mockResolvedValue(false);
      expect(await provider.isInstalled()).toBe(false);
    });

    it('returns true when the installed marker is present', async () => {
      mocks.exists.mockResolvedValue(true);
      expect(await provider.isInstalled()).toBe(true);
    });

    it('checks the marker path under ~/.linuxify/distros/ubuntu/installed', async () => {
      mocks.exists.mockResolvedValue(false);
      await provider.isInstalled();
      expect(mocks.exists).toHaveBeenCalledWith(
        '/tmp/linuxify-test-ubuntu/distros/ubuntu/installed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // install
  // -------------------------------------------------------------------------

  describe('install()', () => {
    it('runs `proot-distro install ubuntu`', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout:
              'Installed distributions:\n  ubuntu [/path/to/rootfs/ubuntu]\n',
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

      const installCall = findCall('proot-distro');
      expect(installCall).toBeDefined();
      expect(installCall!.args).toEqual(['install', 'ubuntu']);
    });

    it('throws DistroError E_DISTRO_INSTALL_FAILED when proot-distro exits non-zero', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'install') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'E: download failed',
            failed: true,
            timedOut: false,
            command: 'proot-distro install ubuntu',
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
        expect(err.message).toContain('proot-distro install ubuntu failed');
      }
    });

    it('writes the installed marker after a successful install', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout:
              'Installed distributions:\n  ubuntu [/path/to/rootfs/ubuntu]\n',
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

      await provider.install({ version: '24.04', arch: 'aarch64' });

      expect(mocks.writeFile).toHaveBeenCalled();
      const [markerPath, markerContent] = mocks.writeFile.mock.calls[0]!;
      expect(markerPath).toBe('/tmp/linuxify-test-ubuntu/distros/ubuntu/installed');
      const parsed = JSON.parse(markerContent as string) as Record<string, unknown>;
      expect(parsed.version).toBe('24.04');
      expect(parsed.arch).toBe('aarch64');
      expect(parsed.rootfsPath).toBe('/path/to/rootfs/ubuntu');
      expect(parsed.rootfsSha256).toBe('a'.repeat(64));
      expect(typeof parsed.installedAt).toBe('string');
    });

    it('passes the mirror override via DISTRO_MIRROR_UBUNTU env var', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout: 'Installed distributions:\n  ubuntu [/p]\n',
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

      await provider.install({ mirror: 'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-base/' });

      const installCall = findCall('proot-distro', 'install');
      const env = (installCall!.opts.env ?? {}) as Record<string, string>;
      expect(env.DISTRO_MIRROR_UBUNTU).toBe('https://mirrors.tuna.tsinghua.edu.cn/ubuntu-base/');
    });

    it('invokes onProgress with status messages', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'list') {
          return {
            exitCode: 0,
            stdout: 'Installed distributions:\n  ubuntu [/p]\n',
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

      const progress = vi.fn();
      await provider.install({ onProgress: progress });
      expect(progress).toHaveBeenCalled();
      // At least one progress message should mention 'install' or 'ubuntu'.
      const messages = progress.mock.calls.map((c) => c[0] as string);
      expect(messages.some((m) => /install|ubuntu/i.test(m))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // uninstall
  // -------------------------------------------------------------------------

  describe('uninstall()', () => {
    it('runs `proot-distro remove ubuntu`', async () => {
      await provider.uninstall();
      const call = findCall('proot-distro', 'remove');
      expect(call).toBeDefined();
      expect(call!.args).toEqual(['remove', 'ubuntu']);
    });

    it('throws DistroError E_DISTRO_UNINSTALL_FAILED on non-zero exit', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'proot-distro' && args[0] === 'remove') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'E: distro not installed',
            failed: true,
            timedOut: false,
            command: 'proot-distro remove ubuntu',
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
      await expect(provider.uninstall()).rejects.toThrow(DistroError);
      try {
        await provider.uninstall();
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_UNINSTALL_FAILED');
      }
    });

    it('removes the installed marker after a successful uninstall', async () => {
      mocks.files.set('/tmp/linuxify-test-ubuntu/distros/ubuntu/installed', '{}');
      await provider.uninstall();
      expect(mocks.rmrf).toHaveBeenCalledWith(
        '/tmp/linuxify-test-ubuntu/distros/ubuntu/installed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  describe('start()', () => {
    it('is a no-op (resolves without invoking proot-distro)', async () => {
      await provider.start();
      expect(callsTo('proot-distro')).toEqual([]);
    });
  });

  describe('stop()', () => {
    it('best-effort kills lingering proot processes for ubuntu', async () => {
      await provider.stop();
      const call = findCall('pkill');
      expect(call).toBeDefined();
      expect(call!.args).toContain('-f');
      expect(call!.args.some((a) => a.includes('proot'))).toBe(true);
      expect(call!.args.some((a) => a.includes('ubuntu'))).toBe(true);
    });

    it('does not throw if pkill fails (best-effort)', async () => {
      mocks.setExecImpl(async () => {
        throw new Error('pkill not found');
      });
      await expect(provider.stop()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // exec
  // -------------------------------------------------------------------------

  describe('exec()', () => {
    it('composes `proot-distro login ubuntu --user linuxify -- bash -c <cmd>`', async () => {
      await provider.exec('echo', ['hello']);
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('login');
      expect(call!.args[1]).toBe('ubuntu');
      expect(call!.args).toContain('--user');
      expect(call!.args).toContain('linuxify');
      const bashIdx = call!.args.indexOf('bash');
      expect(bashIdx).toBeGreaterThan(-1);
      expect(call!.args[bashIdx - 1]).toBe('--');
      expect(call!.args[bashIdx + 1]).toBe('-c');
      const composed = call!.args[bashIdx + 2] as string;
      expect(composed).toMatch(/echo.*hello/);
    });

    it('returns the captured stdout/stderr/exitCode', async () => {
      mocks.setExecImpl(async () => ({
        exitCode: 0,
        stdout: 'captured-out',
        stderr: 'captured-err',
        failed: false,
        timedOut: false,
        command: 'proot-distro login ubuntu',
      }));
      const result = await provider.exec('echo', ['hi']);
      expect(result).toEqual({
        stdout: 'captured-out',
        stderr: 'captured-err',
        exitCode: 0,
      });
    });

    it('honors a custom user via ExecOpts.user', async () => {
      await provider.exec('whoami', [], { user: 'root' });
      const call = findCall('proot-distro', 'login');
      const userIdx = call!.args.indexOf('--user');
      expect(call!.args[userIdx + 1]).toBe('root');
    });

    it('passes env vars via --env KEY=VALUE', async () => {
      await provider.exec('printenv', ['FOO'], { env: { FOO: 'bar' } });
      const call = findCall('proot-distro', 'login');
      const envIdx = call!.args.indexOf('--env');
      expect(envIdx).toBeGreaterThan(-1);
      expect(call!.args[envIdx + 1]).toBe('FOO=bar');
    });

    it('passes cwd via --cwd', async () => {
      await provider.exec('pwd', [], { cwd: '/home/linuxify' });
      const call = findCall('proot-distro', 'login');
      const cwdIdx = call!.args.indexOf('--cwd');
      expect(cwdIdx).toBeGreaterThan(-1);
      expect(call!.args[cwdIdx + 1]).toBe('/home/linuxify');
    });

    it('passes timeoutMs through to exec', async () => {
      await provider.exec('sleep', ['1'], { timeoutMs: 5000 });
      const call = findCall('proot-distro', 'login');
      expect(call!.opts.timeoutMs).toBe(5000);
    });

    it('shell-quotes args containing spaces', async () => {
      await provider.exec('echo', ['hello world']);
      const call = findCall('proot-distro', 'login');
      const bashIdx = call!.args.indexOf('bash');
      const composed = call!.args[bashIdx + 2] as string;
      // The composed string should contain 'hello world' (single-quoted).
      expect(composed).toContain("'hello world'");
    });

    it('uses the composeShellCommand helper for arg composition', () => {
      // Verify the exported helper produces the expected shape.
      const composed = composeShellCommand('echo', ['hello', 'world']);
      expect(composed).toBe('echo hello world');
    });
  });

  // -------------------------------------------------------------------------
  // shell
  // -------------------------------------------------------------------------

  describe('shell()', () => {
    it('composes `proot-distro login ubuntu --user linuxify`', async () => {
      await provider.shell();
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('login');
      expect(call!.args[1]).toBe('ubuntu');
      expect(call!.args).toContain('--user');
      expect(call!.args).toContain('linuxify');
      // shell() should NOT append `-- bash -c ...` — proot-distro login
      // defaults to an interactive shell when no `--` trailer is given.
      expect(call!.args).not.toContain('bash');
    });

    it('uses stdio:inherit for interactive use', async () => {
      await provider.shell();
      const call = findCall('proot-distro', 'login');
      expect(call!.opts.stdio).toBe('inherit');
    });

    it('honors a custom user via ShellOpts.user', async () => {
      await provider.shell({ user: 'root' });
      const call = findCall('proot-distro', 'login');
      const userIdx = call!.args.indexOf('--user');
      expect(call!.args[userIdx + 1]).toBe('root');
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

    it('returns the marker fields plus disk usage', async () => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '24.04',
          arch: 'aarch64',
          rootfsPath: '/path/to/rootfs/ubuntu',
          rootfsSha256: 'a'.repeat(64),
        }),
      );
      mocks.setExecImpl(async (cmd) => {
        if (cmd === 'du') {
          return {
            exitCode: 0,
            stdout: '350\t/path/to/rootfs/ubuntu\n',
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
      expect(info).toEqual({
        name: 'ubuntu',
        version: '24.04',
        arch: 'aarch64',
        installedAt: '2025-01-01T00:00:00.000Z',
        rootfsPath: '/path/to/rootfs/ubuntu',
        rootfsSha256: 'a'.repeat(64),
        diskUsageMb: 350,
      });
    });

    it('returns 0 for diskUsageMb when du fails', async () => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '24.04',
          arch: 'aarch64',
          rootfsPath: '/p',
          rootfsSha256: 'a'.repeat(64),
        }),
      );
      mocks.setExecImpl(async (cmd) => {
        if (cmd === 'du') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'du: cannot access',
            failed: true,
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
      expect(info.diskUsageMb).toBe(0);
    });

    it('throws DistroError E_DISTRO_MARKER_CORRUPT when the marker is unparseable', async () => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue('not valid json {{{');
      await expect(provider.info()).rejects.toThrow(DistroError);
      try {
        await provider.info();
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_MARKER_CORRUPT');
      }
    });
  });

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('runs `apt-get update && apt-get upgrade -y` as root', async () => {
      await provider.update();
      const call = findCall('proot-distro', 'login');
      expect(call).toBeDefined();
      // update() runs as root so it can write to /var/lib/apt/.
      const userIdx = call!.args.indexOf('--user');
      expect(call!.args[userIdx + 1]).toBe('root');
      const bashIdx = call!.args.indexOf('bash');
      const composed = call!.args[bashIdx + 2] as string;
      expect(composed).toContain('apt-get update');
      expect(composed).toContain('apt-get upgrade -y');
    });

    it('throws DistroError E_DISTRO_UPDATE_FAILED when apt exits non-zero', async () => {
      mocks.setExecImpl(async () => ({
        exitCode: 100,
        stdout: '',
        stderr: 'E: Unable to lock dpkg status',
        failed: true,
        timedOut: false,
        command: 'proot-distro login',
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
  // snapshot
  // -------------------------------------------------------------------------

  describe('snapshot()', () => {
    beforeEach(() => {
      mocks.exists.mockResolvedValue(true);
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '24.04',
          arch: 'aarch64',
          rootfsPath: '/path/to/rootfs/ubuntu',
          rootfsSha256: 'a'.repeat(64),
        }),
      );
    });

    it('throws E_DISTRO_NOT_INSTALLED when no marker exists', async () => {
      mocks.exists.mockResolvedValue(false);
      await expect(provider.snapshot('pre-install')).rejects.toThrow(DistroError);
      try {
        await provider.snapshot('pre-install');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_NOT_INSTALLED');
      }
    });

    it('runs `tar --zstd -cpf <out> -C <parent> ubuntu`', async () => {
      await provider.snapshot('pre-cline');
      const call = findCall('tar');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('--zstd');
      expect(call!.args).toContain('-cpf');
      // The output path should be under ~/.linuxify/snapshots/ubuntu/.
      const outIdx = call!.args.indexOf('-cpf') + 1;
      expect(call!.args[outIdx]).toMatch(
        /\/tmp\/linuxify-test-ubuntu\/snapshots\/ubuntu\/pre-cline\.tar\.zst$/,
      );
      // -C <parent> <basename>
      const cIdx = call!.args.indexOf('-C');
      expect(call!.args[cIdx + 1]).toBe('/path/to/rootfs');
      expect(call!.args[cIdx + 2]).toBe('ubuntu');
    });

    it('returns the snapshot tarball path', async () => {
      const result = await provider.snapshot('pre-cline');
      expect(result).toMatch(
        /\/tmp\/linuxify-test-ubuntu\/snapshots\/ubuntu\/pre-cline\.tar\.zst$/,
      );
    });

    it('sanitizes the snapshot name (replaces / and spaces with _)', async () => {
      const result = await provider.snapshot('pre cline/v2');
      expect(result).toMatch(/pre_cline_v2\.tar\.zst$/);
    });

    it('rejects an empty name with E_DISTRO_SNAPSHOT_INVALID_NAME', async () => {
      await expect(provider.snapshot('///')).rejects.toThrow(DistroError);
      try {
        await provider.snapshot('///');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_SNAPSHOT_INVALID_NAME');
      }
    });

    it('throws E_DISTRO_SNAPSHOT_FAILED when tar exits non-zero', async () => {
      mocks.setExecImpl(async (cmd) => {
        if (cmd === 'tar') {
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'tar: cannot open',
            failed: true,
            timedOut: false,
            command: 'tar',
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
      await expect(provider.snapshot('pre-cline')).rejects.toThrow(DistroError);
      try {
        await provider.snapshot('pre-cline');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_SNAPSHOT_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // restore
  // -------------------------------------------------------------------------

  describe('restore()', () => {
    beforeEach(() => {
      mocks.exists.mockImplementation(async (p: string) => {
        // Snapshot file exists; marker exists.
        return p.endsWith('.tar.zst') || p.endsWith('/installed');
      });
      mocks.readFile.mockResolvedValue(
        JSON.stringify({
          installedAt: '2025-01-01T00:00:00.000Z',
          version: '24.04',
          arch: 'aarch64',
          rootfsPath: '/path/to/rootfs/ubuntu',
          rootfsSha256: 'a'.repeat(64),
        }),
      );
    });

    it('throws E_DISTRO_RESTORE_SNAPSHOT_MISSING when the snapshot file is absent', async () => {
      mocks.exists.mockResolvedValue(false);
      await expect(provider.restore('/nope.tar.zst')).rejects.toThrow(DistroError);
      try {
        await provider.restore('/nope.tar.zst');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_RESTORE_SNAPSHOT_MISSING');
      }
    });

    it('runs `tar --zstd -xpf <snapshot> -C <parent>`', async () => {
      await provider.restore('/tmp/linuxify-test-ubuntu/snapshots/ubuntu/snap.tar.zst');
      const call = findCall('tar');
      expect(call).toBeDefined();
      expect(call!.args[0]).toBe('--zstd');
      expect(call!.args).toContain('-xpf');
      expect(call!.args).toContain('/tmp/linuxify-test-ubuntu/snapshots/ubuntu/snap.tar.zst');
      const cIdx = call!.args.indexOf('-C');
      expect(call!.args[cIdx + 1]).toBe('/path/to/rootfs');
    });

    it('removes the existing rootfs before extracting', async () => {
      await provider.restore('/tmp/snap.tar.zst');
      expect(mocks.rmrf).toHaveBeenCalledWith('/path/to/rootfs/ubuntu');
    });

    it('throws E_DISTRO_RESTORE_FAILED when tar exits non-zero', async () => {
      mocks.setExecImpl(async (cmd) => {
        if (cmd === 'tar') {
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'tar: corrupted archive',
            failed: true,
            timedOut: false,
            command: 'tar',
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
      await expect(provider.restore('/tmp/snap.tar.zst')).rejects.toThrow(DistroError);
      try {
        await provider.restore('/tmp/snap.tar.zst');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_RESTORE_FAILED');
      }
    });

    it('refreshes the marker rootfsSha256 after a successful restore', async () => {
      mocks.sha256File.mockResolvedValue('b'.repeat(64));
      await provider.restore('/tmp/snap.tar.zst');
      expect(mocks.writeFile).toHaveBeenCalled();
      const [, content] = mocks.writeFile.mock.calls[0]!;
      const parsed = JSON.parse(content as string) as Record<string, unknown>;
      expect(parsed.rootfsSha256).toBe('b'.repeat(64));
    });
  });
});
