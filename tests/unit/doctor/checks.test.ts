/**
 * Unit tests for the doctor checks in `src/doctor/checks/`.
 *
 * Covers four representative checks (one per major category shape):
 *
 *   - `host.arch` — pure function of `getArch()`; no I/O. Tests the
 *     supported/unsupported-arch decision branch.
 *   - `runtime.node` — shells out via `exec('node', ['--version'])`. Tests
 *     the parsing of `v22.11.0` into a major version and the version-floor
 *     comparison.
 *   - `bootstrap.completed` — pure function of `ctx.state`. Tests the
 *     "all 9 stages present" decision.
 *   - `path.linuxify_bin` — pure function of `process.env.PATH` and
 *     `getLinuxifyHome()`. Tests the PATH-membership check.
 *
 * All external dependencies (`utils/process`, `utils/fs`, `utils/log`) are
 * mocked via `vi.mock` so no real subprocess or filesystem I/O occurs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared via `vi.hoisted` so they are available to the hoisted
// `vi.mock` factories.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const exec = vi.fn();
  const getArch = vi.fn<() => string>();
  const getLinuxifyHome = vi.fn<() => string>();
  const isTermux = vi.fn<() => boolean>();
  const isAndroid = vi.fn<() => boolean>();
  const getTermuxPrefix = vi.fn<() => string>();
  const exists = vi.fn<(p: string) => Promise<boolean>>();
  const isReachable = vi.fn<(url: string, opts?: unknown) => Promise<boolean>>();
  return { exec, getArch, getLinuxifyHome, isTermux, isAndroid, getTermuxPrefix, exists, isReachable };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  getArch: mocks.getArch,
  getLinuxifyHome: mocks.getLinuxifyHome,
  isTermux: mocks.isTermux,
  isAndroid: mocks.isAndroid,
  getTermuxPrefix: mocks.getTermuxPrefix,
  execOrThrow: vi.fn(),
  getEnv: vi.fn(),
  getPlatform: vi.fn(() => 'linux'),
  getDefaultUserAgent: vi.fn(() => 'linuxify/test'),
  sleep: vi.fn(),
}));

vi.mock('../../../src/utils/fs.js', () => ({
  exists: mocks.exists,
  ensureDir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../../../src/utils/net.js', () => ({
  isReachable: mocks.isReachable,
  download: vi.fn(),
  fetchJson: vi.fn(),
}));

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
// SUT imports — after mocks are registered.
// ---------------------------------------------------------------------------

import { hostArchCheck } from '../../../src/doctor/checks/host-arch.js';
import { runtimeNodeCheck } from '../../../src/doctor/checks/runtime-node.js';
import { bootstrapCompletedCheck } from '../../../src/doctor/checks/bootstrap-completed.js';
import { pathLinuxifyBinCheck } from '../../../src/doctor/checks/path-linuxify-bin.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { defaultState } from '../../../src/state/store.js';
import type { DoctorContext } from '../../../src/doctor/types.js';

const { exec: mockExec, getArch: mockGetArch, getLinuxifyHome: mockGetLinuxifyHome } = mocks;

/** Build a DoctorContext with the default config and an empty state. */
function makeCtx(): DoctorContext {
  return {
    config: DEFAULT_CONFIG,
    state: defaultState(),
  };
}

/** Set process.env.PATH to a colon-separated list of entries. */
function setPath(entries: string[]): void {
  process.env.PATH = entries.join(':');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doctor/checks — host.arch', () => {
  beforeEach(() => {
    mockGetArch.mockReturnValue('aarch64');
  });

  it('passes for aarch64', async () => {
    mockGetArch.mockReturnValue('aarch64');
    const r = await hostArchCheck.run(makeCtx());
    expect(r.status).toBe('ok');
    expect(r.message).toContain('aarch64');
    expect(r.detail).toMatchObject({ arch: 'aarch64' });
    expect(r.fixCommand).toBeUndefined();
  });

  it('passes for armv7l', async () => {
    mockGetArch.mockReturnValue('armv7l');
    const r = await hostArchCheck.run(makeCtx());
    expect(r.status).toBe('ok');
  });

  it('passes for x86_64', async () => {
    mockGetArch.mockReturnValue('x86_64');
    const r = await hostArchCheck.run(makeCtx());
    expect(r.status).toBe('ok');
  });

  it('fails for unknown arch with a fixCommand', async () => {
    mockGetArch.mockReturnValue('mips');
    const r = await hostArchCheck.run(makeCtx());
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/Unsupported architecture 'mips'/);
    expect(r.fixCommand).toBeDefined();
    expect(r.fixDocs).toBeDefined();
  });

  it('has the correct id, name, and category', () => {
    expect(hostArchCheck.id).toBe('host.arch');
    expect(hostArchCheck.name).toBe('Architecture');
    expect(hostArchCheck.category).toBe('host');
  });

  it('belongs to all six profiles', () => {
    expect(hostArchCheck.profile).toEqual([
      'minimal',
      'standard',
      'deep',
      'pre-flight',
      'post-install',
      'ci',
    ]);
  });

  it('returns durationMs >= 0', async () => {
    const r = await hostArchCheck.run(makeCtx());
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('doctor/checks — runtime.node', () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it('passes for Node v22', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'v22.11.0\n',
      stderr: '',
      failed: false,
      timedOut: false,
      command: 'node --version',
    });
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('ok');
    expect(r.message).toContain('v22.11.0');
    expect(r.detail).toMatchObject({ major: 22 });
  });

  it('passes for Node v20 (minimum)', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'v20.0.0\n',
      stderr: '',
      failed: false,
      timedOut: false,
      command: 'node --version',
    });
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('ok');
  });

  it('fails for Node v18 (too old)', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'v18.19.0\n',
      stderr: '',
      failed: false,
      timedOut: false,
      command: 'node --version',
    });
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/expected ≥ v20/);
    expect(r.fixCommand).toBe('linuxify runtimes install node 22');
  });

  it('fails when node exits non-zero', async () => {
    mockExec.mockResolvedValue({
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
      failed: true,
      timedOut: false,
      command: 'node --version',
    });
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/exited 127/);
    expect(r.fixCommand).toBe('linuxify runtimes install node 22');
  });

  it('fails when node binary is missing (exec throws)', async () => {
    mockExec.mockRejectedValue(new Error('ENOENT: node'));
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/node binary not found/);
    expect(r.fixCommand).toBe('linuxify runtimes install node 22');
  });

  it('warns when version string cannot be parsed', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'weird-version\n',
      stderr: '',
      failed: false,
      timedOut: false,
      command: 'node --version',
    });
    const r = await runtimeNodeCheck.run(makeCtx());
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/Could not parse/);
  });

  it('has the correct id, name, and category', () => {
    expect(runtimeNodeCheck.id).toBe('runtime.node');
    expect(runtimeNodeCheck.name).toBe('Node.js');
    expect(runtimeNodeCheck.category).toBe('runtime');
  });
});

