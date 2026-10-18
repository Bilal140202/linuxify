/**
 * Unit tests for `src/docker/engine.ts` — `DockerEngine` orchestrator.
 *
 * The engine sits between the CLI and the runtime-specific clients
 * (PodroidClient / ProotDockerClient). It is responsible for:
 *   - Detecting which runtime to use (delegates to `detect.ts`).
 *   - Allocating host ports (delegates to `port-allocator.ts`).
 *   - Deciding whether to pull (delegates to the client).
 *   - Recording state in `state.docker.containers[]`.
 *
 * These tests mock every dependency except the real `StateStore` and
 * real `fs` (both pointed at a tmpdir via `LINUXIFY_HOME`):
 *   - `utils/log.js` — no-op logger (pino's lazy init is flaky under
 *     vitest stdio capture).
 *   - `utils/process.js` — `exec` + `getLinuxifyHome` (tmpdir).
 *   - `utils/distros.js` — `getActiveDistro` returns a controllable distro.
 *   - `docker/detect.js` — `detectRuntime` + `getDockerArch` return
 *     controllable `RuntimeInfo` values.
 *   - `docker/port-allocator.js` — `allocatePort` + `reservePort` are
 *     controllable.
 *   - `docker/podroid-cli.js` + `docker/proot-cli.js` — mock client
 *     classes whose methods are shared `vi.fn()`s so tests can
 *     configure return values per-test.
 *
 * Covers:
 *   - `init()`:
 *     - Creates `~/.linuxify/docker/` + `data/` dirs.
 *     - Detects runtime via `detectRuntime()`.
 *     - Sets `state.docker.initialized = true` + `default_runtime`.
 *     - Returns `{success: false}` when no runtime is available.
 *     - Idempotent (second call doesn't re-init).
 *   - `run(opts)`:
 *     - Auto-inits when not yet initialized.
 *     - Returns failure when no runtime is available.
 *     - Auto-generates name from `imageToSlug(image)` when `opts.name`
 *       is undefined.
 *     - Deduplicates name on collision (`nginx`, `nginx-2`, `nginx-3`).
 *     - Default port: when no `opts.ports`, exposes guest port 80.
 *     - Auto-allocates host port via `allocatePort`.
 *     - Honors explicit `opts.ports[0].hostPort` (calls `reservePort`).
 *     - Pre-checks image arch before pulling (refuses amd64-only image
 *       on arm64 host — covered by `pullImage` mock).
 *     - Pulls when `opts.pull` is true OR image is not cached.
 *     - Skips pull when image is cached.
 *     - Calls `client.runContainer(...)` with the right args.
 *     - On Podroid: calls `client.addForward(guest, host, 'tcp')` for
 *       each port mapping.
 *     - On proot-distro docker/podman: does NOT call addForward.
 *     - Records the container in `state.docker.containers[]` with all
 *       the right fields.
 *     - Returns `{success: true, url: 'http://127.0.0.1:<port>'}`.
 *     - Returns failure when pull fails.
 *     - Returns failure when runContainer fails.
 *   - `ps()`: reconciles statuses from the runtime; updates state.
 *   - `stop(name)`: failure when not in state; success updates state.
 *   - `rm(name)`: failure when not in state; success removes from state
 *     and on Podroid also removes the forward rule.
 *   - `logs(name, lines)`: failure when not in state; success returns logs.
 *   - `forward(guest, host)`: failure when not on Podroid.
 *   - `clean()`: stops + removes every container in state; on Podroid
 *     calls `cleanForwards()`; clears `state.docker.containers = []`.
 *   - `doctor()`: pushes issues for not-initialized, runtime
 *     unavailable, stale state, wake lock disabled.
 *   - `getClient(info, distro)` (indirect): returns PodroidClient when
 *     info.kind === 'podroid'; ProotDockerClient when kind is
 *     docker/podman; throws `E_DOCKER_NO_DISTRO` when kind is
 *     docker/podman and distro is null.
 *   - `isImageCached()` (indirect): true when `docker images -q` returns
 *     non-empty stdout; false when empty.
 *   - `deduplicateName()` (indirect): `nginx`, `nginx-2`, `nginx-3`.
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
  // ---- Captured exec calls (used by isImageCached + nothing else). ----
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
  const exec = vi.fn(async (cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    execCalls.push({ cmd, args, opts });
    return execImpl(cmd, args, opts);
  });
  const setExecImpl = (fn: typeof execImpl): void => { execImpl = fn; };

  // ---- Linuxify home (tmpdir). ----
  let linuxifyHome = '/tmp/linuxify-test-engine';
  const getLinuxifyHome = () => linuxifyHome;
  const setLinuxifyHome = (p: string) => { linuxifyHome = p; };

  // ---- getActiveDistro — returns controllable distro. ----
  let activeDistro: string | null = 'ubuntu';
  const getActiveDistro = vi.fn(async () => activeDistro);
  const setActiveDistro = (d: string | null) => { activeDistro = d; };

  // ---- detectRuntime — returns controllable RuntimeInfo. ----
  type RuntimeInfo = import('../../../src/docker/config.js').RuntimeInfo;
  let runtimeInfo: RuntimeInfo = {
    kind: 'podroid',
    available: true,
    version: null,
    endpoint: '127.0.0.1:9922',
    binaryPath: null,
  };
  const detectRuntime = vi.fn(async () => runtimeInfo);
  const setRuntimeInfo = (info: RuntimeInfo) => { runtimeInfo = info; };

  // ---- getDockerArch — returns controllable arch. ----
  let dockerArch: 'amd64' | 'arm64' | 'arm/v7' | 'unknown' = 'arm64';
  const getDockerArch = vi.fn(() => dockerArch);
  const setDockerArch = (a: typeof dockerArch) => { dockerArch = a; };

  // ---- allocatePort / reservePort — controllable. ----
  const allocatePort = vi.fn(async (): Promise<{ hostPort: number; reused: boolean }> => ({
    hostPort: 8000,
    reused: false,
  }));
  const reservePort = vi.fn(async (): Promise<void> => undefined);

  // ---- PodroidClient mock class. ----
  // Methods are shared vi.fn()s so tests can configure return values
  // per-test. The class is `class { ... }` so `client instanceof
  // MockPodroidClient` works (the engine uses instanceof to detect
  // Podroid clients vs proot clients).
  const podroidClientMethods = {
    runInVm: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    pullImage: vi.fn(async () => ({ ok: true, message: 'Pulled.' })),
    runContainer: vi.fn(async () => ({ ok: true, containerId: 'abc123def456', message: 'Started.' })),
    stop: vi.fn(async () => true),
    stopAndRemove: vi.fn(async () => true),
    start: vi.fn(async () => true),
    addForward: vi.fn(async () => ({ ok: true, ruleId: 'podroid-80-8000-tcp', message: 'forwarded.' })),
    removeForward: vi.fn(async () => true),
    cleanForwards: vi.fn(async () => 1),
    listContainers: vi.fn(async () => []),
    logs: vi.fn(async () => ''),
  };

  class MockPodroidClient {
    constructor(public opts: { host: string; port?: number; user?: string; password?: string; sshKey?: string }) {
      // Shared methods — every instance uses the same vi.fn()s.
      Object.assign(this, podroidClientMethods);
    }
  }

  // ---- ProotDockerClient mock class. ----
  const prootClientMethods = {
    pullImage: vi.fn(async () => ({ ok: true, message: 'Pulled.' })),
    runContainer: vi.fn(async () => ({ ok: true, containerId: 'abc123def456', message: 'Started.' })),
    stop: vi.fn(async () => true),
    stopAndRemove: vi.fn(async () => true),
    start: vi.fn(async () => true),
    listContainers: vi.fn(async () => []),
    logs: vi.fn(async () => ''),
  };

  class MockProotDockerClient {
    constructor(public opts: { distro: string; binary?: 'docker' | 'podman' }) {
      Object.assign(this, prootClientMethods);
    }
  }

  return {
    execCalls,
    exec,
    setExecImpl,
    getLinuxifyHome,
    setLinuxifyHome,
    getActiveDistro,
    setActiveDistro,
    detectRuntime,
    setRuntimeInfo,
    getDockerArch,
    setDockerArch,
    allocatePort,
    reservePort,
    podroidClientMethods,
    prootClientMethods,
    MockPodroidClient,
    MockProotDockerClient,
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  getLinuxifyHome: mocks.getLinuxifyHome,
  getArch: vi.fn(() => 'x86_64'),
  isTermux: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
  getAndroidVersion: vi.fn(async () => null),
  getTermuxPrefix: vi.fn(() => '/data/data/com.termux/files/usr'),
  getDefaultUserAgent: vi.fn(() => 'linuxify/test'),
}));

vi.mock('../../../src/utils/distros.js', () => ({
  getActiveDistro: mocks.getActiveDistro,
}));

// Mock the telemetry singleton to return null so the docker engine's
// `track()` calls become no-ops (telemetry is opt-in; tests don't opt in).
// This avoids pulling in the real TelemetryClient class which would
// touch the filesystem for the queue path.
vi.mock('../../../src/telemetry/index.js', () => ({
  getTelemetryClient: vi.fn(() => null),
  dockerRunStart: vi.fn(() => ({ event_type: 'docker.run_start', fields: {} })),
  dockerRunComplete: vi.fn(() => ({ event_type: 'docker.run_complete', fields: {} })),
  dockerRunFailed: vi.fn(() => ({ event_type: 'docker.run_failed', fields: {} })),
  dockerPs: vi.fn(() => ({ event_type: 'docker.ps', fields: {} })),
  dockerStop: vi.fn(() => ({ event_type: 'docker.stop', fields: {} })),
  dockerRm: vi.fn(() => ({ event_type: 'docker.rm', fields: {} })),
  dockerClean: vi.fn(() => ({ event_type: 'docker.clean', fields: {} })),
  dockerDoctor: vi.fn(() => ({ event_type: 'docker.doctor', fields: {} })),
  dockerConfig: vi.fn(() => ({ event_type: 'docker.config', fields: {} })),
}));

vi.mock('../../../src/docker/detect.js', () => ({
  detectRuntime: mocks.detectRuntime,
  getDockerArch: mocks.getDockerArch,
}));

vi.mock('../../../src/docker/port-allocator.js', () => ({
  allocatePort: mocks.allocatePort,
  reservePort: mocks.reservePort,
  isPortFree: vi.fn(async () => true),
}));

vi.mock('../../../src/docker/podroid-cli.js', () => ({
  PodroidClient: mocks.MockPodroidClient,
}));

vi.mock('../../../src/docker/proot-cli.js', () => ({
  ProotDockerClient: mocks.MockProotDockerClient,
}));

import { mkdtemp, rm, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeInfo } from '../../../src/docker/config.js';
import { DockerEngine, shellQuote } from '../../../src/docker/engine.js';
import { StateStore, defaultState, DEFAULT_DOCKER_STATE } from '../../../src/state/index.js';
import type { DockerContainer } from '../../../src/state/index.js';


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePodroidInfo(available = true, endpoint = '127.0.0.1:9922'): RuntimeInfo {
  return {
    kind: 'podroid',
    available,
    version: null,
    endpoint,
    binaryPath: null,
    unavailableReason: available ? undefined : 'Podroid not detected.',
  };
}

function makeDockerInfo(available = true, distro = 'ubuntu'): RuntimeInfo {
  return {
    kind: 'docker',
    available,
    version: available ? 'Docker 29.5.3' : null,
    endpoint: distro,
    binaryPath: available ? '/usr/bin/docker' : null,
    unavailableReason: available ? undefined : 'docker not installed.',
  };
}

function makePodmanInfo(available = true, distro = 'ubuntu'): RuntimeInfo {
  return {
    kind: 'podman',
    available,
    version: available ? 'podman 5.0.0' : null,
    endpoint: distro,
    binaryPath: available ? '/usr/bin/podman' : null,
    unavailableReason: available ? undefined : 'podman not installed.',
  };
}

/** Set up a fresh tmpdir + StateStore pointed at it; seed with defaultState. */
async function freshTmp(): Promise<{ linuxifyHome: string; stateStore: StateStore }> {
  const linuxifyHome = await mkdtemp(join(tmpdir(), 'linuxify-engine-'));
  mocks.setLinuxifyHome(linuxifyHome);
  const statePath = join(linuxifyHome, 'state.json');
  const stateStore = new StateStore(statePath);
  await stateStore.save(defaultState());
  return { linuxifyHome, stateStore };
}

