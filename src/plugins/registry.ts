/**
 * Plugin registry — in-memory store of loaded plugins.
 *
 * @module linuxify/plugins/registry
 *
 * The {@link PluginRegistry} holds the set of loaded {@link Plugin} objects
 * and provides lookup, enable/disable, and listing operations. It is
 * populated by the {@link ./loader.ts | PluginLoader} and consumed by the
 * {@link ./hooks.ts | HookDispatcher}.
 *
 * The registry is process-scoped: it lives for the duration of a single CLI
 * invocation and is not persisted to disk. Enable/disable status is also
 * mirrored to `state.json`'s `plugins` array by the CLI's `plugin enable`/
 * `plugin disable` commands (not by the registry itself).
 *
 * @packageDocumentation
 */

import { logger } from '../utils/log.js';

import type { Plugin, PluginHookName } from './types.js';

// ============================================================================
// PluginRegistry
// ============================================================================

/**
 * In-memory registry of loaded plugins.
 *
 * Plugins are keyed by their manifest `name` (which is unique within a single
 * plugins directory — the loader deduplicates on discovery).
 */
export class PluginRegistry {
  /** Internal map of plugin name → Plugin object. */
  private readonly plugins = new Map<string, Plugin>();

  /**
   * Register a plugin. If a plugin with the same name is already registered,
   * it is overwritten (and a debug message is logged).
   *
   * @param plugin - The plugin to register.
   */
  register(plugin: Plugin): void {
    const existing = this.plugins.get(plugin.manifest.name);
    if (existing) {
      logger.debug(
        { name: plugin.manifest.name },
        'overwriting previously-registered plugin',
      );
    }
    this.plugins.set(plugin.manifest.name, plugin);
    logger.debug(
      { name: plugin.manifest.name, version: plugin.manifest.version },
      'plugin registered',
    );
  }

  /**
   * Unregister a plugin by name. No-op if the plugin is not registered.
   *
   * @param name - The plugin name.
   */
  unregister(name: string): void {
    if (this.plugins.delete(name)) {
      logger.debug({ name }, 'plugin unregistered');
    }
  }

  /**
   * Look up a registered plugin by name.
   *
   * @param name - The plugin name.
   * @returns The plugin, or `undefined` if not registered.
   */
  get(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * List all registered plugins (enabled and disabled).
   *
   * @returns A shallow-copy array of all registered plugins.
   */
  list(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * List only enabled plugins. Disabled plugins are excluded.
   *
   * @returns A shallow-copy array of enabled plugins.
   */
  listEnabled(): Plugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.enabled);
  }

  /**
   * Enable a plugin. Sets `plugin.enabled = true`.
   *
   * @param name - The plugin name.
   * @throws {Error} if the plugin is not registered.
   */
  enable(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Cannot enable plugin '${name}': not registered`);
    }
    plugin.enabled = true;
    logger.debug({ name }, 'plugin enabled');
  }

  /**
   * Disable a plugin. Sets `plugin.enabled = false`. Disabled plugins'
   * hooks are not dispatched by the {@link ./hooks.ts | HookDispatcher}.
   *
   * @param name - The plugin name.
   * @throws {Error} if the plugin is not registered.
   */
  disable(name: string): void {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(`Cannot disable plugin '${name}': not registered`);
    }
    plugin.enabled = false;
    logger.debug({ name }, 'plugin disabled');
  }

  /**
   * Check whether a plugin has a specific hook implemented.
   *
   * @param name - The plugin name.
   * @param hookName - The hook name.
   * @returns `true` if the plugin is registered, enabled, and implements the
   *   hook.
   */
  hasHook(name: string, hookName: PluginHookName): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin || !plugin.enabled) return false;
    return plugin.hooks[hookName] !== undefined;
  }

  /**
   * Clear the registry. Used by tests to start fresh.
   */
  clear(): void {
    this.plugins.clear();
  }
}
