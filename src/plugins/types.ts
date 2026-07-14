/**
 * Plugin type definitions.
 *
 * @module linuxify/plugins/types
 *
 * This module is the single source of truth for every TypeScript type used by
 * the plugin subsystem: the manifest shape, the {@link Plugin} runtime
 * record, the {@link PluginInstall} state entry, the hook-name union, and the
 * extension-API interfaces ({@link LinuxifyContext}, {@link ConfigAPI},
 * {@link StateAPI}, {@link RuntimeAPI}, …) that plugins consume via
 * `ctx.*`.
 *
 * The Zod schema that validates the manifest at load time lives in
 * {@link ./manifest.ts | manifest.ts}; the runtime implementation of
 * {@link LinuxifyContext} lives in {@link ./context.ts | context.ts}. Both
 * import the type-only declarations from this file so that the type and the
 * runtime schema cannot drift apart.
 *
 * See:
 *  - docs/10-plugin-sdk/plugin-sdk.md §3 (manifest format)
 *  - docs/10-plugin-sdk/extension-api.md §1-§11 (API surface + hook signatures)
 *  - docs/02-architecture/type-reference.md §9 (plugin types reference)
 *
 * @packageDocumentation
 */

import type { Logger } from '../utils/log.js';

// ============================================================================
// Manifest types
// ============================================================================

/**
 * The set of hook names a plugin may declare in its manifest. Each name maps
 * to a relative file path (string) pointing at an ESM module that exports a
 * single async function.
 *
 * The union is derived from the `hooks` field of {@link PluginManifest} so it
 * stays in sync if a hook is added or removed.
 */
export type PluginHookName = keyof PluginManifest['hooks'];

/**
 * Manifest for a Linuxify plugin, read from `linuxify.plugin.json` at the
 * plugin's package root.
 *
 * Every plugin ships a `linuxify.plugin.json` manifest declaring its identity,
 * its compatibility with the Linuxify CLI (via the `linuxify` semver range),
 * what it provides (runtimes, distros, commands, doctor checks, patch types),
 * and the hooks it implements. The loader reads the manifest at startup,
 * validates it against the Zod schema in
 * {@link ./manifest.ts | manifest.ts}, and dynamic-imports the hook files on
 * first invocation.
 *
 * Hook file paths are relative to the plugin's root directory and must point
 * at ESM modules exporting a single async function (default export or a named
 * export matching the hook name).
 */
export interface PluginManifest {
  /** Plugin name; must be lowercase kebab-case (e.g. `linuxify-plugin-java`). */
  readonly name: string;
  /** Plugin version; must be a valid semver string (e.g. `1.0.0`). */
  readonly version: string;
  /**
   * Semver range constraining which Linuxify CLI versions may load this
   * plugin. The loader checks `semver.satisfies(LINUXIFY_VERSION, linuxify)`;
   * a mismatch causes the plugin to be skipped with a warning.
   */
  readonly linuxify: string;
  /**
   * Optional human-readable description. Not validated; surfaced in
   * `linuxify plugin list` output.
   */
  readonly description?: string;
  /**
   * Declaration of what the plugin contributes to Linuxify. Each sub-field is
   * a string array. The loader uses these declarations to build the registry
   * of available runtimes, distros, commands, doctor checks, and patch types
   * before invoking any plugin code.
   */
  readonly provides: {
    /** Runtime names this plugin registers (e.g. `['java']`). */
    readonly runtimes?: readonly string[];
    /** Distro names this plugin registers (e.g. `['fedora']`). */
    readonly distros?: readonly string[];
    /** Custom subcommand names this plugin registers. */
    readonly commands?: readonly string[];
    /** Doctor check IDs this plugin registers. */
    readonly doctorChecks?: readonly string[];
    /** Custom patch type names this plugin registers. */
    readonly patchTypes?: readonly string[];
  };
  /**
   * Map of hook name to relative file path. Each path resolves to an ESM
   * module that exports a single async function. A plugin need not implement
   * every hook; omit the entry for hooks you do not implement.
   */
  readonly hooks: {
    readonly preInstall?: string;
    readonly postInstall?: string;
    readonly prePatch?: string;
    readonly postPatch?: string;
    readonly preRun?: string;
    readonly postRun?: string;
    readonly doctor?: string;
    readonly bootstrap?: string;
    readonly command?: string;
  };
  /**
   * Path to a JSON Schema file that validates the plugin's configuration.
   * Optional; if omitted, the plugin's config is unchecked.
   */
  readonly configSchema?: string;
}

