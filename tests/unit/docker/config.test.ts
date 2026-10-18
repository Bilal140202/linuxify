/**
 * Unit tests for `src/docker/config.ts` — pure helpers + Zod schemas +
 * exported constants.
 *
 * Covers:
 *   - `imageToSlug()`:
 *     - single-component image names pass through (`nginx` → `nginx`)
 *     - registry prefix stripped (`lscr.io/linuxserver/calibre-web:latest`
 *       → `calibre-web`)
 *     - namespace stripped (`iib0011/omni-tools:latest` → `omni-tools`)
 *     - tag stripped (`freshrss/freshrss:edge` → `freshrss`)
 *     - docker.io/library/ prefix stripped (`docker.io/library/postgres:16`
 *       → `postgres`)
 *     - empty string falls back to `container`
 *     - sanitization (`Foo BAR!` → `foo-bar`)
 *   - `PortMappingSchema`:
 *     - valid `{guestPort: 80}` parses
 *     - valid `{hostPort: 8080, guestPort: 80}` parses
 *     - `guestPort: 0` rejected (min 1)
 *     - `guestPort: 70000` rejected (max 65535)
 *     - `hostPort: 80` rejected (min 1024)
 *   - Default constants: `DEFAULT_RESTART_POLICY`,
 *     `DEFAULT_PORT_RANGE_START`, `DEFAULT_PORT_RANGE_END`.
 *
 * No mocks needed — `config.ts` is pure (only imports zod).
 */

import {
  imageToSlug,
  PortMappingSchema,
  DEFAULT_RESTART_POLICY,
  DEFAULT_PORT_RANGE_START,
  DEFAULT_PORT_RANGE_END,
} from '../../../src/docker/config.js';

describe('docker/config — imageToSlug', () => {
  it('passes through single-component image names', () => {
    expect(imageToSlug('nginx')).toBe('nginx');
  });

  it('strips the registry prefix and tag', () => {
    expect(imageToSlug('lscr.io/linuxserver/calibre-web:latest')).toBe('calibre-web');
  });

  it('strips a non-registry namespace and the tag', () => {
    // `iib0011` has no dot so it isn't treated as a registry prefix.
    expect(imageToSlug('iib0011/omni-tools:latest')).toBe('omni-tools');
  });

  it('strips the tag and collapses a repeated namespace/name', () => {
    expect(imageToSlug('freshrss/freshrss:edge')).toBe('freshrss');
  });

  it('strips the docker.io/library/ prefix and tag', () => {
    // `docker.io` has a dot so it's treated as a registry; `library` is
    // the implicit namespace; the last component is `postgres`.
    expect(imageToSlug('docker.io/library/postgres:16')).toBe('postgres');
  });

  it('falls back to "container" on empty input', () => {
    expect(imageToSlug('')).toBe('container');
  });

  it('sanitizes upper-case + punctuation to lowercase kebab', () => {
    expect(imageToSlug('Foo BAR!')).toBe('foo-bar');
  });

  it('sanitizes a slug that collapses to empty back to "container"', () => {
    // All non-alphanumerics → empty after sanitization.
    expect(imageToSlug('!!!')).toBe('container');
  });
});

describe('docker/config — PortMappingSchema', () => {
  it('parses a guest-only mapping', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 80 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.guestPort).toBe(80);
      expect(parsed.data.hostPort).toBeUndefined();
    }
  });

  it('parses a full host+guest mapping', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 8080, guestPort: 80 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hostPort).toBe(8080);
      expect(parsed.data.guestPort).toBe(80);
    }
  });

  it('rejects guestPort: 0 (min 1)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 0 });
    expect(parsed.success).toBe(false);
  });

  it('rejects guestPort: 70000 (max 65535)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 70000 });
    expect(parsed.success).toBe(false);
  });

  it('rejects hostPort: 80 (min 1024 — non-privileged range only)', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 80, guestPort: 80 });
    expect(parsed.success).toBe(false);
  });

  it('accepts hostPort: 1024 (boundary)', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 1024, guestPort: 80 });
    expect(parsed.success).toBe(true);
  });

  it('accepts guestPort: 1 (boundary)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 1 });
    expect(parsed.success).toBe(true);
  });
});