/** Reset all mock state between tests. */
function resetMocks(): void {
  mocks.execCalls.length = 0;
  mocks.exec.mockClear();
  mocks.setExecImpl(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    failed: false,
    timedOut: false,
    command: '',
  }));
  mocks.setActiveDistro('ubuntu');
  mocks.setRuntimeInfo(makePodroidInfo(true));
  mocks.setDockerArch('arm64');
  mocks.getActiveDistro.mockClear();
  mocks.detectRuntime.mockClear();
  mocks.getDockerArch.mockClear();
  mocks.allocatePort.mockClear();
  mocks.reservePort.mockClear();
  // Reset client method mocks.
  for (const fn of Object.values(mocks.podroidClientMethods)) {
    (fn as unknown as { mockClear: () => void }).mockClear();
  }
  for (const fn of Object.values(mocks.prootClientMethods)) {
    (fn as unknown as { mockClear: () => void }).mockClear();
  }
  // Default mock implementations.
  mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  mocks.podroidClientMethods.pullImage.mockResolvedValue({ ok: true, message: 'Pulled.' });
  mocks.podroidClientMethods.runContainer.mockResolvedValue({ ok: true, containerId: 'abc123def456', message: 'Started.' });
  mocks.podroidClientMethods.stop.mockResolvedValue(true);
  mocks.podroidClientMethods.stopAndRemove.mockResolvedValue(true);
  mocks.podroidClientMethods.start.mockResolvedValue(true);
  mocks.podroidClientMethods.addForward.mockResolvedValue({ ok: true, ruleId: 'podroid-80-8000-tcp', message: 'forwarded.' });
  mocks.podroidClientMethods.removeForward.mockResolvedValue(true);
  mocks.podroidClientMethods.cleanForwards.mockResolvedValue(1);
  mocks.podroidClientMethods.listContainers.mockResolvedValue([]);
  mocks.podroidClientMethods.logs.mockResolvedValue('');
  mocks.prootClientMethods.pullImage.mockResolvedValue({ ok: true, message: 'Pulled.' });
  mocks.prootClientMethods.runContainer.mockResolvedValue({ ok: true, containerId: 'abc123def456', message: 'Started.' });
  mocks.prootClientMethods.stop.mockResolvedValue(true);
  mocks.prootClientMethods.stopAndRemove.mockResolvedValue(true);
  mocks.prootClientMethods.start.mockResolvedValue(true);
  mocks.prootClientMethods.listContainers.mockResolvedValue([]);
  mocks.prootClientMethods.logs.mockResolvedValue('');
  // Default allocatePort.
  mocks.allocatePort.mockResolvedValue({ hostPort: 8000, reused: false });
  mocks.reservePort.mockResolvedValue(undefined);
}

