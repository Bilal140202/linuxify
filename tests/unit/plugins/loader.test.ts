/**
 * Unit tests for `src/plugins/loader.ts` (the `PluginLoader` class).
 *
 * These tests point the loader at the fixture plugins under
 * `tests/fixtures/plugins/` and exercise discovery, loading, version
 * compatibility checking, and hook verification. The logger is mocked
 * (pino's lazy initializer crashes under vitest's stdio capture).
 */

import { mkdtemp, cp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger (pino's lazy initializer crashes under vitest's stdio capture).
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
import { PluginLoader } from '../../../src/plugins/loader.js';
import { StateStore } from '../../../src/state/store.js';
import { PluginError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Path to the fixture plugins directory (relative to this test file). */
const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'plugins',
);

/** A minimal valid Config for constructing the context. */
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

/** Build a root LinuxifyContextImpl backed by a real PluginHost. */
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

describe('PluginLoader', () => {
  let tmpPluginsDir: string;
  let tmpStateDir: string;
  let stateStore: StateStore;
  let context: LinuxifyContextImpl;

  beforeEach(async () => {
    tmpPluginsDir = await mkdtemp(join(tmpdir(), 'linuxify-loader-test-'));
    await cp(join(FIXTURES_DIR, 'valid-plugin'), join(tmpPluginsDir, 'valid-plugin'), {
      recursive: true,
    });
    await cp(join(FIXTURES_DIR, 'invalid-manifest'), join(tmpPluginsDir, 'invalid-manifest'), {
      recursive: true,
    });
    await cp(join(FIXTURES_DIR, 'missing-hooks'), join(tmpPluginsDir, 'missing-hooks'), {
      recursive: true,
    });

    tmpStateDir = await mkdtemp(join(tmpdir(), 'linuxify-loader-state-'));
    stateStore = new StateStore(join(tmpStateDir, 'state.json'));
    await stateStore.load();

    context = buildRootContext(stateStore);
  });

  afterEach(async () => {
    await rm(tmpPluginsDir, { recursive: true, force: true }).catch(() => {});
    await rm(tmpStateDir, { recursive: true, force: true }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  // discover()
  // -------------------------------------------------------------------------

  describe('discover()', () => {
    it('discovers plugins with valid manifests', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      const manifests = await loader.discover();
      const names = manifests.map((m) => m.name);
      expect(names).toContain('valid-plugin');
      expect(names).toContain('missing-hooks-plugin');
      // invalid-manifest is silently skipped (fails Zod validation).
      expect(names).not.toContain('invalid-plugin');
    });

    it('returns an empty array when the plugins dir does not exist', async () => {
      const loader = new PluginLoader({
        pluginsDir: join(tmpdir(), `non-existent-${Date.now()}`),
        stateStore,
        context,
      });
      const manifests = await loader.discover();
      expect(manifests).toEqual([]);
    });

    it('skips directories without a manifest', async () => {
      await mkdir(join(tmpPluginsDir, 'no-manifest-dir'), { recursive: true });
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      const manifests = await loader.discover();
      expect(manifests.find((m) => m.name === 'no-manifest-dir')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // load()
  // -------------------------------------------------------------------------

  describe('load()', () => {
    it('loads a valid plugin and resolves all hook functions', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      const plugin = await loader.load('valid-plugin');
      expect(plugin.manifest.name).toBe('valid-plugin');
      expect(plugin.manifest.version).toBe('1.0.0');
      expect(plugin.enabled).toBe(true);
      expect(Object.keys(plugin.hooks)).toHaveLength(9);
      expect(typeof plugin.hooks.preInstall).toBe('function');
      expect(typeof plugin.hooks.command).toBe('function');
    });

    it('throws E_PLUGIN_NOT_FOUND for unknown plugin name', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      await expect(loader.load('does-not-exist')).rejects.toMatchObject({
        code: 'E_PLUGIN_NOT_FOUND',
      });
    });

    it('throws E_PLUGIN_LOAD_FAILED when a declared hook file does not exist', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      await expect(loader.load('missing-hooks-plugin')).rejects.toMatchObject({
        code: 'E_PLUGIN_LOAD_FAILED',
      });
    });

    it('throws E_PLUGIN_VERSION_INCOMPAT when linuxify range does not match', async () => {
      const incompatibleDir = join(tmpPluginsDir, 'incompatible-version');
      await mkdir(incompatibleDir, { recursive: true });
      await writeFile(
        join(incompatibleDir, 'linuxify.plugin.json'),
        JSON.stringify({
          name: 'incompatible-version',
          version: '1.0.0',
          linuxify: '>=99.0.0',
          provides: {
            runtimes: [],
            distros: [],
            commands: [],
            doctorChecks: [],
            patchTypes: [],
          },
          hooks: {},
        }),
      );
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      await expect(loader.load('incompatible-version')).rejects.toMatchObject({
        code: 'E_PLUGIN_VERSION_INCOMPAT',
      });
    });

    it('returns cached plugin on second load() call', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      const first = await loader.load('valid-plugin');
      const second = await loader.load('valid-plugin');
      expect(second).toBe(first);
    });

    it('invoking a resolved hook returns the expected value', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      const plugin = await loader.load('valid-plugin');
      const fn = plugin.hooks.command;
      expect(fn).toBeDefined();
      const result = await fn!('arg1');
      expect(result).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // loadAll()
  // -------------------------------------------------------------------------

  describe('loadAll()', () => {
    it('loads all valid plugins and skips broken ones', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      const plugins = await loader.loadAll();
      const names = plugins.map((p) => p.manifest.name);
      expect(names).toContain('valid-plugin');
      expect(names).not.toContain('missing-hooks-plugin');
      expect(names).not.toContain('invalid-plugin');
    });
  });

  // -------------------------------------------------------------------------
  // unload()
  // -------------------------------------------------------------------------

  describe('unload()', () => {
    it('removes a plugin from the cache so the next load re-imports', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      const first = await loader.load('valid-plugin');
      await loader.unload('valid-plugin');
      const second = await loader.load('valid-plugin');
      expect(second).not.toBe(first);
      expect(second.manifest.name).toBe('valid-plugin');
    });

    it('is a no-op for an unknown plugin name', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await expect(loader.unload('never-loaded')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // getHook()
  // -------------------------------------------------------------------------

  describe('getHook()', () => {
    it('returns the hook function for a loaded plugin', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      await loader.load('valid-plugin');
      const fn = loader.getHook('valid-plugin', 'preInstall');
      expect(typeof fn).toBe('function');
    });

    it('returns undefined for an unloaded plugin', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      await loader.load('valid-plugin');
      expect(loader.getHook('unloaded-plugin', 'preInstall')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Error types
  // -------------------------------------------------------------------------

  describe('error types', () => {
    it('throws PluginError instances (not generic Error)', async () => {
      const loader = new PluginLoader({ pluginsDir: tmpPluginsDir, stateStore, context });
      await loader.discover();
      try {
        await loader.load('does-not-exist');
        throw new Error('expected load to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(PluginError);
      }
    });
  });
});
