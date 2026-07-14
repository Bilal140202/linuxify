/**
 * Unit tests for `src/plugins/hooks.ts` (the `HookDispatcher` class).
 *
 * Exercises:
 *  - Parallel dispatch: every matching plugin's hook is called, results
 *    collected in order.
 *  - Sequential dispatch: first non-undefined result wins.
 *  - Error isolation: a hook that throws does not break others.
 *  - Timeout: a hook that exceeds the timeout is aborted and treated as
 *    undefined.
 *  - Disabled plugins are skipped.
 *  - The context passed to each hook is scoped to that plugin.
 *
 * The logger is mocked (pino's lazy initializer crashes under vitest's stdio
 * capture).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger.
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
    level: 'info',
  };
  return { logger, createLogger: () => logger, getDefaultLogger: () => logger };
});

import type { Config } from '../../../src/config/schema.js';
import { PluginHost, LinuxifyContextImpl } from '../../../src/plugins/context.js';
import { HookDispatcher } from '../../../src/plugins/hooks.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import type { Plugin, PluginHookFn, PluginManifest } from '../../../src/plugins/types.js';
import { StateStore } from '../../../src/state/store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function minimalConfig(): Config {
  return {
    config_schema_version: 1,
    bootstrap: {
      distro: 'ubuntu',
      runtimes: [],
      parallel_downloads: 4,
      locale: 'en_US.UTF-8',
      timezone: 'UTC',
    },
    distro: { default: 'ubuntu' },
    runtime: { node_default_version: 'lts', python_default_version: '3.12' },
    telemetry: { enabled: false, endpoint: 'https://telemetry.linuxify.sh/v2', sample_rate: 0.1 },
    sync: { enabled: false, endpoint: 'https://sync.linuxify.sh' },
    registry: {
      url: 'https://github.com/linuxify/registry',
      branch: 'main',
      trust_self_signed: false,
    },
    logging: { level: 'info', file_enabled: true, console_enabled: true },
    i18n: { locale: 'en' },
    profiles: {},
    experimental: { features: [] },
  };
}

/** Build a plugin with the given hook implementation. */
function makePlugin(
  name: string,
  hookImpls: Partial<Record<string, PluginHookFn>>,
  enabled = true,
): Plugin {
  return {
    manifest: {
      name,
      version: '1.0.0',
      linuxify: '*',
      provides: {},
      hooks: {},
    } as PluginManifest,
    path: `/tmp/${name}`,
    enabled,
    hooks: hookImpls,
  };
}

