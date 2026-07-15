/**
 * Tests for the report generator.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateReport, formatReport, type Report } from '../../../src/report/index.js';

// Mock utils that touch the filesystem or subprocesses
vi.mock('../../../src/utils/process.js', () => ({
  getArch: () => 'x86_64',
  getPlatform: () => 'linux',
  isTermux: () => false,
  isAndroid: () => false,
  getAndroidVersion: async () => null,
  getLinuxifyHome: () => '/tmp/linuxify-test',
  exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false, command: '' })),
}));

vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }),
  },
}));

vi.mock('../../../src/utils/fs.js', () => ({
  exists: async () => false,
  readFile: async () => '',
  stat: async () => ({}),
}));

function makeMockStateStore() {
  const state = {
    schema_version: 1,
    linuxify_version: '0.1.0-alpha.1',
    active_distro: 'ubuntu',
    installed_distros: [{ name: 'ubuntu', version: '24.04', installed_at: '2026-01-01T00:00:00Z', rootfs_sha256: 'abc' }],
    installed_runtimes: [
      { name: 'node', version: '22.11.0', distro: 'ubuntu', path: '/usr/bin/node', installed_at: '2026-01-01T00:00:00Z', is_default: true },
    ],
    installed_packages: [
      { name: 'cline', version: '1.2.0', distro: 'ubuntu', runtime: 'node', runtime_version: '22.11.0', install_date: '2026-01-01T00:00:00Z', launcher_path: '/usr/bin/cline', patches_applied: ['cline-001'] },
    ],
    applied_patches: [],
    bootstrap_progress: { current_stage: 8, completed_stages: [0,1,2,3,4,5,6,7,8], failed_stage: null, error: null, started_at: '2026-01-01T00:00:00Z', last_updated_at: '2026-01-01T00:05:00Z' },
    last_doctor_run: null,
    telemetry: { user_id: null, enabled: false, last_flush: null },
    plugins: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
  return {
    load: vi.fn(async () => state),
    get: () => state,
    update: vi.fn(async (fn: (s: unknown) => void) => { fn(state); return state; }),
    save: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
    unlock: vi.fn(async () => undefined),
    withLock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    statePath: '/tmp/state.json',
    lockPath: '/tmp/.lock',
  };
}

const mockConfig = {
  schema_version: 1,
  bootstrap: { distro: 'ubuntu', mirror: null, runtimes: ['node', 'python'], parallel_downloads: 4, locale: 'en_US.UTF-8', timezone: 'UTC' },
  distro: { default: 'ubuntu' },
  runtime: { node_default_version: 'lts', python_default_version: '3.12' },
  telemetry: { enabled: false, user_id: null, endpoint: 'https://telemetry.linuxify.sh/v2', sample_rate: 0.1 },
  sync: { enabled: false, endpoint: 'https://sync.linuxify.sh', device_name: null },
  registry: { url: 'https://github.com/linuxify/registry', branch: 'main', trust_self_signed: false },
  logging: { level: 'info', file_enabled: true, console_enabled: true },
  i18n: { locale: 'en' },
  profiles: {},
  experimental: { features: [] },
};

describe('report generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a report with correct schema version', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    expect(report.schema).toBe('linuxify.report.v1');
    expect(report.linuxifyVersion).toBe('0.1.0-alpha.1');
  });

  it('includes host environment info', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    expect(report.host.platform).toBe('linux');
    expect(report.host.arch).toBe('x86_64');
    expect(report.host.isTermux).toBe(false);
  });

  it('includes install state from state store', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    expect(report.install.activeDistro).toBe('ubuntu');
    expect(report.install.installedDistros).toEqual([]);
  });

  it('includes installed runtimes', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    expect(report.runtimes).toHaveLength(1);
    expect(report.runtimes[0].name).toBe('node');
    expect(report.runtimes[0].isDefault).toBe(true);
  });

  it('includes installed packages', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0].name).toBe('cline');
    expect(report.packages[0].patchesApplied).toContain('cline-001');
  });

  it('formats as JSON', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const json = formatReport(report, 'json');
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe('linuxify.report.v1');
  });

  it('formats as markdown with fenced block', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const md = formatReport(report, 'markdown');
    expect(md).toContain('```linuxify-report');
    expect(md).toContain('```');
  });

  it('formats as fingerprint one-liner', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const fp = formatReport(report, 'fingerprint');
    expect(fp).toContain('linuxify/0.1.0-alpha.1');
    expect(fp).toContain('arch/x86_64');
    expect(fp).not.toContain('\n');
  });

  it('formats as human-readable text with sections', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const text = formatReport(report, 'text');
    expect(text).toContain('Linuxify Report');
    expect(text).toContain('Environment');
    expect(text).toContain('Packages');
  });

  it('handles state load failure gracefully', async () => {
    const brokenStore = makeMockStateStore();
    brokenStore.load = vi.fn(async () => { throw new Error('corrupt'); });
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: brokenStore as never,
    });
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings[0]).toContain('Failed to load state');
  });

  it('does not leak PII (no env values, no file paths beyond ~/.linuxify/)', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const json = JSON.stringify(report);
    // No home directory paths beyond ~/.linuxify
    expect(json).not.toContain('/home/');
    expect(json).not.toContain('/Users/');
    // No env var values
    expect(json).not.toContain('ANTHROPIC_API_KEY');
    expect(json).not.toContain('OPENAI_API_KEY');
  });
});

describe('report fingerprint', () => {
  it('produces a stable one-line fingerprint', async () => {
    const report = await generateReport({
      config: mockConfig as never,
      stateStore: makeMockStateStore() as never,
    });
    const fp1 = formatReport(report, 'fingerprint');
    const fp2 = formatReport(report, 'fingerprint');
    expect(fp1).toBe(fp2);
  });

  it('includes doctor status in fingerprint', async () => {
    const report: Report = {
      schema: 'linuxify.report.v1',
      generatedAt: '2026-01-01T00:00:00Z',
      linuxifyVersion: '0.1.0-alpha.1',
      host: { platform: 'android', arch: 'arm64', androidVersion: '16', termuxVersion: '0.119', isTermux: true, kernel: '6.17', storageFreeMb: 8000, memoryFreeMb: null },
      install: { linuxifyHome: '~/.linuxify', bootstrapComplete: true, bootstrapStagesDone: [0,1,2,3,4,5,6,7,8], bootstrapStagesFailed: [], activeDistro: 'ubuntu', installedDistros: ['ubuntu'], configSchemaVersion: 1 },
      runtimes: [{ name: 'node', version: '24.18', distro: 'ubuntu', isDefault: true }],
      packages: [],
      doctor: { profile: 'standard', ok: 15, warn: 0, fail: 0, missing: 0, skip: 0, total: 15, durationMs: 100, failingChecks: [] },
      compatibility: [],
      warnings: [],
    };
    const fp = formatReport(report, 'fingerprint');
    expect(fp).toContain('android/16');
    expect(fp).toContain('termux/0.119');
    expect(fp).toContain('distro/ubuntu');
    expect(fp).toContain('node/24.18');
    expect(fp).toContain('arch/arm64');
    expect(fp).toContain('kernel/6.17');
    expect(fp).toContain('storage/ok');
    expect(fp).toContain('doctor/clean');
  });
});
