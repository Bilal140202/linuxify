/**
 * Unit tests for `src/docker/detect.ts` — runtime detection (Podroid +
 * proot-distro Docker/Podman).
 *
 * Covers:
 *   - `detectPodroid()`:
 *     - Honors `LINUXIFY_PODROID_HOST` env var → probes SSH on host:9922.
 *       - SSH reachable → available=true, endpoint=`${host}:9922`.
 *       - SSH unreachable → available=false with the env-var hint.
 *     - When `~/.podroid/` exists → probes SSH on 127.0.0.1:9922.
 *       - SSH reachable → available=true.
 *       - SSH unreachable → available=false with the local hint.
 *     - When `podroid-forward` is on PATH → treats as detected.
 *     - When nothing is found → canonical "Podroid not detected" message.
 *   - `detectProotDistro(distro, 'docker')`:
 *     - Returns `available: false` when `which docker` exits non-zero.
 *     - Returns `available: true` when `which docker` + `docker --version` + `docker info` succeed.
 *     - Returns `available: false` ("daemon is not responding") when `docker info` fails.
 *   - `detectProotDistro(distro, 'podman')`:
 *     - Returns available when `which podman` + `podman --version` succeed (no daemon check).
 *   - `detectRuntime()`:
 *     - Honors `preferred: 'podroid'` (skips proot probes).
 *     - Honors `preferred: 'docker'`.
 *     - Auto-detect order: Podroid → docker → podman.
 *     - When nothing is available, returns the Podroid result.
 *     - When `distro` is null and Podroid unavailable, returns Podroid's unavailable result.
 *   - `detectRuntimeKind()`: returns kind when available, null otherwise.
 *   - `getDockerArch()`:
 *     - aarch64 → arm64, armv7l → arm/v7, x86_64 → amd64, unknown → unknown.
 *
 * Mocks `utils/process.js` (exec/getLinuxifyHome/isTermux/getArch),
 * `utils/fs.js` (exists), `utils/log.js`, and `node:net` (the SSH probe
 * Socket used by `probeSsh`).
 */

vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Captured exec calls: { cmd, args } in invocation order.
  const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

  // Default exec implementation — returns success with empty output.
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

  const exec = vi.fn(async (cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    execCalls.push({ cmd, args, opts });
    return execImpl(cmd, args, opts);
  });

  // Replace exec implementation.
  const setExecImpl = (
    fn: typeof execImpl,
  ): void => {
    execImpl = fn;
  };

  // `exists` mock: returns true if the path is in `existingPaths`.
  const existingPaths = new Set<string>();
  const exists = vi.fn(async (p: string) => existingPaths.has(p));

  // `getLinuxifyHome` mock.
  let linuxifyHome = '/tmp/linuxify-test-detect/.linuxify';

  // `isTermux` mock.
  let termux = false;

  // `getArch` mock.
  let arch: 'aarch64' | 'armv7l' | 'x86_64' | 'unknown' = 'aarch64';

  return {
    execCalls,
    exec,
    setExecImpl,
    existingPaths,
    exists,
    getLinuxifyHome: () => linuxifyHome,
    setLinuxifyHome: (p: string) => { linuxifyHome = p; },
    isTermux: () => termux,
    setTermux: (v: boolean) => { termux = v; },
    getArch: () => arch,
    setArch: (a: typeof arch) => { arch = a; },
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  getLinuxifyHome: mocks.getLinuxifyHome,
  isTermux: mocks.isTermux,
  getArch: mocks.getArch,
}));

vi.mock('../../../src/utils/fs.js', () => ({
  exists: mocks.exists,
}));

import { createServer as realCreateServer, type Server } from 'node:net';
import { join } from 'node:path';