// ============================================================================
// Runtime plugin record
// ============================================================================

/**
 * A generic async function type used for plugin hooks. The actual argument
 * types vary per hook (see the hook signatures in
 * `docs/10-plugin-sdk/extension-api.md §11`); the dispatcher passes
 * `(...args, context)` where `context` is the scoped {@link LinuxifyContext}.
 *
 * Using a concrete function type (rather than `Function`) keeps the
 * `@typescript-eslint/ban-types` rule satisfied and gives callers a usable
 * return type.
 */
export type PluginHookFn = (...args: readonly unknown[]) => unknown | Promise<unknown>;

/**
 * A loaded plugin: the validated manifest, the absolute path to the plugin
 * directory, whether the plugin is enabled, and the resolved hook functions
 * (indexed by hook name).
 *
 * The `hooks` map is populated by the loader after dynamic-importing each
 * hook file declared in the manifest. Only hooks that were both declared in
 * the manifest and present in the imported module appear here.
 */
export interface Plugin {
  /** The validated plugin manifest. */
  readonly manifest: PluginManifest;
  /** Absolute path to the plugin's root directory. */
  readonly path: string;
  /** Whether the plugin is enabled (disabled plugins' hooks are not dispatched). */
  enabled: boolean;
  /** Resolved hook functions, indexed by hook name. */
  hooks: Partial<Record<PluginHookName, PluginHookFn>>;
}

// ============================================================================
// State entry (persisted in state.json)
// ============================================================================

/**
 * A plugin-install record persisted in `state.json`'s `plugins` array.
 *
 * Written when a plugin is installed via `linuxify plugin install` and removed
 * on uninstall. The `hooks_used` array lists the hook names the plugin
 * registered handlers for, so `linuxify doctor` can warn about plugins that
 * subscribe to deprecated hooks.
 */
export interface PluginInstall {
  /** Plugin name (matches {@link PluginManifest.name}). */
  readonly name: string;
  /** Plugin version (matches {@link PluginManifest.version}). */
  readonly version: string;
  /** Install source URI (npm name, git URL, or local path). */
  readonly source: string;
  /** ISO timestamp the plugin was installed. */
  readonly installed_at: string;
  /** Whether the plugin is enabled. */
  readonly enabled: boolean;
  /** Hook names the plugin registered handlers for. */
  readonly hooks_used: readonly string[];
}

// ============================================================================
// Extension API interfaces (the `LinuxifyContext` surface)
// ============================================================================

/**
 * Identity of the plugin being invoked. Passed to every hook and to `init()`
 * so the plugin can locate bundled assets via `rootDir`.
 */
export interface PluginIdentity {
  /** Plugin name. */
  readonly name: string;
  /** Plugin version. */
  readonly version: string;
  /** Absolute path to the manifest file. */
  readonly manifestPath: string;
  /** Absolute path to the plugin's root directory. */
  readonly rootDir: string;
}

/**
 * Config API exposed to plugins. All keys are scoped to the plugin's
 * namespace: a plugin named `my-plugin` calling `get('foo')` actually reads
 * the `my-plugin.foo` entry. Plugins cannot read or write another plugin's
 * config keys.
 *
 * The backing store is an in-memory per-process map in v1; persistence to
 * `~/.linuxify/config.toml` under `[plugin.<name>]` is layered on by the host
 * in a future revision.
 */