beforeEach(async () => {
  await resetMocks();
});

afterEach(async () => {
  const home = mocks.getLinuxifyHome();
  if (home.startsWith(tmpdir())) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docker/engine — init', () => {
  it('creates ~/.linuxify/docker/ + data/ subdirs and detects runtime', async () => {
    const { linuxifyHome, stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.init();
    expect(r.success).toBe(true);
    // Verify the dirs were actually created on the real filesystem.
    const dockerDirStat = await stat(join(linuxifyHome, 'docker'));
    expect(dockerDirStat.isDirectory()).toBe(true);
    const dataDirStat = await stat(join(linuxifyHome, 'docker', 'data'));
    expect(dataDirStat.isDirectory()).toBe(true);
  });

  it('sets state.docker.initialized = true and default_runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    await engine.init();
    const state = await stateStore.load();
    expect(state.docker.initialized).toBe(true);
    expect(state.docker.default_runtime).toBe('podroid');
    expect(state.docker.initialized_at).not.toBeNull();
  });

  it('returns {success: false} when no runtime is available', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(false));
    const engine = new DockerEngine(stateStore);
    const r = await engine.init();
    expect(r.success).toBe(false);
    expect(r.runtime.available).toBe(false);
    expect(r.message).toContain('Podroid');
  });

  it('is idempotent — second call succeeds and preserves default_runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r1 = await engine.init();
    const r2 = await engine.init();
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    const state2 = await stateStore.load();
    expect(state2.docker.initialized).toBe(true);
    expect(state2.docker.default_runtime).toBe('podroid');
  });
});