import {
  detectPodroid,
  detectProotDistro,
  detectRuntime,
  detectRuntimeKind,
  getDockerArch,
} from '../../../src/docker/detect.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an exec result with the given fields. */
function result(opts: { exitCode?: number; stdout?: string; stderr?: string }): {
  exitCode: number;
  stdout: string;
  stderr: string;
  failed: boolean;
  timedOut: boolean;
  command: string;
} {
  const exitCode = opts.exitCode ?? 0;
  return {
    exitCode,
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    failed: exitCode !== 0,
    timedOut: false,
    command: '',
  };
}

/**
 * Bind a real TCP server on 127.0.0.1:9922 so `probeSsh` (which uses
 * a real node:net.Socket) succeeds. Returns a function that closes the
 * server. Safe to call repeatedly — reuses the existing server.
 *
 * The dynamic `import('node:net')` in `probeSsh` is NOT intercepted by
 * `vi.mock` for node built-ins, so we have to actually bind the port.
 * Port 9922 is the canonical Podroid SSH port and is unlikely to be in
 * use on a test/dev machine.
 */
let sshServer: Server | null = null;
async function bindSshPort(): Promise<void> {
  if (sshServer) return;
  sshServer = realCreateServer();
  await new Promise<void>((resolve, reject) => {
    sshServer!.once('listening', resolve);
    sshServer!.once('error', reject);
    sshServer!.listen(9922, '127.0.0.1');
  });
}

async function unbindSshPort(): Promise<void> {
  if (!sshServer) return;
  await new Promise<void>((resolve) => {
    sshServer!.close(() => { resolve(); });
    sshServer = null;
  });
}

beforeEach(async () => {
  mocks.execCalls.length = 0;
  mocks.exec.mockClear();
  mocks.exists.mockClear();
  mocks.existingPaths.clear();
  mocks.setLinuxifyHome('/tmp/linuxify-test-detect/.linuxify');
  mocks.setTermux(false);
  mocks.setArch('aarch64');
  mocks.setExecImpl(async (cmd, args) => result({ exitCode: 0, stdout: '', stderr: '' }));
  delete process.env.LINUXIFY_PODROID_HOST;
  await unbindSshPort();
});

afterEach(async () => {
  await unbindSshPort();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docker/detect — detectPodroid', () => {
  describe('LINUXIFY_PODROID_HOST env override', () => {
    it('probes SSH on the configured host:9922 and returns available=true when reachable', async () => {
      process.env.LINUXIFY_PODROID_HOST = '127.0.0.1';
      await bindSshPort();
      const info = await detectPodroid();
      expect(info.available).toBe(true);
      expect(info.endpoint).toBe('127.0.0.1:9922');
      expect(info.kind).toBe('podroid');
    });

    it('returns available=false with the env-var hint when SSH is not reachable', async () => {
      process.env.LINUXIFY_PODROID_HOST = '127.0.0.1';
      // No bindSshPort() — port 9922 not bound.
      const info = await detectPodroid();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toContain('LINUXIFY_PODROID_HOST=127.0.0.1');
      expect(info.endpoint).toBe('127.0.0.1:9922');
    });
  });

  describe('~/.podroid/ directory probe', () => {
    it('probes SSH on 127.0.0.1:9922 when ~/.podroid/ exists and SSH is reachable', async () => {
      mocks.existingPaths.add(join(mocks.getLinuxifyHome(), '..', '.podroid'));
      await bindSshPort();
      const info = await detectPodroid();
      expect(info.available).toBe(true);
      expect(info.endpoint).toBe('127.0.0.1:9922');
    });

    it('returns available=false with the local SSH hint when SSH is not reachable', async () => {
      mocks.existingPaths.add(join(mocks.getLinuxifyHome(), '..', '.podroid'));
      // No bindSshPort() — port 9922 not bound.
      const info = await detectPodroid();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toContain('127.0.0.1:9922');
    });
  });

  describe('podroid-forward on PATH', () => {
    it('treats Podroid as detected when `which podroid-forward` exits 0 and SSH is reachable', async () => {
      mocks.setExecImpl(async (cmd, args) => {
        if (cmd === 'which' && args[0] === 'podroid-forward') {
          return result({ exitCode: 0, stdout: '/data/data/com.termux/files/usr/bin/podroid-forward\n' });
        }
        return result({});
      });
      await bindSshPort();
      const info = await detectPodroid();
      expect(info.available).toBe(true);
      expect(info.binaryPath).toContain('podroid-forward');
    });
  });

  it('returns the canonical "Podroid not detected" reason when nothing is found', async () => {
    // Ensure `which podroid-forward` does NOT succeed (no marker found).
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which') return result({ exitCode: 1 });
      return result({});
    });
    const info = await detectPodroid();
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain('Podroid not detected');
    expect(info.unavailableReason).toContain('https://github.com/ExTV/Podroid');
  });
});

