// tests/unit/bootstrap/stages.test.ts
//
// Unit tests for the bootstrap stage modules and the marker file helpers.
//
// Covers:
//  - Marker file write/read/clear semantics (markers.ts).
//  - Individual stage contracts: stage 0 (preflight delegation), stage 1
//    (host deps), stage 5 (home setup), stage 6 (PATH wiring), stage 8
//    (tips).
//  - Stage idempotency and graceful error handling (stages return
//    StageResult, never throw).

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory fs mock — shared across tests. We track files in a Map.
// Declared via `vi.hoisted` so the hoisted `vi.mock` factory can reference
// the mock functions.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Buffer>();

  const ensureDir = vi.fn<(p: string) => Promise<void>>(async (_p: string) => {
    // directories are implicit in the in-memory model
  });
  const exists = vi.fn<(p: string) => Promise<boolean>>(async (p) => files.has(p));
  const readFile = vi.fn<(p: string) => Promise<string>>(async (p) => {
    const v = files.get(p);
    if (v === undefined) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return typeof v === 'string' ? v : v.toString('utf8');
  });
  const writeFile = vi.fn<(p: string, data: string | Buffer) => Promise<void>>(
    async (p, data) => {
      files.set(p, data);
    },
  );

  // `node:fs/promises` is used inside markers.ts / stage modules for
  // unlink / rename / symlink / readlink.
  const unlink = vi.fn<(p: string) => Promise<void>>(async (p) => {
    files.delete(p);
  });
  const rename = vi.fn<(a: string, b: string) => Promise<void>>(async (a, b) => {
    const v = files.get(a);
    if (v !== undefined) {
      files.delete(a);
      files.set(b, v);
    }
  });
  const symlink = vi.fn<(target: string, path: string) => Promise<void>>(async (_t, path) => {
    files.set(path, 'SYMLINK');
  });
  const readlink = vi.fn<(p: string) => Promise<string>>(async (p) => {
    const v = files.get(p);
    if (typeof v === 'string' && v === 'SYMLINK') return '/somewhere/linuxify';
    throw new Error(`EINVAL: ${p}`);
  });

  // Other util mocks.
  const exec = vi.fn();
  const isTermux = vi.fn(() => true);
  const isAndroid = vi.fn(() => true);
  const getArch = vi.fn(() => 'aarch64');
  const getTermuxPrefix = vi.fn(() => '/data/data/com.termux/files/usr');

  return {
    files,
    ensureDir,
    exists,
    readFile,
    writeFile,
    unlink,
    rename,
    symlink,
    readlink,
    exec,
    isTermux,
    isAndroid,
    getArch,
    getTermuxPrefix,
  };
});

vi.mock('node:fs/promises', () => ({
  unlink: mocks.unlink,
  rename: mocks.rename,
  symlink: mocks.symlink,
  readlink: mocks.readlink,
  default: {
    unlink: mocks.unlink,
    rename: mocks.rename,
    symlink: mocks.symlink,
    readlink: mocks.readlink,
  },
}));

vi.mock('../../../src/utils/fs.js', () => ({
  ensureDir: mocks.ensureDir,
  exists: mocks.exists,
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
}));

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  execOrThrow: vi.fn(),
  isTermux: mocks.isTermux,
  isAndroid: mocks.isAndroid,
  getArch: mocks.getArch,
  getTermuxPrefix: mocks.getTermuxPrefix,
}));

vi.mock('../../../src/utils/net.js', () => ({
  isReachable: vi.fn(async () => true),
  download: vi.fn(),
}));

vi.mock('../../../src/utils/crypto.js', () => ({
  sha256File: vi.fn(async () => 'deadbeef'.repeat(8)),
  verifySha256: vi.fn(async () => true),
}));

vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('../../../src/utils/errors.js', () => ({
  LinuxifyError: class LinuxifyError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'LinuxifyError';
    }
  },
  BootstrapError: class BootstrapError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
      this.name = 'BootstrapError';
    }
  },
}));

// ---------------------------------------------------------------------------
// SUT imports
// ---------------------------------------------------------------------------

import {
  clearAllStageMarkers,
  clearStageMarker,
  doneMarkerPath,
  failedMarkerPath,
  isStageComplete,
  markStageComplete,
  markStageFailed,
  readDoneMarker,
  readFailedMarker,
} from '../../../src/bootstrap/markers.js';
import { stage0Preflight } from '../../../src/bootstrap/stages/stage-0-preflight.js';
import { stage1HostDeps } from '../../../src/bootstrap/stages/stage-1-host-deps.js';
import {
  buildFirstBootScript,
  stage3FirstBoot,
} from '../../../src/bootstrap/stages/stage-3-first-boot.js';
import { stage5Home } from '../../../src/bootstrap/stages/stage-5-home.js';
import { stage6Path } from '../../../src/bootstrap/stages/stage-6-path.js';
import { renderBanner, stage8Tips } from '../../../src/bootstrap/stages/stage-8-tips.js';
import type { BootstrapContext } from '../../../src/bootstrap/types.js';

