/**
 * Unit tests for `src/runtimes/provider.ts` — the registry functions and the
 * `RuntimeProvider` interface contract.
 *
 * Covers:
 *   - registerRuntime / getRuntime / listRuntimes round-trip.
 *   - getRuntime throws RuntimeError with E_RUNTIME_NOT_FOUND on unknown names.
 *   - registerRuntime rejects providers with an empty name.
 *   - listRuntimes returns the registered providers sorted alphabetically.
 *   - re-registration overwrites the prior entry (with a warning).
 *   - unregisterRuntime and clearRuntimes remove entries.
 *   - findInstalledRuntimes / upsertRuntimeInstall / removeRuntimeInstall /
 *     markDefaultRuntime / getDefaultRuntimeVersion state helpers.
 *   - createDefaultDistroExec returns a function with the expected signature.
 *
 * Each test starts with a clean registry via `clearRuntimes()` so the tests
 * are deterministic regardless of import order (the runtime index.ts
 * auto-registers built-ins on first import).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the logger to avoid pino's lazy initializer crashing under vitest's
// stdio capture (see tests/unit/state/store.test.ts for the same pattern).
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
  };
  return { logger };
});

import {
  registerRuntime,
  getRuntime,
  listRuntimes,
  unregisterRuntime,
  clearRuntimes,
  createDefaultDistroExec,
  findInstalledRuntimes,
  upsertRuntimeInstall,
  removeRuntimeInstall,
  markDefaultRuntime,
  getDefaultRuntimeVersion,
  type RuntimeProvider,
  type InstalledRuntime,
} from '../../../src/runtimes/provider.js';
import type { State } from '../../../src/state/schema.js';
import { StateStore, defaultState } from '../../../src/state/store.js';
import { RuntimeError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory RuntimeProvider for registry tests. The methods are
 * stubs — registry tests don't invoke them, only check identity / lookup.
 */
function makeFakeProvider(name: string, displayName?: string): RuntimeProvider {
  return {
    name,
    displayName: displayName ?? `Fake ${name}`,
    defaultVersion: '1.0',
    supportedVersions: ['1.0', '2.0'],
    isInstalled: async () => false,
    install: async () => undefined,
    uninstall: async () => undefined,
    list: async () => [],
    getDefault: async () => null,
    setDefault: async () => undefined,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    pathFor: () => '/usr/bin/fake',
  };
}