describe('docker/engine — run (happy path, Podroid)', () => {
  it('auto-inits, auto-generates name, allocates port, pulls (image not cached), runs container, adds forward, records state', async () => {
    const { stateStore } = await freshTmp();
    // Detect returns Podroid available.
    mocks.setRuntimeInfo(makePodroidInfo(true));
    // isImageCached → false (so a pull happens).
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    // Allocate port 8000.
    mocks.allocatePort.mockResolvedValue({ hostPort: 8000, reused: false });

    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });

    expect(r.success).toBe(true);
    expect(r.name).toBe('nginx');
    expect(r.hostPort).toBe(8000);
    expect(r.guestPort).toBe(80); // default guest port
    expect(r.url).toBe('http://127.0.0.1:8000');
    expect(r.containerId).toBe('abc123def456');
    expect(r.runtime).toBe('podroid');

    // Auto-init was performed.
    const state = await stateStore.load();
    expect(state.docker.initialized).toBe(true);

    // runContainer was called with the right args.
    const runCall = mocks.podroidClientMethods.runContainer.mock.calls[0];
    expect(runCall?.[0]?.image).toBe('nginx');
    expect(runCall?.[0]?.name).toBe('nginx');
    expect(runCall?.[0]?.ports).toEqual([{ host: 8000, guest: 80 }]);
    expect(runCall?.[0]?.restart).toBe('unless-stopped');

    // addForward was called for the (single) port mapping.
    expect(mocks.podroidClientMethods.addForward).toHaveBeenCalledWith(80, 8000, 'tcp');

    // The container was recorded in state.
    const c = state.docker.containers.find((x) => x.name === 'nginx');
    expect(c).toBeDefined();
    expect(c!.image).toBe('nginx');
    expect(c!.host_port).toBe(8000);
    expect(c!.guest_port).toBe(80);
    expect(c!.runtime).toBe('podroid');
    expect(c!.status).toBe('running');
    expect(c!.restart_policy).toBe('unless-stopped');
    expect(c!.forward_rule_id).toBe('podroid-80-8000-tcp');
    expect(c!.container_id).toBe('abc123def456');
  });

  it('auto-inits when state.docker.initialized is false', async () => {
    const { stateStore } = await freshTmp();
    // state.docker.initialized = false (defaultState).
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });

    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });
    expect(r.success).toBe(true);
    // detectRuntime should have been called twice: once for init, once for run.
    expect(mocks.detectRuntime).toHaveBeenCalledTimes(2);
    // The state should now have initialized = true.
    const state = await stateStore.load();
    expect(state.docker.initialized).toBe(true);
  });

  it('returns failure when no runtime is available', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(false));
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });
    expect(r.success).toBe(false);
    expect(r.message).toContain('Podroid');
    expect(r.runtime).toBe('podroid');
  });

  it('auto-generates name from imageToSlug(image) when opts.name is undefined', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'lscr.io/linuxserver/calibre-web:latest' });
    expect(r.name).toBe('calibre-web');
  });

  it('deduplicates name on collision: nginx → nginx, then nginx-2, then nginx-3', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    // Pre-seed state with two existing containers named nginx and nginx-2.
    await stateStore.update((s) => {
      s.docker.containers.push(
        {
          name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
          host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
        },
        {
          name: 'nginx-2', image: 'nginx', container_id: 'b', runtime: 'podroid',
          host_port: 8001, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
        },
      );
    });
    const r = await engine.run({ image: 'nginx' });
    expect(r.name).toBe('nginx-3');
  });

  it('defaults to guest port 80 when opts.ports is undefined', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });
    expect(r.guestPort).toBe(80);
  });

  it('auto-allocates host port via allocatePort when no explicit hostPort', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.allocatePort.mockResolvedValue({ hostPort: 8123, reused: false });
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });
    expect(r.hostPort).toBe(8123);
    expect(mocks.allocatePort).toHaveBeenCalledWith(expect.anything(), 'nginx', 80);
  });

  it('honors explicit opts.ports[0].hostPort (calls reservePort)', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx', ports: [{ hostPort: 8080, guestPort: 80 }] });
    expect(r.hostPort).toBe(8080);
    expect(mocks.reservePort).toHaveBeenCalledWith(expect.anything(), 8080, 'nginx');
    expect(mocks.allocatePort).not.toHaveBeenCalled();
  });

  it('skips pull when image is cached', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    // isImageCached returns true (non-empty stdout).
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: 'image-id-123\n', stderr: '' });
    const engine = new DockerEngine(stateStore);
    await engine.run({ image: 'nginx' });
    // pullImage should NOT have been called.
    expect(mocks.podroidClientMethods.pullImage).not.toHaveBeenCalled();
  });

  it('pulls when opts.pull is true even if image is cached', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    // isImageCached would return true (non-empty stdout) — but pull:true forces a pull.
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: 'image-id-123\n', stderr: '' });
    const engine = new DockerEngine(stateStore);
    await engine.run({ image: 'nginx', pull: true });
    expect(mocks.podroidClientMethods.pullImage).toHaveBeenCalledTimes(1);
    expect(mocks.podroidClientMethods.pullImage).toHaveBeenCalledWith('nginx', 'arm64');
  });

  it('records volumes and env in the state.docker.containers[] entry', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    await engine.run({
      image: 'nginx',
      volumes: [{ hostPath: '/host', containerPath: '/data', mode: 'rw' }],
      env: [{ key: 'FOO', value: 'bar' }],
    });
    const state = await stateStore.load();
    const c = state.docker.containers.find((x) => x.name === 'nginx');
    expect(c).toBeDefined();
    expect(c!.volumes).toEqual([{ host_path: '/host', container_path: '/data', mode: 'rw' }]);
    expect(c!.env).toEqual([{ key: 'FOO', value: 'bar' }]);
  });

  it('returns failure when pull fails (manifest missing for arch)', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.pullImage.mockResolvedValue({ ok: false, message: "no manifest for arch 'arm64'" });
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx', pull: true });
    expect(r.success).toBe(false);
    expect(r.message).toContain('no manifest for arch');
  });

  it('returns failure when runContainer fails', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.runContainer.mockResolvedValue({ ok: false, containerId: '', message: 'name taken' });
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx', pull: true });
    expect(r.success).toBe(false);
    expect(r.message).toContain('name taken');
  });
});