// Convenience aliases for tests below.
const { files, ensureDir: mockEnsureDir, exec: mockExec, isTermux: mockIsTermux } = mocks;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const MARKERS_DIR = '/tmp/test-linuxify/.bootstrap';

function makeContext(overrides: Partial<BootstrapContext> = {}): BootstrapContext {
  return {
    config: {
      default: {
        distro: 'ubuntu',
        telemetry: false,
        autoUpdateCheck: true,
        logLevel: 'info',
        color: 'auto',
        shellRc: '',
        cacheTtlHours: 24,
      },
      run: {
        defaultDistro: 'ubuntu',
        bindHome: true,
        workspaceMount: '/home/linuxify/workspace',
      },
      patcher: { preferAst: true, backup: true, concurrency: 4 },
      bootstrap: {
        minFreeSpaceMb: 2048,
        timeoutMinutes: 30,
        locale: 'en_US.UTF-8',
        timezone: 'Etc/UTC',
      },
      distro: { extra: [], mirrors: {} },
      runtime: {
        skip: [],
        node: { version: 'lts', registry: 'https://registry.npmjs.org' },
        python: { version: '3.12', indexUrl: 'https://pypi.org/simple' },
        rust: { toolchain: 'stable' },
      },
      telemetry: {
        enabled: false,
        endpoint: '',
        batchSize: 25,
        flushIntervalMs: 30000,
        redactionPatterns: [],
      },
      sync: { enabled: false },
      plugin: {},
      profile: {},
    } as BootstrapContext['config'],
    stateStore: { save: vi.fn(), load: vi.fn() } as unknown as BootstrapContext['stateStore'],
    force: false,
    markersDir: MARKERS_DIR,
    linuxifyHome: '/tmp/test-linuxify',
    offline: false,
    linuxifyVersion: '0.1.0-test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('markers', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
  });

  it('doneMarkerPath and failedMarkerPath produce the expected filenames', () => {
    expect(doneMarkerPath(MARKERS_DIR, 3)).toBe(`${MARKERS_DIR}/stage-3.done`);
    expect(failedMarkerPath(MARKERS_DIR, 7)).toBe(`${MARKERS_DIR}/stage-7.failed`);
  });

  it('isStageComplete returns false before markStageComplete is called', async () => {
    expect(await isStageComplete(MARKERS_DIR, 2)).toBe(false);
  });

  it('markStageComplete writes a JSON marker that isStageComplete reports as present', async () => {
    await markStageComplete(MARKERS_DIR, {
      stage: 2,
      name: 'Rootfs',
      completedAt: '2025-01-01T00:00:00Z',
      durationMs: 12345,
      linuxifyVersion: '0.1.0-test',
      details: { mirror: 'https://example.com' },
    });
    expect(await isStageComplete(MARKERS_DIR, 2)).toBe(true);
    const marker = await readDoneMarker(MARKERS_DIR, 2);
    expect(marker?.name).toBe('Rootfs');
    expect(marker?.durationMs).toBe(12345);
  });

  it('markStageComplete removes any stale .failed marker', async () => {
    await markStageFailed(MARKERS_DIR, {
      stage: 4,
      name: 'Runtimes',
      failedAt: '2025-01-01T00:00:00Z',
      error: 'boom',
    });
    expect(files.has(failedMarkerPath(MARKERS_DIR, 4))).toBe(true);
    await markStageComplete(MARKERS_DIR, {
      stage: 4,
      name: 'Runtimes',
      completedAt: '2025-01-01T00:01:00Z',
      durationMs: 1,
      linuxifyVersion: '0.1.0-test',
    });
    expect(files.has(failedMarkerPath(MARKERS_DIR, 4))).toBe(false);
    expect(files.has(doneMarkerPath(MARKERS_DIR, 4))).toBe(true);
  });

  it('markStageFailed removes any stale .done marker', async () => {
    await markStageComplete(MARKERS_DIR, {
      stage: 5,
      name: 'Home',
      completedAt: '2025-01-01T00:00:00Z',
      durationMs: 1,
      linuxifyVersion: '0.1.0-test',
    });
    expect(files.has(doneMarkerPath(MARKERS_DIR, 5))).toBe(true);
    await markStageFailed(MARKERS_DIR, {
      stage: 5,
      name: 'Home',
      failedAt: '2025-01-01T00:01:00Z',
      error: 'disk full',
    });
    expect(files.has(doneMarkerPath(MARKERS_DIR, 5))).toBe(false);
    expect(files.has(failedMarkerPath(MARKERS_DIR, 5))).toBe(true);
  });

  it('clearStageMarker removes both markers', async () => {
    await markStageComplete(MARKERS_DIR, {
      stage: 6,
      name: 'PATH',
      completedAt: '2025-01-01T00:00:00Z',
      durationMs: 1,
      linuxifyVersion: '0.1.0-test',
    });
    await clearStageMarker(MARKERS_DIR, 6);
    expect(await isStageComplete(MARKERS_DIR, 6)).toBe(false);
  });

  it('clearAllStageMarkers removes every stage marker (0-8)', async () => {
    for (let i = 0; i <= 8; i++) {
      await markStageComplete(MARKERS_DIR, {
        stage: i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
        name: `Stage${i}`,
        completedAt: '2025-01-01T00:00:00Z',
        durationMs: 1,
        linuxifyVersion: '0.1.0-test',
      });
    }
    await clearAllStageMarkers(MARKERS_DIR);
    for (let i = 0; i <= 8; i++) {
      expect(await isStageComplete(MARKERS_DIR, i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)).toBe(false);
    }
  });

  it('readDoneMarker returns null for a missing marker', async () => {
    expect(await readDoneMarker(MARKERS_DIR, 0)).toBeNull();
  });

  it('readFailedMarker returns null for a missing marker', async () => {
    expect(await readFailedMarker(MARKERS_DIR, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('stage 0 — preflight delegation', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    // Seed the Termux `pkg` binary so the termux-source check passes.
    files.set('/data/data/com.termux/files/usr/bin/pkg', '#!/data/data/com.termux/files/usr/bin/sh\n');
    mockExec.mockImplementation((cmd: string) => {
      if (cmd === 'dpkg')
        return Promise.resolve({
          exitCode: 0,
          stdout: 'Package: com.termux\nVersion: 0.118.0\n',
          stderr: '',
        });
      if (cmd === 'getprop')
        return Promise.resolve({ exitCode: 0, stdout: '33\n', stderr: '' });
      if (cmd === 'df')
        return Promise.resolve({
          exitCode: 0,
          stdout:
            'Filesystem 1K-blocks Used Avail Use% Mounted on\n/tmp 10000000 0 10000000 0% /\n',
          stderr: '',
        });
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
    });
  });

  it('returns success:true when preflight passes', async () => {
    const result = await stage0Preflight(makeContext());
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns success:false when preflight fails (non-Termux host)', async () => {
    mockIsTermux.mockReturnValue(false);
    const result = await stage0Preflight(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Preflight failed/);
    mockIsTermux.mockReturnValue(true);
  });
});

// ---------------------------------------------------------------------------

describe('stage 1 — host deps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success:true when pkg update + pkg install + proot-distro version all exit 0', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'proot-distro v1.13.0\n',
      stderr: '',
    });
    const result = await stage1HostDeps(makeContext());
    expect(result.success).toBe(true);
    expect(result.details?.prootDistroVersion).toBe('1.13.0');
  });

  it('returns success:false when pkg update fails', async () => {
    mockExec.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Repository is down',
    });
    const result = await stage1HostDeps(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pkg update failed/);
  });

  it('succeeds when proot-distro list works (even with old version — warns, not fails)', async () => {
    // The new verification uses `proot-distro list` (not `proot-distro version`).
    // Old version is a warning, not a failure — the `list` success is sufficient.
    mockExec
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // pkg update
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // pkg install
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Installed containers:\n\n  ubuntu\n', stderr: '' }) // proot-distro list
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Version: 1.10.0\n', stderr: '' }); // dpkg -s proot-distro (for version logging)
    const result = await stage1HostDeps(makeContext());
    expect(result.success).toBe(true); // succeeds even with old version
    expect(result.details).toHaveProperty('prootDistroVersion', '1.10.0');
  });

  it('returns success:false (not throw) when exec rejects', async () => {
    mockExec.mockRejectedValue(new Error('ENOENT pkg'));
    const result = await stage1HostDeps(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Stage 1 threw/);
  });
});

