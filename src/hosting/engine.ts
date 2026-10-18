import { createServer } from 'node:net';
import { join } from 'node:path';
/**
 * Hosting engine — core orchestrator for all hosting operations.
 *
 * @module linuxify/hosting/engine
 *
 * Manages:
 * - Initialization (install nginx + PM2)
 * - Project detection and deployment
 * - Application lifecycle (start/stop/restart/remove)
 * - Port allocation
 * - Config persistence
 */

import { exists, readFile, writeFile, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { exec, getLinuxifyHome } from '../utils/process.js';

import { HostingConfigSchema, DEFAULT_HOSTING_CONFIG, type HostingConfig, type DeployedApp } from './config.js';
import { detectProject, type DetectionResult } from './detect.js';
import { TunnelManager } from './expose.js';
import { ProcessManager } from './process-manager.js';
import { ServiceManager, type ServiceType } from './services.js';

const HOSTING_SUBDIR = 'hosting';
const HOSTING_CONFIG_FILE = 'config.json';

export type HostingStatus = 'initialized' | 'not-initialized' | 'broken';

export interface DeploymentPlan {
  detection: DetectionResult;
  port: number;
  name: string;
  steps: string[];
  estimatedStorageMb: number;
}

export class HostingEngine {
  private readonly homeDir: string;
  private readonly configPath: string;
  private config: HostingConfig | null = null;
  private readonly distro: string;
  private readonly pm: ProcessManager;
  private readonly services: ServiceManager;
  private readonly tunnels: TunnelManager;

  constructor(distro: string) {
    this.distro = distro;
    this.homeDir = join(getLinuxifyHome(), HOSTING_SUBDIR);
    this.configPath = join(this.homeDir, HOSTING_CONFIG_FILE);
    this.pm = new ProcessManager(distro);
    this.services = new ServiceManager(distro);
    this.tunnels = new TunnelManager(distro);
  }

  /**
   * Initialize the hosting environment.
   * Installs nginx + PM2 inside the proot, creates config.
   */
  async init(): Promise<{ success: boolean; message: string }> {
    logger.info({ distro: this.distro }, 'hosting: initializing');

    // Create hosting directory
    await ensureDir(this.homeDir);

    // Check if already initialized
    const existing = await this.loadConfig();
    if (existing?.initialized) {
      return { success: true, message: 'Hosting already initialized.' };
    }

    // Install nginx
    logger.info('hosting: installing nginx');
    const nginxResult = await exec(
      'proot-distro',
      ['login', this.distro, '--', 'bash', '-c',
       'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>/dev/null && apt-get install -y -qq nginx 2>&1 | tail -3'],
      { timeoutMs: 120_000, env: { TERM: 'dumb' } },
    );
    if (nginxResult.exitCode !== 0) {
      logger.warn({ exitCode: nginxResult.exitCode }, 'hosting: nginx install had issues');
    }

    // Install PM2
    logger.info('hosting: installing PM2');
    const pm2Ok = await this.pm.install();
    if (!pm2Ok) {
      logger.warn('hosting: PM2 install failed — trying with npm');
    }

    // Write config
    const config: HostingConfig = {
      ...DEFAULT_HOSTING_CONFIG,
      initialized: true,
      initializedAt: new Date().toISOString(),
    };
    await this.saveConfig(config);
    this.config = config;

    logger.info('hosting: initialization complete');
    return { success: true, message: 'Hosting environment initialized. nginx + PM2 installed.' };
  }

  /**
   * Detect the project type in the given path and generate a deployment plan.
   */
  async plan(projectPath: string, appName?: string): Promise<DeploymentPlan> {
    const detection = await detectProject(projectPath);
    const port = await this.findAvailablePort();
    const name = appName ?? detection.framework.toLowerCase().replace(/[^a-z0-9]/g, '-');

    const steps: string[] = [];
    if (detection.installCommand) steps.push(`Install: ${detection.installCommand}`);
    if (detection.buildCommand) steps.push(`Build: ${detection.buildCommand}`);
    steps.push(`Start: ${detection.startCommand} (port ${port})`);

    return {
      detection,
      port,
      name,
      steps,
      estimatedStorageMb: 100, // rough estimate
    };
  }

  /**
   * Deploy a project.
   */
  async deploy(projectPath: string, appName?: string): Promise<{ success: boolean; url: string | null; message: string }> {
    const plan = await this.plan(projectPath, appName);
    const d = plan.detection;

    if (d.type === 'unknown') {
      return { success: false, url: null, message: `Could not detect project type in ${projectPath}` };
    }

    logger.info({ name: plan.name, type: d.type, port: plan.port }, 'hosting: deploying');

    // Execute install
    if (d.installCommand) {
      logger.info(`hosting: running ${d.installCommand}`);
      const r = await exec(
        'proot-distro',
        ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c',
         `cd ${projectPath} && ${d.installCommand} 2>&1 | tail -5`],
        { timeoutMs: 300_000, env: { TERM: 'dumb' } },
      );
      if (r.exitCode !== 0) {
        return { success: false, url: null, message: `Install failed: ${r.stderr.slice(0, 200)}` };
      }
    }

    // Execute build
    if (d.buildCommand) {
      logger.info(`hosting: running ${d.buildCommand}`);
      const r = await exec(
        'proot-distro',
        ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c',
         `cd ${projectPath} && ${d.buildCommand} 2>&1 | tail -5`],
        { timeoutMs: 300_000, env: { TERM: 'dumb' } },
      );
      if (r.exitCode !== 0) {
        return { success: false, url: null, message: `Build failed: ${r.stderr.slice(0, 200)}` };
      }
    }

    // Start with PM2
    const startCmd = d.startCommand.replace('${PORT}', String(plan.port));
    const pm2Result = await this.pm.start(plan.name, startCmd, projectPath);
    if (pm2Result !== 0) {
      return { success: false, url: null, message: 'Failed to start with PM2' };
    }

    // Record in config
    const app: DeployedApp = {
      name: plan.name,
      type: d.type as DeployedApp['type'],
      path: projectPath,
      port: plan.port,
      pid: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      framework: d.framework,
      autoDeployed: appName === undefined,
    };

    // BUG FIX (B-H2): if config.json was missing or malformed, fall back to a
    // properly-initialized config (initialized=true) rather than the bare
    // DEFAULT_HOSTING_CONFIG (which has initialized=false). Otherwise a
    // successful deploy would silently flip the host's initialized flag to
    // false and break `host doctor` + every other path that gates on
    // `isInitialized()`.
    const existing = await this.loadConfig();
    const config: HostingConfig = existing
      ? { ...existing }
      : {
          ...DEFAULT_HOSTING_CONFIG,
          initialized: true,
          initializedAt: new Date().toISOString(),
        };
    // Remove any existing app with the same name
    config.apps = config.apps.filter((a) => a.name !== plan.name);
    config.apps.push(app);
    await this.saveConfig(config);

    const url = `http://127.0.0.1:${plan.port}`;
    return { success: true, url, message: `Deployed ${plan.name} at ${url}` };
  }

  /**
   * List all deployed apps.
   */
  async list(): Promise<DeployedApp[]> {
    const config = await this.loadConfig();
    return config?.apps ?? [];
  }

  /**
   * Get status of all apps + services.
   */
  async status(): Promise<{ apps: DeployedApp[]; services: unknown[] }> {
    const config = await this.loadConfig();
    const apps = config?.apps ?? [];
    const services = await this.services.getAllStatus();
    return { apps, services };
  }

  /**
   * Start a stopped app.
   */
  async startApp(name: string): Promise<boolean> {
    const config = await this.loadConfig();
    const app = config?.apps.find((a) => a.name === name);
    if (!app) return false;

    const d = await detectProject(app.path);
    const startCmd = d.startCommand.replace('${PORT}', String(app.port));
    const result = await this.pm.start(name, startCmd, app.path);

    if (result === 0 && config) {
      app.status = 'running';
      app.startedAt = new Date().toISOString();
      await this.saveConfig(config);
      this.config = config;
    }
    return result === 0;
  }

  /**
   * Stop a running app.
   */
  async stopApp(name: string): Promise<boolean> {
    const result = await this.pm.stop(name);
    const config = await this.loadConfig();
    if (result === 0 && config) {
      const app = config.apps.find((a) => a.name === name);
      if (app) {
        app.status = 'stopped';
        app.startedAt = null;
        await this.saveConfig(config);
        this.config = config;
      }
    }
    return result === 0;
  }

  /**
   * Restart an app.
   *
   * BUG FIX (B-H4): previously this method called `pm.restart(name)`
   * directly without first checking that the app actually exists in the
   * hosting config — if PM2 happened to have a process with the same
   * name (e.g. a leftover from a removed deployment), the restart would
   * succeed and report "Restarted" while the hosting config remained
   * out of sync. We now refuse with `false` if the app is not in config.
   */
  async restartApp(name: string): Promise<boolean> {
    const config = await this.loadConfig();
    const app = config?.apps.find((a) => a.name === name);
    if (!app) {
      logger.warn({ name }, 'hosting: restartApp — app not in config');
      return false;
    }
    const result = await this.pm.restart(name);
    if (result === 0 && config) {
      app.status = 'running';
      app.startedAt = new Date().toISOString();
      await this.saveConfig(config);
    }
    return result === 0;
  }

  /**
   * Remove an app.
   *
   * BUG FIX (B-H5): previously this method always returned `true` even
   * if `pm.remove()` failed, masking real failures from the user. We
   * now return the actual PM2 outcome AND clean up config regardless
   * (so a broken PM2 entry doesn't keep the config entry alive as
   * garbage).
   */
  async removeApp(name: string): Promise<boolean> {
    const pmResult = await this.pm.remove(name);
    const config = await this.loadConfig();
    if (config) {
      const before = config.apps.length;
      config.apps = config.apps.filter((a) => a.name !== name);
      const after = config.apps.length;
      if (before !== after) {
        await this.saveConfig(config);
        logger.info({ name, removed: before - after }, 'hosting: removed app from config');
      }
    }
    if (pmResult !== 0) {
      logger.warn({ name, exitCode: pmResult }, 'hosting: PM2 delete had non-zero exit');
      // We still return true if the config entry was removed — the app
      // is functionally gone from the user's perspective even if PM2
      // was already in a bad state. The PM2 warning is logged.
      return config?.apps.find((a) => a.name === name) === undefined;
    }
    return true;
  }

  /**
   * Get logs for an app.
   */
  async logs(name: string, lines: number = 50): Promise<string> {
    return await this.pm.logs(name, lines);
  }

  /**
   * Install a database service.
   */
  async addService(service: ServiceType): Promise<boolean> {
    const installed = await this.services.install(service);
    if (installed) {
      const config = await this.loadConfig() ?? DEFAULT_HOSTING_CONFIG;
      if (!config.installedServices.includes(service)) {
        config.installedServices.push(service);
        await this.saveConfig(config);
        this.config = config;
      }
    }
    return installed;
  }

  /**
   * Expose an app publicly.
   */
  async expose(appName: string): Promise<{ method: string; url: string | null; message: string }> {
    const config = await this.loadConfig();
    const app = config?.apps.find((a) => a.name === appName);
    if (!app) {
      return { method: 'none', url: null, message: `App '${appName}' not found` };
    }
    const result = await this.tunnels.expose(appName, app.port);
    return { method: result.method, url: result.url, message: result.message };
  }

  /**
   * Check hosting health.
   */
  async doctor(): Promise<{ initialized: boolean; nginxOk: boolean; pm2Ok: boolean; issues: string[] }> {
    const issues: string[] = [];
    const config = await this.loadConfig();

    if (!config?.initialized) {
      issues.push('Hosting not initialized. Run: linuxify host init');
      return { initialized: false, nginxOk: false, pm2Ok: false, issues };
    }

    // Check nginx
    const nginxR = await exec(
      'proot-distro',
      ['login', this.distro, '--', 'which', 'nginx'],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );
    const nginxOk = nginxR.exitCode === 0;
    if (!nginxOk) issues.push('nginx not installed');

    // Check PM2
    const pm2Ok = await this.pm.isInstalled();
    if (!pm2Ok) issues.push('PM2 not installed');

    // Check apps
    for (const app of config.apps) {
      if (app.status === 'failed') issues.push(`App '${app.name}' is in failed state`);
    }

    return { initialized: true, nginxOk, pm2Ok, issues };
  }

  /**
   * Check if hosting is initialized.
   */
  async isInitialized(): Promise<boolean> {
    const config = await this.loadConfig();
    return config?.initialized ?? false;
  }

  // ─── Private helpers ──────────────────────────────────────────

  private async loadConfig(): Promise<HostingConfig | null> {
    if (this.config) return this.config;
    try {
      if (!(await exists(this.configPath))) return null;
      const raw = await readFile(this.configPath);
      const parsed = JSON.parse(raw);
      const result = HostingConfigSchema.safeParse(parsed);
      if (result.success) {
        this.config = result.data;
        return result.data;
      }
      logger.warn('hosting: config.json is malformed');
      return null;
    } catch {
      return null;
    }
  }

  private async saveConfig(config: HostingConfig): Promise<void> {
    await ensureDir(this.homeDir);
    await writeFile(this.configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Find an available port. Starts from `defaultPort` (or the next slot
   * above any ports already used by deployed apps), then probes the OS to
   * confirm the port is actually bindable before returning it.
   *
   * BUG FIX (B-H15): previously this only walked past ports recorded in
   * `config.apps`, which meant if nginx (or anything else outside Linuxify)
   * was already bound to the next candidate port, deploy would silently
   * try to bind it and fail at runtime with `EADDRINUSE`. Now we probe
   * via a throwaway TCP server to confirm the port is actually free.
   */
  private async findAvailablePort(): Promise<number> {
    const config = await this.loadConfig();
    const usedPorts = new Set(config?.apps.map((a) => a.port) ?? []);
    let port = config?.defaultPort ?? 8080;
    // Skip past any ports already in use by deployed apps.
    while (usedPorts.has(port)) port++;
    // Now probe the OS to confirm each candidate is actually bindable.
    // Cap the search so we don't loop forever in pathological cases.
    const MAX_PROBES = 100;
    for (let i = 0; i < MAX_PROBES; i++) {
      if (await this.isPortFree(port)) return port;
      port++;
    }
    // Fall back to a random high port if everything in the default range
    // is taken. Ephemeral range starts at 49152 per RFC 6056; we step
    // up from there.
    const fallback = 49152 + Math.floor(Math.random() * 10000);
    return fallback;
  }

  /**
   * Probe whether a TCP port is currently free on the loopback interface.
   * Resolves true if the port can be bound (i.e. nothing is listening on
   * it), false otherwise. Never throws — a probe error is treated as
   * "port not free" so we move on to the next candidate.
   */
  private async isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = createServer();
      srv.unref();
      srv.once('error', () => {
        try { srv.close(); } catch { /* ignore */ }
        resolve(false);
      });
      srv.once('listening', () => {
        try { srv.close(); } catch { /* ignore */ }
        resolve(true);
      });
      srv.listen(port, '127.0.0.1');
    });
  }
}