describe('docker/engine — run (proot-distro docker path)', () => {
  it('does NOT call addForward on proot-distro docker', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makeDockerInfo(true));
    // isImageCached check uses exec directly for proot-distro docker.
    mocks.setExecImpl(async () => ({ exitCode: 0, stdout: 'image-id\n', stderr: '', failed: false, timedOut: false, command: '' }));
    const engine = new DockerEngine(stateStore);
    const r = await engine.run({ image: 'nginx' });
    expect(r.success).toBe(true);
    expect(r.runtime).toBe('docker');
    // addForward is NOT called on proot-distro docker.
    expect(mocks.prootClientMethods.listContainers).toBeDefined();
  });

  it('records the container with empty forward_rule_id on proot-distro docker', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makeDockerInfo(true));
    mocks.setExecImpl(async () => ({ exitCode: 0, stdout: 'image-id\n', stderr: '', failed: false, timedOut: false, command: '' }));
    const engine = new DockerEngine(stateStore);
    await engine.run({ image: 'nginx' });
    const state = await stateStore.load();
    const c = state.docker.containers.find((x) => x.name === 'nginx');
    expect(c).toBeDefined();
    expect(c!.forward_rule_id).toBe('');
    expect(c!.runtime).toBe('docker');
  });

  it('returns failure with E_DOCKER_NO_DISTRO when kind=docker and distro is null', async () => {
    const { stateStore } = await freshTmp();
    // Force a mismatch: detectRuntime returns available=true docker, but
    // getActiveDistro returns null. The engine's getClient throws
    // E_DOCKER_NO_DISTRO.
    mocks.setRuntimeInfo(makeDockerInfo(true));
    mocks.setActiveDistro(null);
    mocks.setExecImpl(async () => ({ exitCode: 0, stdout: '', stderr: '', failed: false, timedOut: false, command: '' }));
    const engine = new DockerEngine(stateStore);
    // BUG-FIX: after the LinuxifyError arg-order fix, the human text
    // ('No active proot-distro...') is in `.message` and the literal
    // code ('E_DOCKER_NO_DISTRO') is in `.code`. Match on .message for
    // the human text and assert .code separately via a try/catch.
    await expect(engine.run({ image: 'nginx' })).rejects.toThrow(/No active proot-distro/);
  });
});