export interface ConfigAPI {
  /** Read a config value scoped to the plugin's namespace. */
  get<T = unknown>(key: string): T | undefined;
  /** Read a config value, returning `defaultValue` if unset. */
  get<T = unknown>(key: string, defaultValue: T): T;
  /** Set a config value scoped to the plugin's namespace. */
  set(key: string, value: unknown): Promise<void>;
  /** Delete a config key. Returns `true` if the key existed. */
  delete(key: string): Promise<boolean>;
  /** Watch a config key for changes. Returns an unsubscribe function. */
  watch(key: string, cb: (newValue: unknown, oldValue: unknown) => void): () => void;
  /** Read all config values in the plugin's namespace. */
  all(): Record<string, unknown>;
}

/** A handle returned by {@link StateAPI.lock} for atomic state updates. */
export interface LockHandle {
  /** Release the lock. Safe to call once. */
  release(): Promise<void>;
}

/**
 * State API exposed to plugins. Reads and writes are scoped to the plugin's
 * namespace so plugins cannot clobber each other's state. The `lock()`
 * method delegates to the underlying {@link StateStore} for cross-process
 * mutual exclusion.
 */
export interface StateAPI {
  /** Read the plugin's entire state namespace as a plain object. */
  get(): Record<string, unknown>;
  /** Read a single key from the plugin's namespace. */
  get<T = unknown>(key: string): T | undefined;
  /** Atomically merge a partial update into the plugin's state namespace. */
  update(partial: Record<string, unknown>): Promise<void>;
  /** Acquire the global state lock for multi-step atomic updates. */
  lock(): Promise<LockHandle>;
}

/**
 * Runtime API for executing commands on the host and inside distros/packages.
 * Plugin-registered runtime providers are stored in a per-plugin namespace
 * but looked up globally (so `ctx.runtime.getProvider('java')` works from any
 * plugin).
 */
export interface RuntimeAPI {
  /** Execute a command on the host. */
  exec(cmd: string, args: readonly string[], opts?: RuntimeExecOptions): Promise<RuntimeExecResult>;
  /** Execute a command inside a named distro (via proot-distro login). */
  inDistro(
    distro: string | 'active',
    cmd: string,
    args: readonly string[],
    opts?: RuntimeExecOptions,
  ): Promise<RuntimeExecResult>;
  /** Execute a command inside a package's prefix. */
  inPackage(
    pkg: string,
    cmd: string,
    args: readonly string[],
    opts?: RuntimeExecOptions,
  ): Promise<RuntimeExecResult>;
  /** Register a runtime provider (custom-runtime plugins call this in init). */
  registerProvider(name: string, provider: unknown): void;
  /** Look up a registered runtime provider by name. */
  getProvider(name: string): unknown | null;
}

/** Options accepted by {@link RuntimeAPI.exec} and friends. */
export interface RuntimeExecOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly timeoutMs?: number;
  readonly stdin?: string;
}

/** Result of {@link RuntimeAPI.exec}. */
export interface RuntimeExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/**
 * Distros API: list, get, install, uninstall distros. Plugin-registered
 * distro providers are stored per-plugin but looked up globally.
 */
export interface DistrosAPI {
  /** List all known distros (built-in + plugin-registered). */
  list(): DistroInfo[];
  /** Get the active distro. */
  getActive(): DistroInfo;
  /** Get a specific distro by name. */
  get(name: string): DistroInfo;
  /** Register a custom distro provider. */
  registerProvider(name: string, provider: unknown): void;
}

/** Information about a distro. */
export interface DistroInfo {
  readonly name: string;
  readonly version: string;
  readonly installed: boolean;
  readonly active: boolean;
  readonly provider: 'builtin' | string;
}

/**
 * Packages API: list, get, install, uninstall, search packages.
 */
export interface PackagesAPI {
  /** List installed packages. */
  list(): PackageInfo[];
  /** Get a single installed package by name. */
  get(name: string): PackageInfo;
  /** Register a package-install callback (used by the host to wire the manager). */
  install(name: string, opts?: Record<string, unknown>): Promise<unknown>;
  /** Register a package-uninstall callback. */
  uninstall(name: string, opts?: Record<string, unknown>): Promise<unknown>;
}

/** Information about an installed package. */
export interface PackageInfo {
  readonly name: string;
  readonly version: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly installedAt: string;
  readonly patches: readonly string[];
}

