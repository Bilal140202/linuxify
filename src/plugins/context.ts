/**
 * `LinuxifyContext` implementation — the API surface passed to every plugin.
 *
 * @module linuxify/plugins/context
 *
 * The {@link LinuxifyContextImpl} class implements the {@link LinuxifyContext}
 * interface declared in {@link ./types.ts | types.ts}. One instance is
 * created per plugin (scoped to that plugin's namespace) and shared across
 * all hook invocations for that plugin within a single Linuxify process.
 *
 * ## Scoping
 *
 * Every API wrapper is scoped to prevent plugins from touching each other's
 * state:
 *  - `config` reads/writes `host.pluginConfig[pluginName][key]`; a plugin
 *    cannot read another plugin's config keys.
 *  - `state` reads/writes `host.pluginState[pluginName][key]`; same scoping.
 *  - `runtime.registerProvider` / `distros.registerProvider` / etc. tag the
 *    registration with the plugin name so `linuxify plugin list` can report
 *    which plugin provided what. Lookups are global (so
 *    `ctx.runtime.getProvider('java')` works from any plugin).
 *
 * ## Host injection
 *
 * The `exec`, `inDistro`, and `inPackage` methods delegate to callbacks on
 * the shared {@link PluginHost}. The host is constructed by
 * {@link ./index.ts | createPluginSystem} with the real `exec` from
 * `utils/process.ts`; tests can inject mock callbacks.
 *
 * See:
 *  - docs/10-plugin-sdk/extension-api.md §1-§10 (full API reference)
 *
 * @packageDocumentation
 */

import type { Config } from '../config/schema.js';
import type { StateStore } from '../state/store.js';
import { PluginError } from '../utils/errors.js';
import { logger as hostLogger, type Logger } from '../utils/log.js';
import { exec as hostExecFn } from '../utils/process.js';

import type {
  LinuxifyContext,
  PluginIdentity,
  ConfigAPI,
  StateAPI,
  LockHandle,
  RuntimeAPI,
  RuntimeExecOptions,
  RuntimeExecResult,
  DistrosAPI,
  DistroInfo,
  PackagesAPI,
  PackageInfo,
  PatchesAPI,
  DoctorAPI,
  DoctorCheckSpec,
  CliAPI,
  RegisteredCommand,
  CommandOptions,
  FlagSpec,
  ParsedArgs,
  PluginManifest,
} from './types.js';

// ============================================================================
// PluginHost — shared state across all plugin contexts in a process
// ============================================================================

/**
 * A registered runtime provider entry. The `pluginName` field records which
 * plugin registered the provider so `linuxify plugin list` can attribute it.
 */
interface RegisteredRuntimeProvider {
  readonly pluginName: string;
  readonly provider: unknown;
}

/**
 * A registered distro provider entry (parallel to
 * {@link RegisteredRuntimeProvider}).
 */
interface RegisteredDistroProvider {
  readonly pluginName: string;
  readonly provider: unknown;
}

/** A registered patch-type handler entry. */
interface RegisteredPatchType {
  readonly pluginName: string;
  readonly handler: unknown;
}

/**
 * The shared host object held by every {@link LinuxifyContextImpl} in a single
 * Linuxify process. Holds the base logger, the state store, the loaded config,
 * and in-memory registries for plugin-registered providers, patch types,
 * doctor checks, and CLI commands.
 *
 * Not exported; callers interact with the host only through the
 * {@link LinuxifyContextImpl} instances created by
 * {@link ./index.ts | createPluginSystem}.
 */
export class PluginHost {
  /** The base logger; per-plugin contexts create children via `logger.child`. */
  readonly logger: Logger;
  /** The state store (for `state.lock()` and persistence). */
  readonly stateStore: StateStore;
  /** The loaded Linuxify config (read-only; plugins cannot mutate global config). */
  readonly config: Config;

  /** Per-plugin config namespaces: `pluginConfig.get('my-plugin')?.['key']`. */
  readonly pluginConfig = new Map<string, Record<string, unknown>>();
  /** Per-plugin state namespaces. */
  readonly pluginState = new Map<string, Record<string, unknown>>();
  /** Config-change watchers: keyed by `pluginName:key`. */
  private readonly configWatchers = new Map<string, Set<(n: unknown, o: unknown) => void>>();