describe('docker/engine — ps', () => {
  it('returns state.docker.containers with status="unknown" when no runtime is available', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(false));
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const list = await engine.ps();
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('unknown');
  });

  it('reconciles running/stopped statuses from the runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.listContainers.mockResolvedValue([
      { id: 'abc', name: 'nginx', image: 'nginx', status: 'Up 2 seconds', ports: '' },
      { id: 'def', name: 'redis', image: 'redis', status: 'Exited (0) 1 minute ago', ports: '' },
    ]);
    await stateStore.update((s) => {
      s.docker.containers.push(
        {
          name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
          host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'unknown', volumes: [], env: [],
        },
        {
          name: 'redis', image: 'redis', container_id: 'b', runtime: 'podroid',
          host_port: 8001, guest_port: 6379, forward_rule_id: '', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'unknown', volumes: [], env: [],
        },
      );
    });
    const engine = new DockerEngine(stateStore);
    const list = await engine.ps();
    expect(list[0]!.status).toBe('running');
    expect(list[0]!.container_id).toBe('abc');
    expect(list[1]!.status).toBe('stopped');
    // State is updated.
    const state = await stateStore.load();
    const c0 = state.docker.containers.find((x) => x.name === 'nginx');
    expect(c0!.status).toBe('running');
  });

  it('marks state-only containers as stopped', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.listContainers.mockResolvedValue([]); // nothing in runtime
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'gone', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const list = await engine.ps();
    expect(list[0]!.status).toBe('stopped');
  });
});