/** Build a root context backed by a real PluginHost. */
function buildRootContext(stateStore: StateStore): LinuxifyContextImpl {
  const host = new PluginHost({ stateStore, config: minimalConfig() });
  return new LinuxifyContextImpl({
    host,
    pluginName: '__test_root__',
    manifestPath: '',
    pluginPath: '',
    manifest: {
      name: '__test_root__',
      version: '0.0.0',
      linuxify: '*',
      provides: {},
      hooks: {},
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HookDispatcher', () => {
  let tmpDir: string;
  let stateStore: StateStore;
  let registry: PluginRegistry;
  let dispatcher: HookDispatcher;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'linuxify-hooks-test-'));
    stateStore = new StateStore(join(tmpDir, 'state.json'));
    await stateStore.load();
    registry = new PluginRegistry();
    const context = buildRootContext(stateStore);
    dispatcher = new HookDispatcher({
      registry,
      context,
      hookTimeoutMs: 5000,
    });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // dispatch() — parallel
  // -------------------------------------------------------------------------

  describe('dispatch()', () => {
    it('calls every enabled plugin that implements the hook', async () => {
      const calls: string[] = [];
      registry.register(
        makePlugin('alpha', {
          preInstall: async () => {
            calls.push('alpha');
            return 'a';
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          preInstall: async () => {
            calls.push('beta');
            return 'b';
          },
        }),
      );
      registry.register(makePlugin('gamma', {})); // no preInstall hook

      const results = await dispatcher.dispatch<string>('preInstall', 'arg');
      expect(calls.sort()).toEqual(['alpha', 'beta']);
      expect(results).toHaveLength(2);
      expect(results.sort()).toEqual(['a', 'b']);
    });

    it('returns an empty array when no plugins implement the hook', async () => {
      registry.register(makePlugin('alpha', {}));
      const results = await dispatcher.dispatch('preInstall');
      expect(results).toEqual([]);
    });

    it('passes all args plus the context to the hook', async () => {
      let receivedArgs: unknown[] = [];
      registry.register(
        makePlugin('alpha', {
          preInstall: async (...args: unknown[]) => {
            receivedArgs = args;
            return undefined;
          },
        }),
      );
      await dispatcher.dispatch('preInstall', 'pkg', 'distro', 'runtime');
      // The last arg should be the context (with a `plugin` property).
      expect(receivedArgs).toHaveLength(4);
      const ctx = receivedArgs[3] as { plugin: { name: string } };
      expect(ctx.plugin.name).toBe('alpha');
    });

    it('skips disabled plugins', async () => {
      const calls: string[] = [];
      registry.register(
        makePlugin('alpha', {
          preInstall: async () => {
            calls.push('alpha');
            return 'a';
          },
        }),
      );
      registry.register(
        makePlugin(
          'beta',
          {
            preInstall: async () => {
              calls.push('beta');
              return 'b';
            },
          },
          false,
        ),
      );
      const results = await dispatcher.dispatch<string>('preInstall');
      expect(calls).toEqual(['alpha']);
      expect(results).toEqual(['a']);
    });
  });

  // -------------------------------------------------------------------------
  // dispatchSequential()
  // -------------------------------------------------------------------------

  describe('dispatchSequential()', () => {
    it('returns the first non-undefined result', async () => {
      registry.register(
        makePlugin('alpha', {
          command: async () => undefined,
        }),
      );
      registry.register(
        makePlugin('beta', {
          command: async () => 42,
        }),
      );
      registry.register(
        makePlugin('gamma', {
          command: async () => 99,
        }),
      );
      const result = await dispatcher.dispatchSequential<number>('command');
      expect(result).toBe(42);
    });

    it('returns undefined when no plugin returns a value', async () => {
      registry.register(
        makePlugin('alpha', {
          command: async () => undefined,
        }),
      );
      const result = await dispatcher.dispatchSequential<number>('command');
      expect(result).toBeUndefined();
    });

    it('stops at the first plugin that returns a value', async () => {
      const calls: string[] = [];
      registry.register(
        makePlugin('alpha', {
          command: async () => {
            calls.push('alpha');
            return 1;
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          command: async () => {
            calls.push('beta');
            return 2;
          },
        }),
      );
      const result = await dispatcher.dispatchSequential<number>('command');
      expect(result).toBe(1);
      expect(calls).toEqual(['alpha']);
    });

    it('continues to the next plugin when one throws', async () => {
      registry.register(
        makePlugin('alpha', {
          command: async () => {
            throw new Error('alpha failed');
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          command: async () => 7,
        }),
      );
      const result = await dispatcher.dispatchSequential<number>('command');
      expect(result).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // Error isolation
  // -------------------------------------------------------------------------

  describe('error isolation', () => {
    it('a hook that throws does not break other plugins', async () => {
      const calls: string[] = [];
      registry.register(
        makePlugin('alpha', {
          preInstall: async () => {
            calls.push('alpha');
            throw new Error('alpha failed');
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          preInstall: async () => {
            calls.push('beta');
            return 'b';
          },
        }),
      );
      const results = await dispatcher.dispatch<string>('preInstall');
      expect(calls.sort()).toEqual(['alpha', 'beta']);
      // alpha's result is undefined (error caught); beta's is 'b'.
      expect(results).toHaveLength(2);
      expect(results).toContain('b');
      expect(results).toContain(undefined);
    });

    it('a hook that throws in sequential mode does not abort the sequence', async () => {
      registry.register(
        makePlugin('alpha', {
          command: async () => {
            throw new Error('alpha failed');
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          command: async () => 5,
        }),
      );
      const result = await dispatcher.dispatchSequential<number>('command');
      expect(result).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  describe('timeout', () => {
    it('a hook that exceeds the timeout is treated as undefined', async () => {
      // Use a very short timeout.
      const context = buildRootContext(stateStore);
      const shortDispatcher = new HookDispatcher({
        registry,
        context,
        hookTimeoutMs: 50,
      });
      registry.register(
        makePlugin('slow', {
          preInstall: async () => {
            await new Promise((resolve) => setTimeout(resolve, 500));
            return 'slow';
          },
        }),
      );
      registry.register(
        makePlugin('fast', {
          preInstall: async () => 'fast',
        }),
      );
      const results = await shortDispatcher.dispatch<string>('preInstall');
      // The slow hook timed out → undefined; the fast hook returned 'fast'.
      expect(results).toContain('fast');
      expect(results).toContain(undefined);
    });

    it('a hook that completes within the timeout returns its value', async () => {
      const context = buildRootContext(stateStore);
      const dispatcher2 = new HookDispatcher({
        registry,
        context,
        hookTimeoutMs: 1000,
      });
      registry.register(
        makePlugin('alpha', {
          preInstall: async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 'ok';
          },
        }),
      );
      const results = await dispatcher2.dispatch<string>('preInstall');
      expect(results).toEqual(['ok']);
    });
  });

  // -------------------------------------------------------------------------
  // Context scoping
  // -------------------------------------------------------------------------

  describe('context scoping', () => {
    it('each hook receives a context scoped to its plugin name', async () => {
      const seenNames: string[] = [];
      registry.register(
        makePlugin('alpha', {
          preInstall: async (...args: unknown[]) => {
            const ctx = args[args.length - 1] as { plugin: { name: string } };
            seenNames.push(ctx.plugin.name);
            return undefined;
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          preInstall: async (...args: unknown[]) => {
            const ctx = args[args.length - 1] as { plugin: { name: string } };
            seenNames.push(ctx.plugin.name);
            return undefined;
          },
        }),
      );
      await dispatcher.dispatch('preInstall');
      expect(seenNames.sort()).toEqual(['alpha', 'beta']);
    });

    it('config writes from one plugin do not leak to another', async () => {
      const capturedConfig: Record<string, unknown> = {};
      registry.register(
        makePlugin('alpha', {
          preInstall: async (...args: unknown[]) => {
            const ctx = args[args.length - 1] as {
              config: { set: (k: string, v: unknown) => Promise<void>; get: (k: string) => unknown };
            };
            await ctx.config.set('secret', 'alpha-value');
            capturedConfig.alpha = ctx.config.get('secret');
          },
        }),
      );
      registry.register(
        makePlugin('beta', {
          preInstall: async (...args: unknown[]) => {
            const ctx = args[args.length - 1] as {
              config: { get: (k: string) => unknown };
            };
            // beta should NOT see alpha's 'secret' key.
            capturedConfig.beta = ctx.config.get('secret');
          },
        }),
      );
      await dispatcher.dispatch('preInstall');
      expect(capturedConfig.alpha).toBe('alpha-value');
      expect(capturedConfig.beta).toBeUndefined();
    });
  });
});