  /** Registered runtime providers, keyed by provider name. */
  readonly runtimeProviders = new Map<string, RegisteredRuntimeProvider>();
  /** Registered distro providers, keyed by provider name. */
  readonly distroProviders = new Map<string, RegisteredDistroProvider>();
  /** Registered patch-type handlers, keyed by type name. */
  readonly patchTypes = new Map<string, RegisteredPatchType>();
  /** Registered doctor checks, keyed by check id. */
  readonly doctorChecks = new Map<string, DoctorCheckSpec & { pluginName: string }>();
  /** Registered CLI commands, keyed by command name. */
  readonly cliCommands = new Map<string, RegisteredCommand>();
  /** Registered global CLI flags, keyed by flag name. */
  readonly cliFlags = new Map<string, FlagSpec & { pluginName: string }>();

  /**
   * Injected host execution callbacks. `execFn` defaults to the real
   * `utils/process.exec`; `inDistroFn` and `inPackageFn` default to
   * not-implemented stubs (wired by the CLI when the distro/package
   * subsystems are available).
   */
  execFn: typeof hostExecFn;
  inDistroFn:
    | ((
        distro: string,
        cmd: string,
        args: readonly string[],
        opts?: RuntimeExecOptions,
      ) => Promise<RuntimeExecResult>)
    | null = null;
  inPackageFn:
    | ((
        pkg: string,
        cmd: string,
        args: readonly string[],
        opts?: RuntimeExecOptions,
      ) => Promise<RuntimeExecResult>)
    | null = null;
  packagesListFn: (() => PackageInfo[]) | null = null;
  packagesGetFn: ((name: string) => PackageInfo) | null = null;
  packagesInstallFn:
    | ((name: string, opts?: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  packagesUninstallFn:
    | ((name: string, opts?: Record<string, unknown>) => Promise<unknown>)
    | null = null;
  distrosListFn: (() => DistroInfo[]) | null = null;
  distrosGetActiveFn: (() => DistroInfo) | null = null;
  distrosGetFn: ((name: string) => DistroInfo) | null = null;

  /**
   * @param opts - The state store, config, and optional logger override.
   */
  constructor(opts: { stateStore: StateStore; config: Config; logger?: Logger }) {
    this.stateStore = opts.stateStore;
    this.config = opts.config;
    this.logger = opts.logger ?? hostLogger;
    // Default `execFn` to the real host exec from `utils/process.ts`.
    this.execFn = hostExecFn;
  }

  /**
   * Notify all watchers for `pluginName:key` that the value changed. Called
   * by the {@link ConfigAPI} wrapper after a successful `set` or `delete`.
   */
  notifyConfigWatchers(pluginName: string, key: string, newValue: unknown, oldValue: unknown): void {
    const set = this.configWatchers.get(`${pluginName}:${key}`);
    if (set) {
      for (const cb of set) {
        try {
          cb(newValue, oldValue);
        } catch (err) {
          this.logger.warn(
            `Config watcher for ${pluginName}:${key} threw: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Register a config watcher. Returns an unsubscribe function.
   */
  addConfigWatcher(
    pluginName: string,
    key: string,
    cb: (newValue: unknown, oldValue: unknown) => void,
  ): () => void {
    const mapKey = `${pluginName}:${key}`;
    let set = this.configWatchers.get(mapKey);
    if (!set) {
      set = new Set();
      this.configWatchers.set(mapKey, set);
    }
    set.add(cb);
    return () => {
      const s = this.configWatchers.get(mapKey);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.configWatchers.delete(mapKey);
      }
    };
  }
}

// ============================================================================
// ConfigAPI wrapper
// ============================================================================

/**
 * Scoped config wrapper. All keys are namespaced under the plugin name so
 * plugins cannot read or write each other's config.
 */
class ScopedConfigAPI implements ConfigAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  /** Get the plugin's config namespace (creating it if missing). */
  private ns(): Record<string, unknown> {
    let m = this.host.pluginConfig.get(this.pluginName);
    if (!m) {
      m = {};
      this.host.pluginConfig.set(this.pluginName, m);
    }
    return m;
  }

  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string, defaultValue: T): T;
  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    const val = this.ns()[key];
    if (val === undefined) return defaultValue;
    return val as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const ns = this.ns();
    const oldValue = ns[key];
    ns[key] = value;
    this.host.notifyConfigWatchers(this.pluginName, key, value, oldValue);
  }

  async delete(key: string): Promise<boolean> {
    const ns = this.ns();
    if (!(key in ns)) return false;
    const oldValue = ns[key];
    delete ns[key];
    this.host.notifyConfigWatchers(this.pluginName, key, undefined, oldValue);
    return true;
  }

  watch(key: string, cb: (newValue: unknown, oldValue: unknown) => void): () => void {
    return this.host.addConfigWatcher(this.pluginName, key, cb);
  }

  all(): Record<string, unknown> {
    return { ...this.ns() };
  }
}

// ============================================================================
// StateAPI wrapper
// ============================================================================

/**
 * Scoped state wrapper. Reads and writes are namespaced; `lock()` delegates
 * to the underlying {@link StateStore} for cross-process mutual exclusion.
 */
class ScopedStateAPI implements StateAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  /** Get the plugin's state namespace (creating it if missing). */
  private ns(): Record<string, unknown> {
    let m = this.host.pluginState.get(this.pluginName);
    if (!m) {
      m = {};
      this.host.pluginState.set(this.pluginName, m);
    }
    return m;
  }

  get(): Record<string, unknown>;
  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key?: string): Record<string, unknown> | T | undefined {
    if (key === undefined) return { ...this.ns() };
    return this.ns()[key] as T | undefined;
  }

  async update(partial: Record<string, unknown>): Promise<void> {
    // Acquire the global state lock to serialise concurrent updates across
    // processes. The in-memory merge itself is synchronous, but holding the
    // lock ensures a concurrent CLI invocation doesn't interleave.
    await this.host.stateStore.withLock(async () => {
      const ns = this.ns();
      for (const [k, v] of Object.entries(partial)) {
        ns[k] = v;
      }
    });
  }

  async lock(): Promise<LockHandle> {
    await this.host.stateStore.lock();
    return {
      release: async () => {
        await this.host.stateStore.unlock();
      },
    };
  }
}

// ============================================================================
// RuntimeAPI wrapper
// ============================================================================

/**
 * Runtime API wrapper. `exec`/`inDistro`/`inPackage` delegate to host
 * callbacks; `registerProvider`/`getProvider` manage the per-plugin
 * provider registry.
 */
class ScopedRuntimeAPI implements RuntimeAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  async exec(
    cmd: string,
    args: readonly string[],
    opts?: RuntimeExecOptions,
  ): Promise<RuntimeExecResult> {
    const start = Date.now();
    // Map the plugin-facing RuntimeExecOptions to the host ExecOptions.
    // `stdin` (a string) maps to execa's `input` field.
    const hostOpts: Record<string, unknown> = {};
    if (opts) {
      if (opts.cwd !== undefined) hostOpts.cwd = opts.cwd;
      if (opts.env !== undefined) hostOpts.env = opts.env;
      if (opts.timeoutMs !== undefined) hostOpts.timeoutMs = opts.timeoutMs;
      if (opts.stdin !== undefined) hostOpts.input = opts.stdin;
    }
    const result = await this.host.execFn(cmd, [...args], hostOpts);
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - start,
    };
  }

  async inDistro(
    distro: string | 'active',
    cmd: string,
    args: readonly string[],
    opts?: RuntimeExecOptions,
  ): Promise<RuntimeExecResult> {
    if (!this.host.inDistroFn) {
      throw new PluginError(
        `runtime.inDistro is not available (distro subsystem not wired)`,
        { code: 'E_PLUGIN_HOST_UNAVAILABLE', details: { plugin: this.pluginName } },
      );
    }
    return this.host.inDistroFn(distro, cmd, args, opts);
  }

  async inPackage(
    pkg: string,
    cmd: string,
    args: readonly string[],
    opts?: RuntimeExecOptions,
  ): Promise<RuntimeExecResult> {
    if (!this.host.inPackageFn) {
      throw new PluginError(
        `runtime.inPackage is not available (package subsystem not wired)`,
        { code: 'E_PLUGIN_HOST_UNAVAILABLE', details: { plugin: this.pluginName } },
      );
    }
    return this.host.inPackageFn(pkg, cmd, args, opts);
  }

  registerProvider(name: string, provider: unknown): void {
    this.host.runtimeProviders.set(name, { pluginName: this.pluginName, provider });
  }

  getProvider(name: string): unknown | null {
    const entry = this.host.runtimeProviders.get(name);
    return entry ? entry.provider : null;
  }
}

// ============================================================================
// DistrosAPI wrapper
// ============================================================================

/**
 * Distros API wrapper. Registration is per-plugin; listing/getting delegates
 * to host callbacks (wired when the distro subsystem is available).
 */
class ScopedDistrosAPI implements DistrosAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  list(): DistroInfo[] {
    if (this.host.distrosListFn) return this.host.distrosListFn();
    return [];
  }

  getActive(): DistroInfo {
    if (this.host.distrosGetActiveFn) return this.host.distrosGetActiveFn();
    throw new PluginError(`distros.getActive is not available`, {
      code: 'E_PLUGIN_HOST_UNAVAILABLE',
    });
  }

  get(name: string): DistroInfo {
    if (this.host.distrosGetFn) return this.host.distrosGetFn(name);
    throw new PluginError(`distros.get is not available`, {
      code: 'E_PLUGIN_HOST_UNAVAILABLE',
    });
  }

  registerProvider(name: string, provider: unknown): void {
    this.host.distroProviders.set(name, { pluginName: this.pluginName, provider });
  }
}

// ============================================================================
// PackagesAPI wrapper
// ============================================================================

/**
 * Packages API wrapper. All methods delegate to host callbacks (wired when
 * the package manager is available).
 */
class ScopedPackagesAPI implements PackagesAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  list(): PackageInfo[] {
    if (this.host.packagesListFn) return this.host.packagesListFn();
    return [];
  }

  get(name: string): PackageInfo {
    if (this.host.packagesGetFn) return this.host.packagesGetFn(name);
    throw new PluginError(`packages.get is not available`, {
      code: 'E_PLUGIN_HOST_UNAVAILABLE',
    });
  }

  async install(name: string, opts?: Record<string, unknown>): Promise<unknown> {
    if (!this.host.packagesInstallFn) {
      throw new PluginError(`packages.install is not available`, {
        code: 'E_PLUGIN_HOST_UNAVAILABLE',
        details: { plugin: this.pluginName, package: name },
      });
    }
    return this.host.packagesInstallFn(name, opts);
  }

  async uninstall(name: string, opts?: Record<string, unknown>): Promise<unknown> {
    if (!this.host.packagesUninstallFn) {
      throw new PluginError(`packages.uninstall is not available`, {
        code: 'E_PLUGIN_HOST_UNAVAILABLE',
        details: { plugin: this.pluginName, package: name },
      });
    }
    return this.host.packagesUninstallFn(name, opts);
  }
}

// ============================================================================
// PatchesAPI wrapper
// ============================================================================

/**
 * Patches API wrapper. `registerType` is per-plugin; `getType` is global.
 * `list` returns an empty array until the patcher subsystem is wired.
 */
class ScopedPatchesAPI implements PatchesAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  list(_pkg: string): unknown[] {
    return [];
  }

  registerType(name: string, handler: unknown): void {
    this.host.patchTypes.set(name, { pluginName: this.pluginName, handler });
  }

  getType(name: string): unknown | null {
    const entry = this.host.patchTypes.get(name);
    return entry ? entry.handler : null;
  }
}

// ============================================================================
// DoctorAPI wrapper
// ============================================================================

/**
 * Doctor API wrapper. `registerCheck` stores the check (tagged with the
 * plugin name); `listChecks` returns all registered checks.
 */
class ScopedDoctorAPI implements DoctorAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  registerCheck(check: DoctorCheckSpec): void {
    this.host.doctorChecks.set(check.id, { ...check, pluginName: this.pluginName });
  }

  listChecks(): DoctorCheckSpec[] {
    return Array.from(this.host.doctorChecks.values()).map(({ pluginName: _pn, ...check }) => check);
  }
}

// ============================================================================
// CliAPI wrapper
// ============================================================================

/**
 * CLI API wrapper. `registerCommand` stores the command (tagged with the
 * plugin name); `registerFlag` stores a global flag.
 */
class ScopedCliAPI implements CliAPI {
  private readonly host: PluginHost;
  private readonly pluginName: string;

  constructor(host: PluginHost, pluginName: string) {
    this.host = host;
    this.pluginName = pluginName;
  }

  registerCommand(
    name: string,
    handler: (args: ParsedArgs, ctx: LinuxifyContext) => Promise<number>,
    options: CommandOptions,
  ): string {
    this.host.cliCommands.set(name, { name, handler, options, pluginName: this.pluginName });
    return name;
  }

  listCommands(): RegisteredCommand[] {
    return Array.from(this.host.cliCommands.values());
  }

  registerFlag(name: string, spec: FlagSpec): void {
    this.host.cliFlags.set(name, { ...spec, pluginName: this.pluginName });
  }
}

// ============================================================================
// LinuxifyContextImpl
// ============================================================================

/**
 * Concrete implementation of {@link LinuxifyContext}. One instance is created
 * per plugin (via {@link forPlugin}) and shared across all hook invocations
 * for that plugin.
 *
 * The root context (created by `createPluginSystem` with no specific plugin)
 * serves as a factory: the {@link HookDispatcher} calls
 * `rootContext.forPlugin(name, manifest, path)` to obtain a scoped context
 * before invoking each hook.
 */
export class LinuxifyContextImpl implements LinuxifyContext {
  readonly plugin: PluginIdentity;
  readonly logger: Logger;
  readonly config: ConfigAPI;
  readonly state: StateAPI;
  readonly runtime: RuntimeAPI;
  readonly distros: DistrosAPI;
  readonly packages: PackagesAPI;
  readonly patches: PatchesAPI;
  readonly doctor: DoctorAPI;
  readonly cli: CliAPI;

  private readonly host: PluginHost;

  /**
   * @param opts - The plugin identity, manifest, path, and shared host.
   */
  constructor(opts: {
    host: PluginHost;
    pluginName: string;
    manifestPath: string;
    pluginPath: string;
    manifest: PluginManifest;
  }) {
    this.host = opts.host;
    this.plugin = {
      name: opts.pluginName,
      version: opts.manifest.version,
      manifestPath: opts.manifestPath,
      rootDir: opts.pluginPath,
    };
    this.logger = opts.host.logger.child({ plugin: opts.pluginName });
    this.config = new ScopedConfigAPI(opts.host, opts.pluginName);
    this.state = new ScopedStateAPI(opts.host, opts.pluginName);
    this.runtime = new ScopedRuntimeAPI(opts.host, opts.pluginName);
    this.distros = new ScopedDistrosAPI(opts.host, opts.pluginName);
    this.packages = new ScopedPackagesAPI(opts.host, opts.pluginName);
    this.patches = new ScopedPatchesAPI(opts.host, opts.pluginName);
    this.doctor = new ScopedDoctorAPI(opts.host, opts.pluginName);
    this.cli = new ScopedCliAPI(opts.host, opts.pluginName);
  }

  /**
   * Create a new scoped context for a different plugin, sharing the same
   * host (and therefore the same registries and state store).
   *
   * Used by the {@link HookDispatcher} to obtain a per-plugin context before
   * invoking each hook.
   *
   * @param pluginName - The plugin name.
   * @param manifest - The plugin's validated manifest.
   * @param pluginPath - Absolute path to the plugin's root directory.
   * @returns A new {@link LinuxifyContextImpl} scoped to the given plugin.
   */
  forPlugin(
    pluginName: string,
    manifest: PluginManifest,
    pluginPath: string,
  ): LinuxifyContextImpl {
    return new LinuxifyContextImpl({
      host: this.host,
      pluginName,
      manifestPath: `${pluginPath}/linuxify.plugin.json`,
      pluginPath,
      manifest,
    });
  }

  /**
   * Expose the underlying host for internal use (e.g. by the loader to
   * record registrations). Not part of the public {@link LinuxifyContext}
   * interface.
   *
   * @internal
   */
  getHost(): PluginHost {
    return this.host;
  }
}