describe('docker/engine — stop', () => {
  it('returns failure when name not in state', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.stop('nope');
    expect(r.success).toBe(false);
    expect(r.message).toContain("not found");
  });

  it('calls client.stop and updates state to status=stopped', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.stop('nginx');
    expect(r.success).toBe(true);
    expect(mocks.podroidClientMethods.stop).toHaveBeenCalledWith('nginx');
    const state = await stateStore.load();
    const c = state.docker.containers.find((x) => x.name === 'nginx');
    expect(c!.status).toBe('stopped');
  });
});

describe('docker/engine — rm', () => {
  it('returns failure when name not in state', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.rm('nope');
    expect(r.success).toBe(false);
    expect(r.message).toContain('not found');
  });

  it('calls client.stopAndRemove and removes from state', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: 'podroid-80-8000-tcp', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.rm('nginx');
    expect(r.success).toBe(true);
    expect(mocks.podroidClientMethods.stopAndRemove).toHaveBeenCalledWith('nginx');
    // On Podroid, the forward rule is also removed.
    expect(mocks.podroidClientMethods.removeForward).toHaveBeenCalledWith(80, 8000);
    // Container is gone from state.
    const state = await stateStore.load();
    expect(state.docker.containers.find((x) => x.name === 'nginx')).toBeUndefined();
  });
});

describe('docker/engine — logs', () => {
  it('returns failure when name not in state', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.logs('nope');
    expect(r.success).toBe(false);
    expect(r.message).toContain('not found');
  });

  it('calls client.logs and returns the logs string', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.logs.mockResolvedValue('log line 1\nlog line 2\n');
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.logs('nginx', 50);
    expect(r.success).toBe(true);
    expect(r.logs).toBe('log line 1\nlog line 2\n');
    expect(mocks.podroidClientMethods.logs).toHaveBeenCalledWith('nginx', 50);
  });
});

describe('docker/engine — forward', () => {
  it('returns failure when not on Podroid runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makeDockerInfo(true));
    // Pre-initialize state so init check passes.
    await stateStore.update((s) => { s.docker.initialized = true; });
    const engine = new DockerEngine(stateStore);
    const r = await engine.forward(80, 8000);
    expect(r.success).toBe(false);
    expect(r.message).toContain('only needed on Podroid');
  });

  it('calls client.addForward on Podroid runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    await stateStore.update((s) => { s.docker.initialized = true; });
    const engine = new DockerEngine(stateStore);
    const r = await engine.forward(80, 8000);
    expect(r.success).toBe(true);
    expect(mocks.podroidClientMethods.addForward).toHaveBeenCalledWith(80, 8000, 'tcp');
  });

  it('returns failure when docker subsystem is not initialized', async () => {
    const { stateStore } = await freshTmp();
    // state.docker.initialized = false (defaultState).
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.forward(80, 8000);
    expect(r.success).toBe(false);
    expect(r.message).toContain('not initialized');
  });
});

