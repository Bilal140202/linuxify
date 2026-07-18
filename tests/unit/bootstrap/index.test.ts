// tests/unit/bootstrap/index.test.ts
//
// Unit tests for src/bootstrap/index.ts — the bootstrap orchestrator.
//
// These tests verify the pipeline's marker-based skip/run logic, the --force
// and --from-stage flags, and the failure-abort contract. Every stage
// implementation is mocked so the tests exercise only the orchestrator's
// sequencing logic.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared via `vi.hoisted` so they are available to the hoisted
// `vi.mock` factories.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // In-memory fs.
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
  const unlink = vi.fn<(p: string) => Promise<void>>(async (p) => {
    files.delete(p);
  });
  const symlink = vi.fn<(target: string, path: string) => Promise<void>>(async (_t, path) => {
    files.set(path, 'SYMLINK');
  });
  const readlink = vi.fn<(p: string) => Promise<string>>(async (p) => {
    const v = files.get(p);
    if (typeof v === 'string' && v === 'SYMLINK') return '/somewhere/linuxify';
    throw new Error(`EINVAL: ${p}`);
  });
  const rename = vi.fn<(a: string, b: string) => Promise<void>>(async (a, b) => {
    const v = files.get(a);
    if (v !== undefined) {
      files.delete(a);
      files.set(b, v);
    }
  });

  // Stage mocks — return success by default; tests override per-test.
  const stage0Mock = vi.fn(async () => ({ success: true, durationMs: 10 }));
  const stage1Mock = vi.fn(async () => ({ success: true, durationMs: 20 }));
  const stage2Mock = vi.fn(async () => ({ success: true, durationMs: 30 }));
  const stage3Mock = vi.fn(async () => ({ success: true, durationMs: 40 }));
  const stage4Mock = vi.fn(async () => ({ success: true, durationMs: 50 }));
  const stage5Mock = vi.fn(async () => ({ success: true, durationMs: 5 }));
  const stage6Mock = vi.fn(async () => ({ success: true, durationMs: 5 }));
  const stage7Mock = vi.fn(async () => ({ success: true, durationMs: 15 }));
  const stage8Mock = vi.fn(async () => ({ success: true, durationMs: 0 }));

  // Config + state store.
  const loadConfig = vi.fn(async () => ({
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
  }));
  const stateStoreSave = vi.fn(async () => undefined);
  const StateStore = vi.fn((path: string) => ({
    path,
    save: stateStoreSave,
    load: vi.fn(async () => ({})),
  }));

  return {
    files,
    ensureDir,
    exists,
    readFile,
    writeFile,
    unlink,
    symlink,
    readlink,
    rename,
    stage0Mock,
    stage1Mock,
    stage2Mock,
    stage3Mock,
    stage4Mock,
    stage5Mock,
    stage6Mock,
    stage7Mock,
    stage8Mock,
    loadConfig,
    stateStoreSave,
    StateStore,
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

vi.mock('../../../src/bootstrap/stages/stage-0-preflight.js', () => ({
  stage0Preflight: mocks.stage0Mock,
}));
vi.mock('../../../src/bootstrap/stages/stage-1-host-deps.js', () => ({
  stage1HostDeps: mocks.stage1Mock,
}));
vi.mock('../../../src/bootstrap/stages/stage-2-rootfs.js', () => ({
  stage2Rootfs: mocks.stage2Mock,
}));
vi.mock('../../../src/bootstrap/stages/stage-3-first-boot.js', () => ({
  stage3FirstBoot: mocks.stage3Mock,
  buildFirstBootScript: vi.fn(() => ''),
}));
vi.mock('../../../src/bootstrap/stages/stage-4-runtimes.js', () => ({
  stage4Runtimes: mocks.stage4Mock,
  buildRuntimesScript: vi.fn(() => ''),
}));
vi.mock('../../../src/bootstrap/stages/stage-5-home.js', () => ({
  stage5Home: mocks.stage5Mock,
  buildDefaultState: vi.fn(() => ({})),
}));
vi.mock('../../../src/bootstrap/stages/stage-6-path.js', () => ({
  stage6Path: mocks.stage6Mock,
}));
vi.mock('../../../src/bootstrap/stages/stage-7-verify.js', () => ({
  stage7Verify: mocks.stage7Mock,
}));
vi.mock('../../../src/bootstrap/stages/stage-8-tips.js', () => ({
  stage8Tips: mocks.stage8Mock,
  renderBanner: vi.fn(() => ''),
}));

vi.mock('../../../src/config/index.js', () => ({ loadConfig: mocks.loadConfig }));
vi.mock('../../../src/state/index.js', () => ({ StateStore: mocks.StateStore }));

vi.mock('../../../src/utils/process.js', () => ({
  exec: vi.fn(),
  execOrThrow: vi.fn(),
  isTermux: vi.fn(() => true),
  isAndroid: vi.fn(() => true),
  getArch: vi.fn(() => 'aarch64'),
  getTermuxPrefix: vi.fn(() => '/data/data/com.termux/files/usr'),
}));

vi.mock('../../../src/utils/net.js', () => ({
  isReachable: vi.fn(async () => true),
  download: vi.fn(),
}));

vi.mock('../../../src/utils/crypto.js', () => ({
  sha256File: vi.fn(async () => 'abc'),
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

import { bootstrap, stages } from '../../../src/bootstrap/index.js';
import { doneMarkerPath } from '../../../src/bootstrap/markers.js';

// Convenience aliases for tests below.
const {
  files,
  stage0Mock,
  stage1Mock,
  stage2Mock,
  stage3Mock,
  stage4Mock,
  stage5Mock,
  stage6Mock,
  stage7Mock,
  stage8Mock,
  loadConfig: mockLoadConfig,
} = mocks;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MARKERS_DIR = '/tmp/test-linuxify/.bootstrap';

function seedDoneMarker(stageId: number, name: string, durationMs = 1): void {
  files.set(
    doneMarkerPath(MARKERS_DIR, stageId as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8),
    JSON.stringify({
      stage: stageId,
      name,
      completedAt: '2025-01-01T00:00:00Z',
      durationMs,
      linuxifyVersion: '0.1.0-test',
    }),
  );
}

// ---------------------------------------------------------------------------

describe('bootstrap orchestrator', () => {
  beforeEach(() => {
    files.clear();
    vi.clearAllMocks();
    // Reset each stage mock to its happy-path default.
    stage0Mock.mockResolvedValue({ success: true, durationMs: 10 });
    stage1Mock.mockResolvedValue({ success: true, durationMs: 20 });
    stage2Mock.mockResolvedValue({ success: true, durationMs: 30 });
    stage3Mock.mockResolvedValue({ success: true, durationMs: 40 });
    stage4Mock.mockResolvedValue({ success: true, durationMs: 50 });
    stage5Mock.mockResolvedValue({ success: true, durationMs: 5 });
    stage6Mock.mockResolvedValue({ success: true, durationMs: 5 });
    stage7Mock.mockResolvedValue({ success: true, durationMs: 15 });
    stage8Mock.mockResolvedValue({ success: true, durationMs: 0 });
    // Point LINUXIFY_HOME at our test scratch dir.
    process.env.LINUXIFY_HOME = '/tmp/test-linuxify';
  });

  it('exports all 9 stages (0 through 8) in order', () => {
    expect(stages).toHaveLength(9);
    expect(stages.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of stages) {
      expect(typeof s.name).toBe('string');
      expect(typeof s.description).toBe('string');
      expect(typeof s.run).toBe('function');
    }
  });

  it('runs every stage on a fresh install and returns a success result', async () => {
    const result = await bootstrap();
    expect(result.failedStage).toBeNull();
    expect(result.error).toBeNull();
    expect(result.completedStages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);

    expect(stage0Mock).toHaveBeenCalledTimes(1);
    expect(stage1Mock).toHaveBeenCalledTimes(1);
    expect(stage8Mock).toHaveBeenCalledTimes(1);

    for (let i = 0; i <= 8; i++) {
      expect(
        files.has(doneMarkerPath(MARKERS_DIR, i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)),
      ).toBe(true);
    }
  });

  it('skips stages whose .done marker is already present', async () => {
    seedDoneMarker(0, 'Preflight');
    seedDoneMarker(1, 'Host Deps');
    seedDoneMarker(2, 'Rootfs');
    seedDoneMarker(3, 'First-Boot');
    seedDoneMarker(4, 'Runtimes');

    const result = await bootstrap();
    expect(result.failedStage).toBeNull();
    expect(result.completedStages).toEqual([5, 6, 7, 8]);

    expect(stage0Mock).not.toHaveBeenCalled();
    expect(stage4Mock).not.toHaveBeenCalled();
    expect(stage5Mock).toHaveBeenCalledTimes(1);
    expect(stage8Mock).toHaveBeenCalledTimes(1);
  });

  it('--force clears all markers and re-runs every stage', async () => {
    for (let i = 0; i <= 8; i++) seedDoneMarker(i, `Stage${i}`);

    const result = await bootstrap({ force: true });
    expect(result.failedStage).toBeNull();
    expect(result.completedStages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(stage0Mock).toHaveBeenCalledTimes(1);
    expect(stage8Mock).toHaveBeenCalledTimes(1);
  });

  it('--from-stage N skips stages 0..N-1 regardless of markers', async () => {
    const result = await bootstrap({ fromStage: 5 });
    expect(result.failedStage).toBeNull();
    expect(result.completedStages).toEqual([5, 6, 7, 8]);
    expect(stage0Mock).not.toHaveBeenCalled();
    expect(stage4Mock).not.toHaveBeenCalled();
    expect(stage5Mock).toHaveBeenCalledTimes(1);
  });

  it('aborts the pipeline on the first failing stage and writes a .failed marker', async () => {
    stage4Mock.mockResolvedValue({ success: false, durationMs: 50, error: 'NodeSource 404' });

    const result = await bootstrap();
    expect(result.failedStage).toBe(4);
    expect(result.error).toBe('NodeSource 404');
    expect(result.completedStages).toEqual([0, 1, 2, 3]);

    expect(stage3Mock).toHaveBeenCalledTimes(1);
    expect(stage4Mock).toHaveBeenCalledTimes(1);
    expect(stage5Mock).not.toHaveBeenCalled();
    expect(stage8Mock).not.toHaveBeenCalled();

    expect(files.has(`${MARKERS_DIR}/stage-4.failed`)).toBe(true);
    expect(files.has(doneMarkerPath(MARKERS_DIR, 4))).toBe(false);
    for (let i = 0; i <= 3; i++) {
      expect(
        files.has(doneMarkerPath(MARKERS_DIR, i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)),
      ).toBe(true);
    }
    for (let i = 5; i <= 8; i++) {
      expect(
        files.has(doneMarkerPath(MARKERS_DIR, i as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)),
      ).toBe(false);
    }
  });

  it('converts a thrown stage into a StageResult failure (does not propagate)', async () => {
    stage2Mock.mockRejectedValue(new Error('network exploded'));
    const result = await bootstrap();
    expect(result.failedStage).toBe(2);
    expect(result.error).toMatch(/threw unexpectedly/);
    expect(result.error).toMatch(/network exploded/);
    expect(result.completedStages).toEqual([0, 1]);
  });

  it('returns a failure result when loadConfig throws', async () => {
    mockLoadConfig.mockRejectedValueOnce(new Error('config parse error'));
    const result = await bootstrap();
    expect(result.failedStage).toBeNull();
    expect(result.error).toMatch(/Bootstrap context construction failed/);
    expect(result.completedStages).toEqual([]);
  });

  it('records per-stage durations in stageDurations', async () => {
    const result = await bootstrap();
    expect(result.stageDurations[0]).toBe(10);
    expect(result.stageDurations[1]).toBe(20);
    expect(result.stageDurations[8]).toBe(0);
  });

  it('forwards offline + bundlePath into the context', async () => {
    stage2Mock.mockImplementation(async (ctx: unknown) => {
      const c = ctx as { offline: boolean; bundlePath?: string };
      expect(c.offline).toBe(true);
      expect(c.bundlePath).toBe('./bundle.tar.gz');
      return { success: true, durationMs: 1 };
    });
    const result = await bootstrap({ offline: true, bundlePath: './bundle.tar.gz' });
    expect(result.failedStage).toBeNull();
    expect(stage2Mock).toHaveBeenCalledTimes(1);
  });
});
