/**
 * Unit tests for `src/plugins/registry.ts` (the `PluginRegistry` class).
 *
 * Exercises register / unregister / get / list / listEnabled / enable /
 * disable / hasHook / clear. No mocking needed — the registry is a pure
 * in-memory store.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { PluginRegistry } from '../../../src/plugins/registry.js';
import type { Plugin, PluginManifest } from '../../../src/plugins/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal Plugin object with the given name and enabled state. */
function makePlugin(name: string, enabled = true, hookNames: string[] = ['preInstall']): Plugin {
  const hooks = {} as Plugin['hooks'];
  for (const h of hookNames) {
    (hooks as Record<string, unknown>)[h] = async () => `${name}:${h}`;
  }
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
    hooks,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  // -------------------------------------------------------------------------
  // register()
  // -------------------------------------------------------------------------

  describe('register()', () => {
    it('stores a plugin that can be retrieved by name', () => {
      const plugin = makePlugin('alpha');
      registry.register(plugin);
      expect(registry.get('alpha')).toBe(plugin);
    });

    it('overwrites a previously-registered plugin with the same name', () => {
      const v1 = makePlugin('alpha');
      v1.manifest.version = '1.0.0';
      const v2 = makePlugin('alpha');
      v2.manifest.version = '2.0.0';
      registry.register(v1);
      registry.register(v2);
      expect(registry.get('alpha')).toBe(v2);
      expect(registry.get('alpha')?.manifest.version).toBe('2.0.0');
    });
  });

  // -------------------------------------------------------------------------
  // unregister()
  // -------------------------------------------------------------------------

  describe('unregister()', () => {
    it('removes a registered plugin', () => {
      registry.register(makePlugin('alpha'));
      registry.unregister('alpha');
      expect(registry.get('alpha')).toBeUndefined();
    });

    it('is a no-op for an unregistered plugin', () => {
      expect(() => registry.unregister('never-registered')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  describe('get()', () => {
    it('returns undefined for an unregistered plugin', () => {
      expect(registry.get('nope')).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    it('returns all registered plugins', () => {
      registry.register(makePlugin('alpha'));
      registry.register(makePlugin('beta'));
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.manifest.name).sort()).toEqual(['alpha', 'beta']);
    });

    it('returns a shallow copy (mutating the array does not affect the registry)', () => {
      registry.register(makePlugin('alpha'));
      const list = registry.list();
      list.pop();
      expect(registry.list()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // listEnabled()
  // -------------------------------------------------------------------------

  describe('listEnabled()', () => {
    it('returns only enabled plugins', () => {
      registry.register(makePlugin('alpha', true));
      registry.register(makePlugin('beta', false));
      registry.register(makePlugin('gamma', true));
      const enabled = registry.listEnabled();
      expect(enabled).toHaveLength(2);
      expect(enabled.map((p) => p.manifest.name).sort()).toEqual(['alpha', 'gamma']);
    });

    it('returns an empty array when no plugins are enabled', () => {
      registry.register(makePlugin('alpha', false));
      expect(registry.listEnabled()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // enable() / disable()
  // -------------------------------------------------------------------------

  describe('enable()', () => {
    it('sets enabled=true on the named plugin', () => {
      registry.register(makePlugin('alpha', false));
      expect(registry.get('alpha')?.enabled).toBe(false);
      registry.enable('alpha');
      expect(registry.get('alpha')?.enabled).toBe(true);
      expect(registry.listEnabled()).toHaveLength(1);
    });

    it('throws when enabling an unregistered plugin', () => {
      expect(() => registry.enable('nope')).toThrow(/not registered/);
    });
  });

  describe('disable()', () => {
    it('sets enabled=false on the named plugin', () => {
      registry.register(makePlugin('alpha', true));
      registry.disable('alpha');
      expect(registry.get('alpha')?.enabled).toBe(false);
      expect(registry.listEnabled()).toHaveLength(0);
    });

    it('throws when disabling an unregistered plugin', () => {
      expect(() => registry.disable('nope')).toThrow(/not registered/);
    });
  });

  // -------------------------------------------------------------------------
  // hasHook()
  // -------------------------------------------------------------------------

  describe('hasHook()', () => {
    it('returns true when an enabled plugin implements the hook', () => {
      registry.register(makePlugin('alpha', true, ['preInstall']));
      expect(registry.hasHook('alpha', 'preInstall')).toBe(true);
    });

    it('returns false when the plugin does not implement the hook', () => {
      registry.register(makePlugin('alpha', true, ['preInstall']));
      expect(registry.hasHook('alpha', 'postInstall')).toBe(false);
    });

    it('returns false when the plugin is disabled', () => {
      registry.register(makePlugin('alpha', false, ['preInstall']));
      expect(registry.hasHook('alpha', 'preInstall')).toBe(false);
    });

    it('returns false when the plugin is not registered', () => {
      expect(registry.hasHook('nope', 'preInstall')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // clear()
  // -------------------------------------------------------------------------

  describe('clear()', () => {
    it('removes all registered plugins', () => {
      registry.register(makePlugin('alpha'));
      registry.register(makePlugin('beta'));
      registry.clear();
      expect(registry.list()).toEqual([]);
    });
  });
});