describe('docker/detect — detectProotDistro (docker)', () => {
  it('returns available=false when `which docker` exits non-zero', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      // The first proot-distro login call probes `which docker`.
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 1, stdout: '', stderr: 'not found' });
      }
      return result({});
    });
    const info = await detectProotDistro('ubuntu', 'docker');
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain("docker is not installed in the 'ubuntu' proot-distro");
  });

  it('returns available=true when `which docker` + `docker --version` + `docker info` all succeed', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/docker\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'Docker version 29.5.3, build 8a3руют\n' });
      }
      if (cmd === 'proot-distro' && args.includes('info')) {
        return result({ exitCode: 0, stdout: '29.5.3\n' });
      }
      return result({});
    });
    const info = await detectProotDistro('ubuntu', 'docker');
    expect(info.available).toBe(true);
    expect(info.kind).toBe('docker');
    expect(info.version).toContain('Docker');
    expect(info.endpoint).toBe('ubuntu');
    expect(info.binaryPath).toBe('/usr/bin/docker');
  });

  it('returns available=false "daemon is not responding" when `docker info` fails', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/docker\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'Docker version 29.5.3\n' });
      }
      if (cmd === 'proot-distro' && args.includes('info')) {
        return result({ exitCode: 1, stdout: '', stderr: 'daemon not running' });
      }
      return result({});
    });
    const info = await detectProotDistro('ubuntu', 'docker');
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain("daemon is not responding");
  });

  it('returns available=false when distro is null', async () => {
    const info = await detectProotDistro(null, 'docker');
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain('No active proot-distro');
  });
});

describe('docker/detect — detectProotDistro (podman)', () => {
  it('returns available=true when `which podman` + `podman --version` succeed (no daemon check)', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/podman\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'podman version 5.0.0\n' });
      }
      return result({});
    });
    const info = await detectProotDistro('ubuntu', 'podman');
    expect(info.available).toBe(true);
    expect(info.kind).toBe('podman');
    expect(info.version).toContain('podman');
  });

  it('returns available=false when `which podman` exits non-zero', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 1 });
      }
      return result({});
    });
    const info = await detectProotDistro('ubuntu', 'podman');
    expect(info.available).toBe(false);
    expect(info.unavailableReason).toContain("podman is not installed in the 'ubuntu' proot-distro");
  });
});

describe('docker/detect — detectRuntime (preferred)', () => {
  it('honors preferred="podroid" (skips proot-distro probes)', async () => {
    // Podroid SSH not up — but with preferred=podroid we should still only
    // call detectPodroid and not shell into proot-distro.
    const info = await detectRuntime('ubuntu', 'podroid');
    expect(info.kind).toBe('podroid');
    // Should not have called proot-distro login.
    const prootCalls = mocks.execCalls.filter((c) => c.cmd === 'proot-distro');
    expect(prootCalls.length).toBe(0);
  });

  it('honors preferred="docker"', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/docker\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'Docker version 29.5.3\n' });
      }
      if (cmd === 'proot-distro' && args.includes('info')) {
        return result({ exitCode: 0, stdout: '29.5.3\n' });
      }
      return result({});
    });
    const info = await detectRuntime('ubuntu', 'docker');
    expect(info.kind).toBe('docker');
    expect(info.available).toBe(true);
  });

  it('honors preferred="podman"', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/podman\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'podman version 5.0.0\n' });
      }
      return result({});
    });
    const info = await detectRuntime('ubuntu', 'podman');
    expect(info.kind).toBe('podman');
    expect(info.available).toBe(true);
  });
});