/**
 * Patches API: list, apply, rollback patches and register custom patch types.
 */
export interface PatchesAPI {
  /** List patches declared by a package. */
  list(pkg: string): unknown[];
  /** Register a custom patch type handler. */
  registerType(name: string, handler: unknown): void;
  /** Look up a registered patch-type handler. */
  getType(name: string): unknown | null;
}

/**
 * Doctor API: register custom checks and run checks/profiles.
 */
export interface DoctorAPI {
  /** Register a custom doctor check. */
  registerCheck(check: DoctorCheckSpec): void;
  /** List registered checks (built-in + plugin-registered). */
  listChecks(): DoctorCheckSpec[];
}

/** A doctor check spec registered by a plugin. */
export interface DoctorCheckSpec {
  readonly id: string;
  readonly name: string;
  readonly category: 'bootstrap' | 'runtime' | 'package' | 'compat' | 'team';
  readonly run: (ctx: LinuxifyContext) => Promise<DoctorResult>;
  readonly fixCommand?: string;
  readonly fixSeverity?: 'safe' | 'unsafe';
}

/** A doctor check result. */
export interface DoctorResult {
  readonly id: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'missing';
  readonly message: string;
  readonly fixCommand?: string;
  readonly fixSeverity?: 'safe' | 'unsafe';
  readonly durationMs?: number;
}

/**
 * CLI API: register custom subcommands and global flags.
 */
export interface CliAPI {
  /** Register a custom subcommand. Returns the command name. */
  registerCommand(
    name: string,
    handler: (args: ParsedArgs, ctx: LinuxifyContext) => Promise<number>,
    options: CommandOptions,
  ): string;
  /** List registered commands (built-in + plugin-registered). */
  listCommands(): RegisteredCommand[];
  /** Register a global flag. */
  registerFlag(name: string, spec: FlagSpec): void;
}

/** Options for registering a command. */
export interface CommandOptions {
  readonly description: string;
  readonly usage?: string;
  readonly flags?: Record<string, FlagSpec>;
  readonly examples?: readonly string[];
  readonly category?: 'setup' | 'package' | 'exec' | 'diag' | 'config' | 'plugin' | 'team';
}

/** A registered command (with its handler and options). */
export interface RegisteredCommand {
  readonly name: string;
  readonly handler: (args: ParsedArgs, ctx: LinuxifyContext) => Promise<number>;
  readonly options: CommandOptions;
  readonly pluginName: string;
}

/** A flag spec for a CLI flag. */
export interface FlagSpec {
  readonly type: 'boolean' | 'string' | 'number' | 'array';
  readonly description: string;
  readonly default?: unknown;
  readonly alias?: string;
  readonly required?: boolean;
}

/** Parsed CLI arguments passed to a command handler. */
export interface ParsedArgs {
  readonly _: readonly string[];
  readonly flags: Record<string, unknown>;
}

/**
 * The single object passed to every plugin's hooks. The context is constructed
 * once per plugin (scoped to that plugin's namespace) and shared across all
 * hook invocations for that plugin within a single Linuxify process.
 *
 * Plugins should not import Linuxify internals directly; the context is the
 * only API surface. See `docs/10-plugin-sdk/extension-api.md` for the full
 * reference.
 */
export interface LinuxifyContext {
  /** Plugin identity (name, version, manifest path, root dir). */
  readonly plugin: PluginIdentity;
  /** Structured logger scoped to the plugin name. */
  readonly logger: Logger;
  /** Read/write access to plugin-scoped config. */
  readonly config: ConfigAPI;
  /** Read/write access to plugin-scoped state (with lock). */
  readonly state: StateAPI;
  /** Command execution (host and inside proot). */
  readonly runtime: RuntimeAPI;
  /** Distro registry. */
  readonly distros: DistrosAPI;
  /** Package registry. */
  readonly packages: PackagesAPI;
  /** Patcher API (register custom patch types). */
  readonly patches: PatchesAPI;
  /** Doctor API (register custom checks). */
  readonly doctor: DoctorAPI;
  /** CLI API (register custom subcommands and flags). */
  readonly cli: CliAPI;
}