// ---------------------------------------------------------------------------

describe('stage 3 — first-boot script builder', () => {
  it('buildFirstBootScript emits apt update, apt install, locale-gen, timezone', () => {
    const script = buildFirstBootScript('en_US.UTF-8', 'Etc/UTC');
    expect(script).toContain('apt-get update');
    expect(script).toContain('build-essential');
    expect(script).toContain('locale-gen en_US.UTF-8');
    expect(script).toContain('ln -sf /usr/share/zoneinfo/Etc/UTC /etc/localtime');
    expect(script).toContain('id linuxify');
  });

  it('buildFirstBootScript escapes locale dots in the sed substitution', () => {
    const script = buildFirstBootScript('en_US.UTF-8', 'UTC');
    // The dot in the locale should be backslash-escaped so sed treats it
    // literally rather than as a regex metacharacter.
    expect(script).toContain('en_US\\.UTF-8');
  });
});

describe('stage 3 — run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns success:true when proot-distro login exits 0', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: '[stage 3] done',
      stderr: '',
    });
    const result = await stage3FirstBoot(makeContext());
    expect(result.success).toBe(true);
    expect(result.details?.locale).toBe('en_US.UTF-8');
    expect(result.details?.timezone).toBe('Etc/UTC');
  });

  it('returns success:false with a retry hint when proot-distro login exits non-zero', async () => {
    mockExec.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'E: Unable to locate package build-essential',
    });
    const result = await stage3FirstBoot(makeContext());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/first-boot script failed/);
    expect(result.error).toMatch(/--from-stage 3/);
  });
});

