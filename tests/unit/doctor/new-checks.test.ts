/**
 * Tests for the new doctor checks added with the hosting + docker subsystems.
 *
 * @module tests/unit/doctor/new-checks.test.ts
 *
 * Covers:
 *  - `hosting.config-state` — verifies hosting config.json parsing + consistency.
 *  - `hosting.nginx-installed` — verifies nginx is installed in the proot.
 *  - `docker.runtime-available` — verifies a docker runtime is detectable.
 *  - `docker.port-allocation` — verifies state.docker port table is sane.
 *  - `docker.arm64-support` — verifies host arch is docker-recognized.
 *  - `docker.wake-lock` — verifies wake-lock is enabled when containers exist.
 *
 * All tests mock `exec` from `utils/process.ts` so no real subprocess is
 * spawned. All filesystem checks use a real `mkdtemp` tmpdir + `LINUXIFY_HOME`
 * env override for isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_DOCKER_STATE, type State, type DockerState } from '../../../src/state/index.js';
import { defaultState } from '../../../src/state/index.js';

// Hoist the execMock so vi.mock factory can reference it.
const { execMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
}));

// Mock the logger so tests don't open real log files.
vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../src/utils/process.js', async (orig) => {
  const actual = await orig() as Record<string, unknown>;
  return {
    ...actual,
    exec: execMock,
  };
});

vi.mock('../../../src/utils/distros.js', () => ({
  getActiveDistro: vi.fn(async (stateActive: string | null) => stateActive || 'ubuntu'),
  getInstalledContainers: vi.fn(async () => ['ubuntu']),
}));

// We import after mocks are set up.
const { hostConfigStateCheck } = await import('../../../src/doctor/checks/host-config-state.js');
const { hostNginxInstalledCheck } = await import('../../../src/doctor/checks/host-nginx-installed.js');
const { dockerRuntimeAvailableCheck } = await import('../../../src/doctor/checks/docker-runtime-available.js');
const { dockerPortAllocationCheck } = await import('../../../src/doctor/checks/docker-port-allocation.js');
const { dockerArm64SupportCheck } = await import('../../../src/doctor/checks/docker-arm64-support.js');
const { dockerWakeLockCheck } = await import('../../../src/doctor/checks/docker-wake-lock.js');

let tmpHome: string;
const savedEnv = process.env.LINUXIFY_HOME;

beforeEach(async () => {
  execMock.mockReset();
  execMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', failed: false, timedOut: false, command: '' });
  tmpHome = await mkdtemp(join(tmpdir(), 'linuxify-test-'));
  process.env.LINUXIFY_HOME = tmpHome;
});

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env.LINUXIFY_HOME;
  } else {
    process.env.LINUXIFY_HOME = savedEnv;
  }
  await rm(tmpHome, { recursive: true, force: true });
});

function makeCtx(dockerOverride?: Partial<DockerState>): { config: unknown; state: State } {
  const state = defaultState();
  state.docker = { ...DEFAULT_DOCKER_STATE, ...dockerOverride };
  return { config: {}, state };
}

describe('hosting.config-state check', () => {
  it('skips when hosting config not found', async () => {
    const ctx = makeCtx();
    const r = await hostConfigStateCheck.run(ctx as never);
    expect(r.status).toBe('skip');
    expect(r.message).toContain('not found');
  });

  it('passes when config.json is valid + no dupes', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    await writeFile(
      join(tmpHome, 'hosting', 'config.json'),
      JSON.stringify({
        schema_version: 1,
        initialized: true,
        initializedAt: new Date().toISOString(),
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      }),
    );
    const r = await hostConfigStateCheck.run(makeCtx() as never);
    expect(r.status).toBe('ok');
  });

  it('fails when config.json is malformed JSON', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    await writeFile(join(tmpHome, 'hosting', 'config.json'), '{ not valid json');
    const r = await hostConfigStateCheck.run(makeCtx() as never);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('malformed');
  });

  it('fails when config fails schema validation (type mismatch)', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    // The HostingConfigSchema doesn't use .strict(), so unknown fields
    // are silently dropped. Trigger a real validation failure by
    // giving a known field the wrong type.
    await writeFile(
      join(tmpHome, 'hosting', 'config.json'),
      JSON.stringify({
        schema_version: 1,
        initialized: true,
        initializedAt: new Date().toISOString(),
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 'not-a-number', // schema expects number 1024-65535
      }),
    );
    const r = await hostConfigStateCheck.run(makeCtx() as never);
    expect(r.status).toBe('fail');
    expect(r.fixCommand).toBe('linuxify repair state');
  });

  it('warns on duplicate app names', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    const now = new Date().toISOString();
    await writeFile(
      join(tmpHome, 'hosting', 'config.json'),
      JSON.stringify({
        schema_version: 1,
        initialized: true,
        initializedAt: now,
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [
          { name: 'app1', type: 'node', path: '/a', port: 8080, pid: null, status: 'running', startedAt: now, autoDeployed: false },
          { name: 'app1', type: 'node', path: '/b', port: 8081, pid: null, status: 'running', startedAt: now, autoDeployed: false },
        ],
        installedServices: [],
        defaultPort: 8080,
      }),
    );
    const r = await hostConfigStateCheck.run(makeCtx() as never);
    expect(r.status).toBe('warn');
    expect(r.detail).toHaveProperty('issues');
  });
});

describe('hosting.nginx-installed check', () => {
  it('skips when hosting not initialized (no config.json)', async () => {
    const r = await hostNginxInstalledCheck.run(makeCtx() as never);
    expect(r.status).toBe('skip');
  });

  it('fails when no active proot-distro (mock returns null)', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    await writeFile(join(tmpHome, 'hosting', 'config.json'), '{}');
    // Override the getActiveDistro mock for this one test.
    const { getActiveDistro } = await import('../../../src/utils/distros.js');
    vi.mocked(getActiveDistro).mockResolvedValueOnce(null as never);
    const state = defaultState();
    state.active_distro = '';
    const r = await hostNginxInstalledCheck.run({ config: {}, state } as never);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('No active proot-distro');
    expect(r.fixCommand).toBe('linuxify init');
  });

  it('passes when nginx is installed', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    await writeFile(join(tmpHome, 'hosting', 'config.json'), '{}');
    execMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '/usr/sbin/nginx',
      stderr: '',
      failed: false,
      timedOut: false,
      command: '',
    });
    const state = defaultState();
    state.active_distro = 'ubuntu';
    const r = await hostNginxInstalledCheck.run({ config: {}, state } as never);
    expect(r.status).toBe('ok');
    expect(r.message).toContain('nginx installed');
  });

  it('fails when nginx not installed', async () => {
    await mkdir(join(tmpHome, 'hosting'), { recursive: true });
    await writeFile(join(tmpHome, 'hosting', 'config.json'), '{}');
    execMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'which: no nginx in PATH',
      failed: false,
      timedOut: false,
      command: '',
    });
    const state = defaultState();
    state.active_distro = 'ubuntu';
    const r = await hostNginxInstalledCheck.run({ config: {}, state } as never);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('not installed');
  });
});

describe('docker.runtime-available check', () => {
  it('skips when docker not initialized AND no containers', async () => {
    const r = await dockerRuntimeAvailableCheck.run(makeCtx() as never);
    expect(r.status).toBe('skip');
  });

  it('runs when docker initialized', async () => {
    // Initialized but no containers — check runs.
    // detectRuntime will probe Podroid first; we mock exec to make it
    // return "podroid-forward not on PATH" so detection falls through.
    execMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
      failed: false,
      timedOut: false,
      command: '',
    });
    const r = await dockerRuntimeAvailableCheck.run(makeCtx({ initialized: true }) as never);
    // No runtime found → fail.
    expect(r.status).toBe('fail');
    expect(r.fixCommand).toBe('linuxify docker init');
  });
});

describe('docker.port-allocation check', () => {
  it('skips when not initialized AND no containers', async () => {
    const r = await dockerPortAllocationCheck.run(makeCtx() as never);
    expect(r.status).toBe('skip');
  });

  it('passes on a clean state', async () => {
    const r = await dockerPortAllocationCheck.run(makeCtx({ initialized: true }) as never);
    expect(r.status).toBe('ok');
  });

  it('warns when next_port_hint is outside range', async () => {
    const r = await dockerPortAllocationCheck.run(
      makeCtx({ initialized: true, next_port_hint: 7000 }) as never,
    );
    expect(r.status).toBe('warn');
    expect(JSON.stringify(r.detail)).toContain('next_port_hint');
  });

  it('warns on duplicate host_ports', async () => {
    const now = new Date().toISOString();
    const containers: DockerState['containers'] = [
      {
        name: 'a', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: now,
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      },
      {
        name: 'b', image: 'nginx', container_id: 'b', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: now,
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      },
    ];
    const r = await dockerPortAllocationCheck.run(
      makeCtx({ initialized: true, containers }) as never,
    );
    expect(r.status).toBe('warn');
    expect(JSON.stringify(r.detail)).toContain('Duplicate');
  });
});

describe('docker.arm64-support check', () => {
  it('skips when docker not initialized', async () => {
    const r = await dockerArm64SupportCheck.run(makeCtx() as never);
    expect(r.status).toBe('skip');
  });

  it('passes on a known arch (x86_64)', async () => {
    // process.arch is x86_64 in the test env; just verify the check
    // resolves to 'ok'.
    const r = await dockerArm64SupportCheck.run(makeCtx({ initialized: true }) as never);
    expect(r.status).toBe('ok');
  });
});

describe('docker.wake-lock check', () => {
  it('passes when no containers', async () => {
    const r = await dockerWakeLockCheck.run(makeCtx() as never);
    expect(r.status).toBe('ok');
    expect(r.message).toContain('No containers');
  });

  it('passes when wake lock enabled + containers exist', async () => {
    const now = new Date().toISOString();
    const r = await dockerWakeLockCheck.run(
      makeCtx({
        wake_lock_enabled: true,
        containers: [
          {
            name: 'a', image: 'nginx', container_id: 'a', runtime: 'podroid',
            host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: now,
            restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
          },
        ],
      }) as never,
    );
    expect(r.status).toBe('ok');
    expect(r.message).toContain('Wake lock enabled');
  });

  it('warns when containers exist but wake lock disabled', async () => {
    const now = new Date().toISOString();
    const r = await dockerWakeLockCheck.run(
      makeCtx({
        wake_lock_enabled: false,
        containers: [
          {
            name: 'a', image: 'nginx', container_id: 'a', runtime: 'podroid',
            host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: now,
            restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
          },
        ],
      }) as never,
    );
    expect(r.status).toBe('warn');
    expect(r.message).toContain('DISABLED');
    expect(r.fixCommand).toContain('--wake-lock on');
  });
});

describe('registration of new checks', () => {
  it('hosting.config-state has the right metadata', () => {
    expect(hostConfigStateCheck.id).toBe('hosting.config-state');
    expect(hostConfigStateCheck.category).toBe('services');
    expect(hostConfigStateCheck.profile).toContain('standard');
    expect(hostConfigStateCheck.profile).toContain('deep');
    expect(hostConfigStateCheck.profile).toContain('post-install');
  });

  it('hosting.nginx-installed has the right metadata', () => {
    expect(hostNginxInstalledCheck.id).toBe('hosting.nginx-installed');
    expect(hostNginxInstalledCheck.category).toBe('services');
    expect(hostNginxInstalledCheck.profile).toContain('deep');
    expect(hostNginxInstalledCheck.profile).toContain('post-install');
  });

  it('docker.runtime-available has the right metadata', () => {
    expect(dockerRuntimeAvailableCheck.id).toBe('docker.runtime-available');
    expect(dockerRuntimeAvailableCheck.category).toBe('services');
    expect(dockerRuntimeAvailableCheck.profile).toContain('standard');
  });

  it('docker.port-allocation has the right metadata', () => {
    expect(dockerPortAllocationCheck.id).toBe('docker.port-allocation');
    expect(dockerPortAllocationCheck.category).toBe('services');
  });

  it('docker.arm64-support has the right metadata', () => {
    expect(dockerArm64SupportCheck.id).toBe('docker.arm64-support');
    expect(dockerArm64SupportCheck.category).toBe('services');
  });

  it('docker.wake-lock has the right metadata', () => {
    expect(dockerWakeLockCheck.id).toBe('docker.wake-lock');
    expect(dockerWakeLockCheck.category).toBe('services');
  });
});