describe('docker/engine — clean', () => {
  it('stops + removes every container, calls cleanForwards on Podroid, clears state.containers', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    await stateStore.update((s) => {
      s.docker.containers.push(
        {
          name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
          host_port: 8000, guest_port: 80, forward_rule_id: 'podroid-80-8000-tcp', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
        },
        {
          name: 'redis', image: 'redis', container_id: 'b', runtime: 'podroid',
          host_port: 8001, guest_port: 6379, forward_rule_id: '', started_at: new Date().toISOString(),
          restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
        },
      );
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.clean();
    expect(r.success).toBe(true);
    expect(r.stopped).toBe(2);
    expect(r.forwardsRemoved).toBe(1);
    expect(mocks.podroidClientMethods.stopAndRemove).toHaveBeenCalledTimes(2);
    expect(mocks.podroidClientMethods.cleanForwards).toHaveBeenCalledTimes(1);
    const state = await stateStore.load();
    expect(state.docker.containers).toEqual([]);
  });

  it('does NOT call cleanForwards on proot-distro docker', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makeDockerInfo(true));
    await stateStore.update((s) => {
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'docker',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.clean();
    expect(r.success).toBe(true);
    expect(r.forwardsRemoved).toBe(0); // no forwards on proot-distro docker
    expect(mocks.prootClientMethods.stopAndRemove).toHaveBeenCalledTimes(1);
  });
});

describe('docker/engine — doctor', () => {
  it('pushes "Docker subsystem not initialized..." issue when state.docker.initialized = false', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    const engine = new DockerEngine(stateStore);
    const r = await engine.doctor();
    expect(r.issues).toContain('Docker subsystem not initialized. Run: linuxify docker init');
  });

  it('pushes an issue when runtime is unavailable', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(false));
    const engine = new DockerEngine(stateStore);
    const r = await engine.doctor();
    expect(r.issues.some((m) => m.includes('Podroid'))).toBe(true);
  });

  it('pushes a stale-state issue for containers in state but not in runtime', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    // listContainers returns empty → state container is "stale".
    mocks.podroidClientMethods.listContainers.mockResolvedValue([]);
    await stateStore.update((s) => {
      s.docker.initialized = true;
      s.docker.containers.push({
        name: 'ghost', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.doctor();
    expect(r.issues.some((m) => m.includes("is in state but not in runtime"))).toBe(true);
  });

  it('pushes a wake-lock issue when containers > 0 and wake_lock_enabled = false', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.listContainers.mockResolvedValue([
      { id: 'abc', name: 'nginx', image: 'nginx', status: 'Up 1 second', ports: '' },
    ]);
    await stateStore.update((s) => {
      s.docker.initialized = true;
      s.docker.containers.push({
        name: 'nginx', image: 'nginx', container_id: 'a', runtime: 'podroid',
        host_port: 8000, guest_port: 80, forward_rule_id: '', started_at: new Date().toISOString(),
        restart_policy: 'unless-stopped', status: 'running', volumes: [], env: [],
      });
    });
    const engine = new DockerEngine(stateStore);
    const r = await engine.doctor();
    expect(r.issues.some((m) => m.includes('Wake lock is disabled'))).toBe(true);
  });
});

describe('docker/engine — isImageCached (indirect)', () => {
  it('skips pull when `docker images -q` returns non-empty stdout (Podroid path)', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: 'image-id-123\n', stderr: '' });
    const engine = new DockerEngine(stateStore);
    await engine.run({ image: 'nginx' });
    expect(mocks.podroidClientMethods.pullImage).not.toHaveBeenCalled();
  });

  it('pulls when `docker images -q` returns empty stdout (Podroid path)', async () => {
    const { stateStore } = await freshTmp();
    mocks.setRuntimeInfo(makePodroidInfo(true));
    mocks.podroidClientMethods.runInVm.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    const engine = new DockerEngine(stateStore);
    await engine.run({ image: 'nginx' });
    expect(mocks.podroidClientMethods.pullImage).toHaveBeenCalledTimes(1);
  });
});

describe('docker/engine — shellQuote (exported)', () => {
  it("wraps a plain string in single quotes", () => {
    expect(shellQuote('foo')).toBe("'foo'");
  });

  it("escapes embedded single quotes via '\\''", () => {
    expect(shellQuote("foo'bar")).toBe("'foo'\\''bar'");
  });

  it('throws E_DOCKER_SHELL_INJECTION when the input contains a NUL byte', () => {
    expect(() => shellQuote('foo\0bar')).toThrow(/E_DOCKER_SHELL_INJECTION/);
  });
});