describe('docker/config — exported constants', () => {
  it('exposes DEFAULT_RESTART_POLICY = "unless-stopped"', () => {
    expect(DEFAULT_RESTART_POLICY).toBe('unless-stopped');
  });

  it('exposes DEFAULT_PORT_RANGE_START = 8000', () => {
    expect(DEFAULT_PORT_RANGE_START).toBe(8000);
  });

  it('exposes DEFAULT_PORT_RANGE_END = 8999', () => {
    expect(DEFAULT_PORT_RANGE_END).toBe(8999);
  });
});

// ===========================================================================
// Engine setConfig / getConfig tests + `linuxify docker config` CLI tests
//
// (Appended section — covers the new DockerEngine.setConfig()/getConfig()
// methods and the `case 'config':` block of `src/cli/commands/docker.ts`.)
//
// Mocks: utils/process.js, utils/distros.js, telemetry/index.js,
// docker/detect.js, docker/port-allocator.js, docker/podroid-cli.js,
// docker/proot-cli.js. getTelemetryClient returns null by default (so
// track() is a no-op); tests that assert telemetry calls either check
// the mocked dockerConfig event helper's .mock.calls directly, or
// override getTelemetryClient to return a fake client with a track spy.
// ===========================================================================

// ---------------------------------------------------------------------------
// Mocks (hoisted)
// ---------------------------------------------------------------------------

const cfgMocks = vi.hoisted(() => {
  // ---- Linuxify home (tmpdir, per-test). ----
  let linuxifyHome = '/tmp/linuxify-test-cfg';
  const getLinuxifyHome = () => linuxifyHome;
  const setLinuxifyHome = (p: string) => { linuxifyHome = p; };

  // ---- getActiveDistro — returns a controllable distro. ----
  let activeDistro: string | null = 'ubuntu';
  const getActiveDistro = vi.fn(async () => activeDistro);
  const setActiveDistro = (d: string | null) => { activeDistro = d; };

  // ---- detectRuntime — returns controllable RuntimeInfo. ----
  // Default: Podroid available so the engine doesn't probe real SSH.
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

  // ---- exec — used only by isImageCached on the proot path; not used by
  //          setConfig/getConfig, but the engine module imports it. ----
  const exec = vi.fn(async (cmd: string, args: string[] = []) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    failed: false,
    timedOut: false,
    command: [cmd, ...args].join(' '),
  }));

  // ---- Telemetry spies. ----
  // The mocked dockerConfig helper is the key spy for setConfig() telemetry
  // tests — the engine calls `dockerConfig(changedKeys, initialized)`
  // before reaching `client.track(...)`, so the spy's .mock.calls reflects
  // what the engine would have emitted, regardless of whether
  // getTelemetryClient returns null.
  const dockerConfig = vi.fn(() => ({ event_type: 'docker.config', fields: {} }));
  const dockerRunStart = vi.fn(() => ({ event_type: 'docker.run_start', fields: {} }));
  const dockerRunComplete = vi.fn(() => ({ event_type: 'docker.run_complete', fields: {} }));
  const dockerRunFailed = vi.fn(() => ({ event_type: 'docker.run_failed', fields: {} }));
  const dockerPs = vi.fn(() => ({ event_type: 'docker.ps', fields: {} }));
  const dockerStop = vi.fn(() => ({ event_type: 'docker.stop', fields: {} }));
  const dockerRm = vi.fn(() => ({ event_type: 'docker.rm', fields: {} }));
  const dockerClean = vi.fn(() => ({ event_type: 'docker.clean', fields: {} }));
  const dockerDoctor = vi.fn(() => ({ event_type: 'docker.doctor', fields: {} }));

  // ---- getTelemetryClient — returns null by default; tests override
  //                            per-test via mockReturnValue. ----
  const getTelemetryClient = vi.fn((): unknown => null);

  // ---- PodroidClient / ProotDockerClient mock classes. ----
  // Unused by setConfig/getConfig (which don't touch the runtime clients),
  // but the engine module imports them transitively so the mock factory
  // must return them.
  class MockPodroidClient {
    constructor(public opts: { host: string; port?: number }) {}
  }
  class MockProotDockerClient {
    constructor(public opts: { distro: string; binary?: 'docker' | 'podman' }) {}
  }

  return {
    getLinuxifyHome, setLinuxifyHome,
    getActiveDistro, setActiveDistro,
    detectRuntime, setRuntimeInfo,
    getDockerArch, setDockerArch,
    exec,
    dockerConfig,
    dockerRunStart, dockerRunComplete, dockerRunFailed,
    dockerPs, dockerStop, dockerRm, dockerClean, dockerDoctor,
    getTelemetryClient,
    MockPodroidClient, MockProotDockerClient,
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: cfgMocks.exec,
  getLinuxifyHome: cfgMocks.getLinuxifyHome,
  getArch: vi.fn(() => 'x86_64'),
  isTermux: vi.fn(() => false),
  isAndroid: vi.fn(() => false),
  getAndroidVersion: vi.fn(async () => null),
  getTermuxPrefix: vi.fn(() => '/data/data/com.termux/files/usr'),
  getDefaultUserAgent: vi.fn(() => 'linuxify/test'),
}));

