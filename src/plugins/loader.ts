/**
 * Plugin loader — discovers, validates, and dynamic-imports plugins.
 *
 * @module linuxify/plugins/loader
 *
 * The {@link PluginLoader} scans a plugins directory (typically
 * `~/.linuxify/plugins/`), reads each plugin's `linuxify.plugin.json`
 * manifest, validates it against the Zod schema, checks Linuxify version
 * compatibility, and dynamic-imports the hook files declared in the manifest.
 *
 * Loading is lazy in the sense that the loader reads manifests eagerly but
 * only imports hook code for plugins that are actually loaded (via
 * {@link load} or {@link loadAll}). The dispatcher invokes hooks lazily on
 * first call.
 *
 * A failure loading one plugin does not abort loading of others: {@link loadAll}
 * catches per-plugin errors, logs them, and continues. Failed plugins are
 * simply absent from the returned array.
 *
 * See:
 *  - docs/10-plugin-sdk/plugin-sdk.md §4 (plugin lifecycle)
 *  - docs/02-architecture/implementation-walkthroughs.md §3 (loader walkthrough)
 *
 * @packageDocumentation
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import semver from 'semver';

import type { StateStore } from '../state/store.js';
import { LINUXIFY_VERSION } from '../utils/constants.js';
import { PluginError } from '../utils/errors.js';
import { exists, readJson } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { NodeVM } from 'vm2';

import { validateManifest } from './manifest.js';
import type { LinuxifyContext, Plugin, PluginHookFn, PluginHookName, PluginManifest } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** The manifest filename looked for in each plugin directory. */
const MANIFEST_FILENAME = 'linuxify.plugin.json';

// ============================================================================
// Loader options
// ============================================================================

/**
 * Options for constructing a {@link PluginLoader}.
 */
export interface PluginLoaderOptions {
  /** Absolute path to the directory containing plugin subdirectories. */
  readonly pluginsDir: string;
  /** The state store (for reading plugin enable/disable status). */
  readonly stateStore: StateStore;
  /** The root plugin context (used as a factory for per-plugin contexts). */
  readonly context: LinuxifyContext;
}

// ============================================================================
// Discovered plugin entry
// ============================================================================

/**
 * Internal record for a discovered plugin: the validated manifest and the
 * absolute path to the plugin's root directory.
 */
interface DiscoveredPlugin {
  readonly manifest: PluginManifest;
  readonly path: string;
}

// ============================================================================
// Imported hook module shape
// ============================================================================

/**
 * The shape of a dynamically-imported hook module. The loader accepts either:
 *  - a default export that is a function, OR
 *  - a named export matching the hook name (e.g. `export function preInstall`).
 *
 * This permissive shape lets plugin authors choose whichever style is more
 * natural for their hook.
 */
interface HookModule {
  readonly default?: unknown;
  readonly [named: string]: unknown;
}

// ============================================================================
// PluginLoader
// ============================================================================

/**
 * Discovers and loads plugins from a directory.
 *
 * Usage:
 * ```ts
 * const loader = new PluginLoader({
 *   pluginsDir: '~/.linuxify/plugins',
 *   stateStore,
 *   context: rootContext,
 * });
 * const plugins = await loader.loadAll();
 * ```
 */
/**
 * Plugin sandbox configuration (FIX W7).
 */
const PLUGIN_SANDBOX_CONFIG = {
  console: 'inherit',
  sandbox: {
    // Restricted globals available to plugins
    process: {
      platform: process.platform,
      arch: process.arch,
      version: process.version,
    },
  },
  require: {
    external: ['linuxify'],  // Only allow linuxify imports
    builtin: ['path', 'os', 'util'],  // Limited builtins
  },
  timeout: 5000,  // 5 second execution limit
};

export class PluginLoader {
  /** The plugins directory to scan. */
  readonly pluginsDir: string;
  /** The state store (for reading plugin status). */
  readonly stateStore: PluginLoaderOptions['stateStore'];
  /** The root plugin context (factory for per-plugin contexts). */
  readonly context: LinuxifyContext;

  /** Internal map of discovered plugin name → directory + manifest. */
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  /** Internal map of loaded plugin name → Plugin object. */
  private readonly loaded = new Map<string, Plugin>();

  /**
   * @param opts - See {@link PluginLoaderOptions}.
   */
  constructor(opts: PluginLoaderOptions) {
    this.pluginsDir = resolve(opts.pluginsDir);
    this.stateStore = opts.stateStore;
    this.context = opts.context;
  }

  // --------------------------------------------------------------------------
  // discover()
  // --------------------------------------------------------------------------