describe('doctor/checks — bootstrap.completed', () => {
  it('passes when all 9 stages are in completed_stages', async () => {
    const ctx = makeCtx();
    ctx.state.bootstrap_progress.completed_stages = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    const r = await bootstrapCompletedCheck.run(ctx);
    expect(r.status).toBe('ok');
    expect(r.message).toMatch(/all 9 stages done/);
    expect(r.fixCommand).toBeUndefined();
  });

  it('fails when no stages are completed', async () => {
    const ctx = makeCtx();
    ctx.state.bootstrap_progress.completed_stages = [];
    const r = await bootstrapCompletedCheck.run(ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/0\/9 stages done/);
    expect(r.fixCommand).toBe('linuxify init --resume');
  });

  it('fails when only some stages are completed', async () => {
    const ctx = makeCtx();
    ctx.state.bootstrap_progress.completed_stages = [0, 1, 2, 3];
    const r = await bootstrapCompletedCheck.run(ctx);
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/4\/9 stages done/);
    expect(r.message).toContain('5');
    expect(r.message).toContain('6');
    expect(r.message).toContain('7');
    expect(r.message).toContain('8');
  });

  it('detail includes the missing stages array', async () => {
    const ctx = makeCtx();
    ctx.state.bootstrap_progress.completed_stages = [0, 1];
    const r = await bootstrapCompletedCheck.run(ctx);
    expect(r.detail).toMatchObject({
      missing: expect.arrayContaining([2, 3, 4, 5, 6, 7, 8]),
      completed: [0, 1],
    });
  });

  it('has the correct id, name, and category', () => {
    expect(bootstrapCompletedCheck.id).toBe('bootstrap.completed');
    expect(bootstrapCompletedCheck.name).toBe('Bootstrap completed');
    expect(bootstrapCompletedCheck.category).toBe('bootstrap');
  });

  it('is in the minimal profile', () => {
    expect(bootstrapCompletedCheck.profile).toContain('minimal');
  });
});

describe('doctor/checks — path.linuxify_bin', () => {
  beforeEach(() => {
    mockGetLinuxifyHome.mockReturnValue('/home/test/.linuxify');
  });

  it('passes when ~/.linuxify/bin is on PATH', async () => {
    setPath([
      '/usr/local/bin',
      '/usr/bin',
      '/home/test/.linuxify/bin',
      '/bin',
    ]);
    const r = await pathLinuxifyBinCheck.run(makeCtx());
    expect(r.status).toBe('ok');
    expect(r.message).toContain('/home/test/.linuxify/bin');
    expect(r.fixCommand).toBeUndefined();
  });

  it('fails when ~/.linuxify/bin is not on PATH', async () => {
    setPath(['/usr/local/bin', '/usr/bin', '/bin']);
    const r = await pathLinuxifyBinCheck.run(makeCtx());
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/not on PATH/);
    expect(r.fixCommand).toBe('linuxify init --from-stage 6');
  });

  it('fails when PATH is empty', async () => {
    setPath([]);
    const r = await pathLinuxifyBinCheck.run(makeCtx());
    expect(r.status).toBe('fail');
  });

  it('does not match a partial path (e.g. /home/test/.linuxify/bin/sub)', async () => {
    setPath(['/home/test/.linuxify/bin/sub', '/usr/bin']);
    const r = await pathLinuxifyBinCheck.run(makeCtx());
    expect(r.status).toBe('fail');
  });

  it('detail includes the path entries when failing', async () => {
    setPath(['/usr/bin', '/bin']);
    const r = await pathLinuxifyBinCheck.run(makeCtx());
    expect(r.detail).toMatchObject({
      target: '/home/test/.linuxify/bin',
      pathEntries: ['/usr/bin', '/bin'],
    });
  });

  it('has the correct id, name, and category', () => {
    expect(pathLinuxifyBinCheck.id).toBe('path.linuxify_bin');
    expect(pathLinuxifyBinCheck.name).toBe('PATH: linuxify/bin');
    expect(pathLinuxifyBinCheck.category).toBe('path');
  });

  it('is in the minimal profile', () => {
    expect(pathLinuxifyBinCheck.profile).toContain('minimal');
  });
});