vi.mock('../../../src/utils/distros.js', () => ({
  getActiveDistro: cfgMocks.getActiveDistro,
}));

vi.mock('../../../src/telemetry/index.js', () => ({
  getTelemetryClient: cfgMocks.getTelemetryClient,
  dockerRunStart: cfgMocks.dockerRunStart,
  dockerRunComplete: cfgMocks.dockerRunComplete,
  dockerRunFailed: cfgMocks.dockerRunFailed,
  dockerPs: cfgMocks.dockerPs,
  dockerStop: cfgMocks.dockerStop,
  dockerRm: cfgMocks.dockerRm,
  dockerClean: cfgMocks.dockerClean,
  dockerDoctor: cfgMocks.dockerDoctor,
  dockerConfig: cfgMocks.dockerConfig,
}));

vi.mock('../../../src/docker/detect.js', () => ({
  detectRuntime: cfgMocks.detectRuntime,
  getDockerArch: cfgMocks.getDockerArch,
}));

vi.mock('../../../src/docker/port-allocator.js', () => ({
  allocatePort: vi.fn(async () => ({ hostPort: 8000, reused: false })),
  reservePort: vi.fn(async () => undefined),
  isPortFree: vi.fn(async () => true),
}));

vi.mock('../../../src/docker/podroid-cli.js', () => ({
  PodroidClient: cfgMocks.MockPodroidClient,
}));

