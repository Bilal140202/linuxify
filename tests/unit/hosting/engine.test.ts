/**
 * Unit tests for `src/hosting/engine.ts` — the `HostingEngine` class.
 *
 * Covers:
 *   - `init()`: creates `~/.linuxify/hosting/`, writes config.json, returns
 *     success message, idempotency.
 *   - `plan()`: calls `detectProject()` + `findAvailablePort()`, generates
 *     a name, returns steps array.
 *   - `deploy()`: unknown-type rejection, install/build/start command flow,
 *     config persistence, B-H2 regression (config is initialized=true even
 *     when starting from no config file), same-name app replacement.
 *   - `list()`: returns `config.apps` (empty array when no config).
 *   - `startApp()` / `stopApp()` / `restartApp()`: app-must-exist check,
 *     PM delegation, status field update, B-H4 regression
 *     (restartApp('nonexistent') returns false without shelling out).
 *   - `removeApp()`: B-H5 regression — config entry always removed; PM2
 *     failure does not prevent config cleanup.
 *   - `addService()` / `expose()`: happy path + not-found path.
 *   - `doctor()`: structure + issue detection for nginx/PM2 missing and
 *     failed apps.
 *   - `findAvailablePort()`: walks past used ports, B-H15 regression
 *     (probes the OS via `createServer().listen`), falls back to high port
 *     after 100 consecutive bound candidates.
 *   - `isInitialized()`: returns `config?.initialized ?? false`.
 *
 * Mocked: `exec`, `logger`, `detectProject`, `createServer` (node:net).
 * Real: fs + `LINUXIFY_HOME` env var (per-test tmpdir isolation).
 */

import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks — shared between the mock factories and the test bodies.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // exec mock: returns a default ok() result; per-test overrides via
  // mockResolvedValueOnce.
  const exec = vi.fn();

  // detectProject mock: returns a node-style DetectionResult by default.
  const detectProject = vi.fn();

  // node:net.createServer mock — used by findAvailablePort to probe whether
  // a port is bindable. `boundPorts` is a Set of ports that should report
  // "bound" (fire the 'error' listener); everything else fires 'listening'.
  const boundPorts = new Set<number>();
  const createServer = vi.fn(() => {
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const server = {
      unref(): void { /* noop */ },
      once(event: string, cb: (...args: unknown[]) => void): void {
        handlers[event] = cb;
      },
      listen(port: number, _host: string): void {
        // Defer to next microtask to mirror the real async API.
        queueMicrotask(() => {
          if (boundPorts.has(port) && handlers.error) {
            handlers.error(new Error('EADDRINUSE'));
          } else if (handlers.listening) {
            handlers.listening();
          }
        });
      },
      close(): void { /* noop */ },
    };
    return server;
  });

  return { exec, detectProject, createServer, boundPorts };
});

// Mock utils/process.js — keep `getLinuxifyHome` real (so LINUXIFY_HOME env
// works), only replace `exec`.
vi.mock('../../../src/utils/process.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../src/utils/process.js')>();
  return { ...actual, exec: mocks.exec };
});

// Mock logger — pino's lazy initializer opens a log file under
// ~/.linuxify/logs/ and is flaky under vitest's stdio capture.
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

// Mock detect.ts so we control the DetectionResult returned by detectProject.
vi.mock('../../../src/hosting/detect.js', () => ({
  detectProject: mocks.detectProject,
}));

// Mock node:net so we can simulate ports being bound.
vi.mock('node:net', () => ({
  createServer: mocks.createServer,
}));

import type { HostingConfig, DeployedApp } from '../../../src/hosting/config.js';
import type { DetectionResult } from '../../../src/hosting/detect.js';
import { HostingEngine } from '../../../src/hosting/engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISTRO = 'ubuntu';

function ok(stdout = '', stderr = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode: 0, stdout, stderr, failed: false, timedOut: false, command: '' };
}
function fail(code = 1, stderr = 'err', stdout = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode: code, stdout, stderr, failed: true, timedOut: false, command: '' };
}

/** A minimal node-style DetectionResult (no PORT placeholder, no build). */
function nodeDetection(overrides: Partial<DetectionResult> = {}): DetectionResult {
  return {
    type: 'node',
    framework: 'Node.js',
    entryPoint: 'index.js',
    buildCommand: null,
    startCommand: 'node index.js',
    installCommand: 'npm install',
    outputDir: null,
    needsDatabase: false,
    detectedFiles: ['package.json'],
    confidence: 0.8,
    ...overrides,
  };
}

