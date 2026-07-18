/**
 * Hook dispatcher — invokes plugin hooks with error isolation and timeout.
 *
 * @module linuxify/plugins/hooks
 *
 * The {@link HookDispatcher} iterates over enabled plugins that implement a
 * given hook and calls each hook function with `(...args, context)`. Hook
 * failures are isolated: a hook that throws or times out is logged and
 * treated as if it returned `undefined`; other plugins' hooks continue to
 * execute. This is the FR-062 isolation guarantee.
 *
 * Two dispatch modes:
 *  - {@link dispatch} — calls every matching plugin's hook in parallel and
 *    returns an array of results (including `undefined` for failed/skipped
 *    hooks).
 *  - {@link dispatchSequential} — calls hooks one at a time and returns the
 *    first non-`undefined` result. Used for the `command` hook (where the
 *    first plugin that handles a command wins).
 *
 * Each hook call has a configurable timeout (default 30 seconds). A hook
 * that exceeds the timeout is aborted (its result is `undefined`) and logged
 * with code `E_PLUGIN_HOOK_TIMEOUT`.
 *
 * @packageDocumentation
 */

import { PluginError } from '../utils/errors.js';
import { logger } from '../utils/log.js';

import type { LinuxifyContextImpl } from './context.js';
import type { PluginRegistry } from './registry.js';
import type { LinuxifyContext, Plugin, PluginHookFn, PluginHookName } from './types.js';

// ============================================================================
// Dispatcher options
// ============================================================================

/**
 * Options for constructing a {@link HookDispatcher}.
 */
export interface HookDispatcherOptions {
  /** The plugin registry (source of loaded plugins). */
  readonly registry: PluginRegistry;
  /**
   * The root plugin context. Must be a {@link LinuxifyContextImpl} so the
   * dispatcher can call `forPlugin(...)` to obtain per-plugin scoped
   * contexts. The root context itself is not passed to any hook.
   */
  readonly context: LinuxifyContext;
  /** Per-hook timeout in milliseconds. Defaults to 30000 (30 seconds). */
  readonly hookTimeoutMs?: number;
}

// ============================================================================
// HookDispatcher
// ============================================================================

/**
 * Dispatches hooks to enabled plugins.
 *
 * Usage:
 * ```ts
 * const dispatcher = new HookDispatcher({ registry, context: rootContext });
 * const results = await dispatcher.dispatch('preInstall', pkg, distro, runtime);
 * ```
 */
export class HookDispatcher {
  /** The plugin registry. */
  readonly registry: PluginRegistry;
  /** The root context (used as a factory for per-plugin contexts). */
  readonly context: LinuxifyContextImpl;
  /** Per-hook timeout in milliseconds. */
  readonly hookTimeoutMs: number;

  /**
   * @param opts - See {@link HookDispatcherOptions}.
   */
  constructor(opts: HookDispatcherOptions) {
    this.registry = opts.registry;
    // The context must be a LinuxifyContextImpl so we can call forPlugin().
    // The task spec types this as `LinuxifyContext`; we cast to the concrete
    // class internally. createPluginSystem always passes a LinuxifyContextImpl.
    this.context = opts.context as LinuxifyContextImpl;
    this.hookTimeoutMs = opts.hookTimeoutMs ?? 30_000;
  }

  // --------------------------------------------------------------------------
  // dispatch()
  // --------------------------------------------------------------------------

  /**
   * Dispatch a hook to every enabled plugin that implements it, in parallel.
   *
   * For each enabled plugin with the hook:
   *  1. Obtain a scoped {@link LinuxifyContext} via `context.forPlugin(...)`.
   *  2. Call the hook function with `(...args, context)`.
   *  3. Wrap the call in try/catch — errors are logged and the result is
   *     treated as `undefined`.
   *  4. Enforce a per-hook timeout (default 30s). A timed-out hook is
   *     aborted and its result is `undefined`.
   *
   * @param hookName - The hook to dispatch.
   * @param args - Positional arguments to pass to each hook (before the context).
   * @returns An array of results, one per matching plugin. Failed/timed-out
   *   hooks contribute `undefined`. The array order matches the registry's
   *   iteration order (insertion order).
   */
  async dispatch<T = unknown>(hookName: PluginHookName, ...args: unknown[]): Promise<T[]> {
    const matching = this.getMatchingPlugins(hookName);
    if (matching.length === 0) return [];

    const results = await Promise.all(
      matching.map(async ({ plugin, fn }) => {
        return this.invokeHook(plugin, hookName, fn, args);
      }),
    );

    return results as T[];
  }