describe('docker/detect — detectRuntime (auto)', () => {
  it('prefers Podroid when SSH is reachable', async () => {
    // Need a Podroid marker so probeSsh is invoked.
    mocks.existingPaths.add(join(mocks.getLinuxifyHome(), '..', '.podroid'));
    await bindSshPort();
    const info = await detectRuntime('ubuntu');
    expect(info.kind).toBe('podroid');
    expect(info.available).toBe(true);
  });

  it('falls back to docker in proot when Podroid SSH is not reachable', async () => {
    // No Podroid marker — Podroid probe falls through immediately.
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'proot-distro' && args.includes('which')) {
        return result({ exitCode: 0, stdout: '/usr/bin/docker\n' });
      }
      if (cmd === 'proot-distro' && args.includes('--version')) {
        return result({ exitCode: 0, stdout: 'Docker version 29.5.3\n' });
      }
      if (cmd === 'proot-distro' && args.includes('info')) {
        return result({ exitCode: 0, stdout: '29.5.3\n' });
      }
      return result({});
    });
    const info = await detectRuntime('ubuntu');
    expect(info.kind).toBe('docker');
    expect(info.available).toBe(true);
  });

  it('returns the Podroid result when nothing is available', async () => {
    // No Podroid marker + `which podroid-forward` fails + proot exits 1.
    mocks.setExecImpl(async (cmd) => {
      if (cmd === 'which') return result({ exitCode: 1 });
      return result({ exitCode: 1 });
    });
    const info = await detectRuntime('ubuntu');
    expect(info.available).toBe(false);
    expect(info.kind).toBe('podroid'); // Podroid's unavailable reason is the actionable one
  });

  it('returns Podroid\'s unavailable result when distro is null and Podroid is unavailable', async () => {
    mocks.setExecImpl(async (cmd) => {
      if (cmd === 'which') return result({ exitCode: 1 });
      return result({});
    });
    const info = await detectRuntime(null);
    expect(info.available).toBe(false);
    expect(info.kind).toBe('podroid');
    expect(info.unavailableReason).toContain('Podroid not detected');
  });
});

describe('docker/detect — detectRuntimeKind', () => {
  it('returns the kind string when available', async () => {
    mocks.existingPaths.add(join(mocks.getLinuxifyHome(), '..', '.podroid'));
    await bindSshPort();
    const kind = await detectRuntimeKind('ubuntu');
    expect(kind).toBe('podroid');
  });

  it('returns null when unavailable', async () => {
    mocks.setExecImpl(async (cmd) => {
      if (cmd === 'which') return result({ exitCode: 1 });
      return result({ exitCode: 1 });
    });
    const kind = await detectRuntimeKind('ubuntu');
    expect(kind).toBeNull();
  });
});

describe('docker/detect — getDockerArch', () => {
  it('maps aarch64 → arm64', () => {
    mocks.setArch('aarch64');
    expect(getDockerArch()).toBe('arm64');
  });

  it('maps armv7l → arm/v7', () => {
    mocks.setArch('armv7l');
    expect(getDockerArch()).toBe('arm/v7');
  });

  it('maps x86_64 → amd64', () => {
    mocks.setArch('x86_64');
    expect(getDockerArch()).toBe('amd64');
  });

  it('maps unknown → unknown', () => {
    mocks.setArch('unknown');
    expect(getDockerArch()).toBe('unknown');
  });
});