// ---------------------------------------------------------------------------

describe('stage 5 — home setup', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
  });

  it('creates the directory tree and writes config.toml + state.json', async () => {
    const ctx = makeContext();
    const result = await stage5Home(ctx);
    expect(result.success).toBe(true);
    expect(mockEnsureDir).toHaveBeenCalled();
    expect(files.has('/tmp/test-linuxify/config.toml')).toBe(true);
    expect(ctx.stateStore.save).toHaveBeenCalled();
    const config = files.get('/tmp/test-linuxify/config.toml') as string;
    expect(config).toContain('[bootstrap]');
    expect(config).toContain('locale = "en_US.UTF-8"');
  });

  it('does NOT overwrite an existing config.toml (idempotency)', async () => {
    files.set('/tmp/test-linuxify/config.toml', '# user-edited\n');
    const ctx = makeContext();
    const result = await stage5Home(ctx);
    expect(result.success).toBe(true);
    expect(files.get('/tmp/test-linuxify/config.toml')).toBe('# user-edited\n');
  });

  it('does NOT call stateStore.save when state.json already exists', async () => {
    files.set('/tmp/test-linuxify/state.json', '{}');
    const ctx = makeContext();
    const result = await stage5Home(ctx);
    expect(result.success).toBe(true);
    expect(ctx.stateStore.save).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('stage 6 — PATH wiring', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    // Simulate `$PREFIX/bin/linuxify` exists for the symlink target.
    files.set('/data/data/com.termux/files/usr/bin/linuxify', '#!/usr/bin/env node\n');
  });

  it('writes the PATH block into shell rc files when absent', async () => {
    const ctx = makeContext();
    const result = await stage6Path(ctx);
    expect(result.success).toBe(true);
    expect(result.details?.editedFiles).toBeDefined();
    expect((result.details as { editedFiles: unknown[] }).editedFiles.length).toBeGreaterThan(0);
  });

  it('is idempotent: a second run does not duplicate the PATH block', async () => {
    const ctx = makeContext();
    const r1 = await stage6Path(ctx);
    const r2 = await stage6Path(ctx);
    const edited1 = ((r1.details as { editedFiles?: unknown[] }).editedFiles ?? []).length;
    const edited2 = ((r2.details as { editedFiles?: unknown[] }).editedFiles ?? []).length;
    // First run edits at least one rc file; second run edits none of them
    // (the guard markers are already present). .bash_profile may have been
    // created in run 1, so edited2 may still be 0 or 1 at most.
    expect(edited1).toBeGreaterThan(0);
    expect(edited2).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------

describe('stage 8 — tips', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
  });

  it('renders a banner with the active distro and runtimes', () => {
    const banner = renderBanner({
      distro: 'ubuntu 24.04 (proot)',
      runtimes: 'node 22.11.0 LTS, python 3.12.3',
      pathHint: '~/.linuxify/bin',
    });
    expect(banner).toContain('Linuxify ready');
    expect(banner).toContain('ubuntu 24.04 (proot)');
    expect(banner).toContain('node 22.11.0 LTS');
    expect(banner).toContain('linuxify add cline');
  });

  it('always returns success:true, even if writeFile throws', async () => {
    mocks.writeFile.mockRejectedValueOnce(new Error('disk full'));
    const ctx = makeContext();
    const result = await stage8Tips(ctx);
    expect(result.success).toBe(true);
  });

  it('writes welcome.txt to the markers dir', async () => {
    const ctx = makeContext();
    await stage8Tips(ctx);
    expect(files.has('/tmp/test-linuxify/.bootstrap/welcome.txt')).toBe(true);
  });
});