  // --------------------------------------------------------------------------
  // dispatchSequential()
  // --------------------------------------------------------------------------

  /**
   * Dispatch a hook sequentially, returning the first non-`undefined` result.
   *
   * Plugins are iterated in registry order. The first plugin whose hook
   * returns a non-`undefined` value wins; subsequent plugins are not called.
   * Errors and timeouts are logged but do not abort the sequence (the next
   * plugin is tried).
   *
   * Used for the `command` hook: the first plugin that handles a command
   * (returns a number exit code) wins.
   *
   * @param hookName - The hook to dispatch.
   * @param args - Positional arguments to pass to each hook (before the context).
   * @returns The first non-`undefined` result, or `undefined` if no plugin
   *   returned a value.
   */
  async dispatchSequential<T = unknown>(
    hookName: PluginHookName,
    ...args: unknown[]
  ): Promise<T | undefined> {
    const matching = this.getMatchingPlugins(hookName);

    for (const { plugin, fn } of matching) {
      const result = await this.invokeHook(plugin, hookName, fn, args);
      if (result !== undefined) {
        return result as T;
      }
    }

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  /**
   * Get all enabled plugins that implement the given hook, along with the
   * hook function.
   *
   * @param hookName - The hook name.
   * @returns An array of `{ plugin, fn }` entries.
   */
  private getMatchingPlugins(
    hookName: PluginHookName,
  ): ReadonlyArray<{ plugin: Plugin; fn: PluginHookFn }> {
    const enabled = this.registry.listEnabled();
    const matching: Array<{ plugin: Plugin; fn: PluginHookFn }> = [];

    for (const plugin of enabled) {
      const fn = plugin.hooks[hookName];
      if (fn !== undefined) {
        matching.push({ plugin, fn });
      }
    }

    return matching;
  }

  /**
   * Invoke a single hook function with error isolation and timeout.
   *
   * @param plugin - The plugin being invoked.
   * @param hookName - The hook name (for logging).
   * @param fn - The hook function.
   * @param args - Positional arguments (the context is appended).
   * @returns The hook's return value, or `undefined` on error/timeout.
   */
  private async invokeHook(
    plugin: Plugin,
    hookName: PluginHookName,
    fn: PluginHookFn,
    args: unknown[],
  ): Promise<unknown> {
    // Build a per-plugin scoped context for this invocation.
    const ctx = this.context.forPlugin(plugin.manifest.name, plugin.manifest, plugin.path);

    // Build the full argument list: (…args, context).
    const callArgs = [...args, ctx];

    try {
      const result = await this.withTimeout(
        Promise.resolve().then(() => fn(...callArgs)),
        plugin.manifest.name,
        hookName,
      );
      return result;
    } catch (err) {
      // Error isolation: log and treat as undefined.
      if (err instanceof PluginError && err.code === 'E_PLUGIN_HOOK_TIMEOUT') {
        logger.error(
          { plugin: plugin.manifest.name, hook: hookName, timeoutMs: this.hookTimeoutMs },
          'plugin hook timed out',
        );
      } else {
        logger.error(
          {
            plugin: plugin.manifest.name,
            hook: hookName,
            error: (err as Error).message,
            code: (err as Error & { code?: string }).code,
          },
          'plugin hook threw; treating as no-op',
        );
      }
      return undefined;
    }
  }

  /**
   * Race a promise against a timeout. If the timeout fires first, reject
   * with a {@link PluginError} (`E_PLUGIN_HOOK_TIMEOUT`).
   *
   * @param promise - The promise to race.
   * @param pluginName - The plugin name (for the error message).
   * @param hookName - The hook name (for the error message).
   * @returns The promise's result, or rejection on timeout.
   */
  private withTimeout<T>(
    promise: Promise<T>,
    pluginName: string,
    hookName: PluginHookName,
  ): Promise<T> {
    if (this.hookTimeoutMs <= 0) return promise;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new PluginError(
              `Hook '${hookName}' in plugin '${pluginName}' timed out after ${this.hookTimeoutMs}ms`,
              {
                code: 'E_PLUGIN_HOOK_TIMEOUT',
                details: { plugin: pluginName, hook: hookName, timeoutMs: this.hookTimeoutMs },
              },
            ),
          ),
        this.hookTimeoutMs,
      );
      // Unref so the timer doesn't keep the event loop alive in tests.
      timer.unref?.();
    });

    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