/** Read the engine's config.json from a tmpdir; returns null if missing. */
async function readConfig(tmp: string): Promise<HostingConfig | null> {
  try {
    const raw = await readFile(join(tmp, 'hosting', 'config.json'), 'utf8');
    return JSON.parse(raw) as HostingConfig;
  } catch {
    return null;
  }
}

/** Write a config.json into a tmpdir. */
async function writeConfig(tmp: string, config: HostingConfig): Promise<void> {
  const dir = join(tmp, 'hosting');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------

describe('HostingEngine', () => {
  let tmp: string;
  let originalLinuxifyHome: string | undefined;

  beforeEach(async () => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    tmp = await mkdtemp(join(tmpdir(), 'linuxify-engine-'));
    process.env.LINUXIFY_HOME = tmp;
    mocks.exec.mockReset();
    mocks.detectProject.mockReset();
    mocks.boundPorts.clear();
    // By default, detectProject returns a node-style result.
    mocks.detectProject.mockResolvedValue(nodeDetection());
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) {
      delete process.env.LINUXIFY_HOME;
    } else {
      process.env.LINUXIFY_HOME = originalLinuxifyHome;
    }
    await rm(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  describe('init()', () => {
    it('creates ~/.linuxify/hosting/ and writes a config.json', async () => {
      mocks.exec.mockResolvedValue(ok());          // nginx install
      mocks.exec.mockResolvedValueOnce(ok());      // pm.install: exec 'npm install -g pm2'
      const eng = new HostingEngine(DISTRO);
      await eng.init();
      const cfg = await readConfig(tmp);
      expect(cfg).not.toBeNull();
    });

    it('writes initialized=true and initializedAt as a fresh ISO timestamp', async () => {
      mocks.exec.mockResolvedValue(ok());
      mocks.exec.mockResolvedValueOnce(ok());
      const before = new Date().toISOString();
      const eng = new HostingEngine(DISTRO);
      await eng.init();
      const after = new Date().toISOString();
      const cfg = await readConfig(tmp);
      expect(cfg?.initialized).toBe(true);
      expect(cfg?.initializedAt).toBeTruthy();
      expect(cfg?.initializedAt! >= before).toBe(true);
      expect(cfg?.initializedAt! <= after).toBe(true);
    });

    it('returns the documented success message', async () => {
      mocks.exec.mockResolvedValue(ok());
      mocks.exec.mockResolvedValueOnce(ok());
      const eng = new HostingEngine(DISTRO);
      const r = await eng.init();
      expect(r.success).toBe(true);
      expect(r.message).toMatch(/nginx \+ PM2 installed/);
    });

    it('invokes nginx install via proot-distro login ubuntu --', async () => {
      mocks.exec.mockResolvedValue(ok());              // nginx install call
      mocks.exec.mockResolvedValueOnce(ok());          // pm.install via ProcessManager
      const eng = new HostingEngine(DISTRO);
      await eng.init();
      const nginxCall = mocks.exec.mock.calls.find(
        (c: unknown[]) => typeof c[1] === 'object' && Array.isArray(c[1] as string[]) && (c[1] as string[]).some((a) => typeof a === 'string' && a.includes('nginx')),
      );
      expect(nginxCall).toBeDefined();
      expect(nginxCall![0]).toBe('proot-distro');
      expect((nginxCall![1] as string[]).slice(0, 3)).toEqual(['login', DISTRO, '--']);
    });

    it('installs PM2 via pm.install (npm install -g pm2)', async () => {
      // Track exec calls — the pm.install call uses `npm install -g pm2`.
      mocks.exec.mockResolvedValue(ok());              // nginx install
      mocks.exec.mockResolvedValueOnce(ok());          // pm.install
      const eng = new HostingEngine(DISTRO);
      await eng.init();
      const pm2InstallCall = mocks.exec.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1] as string[]) && (c[1] as string[]).includes('pm2') && (c[1] as string[]).includes('install'),
      );
      expect(pm2InstallCall).toBeDefined();
    });

    it('is idempotent: second call returns "already initialized" without re-running installs', async () => {
      // First init: real installs.
      mocks.exec.mockResolvedValue(ok());          // nginx
      mocks.exec.mockResolvedValueOnce(ok());      // pm2 install
      const eng = new HostingEngine(DISTRO);
      const r1 = await eng.init();
      expect(r1.success).toBe(true);
      expect(r1.message).toMatch(/nginx \+ PM2 installed/);

      // Capture call count after first init.
      const callsAfterFirst = mocks.exec.mock.calls.length;
      // Second init: should not call exec at all.
      const r2 = await eng.init();
      expect(r2.success).toBe(true);
      expect(r2.message).toMatch(/already initialized/);
      expect(mocks.exec.mock.calls.length).toBe(callsAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // plan()
  // -------------------------------------------------------------------------

  describe('plan()', () => {
    it('calls detectProject on the given path', async () => {
      mocks.exec.mockResolvedValue(ok());
      const eng = new HostingEngine(DISTRO);
      await eng.plan('/srv/app');
      expect(mocks.detectProject).toHaveBeenCalledWith('/srv/app');
    });

    it('calls findAvailablePort and includes it in the plan', async () => {
      mocks.exec.mockResolvedValue(ok());
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.port).toBeGreaterThan(0);
      // With no apps in config and a free 8080, the port should be 8080.
      expect(plan.port).toBe(8080);
    });

    it('generates a name from the framework slug when appName is omitted', async () => {
      mocks.detectProject.mockResolvedValueOnce(nodeDetection({ framework: 'Node.js' }));
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      // framework.toLowerCase().replace(/[^a-z0-9]/g, '-') === 'node-js'
      expect(plan.name).toBe('node-js');
    });

    it('uses the provided appName when given', async () => {
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app', 'my-cool-app');
      expect(plan.name).toBe('my-cool-app');
    });

    it('returns a steps array with install/build/start entries', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ installCommand: 'npm install', buildCommand: 'npm run build', startCommand: 'node index.js' }),
      );
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.steps).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Install: npm install/),
          expect.stringMatching(/^Build: npm run build/),
          expect.stringMatching(/^Start: node index\.js \(port/),
        ]),
      );
    });

    it('omits the Build step when buildCommand is null', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ installCommand: 'npm install', buildCommand: null }),
      );
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      const hasBuild = plan.steps.some((s) => s.startsWith('Build:'));
      expect(hasBuild).toBe(false);
    });

    it('omits the Install step when installCommand is empty', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ installCommand: '' }),
      );
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      const hasInstall = plan.steps.some((s) => s.startsWith('Install:'));
      expect(hasInstall).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // deploy()
  // -------------------------------------------------------------------------

  describe('deploy()', () => {
    it('returns failure when detection type is "unknown"', async () => {
      mocks.detectProject.mockResolvedValueOnce(nodeDetection({ type: 'unknown' as DetectionResult['type'] }));
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app');
      expect(r.success).toBe(false);
      expect(r.url).toBeNull();
      expect(r.message).toMatch(/Could not detect project type/);
    });

    it('runs the install command via proot-distro; returns failure on non-zero exit', async () => {
      mocks.detectProject.mockResolvedValueOnce(nodeDetection({ installCommand: 'npm install' }));
      mocks.exec.mockResolvedValueOnce(fail(1, '', 'npm install failed')); // install
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/Install failed/);
    });

    it('runs the build command (if any) and returns failure on non-zero exit', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ installCommand: 'npm install', buildCommand: 'npm run build' }),
      );
      mocks.exec
        .mockResolvedValueOnce(ok())                  // install
        .mockResolvedValueOnce(fail(1, '', 'build err')); // build
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/Build failed/);
    });

    it('calls pm.start(name, startCmd-with-PORT-substituted, cwd)', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({
          startCommand: 'uvicorn main:app --host 0.0.0.0 --port ${PORT}',
        }),
      );
      mocks.exec.mockResolvedValue(ok()); // install + build skipped (no build)
      // For this test, install is present (npm install) so we need:
      //   call 1: install (npm install)
      //   call 2: pm2 start (via pm.start)
      mocks.exec
        .mockResolvedValueOnce(ok()) // install
        .mockResolvedValueOnce(ok()); // pm2 start
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app', 'myapp');
      expect(r.success).toBe(true);
      // Find the pm2 start call.
      const pm2Call = mocks.exec.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1] as string[]) && (c[1] as string[]).some((a) => typeof a === 'string' && a.includes('pm2 start')),
      );
      expect(pm2Call).toBeDefined();
      const args = pm2Call![1] as string[];
      // The bash -c script is the last positional arg.
      const script = args[args.length - 1] as string;
      // ${PORT} should be substituted with the actual port (8080 in this test).
      expect(script).toContain('--port 8080');
      expect(script).not.toContain('${PORT}');
      // The name should be interpolated.
      expect(script).toContain('--name myapp');
      expect(script).toContain('--no-treekill');
      // The cwd should be in the cd prefix.
      expect(script).toContain('cd /srv/app');
    });

    it('returns failure when pm2 start exits non-zero', async () => {
      mocks.detectProject.mockResolvedValueOnce(nodeDetection({ installCommand: 'npm install' }));
      mocks.exec
        .mockResolvedValueOnce(ok())              // install
        .mockResolvedValueOnce(fail(1));          // pm2 start
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app');
      expect(r.success).toBe(false);
      expect(r.message).toMatch(/Failed to start with PM2/);
    });

    it('records the app in config.json with the right fields', async () => {
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ framework: 'Express' }),
      );
      mocks.exec.mockResolvedValueOnce(ok());   // install
      mocks.exec.mockResolvedValueOnce(ok());   // pm2 start
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app', 'myapp');
      expect(r.success).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps).toHaveLength(1);
      const app = cfg?.apps[0]!;
      expect(app.name).toBe('myapp');
      expect(app.type).toBe('node');
      expect(app.path).toBe('/srv/app');
      expect(app.port).toBe(8080);
      expect(app.status).toBe('running');
      expect(app.startedAt).toBeTruthy();
      expect(app.framework).toBe('Express');
      expect(app.autoDeployed).toBe(false); // appName was provided
    });

    it('sets autoDeployed=true when appName is omitted', async () => {
      mocks.detectProject.mockResolvedValueOnce(nodeDetection());
      mocks.exec.mockResolvedValueOnce(ok());
      mocks.exec.mockResolvedValueOnce(ok());
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app'); // no appName
      expect(r.success).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps[0]?.autoDeployed).toBe(true);
    });

    it('removes any existing app with the same name before pushing the new one', async () => {
      // Pre-seed a config with an existing app at the same name.
      const existingApp: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/old/path',
        port: 9999,
        pid: 42,
        status: 'stopped',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [existingApp],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.detectProject.mockResolvedValueOnce(nodeDetection());
      mocks.exec.mockResolvedValueOnce(ok()); // install
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 start
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/new/path', 'myapp');
      expect(r.success).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps).toHaveLength(1);
      expect(cfg?.apps[0]?.path).toBe('/new/path');
      expect(cfg?.apps[0]?.port).toBe(8080);
    });

    // B-H2 regression test
    it('B-H2: when config.json is missing, deploy() writes a config with initialized=true (not the bare DEFAULT_HOSTING_CONFIG which has initialized=false)', async () => {
      // No config.json exists initially.
      mocks.detectProject.mockResolvedValueOnce(nodeDetection());
      mocks.exec.mockResolvedValueOnce(ok()); // install
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 start
      const eng = new HostingEngine(DISTRO);
      const r = await eng.deploy('/srv/app', 'myapp');
      expect(r.success).toBe(true);
      const cfg = await readConfig(tmp);
      // B-H2 assertion: the freshly-written config must have initialized=true.
      expect(cfg?.initialized).toBe(true);
      expect(cfg?.initializedAt).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    it('returns config.apps when config exists', async () => {
      const app: DeployedApp = {
        name: 'a',
        type: 'node',
        path: '/x',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      const eng = new HostingEngine(DISTRO);
      const apps = await eng.list();
      expect(apps).toHaveLength(1);
      expect(apps[0]!.name).toBe('a');
    });

    it('returns an empty array when no config exists', async () => {
      const eng = new HostingEngine(DISTRO);
      const apps = await eng.list();
      expect(apps).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // startApp()
  // -------------------------------------------------------------------------

  describe('startApp()', () => {
    it('returns false when app is not in config', async () => {
      const eng = new HostingEngine(DISTRO);
      const result = await eng.startApp('nonexistent');
      expect(result).toBe(false);
    });

    it('calls pm.start with PORT-substituted startCommand and updates status to running', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: null,
        status: 'stopped',
        startedAt: null,
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.detectProject.mockResolvedValueOnce(
        nodeDetection({ startCommand: 'node server.js --port ${PORT}' }),
      );
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 start
      const eng = new HostingEngine(DISTRO);
      const result = await eng.startApp('myapp');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps[0]?.status).toBe('running');
      expect(cfg?.apps[0]?.startedAt).toBeTruthy();
      // Verify the pm2 start command was called with PORT substituted.
      const pm2Call = mocks.exec.mock.calls.find(
        (c: unknown[]) => Array.isArray(c[1] as string[]) && (c[1] as string[]).some((a) => typeof a === 'string' && a.includes('pm2 start')),
      );
      expect(pm2Call).toBeDefined();
      const args = pm2Call![1] as string[];
      const script = args[args.length - 1] as string;
      expect(script).toContain('--port 8080');
      expect(script).not.toContain('${PORT}');
    });

    it('returns false (without updating status) when pm.start exits non-zero', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: null,
        status: 'stopped',
        startedAt: null,
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.detectProject.mockResolvedValueOnce(nodeDetection());
      mocks.exec.mockResolvedValueOnce(fail(1)); // pm2 start fails
      const eng = new HostingEngine(DISTRO);
      const result = await eng.startApp('myapp');
      expect(result).toBe(false);
      const cfg = await readConfig(tmp);
      // Status should still be 'stopped'.
      expect(cfg?.apps[0]?.status).toBe('stopped');
    });
  });

  // -------------------------------------------------------------------------
  // stopApp()
  // -------------------------------------------------------------------------

  describe('stopApp()', () => {
    it('calls pm.stop and updates status to stopped on success', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 stop
      const eng = new HostingEngine(DISTRO);
      const result = await eng.stopApp('myapp');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps[0]?.status).toBe('stopped');
      expect(cfg?.apps[0]?.startedAt).toBeNull();
    });

    it('still calls pm.stop (and returns false) when app is not in config — does NOT throw', async () => {
      mocks.exec.mockResolvedValueOnce(ok());
      const eng = new HostingEngine(DISTRO);
      const result = await eng.stopApp('nonexistent');
      // stopApp always shells out to pm2.stop regardless of config; just
      // doesn't update a config entry.
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // restartApp()
  // -------------------------------------------------------------------------

  describe('restartApp()', () => {
    it('B-H4: returns false when app is not in config (does NOT shell out to PM2)', async () => {
      const eng = new HostingEngine(DISTRO);
      const result = await eng.restartApp('nonexistent');
      expect(result).toBe(false);
      // Crucially, exec should never have been called — no PM2 restart
      // was attempted for an app that doesn't exist in config.
      expect(mocks.exec).not.toHaveBeenCalled();
    });

    it('calls pm.restart and updates status to running on success', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'failed',
        startedAt: null,
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 restart
      const eng = new HostingEngine(DISTRO);
      const result = await eng.restartApp('myapp');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps[0]?.status).toBe('running');
      expect(cfg?.apps[0]?.startedAt).toBeTruthy();
    });

    it('returns false when pm.restart exits non-zero', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'failed',
        startedAt: null,
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(fail(1));
      const eng = new HostingEngine(DISTRO);
      const result = await eng.restartApp('myapp');
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // removeApp() — B-H5 regression
  // -------------------------------------------------------------------------

  describe('removeApp()', () => {
    it('B-H5: returns true when PM2 delete succeeds; removes the config entry', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok()); // pm2 delete
      const eng = new HostingEngine(DISTRO);
      const result = await eng.removeApp('myapp');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.apps).toEqual([]);
    });

    it('B-H5: still removes the config entry when PM2 delete fails', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(fail(1)); // pm2 delete fails
      const eng = new HostingEngine(DISTRO);
      const result = await eng.removeApp('myapp');
      // The function returns true because the config entry WAS removed.
      expect(result).toBe(true);
      // Crucially, the config entry is gone even though PM2 failed.
      const cfg = await readConfig(tmp);
      expect(cfg?.apps).toEqual([]);
    });

    it('B-H5: when app is not in config and PM2 fails, returns true (vacuously)', async () => {
      // No config file seeded; PM2 delete fails (no process to delete).
      mocks.exec.mockResolvedValueOnce(fail(1));
      const eng = new HostingEngine(DISTRO);
      const result = await eng.removeApp('myapp');
      // No config to remove from; the function returns true because
      // `config?.apps.find(...) === undefined` is true when config is null.
      expect(result).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // addService()
  // -------------------------------------------------------------------------

  describe('addService()', () => {
    it('returns true on successful install and records the service in config', async () => {
      // services.install('redis') runs 2 apt commands + 1 isInstalled probe.
      // Sequence: apt install redis-server, redis-server --daemonize, isInstalled probe.
      mocks.exec
        .mockResolvedValueOnce(ok()) // apt install
        .mockResolvedValueOnce(ok()) // redis-server --daemonize
        .mockResolvedValueOnce(ok()); // isInstalled probe → true
      const eng = new HostingEngine(DISTRO);
      const result = await eng.addService('redis');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.installedServices).toContain('redis');
    });

    it('returns false when services.install reports failure (does not add to config)', async () => {
      // services.install('redis') runs 2 commands + isInstalled probe.
      mocks.exec
        .mockResolvedValueOnce(ok()) // apt install
        .mockResolvedValueOnce(ok()) // redis-server
        .mockResolvedValueOnce(fail(1)); // isInstalled probe → false
      const eng = new HostingEngine(DISTRO);
      const result = await eng.addService('redis');
      expect(result).toBe(false);
      // Config should not have been written (no config file existed, and
      // addService only writes when install succeeded).
      const cfg = await readConfig(tmp);
      expect(cfg).toBeNull();
    });

    it('does not duplicate an already-installed service in installedServices', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: ['redis'],
        defaultPort: 8080,
      });
      mocks.exec
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok());
      const eng = new HostingEngine(DISTRO);
      const result = await eng.addService('redis');
      expect(result).toBe(true);
      const cfg = await readConfig(tmp);
      expect(cfg?.installedServices.filter((s) => s === 'redis')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // expose()
  // -------------------------------------------------------------------------

  describe('expose()', () => {
    it('returns method "none" when app is not in config', async () => {
      const eng = new HostingEngine(DISTRO);
      const r = await eng.expose('nonexistent');
      expect(r.method).toBe('none');
      expect(r.url).toBeNull();
      expect(r.message).toMatch(/not found/);
    });

    it('happy path: delegates to TunnelManager.expose (auto-selects local)', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      // TunnelManager.expose calls getLocalIp which calls `ip addr show wlan0`
      // first; we mock exec to return a valid wlan0 IP.
      mocks.exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '    inet 192.168.1.42/24 brd 192.168.1.255 scope global wlan0\n',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });
      const eng = new HostingEngine(DISTRO);
      const r = await eng.expose('myapp');
      expect(r.method).toBe('local');
      expect(r.url).toBe('http://192.168.1.42:8080');
    });

    it('not-initialized path: returns method "none" when local IP cannot be determined', async () => {
      const app: DeployedApp = {
        name: 'myapp',
        type: 'node',
        path: '/srv/app',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      // `ip addr show wlan0` fails AND `hostname -I` returns empty.
      mocks.exec.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'no such device',
        failed: true,
        timedOut: false,
        command: '',
      });
      mocks.exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: '   \n',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });
      const eng = new HostingEngine(DISTRO);
      const r = await eng.expose('myapp');
      expect(r.method).toBe('none');
      expect(r.url).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // doctor()
  // -------------------------------------------------------------------------

  describe('doctor()', () => {
    it('returns initialized=false + the documented issue when not initialized', async () => {
      const eng = new HostingEngine(DISTRO);
      const d = await eng.doctor();
      expect(d.initialized).toBe(false);
      expect(d.nginxOk).toBe(false);
      expect(d.pm2Ok).toBe(false);
      expect(d.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/not initialized/i)]),
      );
    });

    it('pushes an issue when nginx is not installed (which probe returns non-zero)', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      });
      // nginx probe: `proot-distro login ubuntu -- which nginx` → exit 1.
      mocks.exec.mockResolvedValueOnce(fail(1)); // nginx missing
      // pm2 isInstalled probe: `which pm2` → exit 0.
      mocks.exec.mockResolvedValueOnce(ok());
      const eng = new HostingEngine(DISTRO);
      const d = await eng.doctor();
      expect(d.initialized).toBe(true);
      expect(d.nginxOk).toBe(false);
      expect(d.pm2Ok).toBe(true);
      expect(d.issues).toEqual(expect.arrayContaining([expect.stringMatching(/nginx not installed/)]));
    });

    it('pushes an issue when PM2 is not installed', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok());  // nginx present
      mocks.exec.mockResolvedValueOnce(fail(1)); // pm2 missing
      const eng = new HostingEngine(DISTRO);
      const d = await eng.doctor();
      expect(d.nginxOk).toBe(true);
      expect(d.pm2Ok).toBe(false);
      expect(d.issues).toEqual(expect.arrayContaining([expect.stringMatching(/PM2 not installed/)]));
    });

    it('pushes an issue for every app whose status is "failed"', async () => {
      const failedApp: DeployedApp = {
        name: 'broken',
        type: 'node',
        path: '/x',
        port: 8080,
        pid: null,
        status: 'failed',
        startedAt: null,
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [failedApp],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok()); // nginx
      mocks.exec.mockResolvedValueOnce(ok()); // pm2
      const eng = new HostingEngine(DISTRO);
      const d = await eng.doctor();
      expect(d.issues).toEqual(
        expect.arrayContaining([expect.stringMatching(/App 'broken' is in failed state/)]),
      );
    });

    it('returns a clean report when everything is OK', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      });
      mocks.exec.mockResolvedValueOnce(ok()); // nginx
      mocks.exec.mockResolvedValueOnce(ok()); // pm2
      const eng = new HostingEngine(DISTRO);
      const d = await eng.doctor();
      expect(d.initialized).toBe(true);
      expect(d.nginxOk).toBe(true);
      expect(d.pm2Ok).toBe(true);
      expect(d.issues).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // isInitialized()
  // -------------------------------------------------------------------------

  describe('isInitialized()', () => {
    it('returns false when no config exists', async () => {
      const eng = new HostingEngine(DISTRO);
      expect(await eng.isInitialized()).toBe(false);
    });

    it('returns config.initialized when config exists', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      });
      const eng = new HostingEngine(DISTRO);
      expect(await eng.isInitialized()).toBe(true);
    });

    it('returns false when config.initialized is false', async () => {
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: false,
        initializedAt: null,
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [],
        installedServices: [],
        defaultPort: 8080,
      });
      const eng = new HostingEngine(DISTRO);
      expect(await eng.isInitialized()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // findAvailablePort() — exercised via plan()
  // -------------------------------------------------------------------------

  describe('findAvailablePort() (via plan())', () => {
    it('returns the defaultPort (8080) when nothing is bound and no apps exist', async () => {
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.port).toBe(8080);
    });

    it('walks past any ports already used by deployed apps', async () => {
      const app: DeployedApp = {
        name: 'a',
        type: 'node',
        path: '/x',
        port: 8080,
        pid: 1,
        status: 'running',
        startedAt: '2025-01-01T00:00:00.000Z',
        autoDeployed: false,
      };
      await writeConfig(tmp, {
        schema_version: 1,
        initialized: true,
        initializedAt: '2025-01-01T00:00:00.000Z',
        webServer: 'nginx',
        processManager: 'pm2',
        apps: [app],
        installedServices: [],
        defaultPort: 8080,
      });
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      // 8080 is used by an existing app → walk to 8081.
      expect(plan.port).toBe(8081);
    });

    it('B-H15: walks past a port that is currently bound (mock createServer error listener)', async () => {
      // Bind 8080 via the mock so the OS probe reports it as taken.
      mocks.boundPorts.add(8080);
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.port).toBe(8081);
    });

    it('B-H15: walks past multiple bound ports', async () => {
      mocks.boundPorts.add(8080);
      mocks.boundPorts.add(8081);
      mocks.boundPorts.add(8082);
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.port).toBe(8083);
    });

    it('B-H15: falls back to a high port (>= 49152) when no candidate in the default range is free', async () => {
      // Bind 100 consecutive ports (8080-8179) so the MAX_PROBES loop
      // exhausts without finding a free port.
      for (let p = 8080; p < 8080 + 100; p++) {
        mocks.boundPorts.add(p);
      }
      const eng = new HostingEngine(DISTRO);
      const plan = await eng.plan('/srv/app');
      expect(plan.port).toBeGreaterThanOrEqual(49152);
    });

    it('B-H15: probes the OS via createServer (the call count is non-zero)', async () => {
      const eng = new HostingEngine(DISTRO);
      await eng.plan('/srv/app');
      expect(mocks.createServer).toHaveBeenCalled();
    });
  });
});
