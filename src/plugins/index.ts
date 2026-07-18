/**
 * Public API surface for the `plugins` subsystem.
 *
 * @module linuxify/plugins
 *
 * Re-exports the plugin types, the Zod manifest schema + validators, the
 * {@link LinuxifyContextImpl} context, the {@link PluginLoader},
 * {@link PluginRegistry}, and {@link HookDispatcher} classes, plus the
 * {@link createPluginSystem} factory that wires them together.
 *
 * Downstream subsystems (CLI, bootstrap, package manager) should import
 * exclusively from here:
 *
 * ```ts
 * import {
 *   createPluginSystem,
 *   PluginLoader,
 *   type LinuxifyContext,
 *   type PluginManifest,
 * } from '../plugins/index.js';
 * ```
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import type { Config } from '../config/schema.js';
import type { StateStore } from '../state/store.js';
import { getLinuxifyHome } from '../utils/process.js';

import { LinuxifyContextImpl, PluginHost } from './context.js';
import { HookDispatcher } from './hooks.js';
import { PluginLoader } from './loader.js';
import { PluginRegistry } from './registry.js';

// ============================================================================
// Type re-exports
// ============================================================================

export type {
  // Manifest + plugin types
  PluginManifest,
  PluginHookName,
  PluginHookFn,
  Plugin,
  PluginInstall,
  // Extension API interfaces
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
  DoctorResult,
  CliAPI,
  RegisteredCommand,
  CommandOptions,
  FlagSpec,
  ParsedArgs,
} from './types.js';

// ============================================================================
// Schema + validator re-exports
// ============================================================================

export {
  PluginManifestSchema,
  PluginProvidesSchema,
  PluginHooksSchema,
  KNOWN_HOOK_NAMES,
  validateManifest,
  lintManifest,
} from './manifest.js';
export type { LintReport, ManifestLintIssue, ManifestLintSeverity } from './manifest.js';

// ============================================================================
// Class re-exports
// ============================================================================

export { LinuxifyContextImpl, PluginHost } from './context.js';
export { PluginLoader } from './loader.js';
export type { PluginLoaderOptions } from './loader.js';
export { PluginRegistry } from './registry.js';
export { HookDispatcher } from './hooks.js';
export type { HookDispatcherOptions } from './hooks.js';

// ============================================================================
// createPluginSystem factory
// ============================================================================

/**
 * Options for {@link createPluginSystem}.
 */
export interface CreatePluginSystemOptions {
  /** The state store (shared with the rest of the CLI). */
  readonly stateStore: StateStore;
  /** The loaded Linuxify config (read-only; plugins get a scoped view). */
  readonly config: Config;
  /**
   * Override the plugins directory. Defaults to
   * `<linuxifyHome>/plugins` (honoring `LINUXIFY_HOME`).
   */
  readonly pluginsDir?: string;
  /**
   * Per-hook timeout in milliseconds. Defaults to 30000 (30 seconds).
   */
  readonly hookTimeoutMs?: number;
}

/**
 * The plugin system bundle returned by {@link createPluginSystem}.
 */
export interface PluginSystem {
  /** The plugin loader (discovers + loads plugins from disk). */
  readonly loader: PluginLoader;
  /** The plugin registry (in-memory store of loaded plugins). */
  readonly registry: PluginRegistry;
  /** The hook dispatcher (invokes hooks with isolation + timeout). */
  readonly dispatcher: HookDispatcher;
  /** The root plugin context (factory for per-plugin scoped contexts). */
  readonly context: LinuxifyContextImpl;
  /** The shared plugin host (holds registries + state; for internal wiring). */
  readonly host: PluginHost;
}

/**
 * Create a fully-wired plugin system: a shared {@link PluginHost}, a root
 * {@link LinuxifyContextImpl}, a {@link PluginLoader}, a
 * {@link PluginRegistry}, and a {@link HookDispatcher}.
 *
 * This is the entry point used by the CLI at startup. The returned
 * {@link PluginSystem} gives the caller everything needed to discover,
 * load, and dispatch hooks to plugins.
 *
 * @param opts - See {@link CreatePluginSystemOptions}.
 * @returns A {@link PluginSystem} bundle.
 *
 * @example
 * ```ts
 * import { createPluginSystem } from '../plugins/index.js';
 * import { StateStore } from '../state/store.js';
 * import { loadConfig } from '../config/loader.js';
 *
 * const stateStore = new StateStore(getStatePath());
 * await stateStore.load();
 * const config = await loadConfig();
 *
 * const system = createPluginSystem({ stateStore, config });
 * const plugins = await system.loader.loadAll();
 * for (const p of plugins) system.registry.register(p);
 * const results = await system.dispatcher.dispatch('preInstall', pkg, distro, rt);
 * ```
 */
export function createPluginSystem(opts: CreatePluginSystemOptions): PluginSystem {
  const pluginsDir = opts.pluginsDir ?? join(getLinuxifyHome(), 'plugins');

  const host = new PluginHost({
    stateStore: opts.stateStore,
    config: opts.config,
  });

  // The root context has a placeholder identity; it's only used as a factory
  // via forPlugin(). The placeholder fields are never exposed to plugins.
  const context = new LinuxifyContextImpl({
    host,
    pluginName: '__root__',
    manifestPath: '',
    pluginPath: '',
    manifest: {
      name: '__root__',
      version: '0.0.0',
      linuxify: '*',
      provides: {},
      hooks: {},
    },
  });

  const loader = new PluginLoader({
    pluginsDir,
    stateStore: opts.stateStore,
    context,
  });

  const registry = new PluginRegistry();

  const dispatcher = new HookDispatcher({
    registry,
    context,
    hookTimeoutMs: opts.hookTimeoutMs,
  });

  return { loader, registry, dispatcher, context, host };
}