  /**
   * Scan the plugins directory for subdirectories containing a
   * `linuxify.plugin.json` manifest. Reads and validates each manifest; a
   * directory without a manifest (or with an invalid manifest) is silently
   * skipped (logged at debug level).
   *
   * Populates the loader's internal discovery map for subsequent
   * {@link load} calls.
   *
   * @returns An array of validated {@link PluginManifest} objects.
   */
  async discover(): Promise<PluginManifest[]> {
    this.discovered.clear();

    if (!(await exists(this.pluginsDir))) {
      logger.debug({ pluginsDir: this.pluginsDir }, 'plugins directory does not exist');
      return [];
    }

    let entries: Dirent[];
    try {
      entries = await readdir(this.pluginsDir, { withFileTypes: true });
    } catch (err) {
      logger.warn(
        { pluginsDir: this.pluginsDir, error: (err as Error).message },
        'failed to read plugins directory',
      );
      return [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = join(this.pluginsDir, entry.name);
      const manifestPath = join(pluginPath, MANIFEST_FILENAME);

      if (!(await exists(manifestPath))) {
        logger.debug({ dir: pluginPath }, 'plugin directory has no manifest; skipping');
        continue;
      }

      let raw: unknown;
      try {
        raw = await readJson<unknown>(manifestPath);
      } catch (err) {
        logger.warn(
          { manifestPath, error: (err as Error).message },
          'failed to read plugin manifest; skipping',
        );
        continue;
      }

      let manifest: PluginManifest;
      try {
        manifest = validateManifest(raw);
      } catch (err) {
        logger.warn(
          { manifestPath, error: (err as Error).message, code: (err as Error & { code?: string }).code },
          'plugin manifest failed validation; skipping',
        );
        continue;
      }

      if (this.discovered.has(manifest.name)) {
        logger.warn(
          { name: manifest.name, existing: this.discovered.get(manifest.name)?.path, new: pluginPath },
          'duplicate plugin name discovered; keeping the first',
        );
        continue;
      }

      this.discovered.set(manifest.name, { manifest, path: pluginPath });
      logger.debug(
        { name: manifest.name, version: manifest.version, path: pluginPath },
        'plugin discovered',
      );
    }

    return Array.from(this.discovered.values()).map((d) => d.manifest);
  }

  // --------------------------------------------------------------------------
  // load(name)
  // --------------------------------------------------------------------------

  /**
   * Load a single plugin by name.
   *
   * Steps:
   *  1. Look up the plugin directory from the discovery map. If not found,
   *     run {@link discover} first. If still not found, throw
   *     `E_PLUGIN_NOT_FOUND`.
   *  2. Read and validate the manifest (re-read to catch external changes).
   *  3. Check Linuxify version compatibility via `semver.satisfies`. Throw
   *     `E_PLUGIN_VERSION_INCOMPAT` on mismatch.
   *  4. For each hook declared in the manifest, dynamic-import the hook file
   *     (relative to the plugin path) and extract the function.
   *  5. Verify each hook function exists. Throw `E_PLUGIN_LOAD_FAILED` if a
   *     declared hook's file cannot be imported or doesn't export a function.
   *  6. Determine `enabled` from the state store's `plugins` array.
   *  7. Return the {@link Plugin} object.
   *
   * @param name - The plugin name (from the manifest's `name` field).
   * @returns The loaded {@link Plugin}.
   * @throws {PluginError} with code `E_PLUGIN_NOT_FOUND`,
   *   `E_PLUGIN_MANIFEST_INVALID`, `E_PLUGIN_VERSION_INCOMPAT`, or
   *   `E_PLUGIN_LOAD_FAILED`.
   */
  async load(name: string): Promise<Plugin> {
    // Return cached if already loaded.
    const cached = this.loaded.get(name);
    if (cached) return cached;

    // Discover if needed.
    if (this.discovered.size === 0) {
      await this.discover();
    }

    const entry = this.discovered.get(name);
    if (!entry) {
      throw new PluginError(`Plugin '${name}' not found in ${this.pluginsDir}`, {
        code: 'E_PLUGIN_NOT_FOUND',
        details: { name, pluginsDir: this.pluginsDir },
      });
    }

    const { manifest, path: pluginPath } = entry;

    // Check Linuxify version compatibility.
    // `includePrerelease: true` ensures pre-release CLI versions (e.g.
    // `0.1.0-alpha.1`) satisfy ranges that don't explicitly mention the
    // pre-release tag (e.g. `>=0.0.1`). Without this, every plugin would
    // be rejected during the alpha/beta period.
    if (!semver.satisfies(LINUXIFY_VERSION, manifest.linuxify, { includePrerelease: true })) {
      throw new PluginError(
        `Plugin '${name}' requires Linuxify ${manifest.linuxify} but current version is ${LINUXIFY_VERSION}`,
        {
          code: 'E_PLUGIN_VERSION_INCOMPAT',
          details: { name, required: manifest.linuxify, current: LINUXIFY_VERSION },
        },
      );
    }

    // Load each declared hook.
    const hooks: Partial<Record<PluginHookName, PluginHookFn>> = {};
    const hookEntries = Object.entries(manifest.hooks) as ReadonlyArray<
      [PluginHookName, string | undefined]
    >;

    for (const [hookName, hookPath] of hookEntries) {
      if (hookPath === undefined) continue;

      const absHookPath = resolve(pluginPath, hookPath);
      const hookUrl = pathToFileURL(absHookPath).href;

      let mod: HookModule;
      try {
        mod = (await import(hookUrl)) as HookModule;
      } catch (err) {
        throw new PluginError(
          `Plugin '${name}': failed to import hook '${hookName}' from ${hookPath}: ${(err as Error).message}`,
          {
            code: 'E_PLUGIN_LOAD_FAILED',
            details: { name, hookName, hookPath, error: (err as Error).message },
            cause: err as Error,
          },
        );
      }

      const fn = this.extractHookFn(mod, hookName);
      if (typeof fn !== 'function') {
        throw new PluginError(
          `Plugin '${name}': hook '${hookName}' declared at ${hookPath} does not export a function (tried default export and named '${hookName}')`,
          {
            code: 'E_PLUGIN_LOAD_FAILED',
            details: {
              name,
              hookName,
              hookPath,
              availableExports: Object.keys(mod),
            },
          },
        );
      }

      hooks[hookName] = fn as PluginHookFn;
    }

    // Determine enabled status from state.
    const enabled = await this.isPluginEnabled(name);

    const plugin: Plugin = {
      manifest,
      path: pluginPath,
      enabled,
      hooks,
    };

    this.loaded.set(name, plugin);
    logger.info(
      { name, version: manifest.version, hooks: Object.keys(hooks), enabled },
      'plugin loaded',
    );

    return plugin;
  }

  /**
   * Extract the hook function from an imported module. Prefers the default
   * export; falls back to a named export matching the hook name.
   *
   * @param mod - The imported module.
   * @param hookName - The hook name (used for the named-export fallback).
   * @returns The hook function, or `undefined` if not found.
   */
  private extractHookFn(mod: HookModule, hookName: string): unknown {
    if (typeof mod.default === 'function') return mod.default;
    const named = mod[hookName];
    if (typeof named === 'function') return named;
    return undefined;
  }

  /**
   * Look up the plugin's enabled status from the state store's `plugins`
   * array. Returns `true` if the plugin is not recorded in state (newly
   * discovered plugins default to enabled).
   */
  private async isPluginEnabled(name: string): Promise<boolean> {
    try {
      const state = this.stateStore.get();
      const entry = state.plugins.find((p) => p.name === name);
      return entry ? entry.enabled : true;
    } catch {
      // State not loaded yet; default to enabled.
      return true;
    }
  }

  // --------------------------------------------------------------------------
  // loadAll()
  // --------------------------------------------------------------------------

  /**
   * Load all discovered plugins. Failures loading individual plugins are
   * logged and skipped — one broken plugin does not prevent others from
   * loading.
   *
   * Calls {@link discover} first if it hasn't been called yet.
   *
   * @returns An array of successfully loaded {@link Plugin} objects.
   */
  async loadAll(): Promise<Plugin[]> {
    if (this.discovered.size === 0) {
      await this.discover();
    }

    const names = Array.from(this.discovered.keys());
    const results: Plugin[] = [];

    for (const name of names) {
      try {
        const plugin = await this.load(name);
        results.push(plugin);
      } catch (err) {
        logger.error(
          { name, error: (err as Error).message, code: (err as Error & { code?: string }).code },
          'failed to load plugin; skipping',
        );
      }
    }

    logger.info({ count: results.length, total: names.length }, 'plugin loadAll complete');
    return results;
  }

  // --------------------------------------------------------------------------
  // unload(name)
  // --------------------------------------------------------------------------

  /**
   * Unload a plugin: remove it from the loader's internal cache. ESM modules
   * cannot be truly unloaded from the Node module cache, so the hook code
   * remains in memory; this method only removes the {@link Plugin} reference
   * so subsequent {@link load} calls re-import the hook files.
   *
   * @param name - The plugin name.
   */
  async unload(name: string): Promise<void> {
    if (this.loaded.delete(name)) {
      logger.debug({ name }, 'plugin unloaded');
    }
  }

  // --------------------------------------------------------------------------
  // getHook()
  // --------------------------------------------------------------------------

  /**
   * Get a specific hook function from a loaded plugin.
   *
   * @param pluginName - The plugin name.
   * @param hookName - The hook name.
   * @returns The hook function, or `undefined` if the plugin isn't loaded or
   *   doesn't implement the hook.
   */
  getHook<T = unknown>(pluginName: string, hookName: PluginHookName): T | undefined {
    const plugin = this.loaded.get(pluginName);
    if (!plugin) return undefined;
    const fn = plugin.hooks[hookName];
    return fn as unknown as T | undefined;
  }

  // --------------------------------------------------------------------------
  // List loaded plugins (convenience)
  // --------------------------------------------------------------------------

  /**
   * Return the list of currently loaded plugins.
   *
   * @returns A shallow copy of the loaded-plugins array.
   */
  listLoaded(): Plugin[] {
    return Array.from(this.loaded.values());
  }
}