vi.mock('../../../src/docker/proot-cli.js', () => ({
  ProotDockerClient: cfgMocks.MockProotDockerClient,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks so they apply to engine.ts's transitive imports)
// ---------------------------------------------------------------------------

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DockerEngine } from '../../../src/docker/engine.js';
import { StateStore, defaultState } from '../../../src/state/index.js';
import type { DockerContainer, DockerState } from '../../../src/state/index.js';
import { runDocker } from '../../../src/cli/commands/docker.js';
import type { CommandContext } from '../../../src/cli/context.js';
import { EXIT_CODES } from '../../../src/utils/constants.js';
import { LinuxifyError } from '../../../src/utils/errors.js';
import type { RuntimeInfo } from '../../../src/docker/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Podroid RuntimeInfo (default: available, localhost:9922). */
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

/** Create a fresh tmpdir + StateStore pointed at it; seed with defaultState. */
async function freshTmp(): Promise<{ linuxifyHome: string; stateStore: StateStore }> {
  const linuxifyHome = await mkdtemp(join(tmpdir(), 'linuxify-cfg-'));
  cfgMocks.setLinuxifyHome(linuxifyHome);
  const statePath = join(linuxifyHome, 'state.json');
  const stateStore = new StateStore(statePath);
  await stateStore.save(defaultState());
  return { linuxifyHome, stateStore };
}

/** Reset all mock state between tests. */
function resetCfgMocks(): void {
  cfgMocks.exec.mockClear();
  cfgMocks.getActiveDistro.mockClear();
  cfgMocks.detectRuntime.mockClear();
  cfgMocks.getDockerArch.mockClear();
  cfgMocks.setActiveDistro('ubuntu');
  cfgMocks.setRuntimeInfo(makePodroidInfo(true));
  cfgMocks.setDockerArch('arm64');
  // Reset telemetry spies.
  cfgMocks.dockerConfig.mockClear();
  cfgMocks.dockerRunStart.mockClear();
  cfgMocks.dockerRunComplete.mockClear();
  cfgMocks.dockerRunFailed.mockClear();
  cfgMocks.dockerPs.mockClear();
  cfgMocks.dockerStop.mockClear();
  cfgMocks.dockerRm.mockClear();
  cfgMocks.dockerClean.mockClear();
  cfgMocks.dockerDoctor.mockClear();
  cfgMocks.getTelemetryClient.mockClear();
  cfgMocks.getTelemetryClient.mockReturnValue(null);
}

beforeEach(() => {
  resetCfgMocks();
});

afterEach(async () => {
  const home = cfgMocks.getLinuxifyHome();
  if (home.startsWith(tmpdir())) {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
});

/** Captured output lines by channel. */
interface CapturedOutput {
  info: string[];
  success: string[];
  warn: string[];
  error: string[];
}

/** Build a minimal CommandContext for the docker CLI tests.
 *  Returns the ctx and a captured-arrays object (info/success/warn/error)
 *  that the test can inspect. The fake Output's methods push to those arrays.
 */
function makeCliCtx(stateStore: StateStore): { ctx: CommandContext; output: CapturedOutput } {
  const captured: CapturedOutput = { info: [], success: [], warn: [], error: [] };
  const fakeOutput = {
    json: false,
    quiet: false,
    noColor: true,
    info: (m: string) => { captured.info.push(m); return undefined; },
    success: (m: string) => { captured.success.push(m); return undefined; },
    warn: (m: string) => { captured.warn.push(m); return undefined; },
    error: (m: string) => { captured.error.push(m); return undefined; },
    progress: (m: string) => { captured.info.push(m); return undefined; },
    blank: () => { captured.info.push(''); return undefined; },
    printJson: () => undefined,
    table: () => undefined,
  } as unknown as CommandContext['output'];
  const ctx = {
    config: {},
    stateStore,
    output: fakeOutput,
    registry: {},
    telemetry: {},
    doctor: {},
    patcher: {},
    plugins: {},
    state: defaultState(),
    flags: {
      dryRun: false,
      yes: false,
      offline: false,
      noTelemetry: false,
      verbose: 0,
      debug: false,
    },
  } as unknown as CommandContext;
  return { ctx, output: captured };
}

// ---------------------------------------------------------------------------
// Tests — DockerEngine.getConfig() (5 tests)
// ---------------------------------------------------------------------------

describe('DockerEngine.getConfig()', () => {
  it('returns the default state values when not initialized', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const cfg = await engine.getConfig();
    expect(cfg.initialized).toBe(false);
    expect(cfg.initializedAt).toBeNull();
    expect(cfg.defaultRuntime).toBeNull();
    expect(cfg.portRangeStart).toBe(8000);
    expect(cfg.portRangeEnd).toBe(8999);
    expect(cfg.nextPortHint).toBe(8000);
    expect(cfg.wakeLockEnabled).toBe(false);
    expect(cfg.containerCount).toBe(0);
  });

  it('returns the persisted values when state.docker is set', async () => {
    const { stateStore } = await freshTmp();
    const sample: DockerContainer = {
      name: 'nginx', image: 'nginx:latest', container_id: 'abc',
      runtime: 'podroid', host_port: 9000, guest_port: 80,
      forward_rule_id: 'fr-1', started_at: '2024-01-01T00:00:00.000Z',
      restart_policy: 'unless-stopped', status: 'running',
      volumes: [], env: [],
    };
    await stateStore.update((s) => {
      s.docker = {
        initialized: true,
        initialized_at: '2024-01-01T00:00:00.000Z',
        default_runtime: 'podroid',
        port_range_start: 9000,
        port_range_end: 9999,
        next_port_hint: 9500,
        wake_lock_enabled: true,
        containers: [sample],
      } as DockerState;
    });
    const engine = new DockerEngine(stateStore);
    const cfg = await engine.getConfig();
    expect(cfg.initialized).toBe(true);
    expect(cfg.initializedAt).toBe('2024-01-01T00:00:00.000Z');
    expect(cfg.defaultRuntime).toBe('podroid');
    expect(cfg.portRangeStart).toBe(9000);
    expect(cfg.portRangeEnd).toBe(9999);
    expect(cfg.nextPortHint).toBe(9500);
    expect(cfg.wakeLockEnabled).toBe(true);
    expect(cfg.containerCount).toBe(1);
  });

  it('containerCount reflects state.docker.containers.length', async () => {
    const { stateStore } = await freshTmp();
    const mk = (n: string): DockerContainer => ({
      name: n, image: 'nginx', container_id: 'id-' + n,
      runtime: 'podroid', host_port: 8000, guest_port: 80,
      forward_rule_id: '', started_at: '2024-01-01T00:00:00.000Z',
      restart_policy: 'unless-stopped', status: 'running',
      volumes: [], env: [],
    });
    await stateStore.update((s) => {
      s.docker.containers = [mk('a'), mk('b'), mk('c')];
    });
    const engine = new DockerEngine(stateStore);
    const cfg = await engine.getConfig();
    expect(cfg.containerCount).toBe(3);
  });

  it('defaultRuntime returns null when state.docker.default_runtime is null (auto-detect)', async () => {
    const { stateStore } = await freshTmp();
    await stateStore.update((s) => {
      s.docker.default_runtime = null;
    });
    const engine = new DockerEngine(stateStore);
    const cfg = await engine.getConfig();
    expect(cfg.defaultRuntime).toBeNull();
  });

  it('nextPortHint reflects state.docker.next_port_hint even when outside the range', async () => {
    const { stateStore } = await freshTmp();
    await stateStore.update((s) => {
      s.docker.next_port_hint = 7000; // below the default start of 8000
    });
    const engine = new DockerEngine(stateStore);
    const cfg = await engine.getConfig();
    // Verbatim read — range-clamping logic is in setConfig, not getConfig.
    expect(cfg.nextPortHint).toBe(7000);
    expect(cfg.portRangeStart).toBe(8000);
    expect(cfg.portRangeEnd).toBe(8999);
  });
});

// ---------------------------------------------------------------------------
// Tests — DockerEngine.setConfig() happy paths (10 tests)
// ---------------------------------------------------------------------------

describe('DockerEngine.setConfig() — happy paths', () => {
  it('setConfig({ wakeLockEnabled: true }) flips state.docker.wake_lock_enabled to true', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const r = await engine.setConfig({ wakeLockEnabled: true });
    expect(r.message).toBe('Updated: wake-lock: false → true.');
    const state = await stateStore.load();
    expect(state.docker.wake_lock_enabled).toBe(true);
  });

  it('setConfig({ wakeLockEnabled: false }) when already false returns "No changes."', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const r = await engine.setConfig({ wakeLockEnabled: false });
    expect(r.message).toBe('No changes.');
    // No state write happened (we can verify by checking that the state file's
    // updated_at timestamp didn't change OR — more simply — that no dockerConfig
    // event was emitted, which only happens when there's an actual change).
    expect(cfgMocks.dockerConfig).not.toHaveBeenCalled();
  });

  it('setConfig({ portRangeStart: 9000, portRangeEnd: 9999 }) updates both bounds', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const r = await engine.setConfig({ portRangeStart: 9000, portRangeEnd: 9999 });
    expect(r.message).toContain('port-range');
    expect(r.message).toContain('9000');
    expect(r.message).toContain('9999');
    const state = await stateStore.load();
    expect(state.docker.port_range_start).toBe(9000);
    expect(state.docker.port_range_end).toBe(9999);
  });

  it('setConfig({ portRangeStart: 9000 }) alone preserves the existing port_range_end', async () => {
    const { stateStore } = await freshTmp();
    // Seed with port_range_end=9999 so portRangeStart=9000 satisfies start < end.
    // (If we left end at the default 8999, the start=9000 would violate
    // the `start < end` rule.)
    await stateStore.update((s) => {
      s.docker.port_range_end = 9999;
    });
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ portRangeStart: 9000 });
    const state = await stateStore.load();
    expect(state.docker.port_range_start).toBe(9000);
    expect(state.docker.port_range_end).toBe(9999); // preserved
  });

  it('setConfig({ portRangeEnd: 9999 }) alone preserves the existing port_range_start', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ portRangeEnd: 9999 });
    const state = await stateStore.load();
    expect(state.docker.port_range_start).toBe(8000); // preserved default
    expect(state.docker.port_range_end).toBe(9999);
  });

  it('setConfig({ portRangeStart: 9000, portRangeEnd: 9999 }) re-pins next_port_hint when outside the new range', async () => {
    const { stateStore } = await freshTmp();
    // Default next_port_hint is 8000, which is below the new start of 9000.
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ portRangeStart: 9000, portRangeEnd: 9999 });
    const state = await stateStore.load();
    expect(state.docker.next_port_hint).toBe(9000); // re-pinned to new start
  });

  it('setConfig({ portRangeStart: 9000, portRangeEnd: 9999 }) preserves next_port_hint when inside the new range', async () => {
    const { stateStore } = await freshTmp();
    await stateStore.update((s) => {
      s.docker.next_port_hint = 9500;
    });
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ portRangeStart: 9000, portRangeEnd: 9999 });
    const state = await stateStore.load();
    expect(state.docker.next_port_hint).toBe(9500); // preserved (inside [9000, 9999])
  });

  it('setConfig({ defaultRuntime: "podroid" }) sets state.docker.default_runtime', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ defaultRuntime: 'podroid' });
    const state = await stateStore.load();
    expect(state.docker.default_runtime).toBe('podroid');
  });

  it('setConfig({ defaultRuntime: null }) resets state.docker.default_runtime to null (auto-detect)', async () => {
    const { stateStore } = await freshTmp();
    // Seed with a non-null runtime to verify the reset actually flips it.
    await stateStore.update((s) => {
      s.docker.default_runtime = 'podroid';
    });
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ defaultRuntime: null });
    const state = await stateStore.load();
    expect(state.docker.default_runtime).toBeNull();
  });

  it('setConfig({ wakeLock, portRange, defaultRuntime }) combined patch updates all 4 fields', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const r = await engine.setConfig({
      wakeLockEnabled: true,
      portRangeStart: 9000,
      portRangeEnd: 9999,
      defaultRuntime: 'docker',
    });
    // Message lists all 3 change categories.
    expect(r.message).toContain('wake-lock');
    expect(r.message).toContain('port-range');
    expect(r.message).toContain('default-runtime');
    const state = await stateStore.load();
    expect(state.docker.wake_lock_enabled).toBe(true);
    expect(state.docker.port_range_start).toBe(9000);
    expect(state.docker.port_range_end).toBe(9999);
    expect(state.docker.default_runtime).toBe('docker');
  });
});