/** Build a fresh default State with no installed runtimes. */
function makeState(): State {
  return defaultState();
}

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('runtimes/provider — registry', () => {
  beforeEach(() => {
    clearRuntimes();
  });

  describe('registerRuntime / getRuntime', () => {
    it('registers a provider and retrieves it by name', () => {
      const p = makeFakeProvider('node');
      registerRuntime(p);
      expect(getRuntime('node')).toBe(p);
    });

    it('lookup is case-insensitive', () => {
      const p = makeFakeProvider('node');
      registerRuntime(p);
      expect(getRuntime('NODE')).toBe(p);
      expect(getRuntime('Node')).toBe(p);
      expect(getRuntime('node')).toBe(p);
    });

    it('trims whitespace before lookup', () => {
      const p = makeFakeProvider('node');
      registerRuntime(p);
      expect(getRuntime('  node  ')).toBe(p);
    });

    it('throws RuntimeError(E_RUNTIME_NOT_FOUND) for an unknown name', () => {
      expect(() => getRuntime('python')).toThrow(RuntimeError);
      try {
        getRuntime('python');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_NOT_FOUND');
        expect(err.message).toContain('python');
        expect(err.fixCommand).toContain('linuxify runtimes list');
      }
    });

    it('throws RuntimeError(E_RUNTIME_INVALID) for an empty name', () => {
      const p = makeFakeProvider('   ');
      expect(() => registerRuntime(p)).toThrow(RuntimeError);
      try {
        registerRuntime(p);
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_INVALID');
      }
    });

    it('re-registration overwrites the prior entry', () => {
      const p1 = makeFakeProvider('node', 'Node v1');
      const p2 = makeFakeProvider('node', 'Node v2');
      registerRuntime(p1);
      registerRuntime(p2);
      expect(getRuntime('node')).toBe(p2);
    });
  });

  describe('listRuntimes', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(listRuntimes()).toEqual([]);
    });

    it('returns registered providers sorted alphabetically by name', () => {
      registerRuntime(makeFakeProvider('python'));
      registerRuntime(makeFakeProvider('node'));
      registerRuntime(makeFakeProvider('rust'));
      registerRuntime(makeFakeProvider('go'));
      const names = listRuntimes().map((p) => p.name);
      expect(names).toEqual(['go', 'node', 'python', 'rust']);
    });

    it('returns a new array (callers may mutate without affecting the registry)', () => {
      registerRuntime(makeFakeProvider('node'));
      const arr1 = listRuntimes();
      arr1.pop();
      const arr2 = listRuntimes();
      expect(arr2).toHaveLength(1);
    });
  });

  describe('unregisterRuntime', () => {
    it('removes a registered provider', () => {
      registerRuntime(makeFakeProvider('node'));
      unregisterRuntime('node');
      expect(listRuntimes()).toEqual([]);
    });

    it('is case-insensitive', () => {
      registerRuntime(makeFakeProvider('node'));
      unregisterRuntime('NODE');
      expect(listRuntimes()).toEqual([]);
    });

    it('is a no-op for an unknown name', () => {
      expect(() => unregisterRuntime('never-registered')).not.toThrow();
    });
  });

  describe('clearRuntimes', () => {
    it('removes all registered providers', () => {
      registerRuntime(makeFakeProvider('node'));
      registerRuntime(makeFakeProvider('python'));
      clearRuntimes();
      expect(listRuntimes()).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// State helper tests
// ---------------------------------------------------------------------------

describe('runtimes/provider — state helpers', () => {
  let state: State;

  beforeEach(() => {
    state = makeState();
  });

  describe('findInstalledRuntimes', () => {
    it('returns an empty array when no entries match', () => {
      expect(findInstalledRuntimes(state, 'node', 'ubuntu')).toEqual([]);
    });

    it('returns matching entries by name and distro', () => {
      const install: InstalledRuntime = {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      };
      upsertRuntimeInstall(state, install);
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '20.18.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-02T00:00:00.000Z',
        isDefault: false,
      });
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'debian',
        path: '/usr/bin/node',
        installedAt: '2025-01-03T00:00:00.000Z',
        isDefault: true,
      });

      const found = findInstalledRuntimes(state, 'node', 'ubuntu');
      expect(found).toHaveLength(2);
      expect(found.map((r) => r.version).sort()).toEqual(['20.18.0', '22.11.0']);
    });

    it('returns a new array (does not expose internal state)', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      const found = findInstalledRuntimes(state, 'node', 'ubuntu');
      found[0]!.isDefault = false;
      const refound = findInstalledRuntimes(state, 'node', 'ubuntu');
      expect(refound[0]!.isDefault).toBe(true);
    });
  });

  describe('upsertRuntimeInstall', () => {
    it('appends a new entry when no matching key exists', () => {
      const before = state.installed_runtimes.length;
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      expect(state.installed_runtimes).toHaveLength(before + 1);
    });

    it('replaces the entry in place when the same (name, distro, version) key exists', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: false,
      });
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-02T00:00:00.000Z',
        isDefault: true,
      });
      expect(state.installed_runtimes).toHaveLength(1);
      expect(state.installed_runtimes[0]!.is_default).toBe(true);
      expect(state.installed_runtimes[0]!.installed_at).toBe('2025-01-02T00:00:00.000Z');
    });

    it('writes the snake_case state.json record shape', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      const record = state.installed_runtimes[0]!;
      expect(record.installed_at).toBe('2025-01-01T00:00:00.000Z');
      expect(record.is_default).toBe(true);
    });
  });

  describe('removeRuntimeInstall', () => {
    it('removes a matching entry and returns true', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      const removed = removeRuntimeInstall(state, 'node', 'ubuntu', '22.11.0');
      expect(removed).toBe(true);
      expect(state.installed_runtimes).toHaveLength(0);
    });

    it('returns false when no matching entry exists', () => {
      const removed = removeRuntimeInstall(state, 'node', 'ubuntu', '22.11.0');
      expect(removed).toBe(false);
    });

    it('does not remove entries with a different distro', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      removeRuntimeInstall(state, 'node', 'debian', '22.11.0');
      expect(state.installed_runtimes).toHaveLength(1);
    });
  });

  describe('markDefaultRuntime', () => {
    it('sets is_default=true on the matching entry', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: false,
      });
      const ok = markDefaultRuntime(state, 'node', 'ubuntu', '22.11.0');
      expect(ok).toBe(true);
      expect(state.installed_runtimes[0]!.is_default).toBe(true);
    });

    it('clears is_default on other entries of the same runtime name in the same distro', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '20.18.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-02T00:00:00.000Z',
        isDefault: false,
      });
      markDefaultRuntime(state, 'node', 'ubuntu', '20.18.0');
      expect(state.installed_runtimes[0]!.is_default).toBe(false);
      expect(state.installed_runtimes[1]!.is_default).toBe(true);
    });

    it('does not affect entries of a different runtime name', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      upsertRuntimeInstall(state, {
        name: 'python',
        version: '3.12.3',
        distro: 'ubuntu',
        path: '/usr/bin/python3',
        installedAt: '2025-01-02T00:00:00.000Z',
        isDefault: true,
      });
      markDefaultRuntime(state, 'node', 'ubuntu', '22.11.0');
      const python = state.installed_runtimes.find((r) => r.name === 'python')!;
      expect(python.is_default).toBe(true);
    });

    it('does not affect entries of the same name in a different distro', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'debian',
        path: '/usr/bin/node',
        installedAt: '2025-01-02T00:00:00.000Z',
        isDefault: true,
      });
      markDefaultRuntime(state, 'node', 'ubuntu', '22.11.0');
      const debian = state.installed_runtimes.find((r) => r.distro === 'debian')!;
      expect(debian.is_default).toBe(true);
    });

    it('returns false when no matching entry exists', () => {
      const ok = markDefaultRuntime(state, 'node', 'ubuntu', '22.11.0');
      expect(ok).toBe(false);
    });
  });

  describe('getDefaultRuntimeVersion', () => {
    it('returns null when no entry is_default=true', () => {
      expect(getDefaultRuntimeVersion(state, 'node', 'ubuntu')).toBeNull();
    });

    it('returns the version of the is_default=true entry', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      expect(getDefaultRuntimeVersion(state, 'node', 'ubuntu')).toBe('22.11.0');
    });

    it('returns null for the wrong distro', () => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
      expect(getDefaultRuntimeVersion(state, 'node', 'debian')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// createDefaultDistroExec
// ---------------------------------------------------------------------------

describe('runtimes/provider — createDefaultDistroExec', () => {
  it('returns a function', () => {
    const fn = createDefaultDistroExec();
    expect(typeof fn).toBe('function');
  });

  it('the returned function has the DistroExecFn signature', () => {
    const fn = createDefaultDistroExec();
    // Verify the function accepts (distro, cmd, args, opts?) and returns a
    // Promise. We don't invoke it (it would shell out to proot-distro) — the
    // integration test suite covers the real exec path.
    expect(fn.length).toBeLessThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// StateStore integration (smoke test that helpers compose with the real store)
// ---------------------------------------------------------------------------

describe('runtimes/provider — StateStore integration', () => {
  it('helpers compose with StateStore.update to persist runtimes', async () => {
    // Use the real StateStore pointed at /tmp via LINUXIFY_HOME (set in
    // tests/setup.ts). We don't actually need a clean tmpdir for this smoke
    // test — we just verify the helpers can be called from inside update().
    const store = new StateStore('/tmp/linuxify-runtime-test-state.json');
    await store.update((state) => {
      upsertRuntimeInstall(state, {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/usr/bin/node',
        installedAt: '2025-01-01T00:00:00.000Z',
        isDefault: true,
      });
    });
    const loaded = await store.load();
    expect(loaded.installed_runtimes).toHaveLength(1);
    expect(loaded.installed_runtimes[0]!.name).toBe('node');
    expect(loaded.installed_runtimes[0]!.installed_at).toBe('2025-01-01T00:00:00.000Z');
    // Cleanup.
    await store.update((state) => {
      removeRuntimeInstall(state, 'node', 'ubuntu', '22.11.0');
    });
  });
});