// ---------------------------------------------------------------------------
// Tests — DockerEngine.setConfig() validation failures (7 tests)
// ---------------------------------------------------------------------------

describe('DockerEngine.setConfig() — validation failures', () => {
  // Implementation note: the engine's
  // BUG-FIX NOTE (was previously asserting the buggy swapped-arg
  // behavior; the engine now correctly calls
  // `new LinuxifyError('<human readable>', 'E_DOCKER_CONFIG_INVALID')`
  // which puts the human text in `.message` and the code in `.code`
  // (prefixed with `E_` by `normalizeErrorCode`).
  // The tests below assert the corrected behavior:
  //   - .code === 'E_DOCKER_CONFIG_INVALID'
  //   - .message contains the human-readable text + the offending value.

  /** Capture the rejection as a LinuxifyError instance. */
  async function captureErr<T>(p: Promise<T>): Promise<LinuxifyError> {
    try {
      await p;
      throw new Error('expected promise to reject, but it resolved');
    } catch (e) {
      return e as LinuxifyError;
    }
  }

  it('setConfig({ portRangeStart: 80 }) throws on minimum 1024 violation', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeStart: 80 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/port_range_start must be an integer in \[1024, 65535\]/);
    expect(err.message).toMatch(/got 80/);
  });

  it('setConfig({ portRangeStart: 70000 }) throws on maximum 65535 violation', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeStart: 70000 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/port_range_start must be an integer in \[1024, 65535\]/);
    expect(err.message).toMatch(/got 70000/);
  });

  it('setConfig({ portRangeStart: 1.5 }) throws on non-integer', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeStart: 1.5 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/port_range_start must be an integer/);
    expect(err.message).toMatch(/got 1\.5/);
  });

  it('setConfig({ portRangeEnd: 80 }) throws on minimum 1024 violation (same rule for end)', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeEnd: 80 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/port_range_end must be an integer in \[1024, 65535\]/);
    expect(err.message).toMatch(/got 80/);
  });

  it('setConfig({ portRangeStart: 9000, portRangeEnd: 9000 }) throws when start equals end', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeStart: 9000, portRangeEnd: 9000 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/must be strictly less than/);
  });

  it('setConfig({ portRangeStart: 9999, portRangeEnd: 9000 }) throws when start > end', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ portRangeStart: 9999, portRangeEnd: 9000 }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/must be strictly less than/);
  });

  it('setConfig({ defaultRuntime: "invalid" }) throws with a message listing valid options', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    const err = await captureErr(engine.setConfig({ defaultRuntime: 'invalid' as never }));
    expect(err).toBeInstanceOf(LinuxifyError);
    expect(err.code).toBe('E_DOCKER_CONFIG_INVALID');
    expect(err.message).toMatch(/default_runtime must be one of/);
    expect(err.message).toMatch(/podroid/);
    expect(err.message).toMatch(/docker/);
    expect(err.message).toMatch(/podman/);
  });
});

// ---------------------------------------------------------------------------
// Tests — DockerEngine.setConfig() telemetry emission (3 tests)
// ---------------------------------------------------------------------------

describe('DockerEngine.setConfig() — telemetry emission', () => {
  it('on successful wakeLockEnabled=true, emits dockerConfig(["wake_lock_enabled"], false)', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({ wakeLockEnabled: true });
    // The engine's track() helper calls the mocked dockerConfig event helper
    // BEFORE checking getTelemetryClient(), so the spy captures the call
    // regardless of whether telemetry is enabled.
    expect(cfgMocks.dockerConfig).toHaveBeenCalledTimes(1);
    const args = cfgMocks.dockerConfig.mock.calls[0];
    expect(args?.[0]).toEqual(['wake_lock_enabled']);
    expect(args?.[1]).toBe(false); // initialized is false (default state)
  });

  it('on successful combined patch, emits dockerConfig with all 3 changed keys', async () => {
    const { stateStore } = await freshTmp();
    const engine = new DockerEngine(stateStore);
    await engine.setConfig({
      wakeLockEnabled: true,
      portRangeStart: 9000,
      portRangeEnd: 9999,
      defaultRuntime: 'docker',
    });
    expect(cfgMocks.dockerConfig).toHaveBeenCalledTimes(1);
    const args = cfgMocks.dockerConfig.mock.calls[0];
    expect(args?.[0]).toEqual(['wake_lock_enabled', 'port_range', 'default_runtime']);
    expect(args?.[1]).toBe(false); // still not initialized
  });

  it('on "No changes" (patch with no actual diff), NO dockerConfig event is emitted', async () => {
    const { stateStore } = await freshTmp();
    // Override getTelemetryClient to return a fake client with a track spy.
    // Even though the engine's track() is never reached on the "No changes"
    // path (the early return at `if (changes.length === 0)` happens before
    // the track() call), we still set up the spy to assert no client.track
    // was invoked — a belt-and-suspenders check.
    const fakeTrack = vi.fn();
    const fakeClient = { track: fakeTrack };
    cfgMocks.getTelemetryClient.mockReturnValue(fakeClient);

    const engine = new DockerEngine(stateStore);
    // Patch with the current default values — no actual diff.
    const r = await engine.setConfig({ wakeLockEnabled: false });
    expect(r.message).toBe('No changes.');
    expect(cfgMocks.dockerConfig).not.toHaveBeenCalled();
    expect(fakeTrack).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — CLI: `linuxify docker config` (5 tests)
// ---------------------------------------------------------------------------

describe('CLI: linuxify docker config', () => {
  it('runDocker({}, ctx, "config") with no opts prints config header + all fields + hint block', async () => {
    const { stateStore } = await freshTmp();
    const { ctx, output } = makeCliCtx(stateStore);
    const code = await runDocker({}, ctx, 'config');
    expect(code).toBe(EXIT_CODES.OK);
    const all = [...output.info, ...output.success, ...output.error];
    expect(all.some((l) => l.includes('Docker configuration:'))).toBe(true);
    // All 5 visible field lines.
    expect(all.some((l) => l.includes('Initialized:'))).toBe(true);
    expect(all.some((l) => l.includes('Default runtime:'))).toBe(true);
    expect(all.some((l) => l.includes('Port range:'))).toBe(true);
    expect(all.some((l) => l.includes('Wake lock:'))).toBe(true);
    expect(all.some((l) => l.includes('Container count:'))).toBe(true);
    // The "To change a setting" hint block.
    expect(all.some((l) => l.includes('To change a setting'))).toBe(true);
    expect(all.some((l) => l.includes('--wake-lock'))).toBe(true);
    expect(all.some((l) => l.includes('--port-range'))).toBe(true);
    expect(all.some((l) => l.includes('--default-runtime'))).toBe(true);
    expect(all.some((l) => l.includes('--reset'))).toBe(true);
  });

  it('runDocker({ "wake-lock": "on" }, ctx, "config") sets state.docker.wake_lock_enabled=true', async () => {
    const { stateStore } = await freshTmp();
    const { ctx, output } = makeCliCtx(stateStore);
    const code = await runDocker({ wakeLock: 'on' }, ctx, 'config');
    expect(code).toBe(EXIT_CODES.OK);
    const state = await stateStore.load();
    expect(state.docker.wake_lock_enabled).toBe(true);
    // Output mentions the update.
    expect(output.success.some((l) => l.includes('wake-lock') && l.includes('true'))).toBe(true);
  });

  it('runDocker({ "wake-lock": "invalid" }, ctx, "config") prints the format error and returns 1', async () => {
    const { stateStore } = await freshTmp();
    const { ctx, output } = makeCliCtx(stateStore);
    const code = await runDocker({ wakeLock: 'invalid' }, ctx, 'config');
    expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
    // State is NOT changed.
    const state = await stateStore.load();
    expect(state.docker.wake_lock_enabled).toBe(false);
    // Error message printed.
    expect(output.error.some((l) => l.includes('--wake-lock must be on|off'))).toBe(true);
    expect(output.error.some((l) => l.includes("got 'invalid'"))).toBe(true);
  });

  it('runDocker({ "port-range": "9000-9999" }, ctx, "config") updates port_range_start and port_range_end', async () => {
    const { stateStore } = await freshTmp();
    const { ctx } = makeCliCtx(stateStore);
    const code = await runDocker({ portRange: '9000-9999' }, ctx, 'config');
    expect(code).toBe(EXIT_CODES.OK);
    const state = await stateStore.load();
    expect(state.docker.port_range_start).toBe(9000);
    expect(state.docker.port_range_end).toBe(9999);
  });

  it('runDocker({ "port-range": "not-a-range" }, ctx, "config") prints the format error and returns 1', async () => {
    const { stateStore } = await freshTmp();
    const { ctx, output } = makeCliCtx(stateStore);
    const code = await runDocker({ portRange: 'not-a-range' }, ctx, 'config');
    expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
    // State unchanged.
    const state = await stateStore.load();
    expect(state.docker.port_range_start).toBe(8000); // default
    expect(state.docker.port_range_end).toBe(8999);   // default
    // Error message printed.
    expect(output.error.some((l) => l.includes('--port-range must be START-END'))).toBe(true);
    expect(output.error.some((l) => l.includes("got 'not-a-range'"))).toBe(true);
  });
});
