/**
 * Unit tests for `src/distros/provider.ts` — the registry functions and the
 * `DistroProvider` interface contract.
 *
 * Covers:
 *   - registerDistro / getDistro / listDistros round-trip.
 *   - getDistro throws DistroError with E_DISTRO_NOT_FOUND on unknown names.
 *   - registerDistro rejects providers with an empty name.
 *   - listDistros returns the registered providers in insertion order.
 *   - re-registration overwrites the prior entry.
 *   - getActiveDistroName reads `state.active_distro` and returns '' when
 *     unset.
 *
 * The four built-in providers are NOT auto-registered here — each test
 * starts with a fresh, empty registry via `_clearDistroRegistryForTests()`
 * so the tests are deterministic regardless of import order.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { DistroError } from '../../../src/utils/errors.js';
import {
  registerDistro,
  getDistro,
  listDistros,
  getActiveDistroName,
  _clearDistroRegistryForTests,
  type DistroProvider,
} from '../../../src/distros/provider.js';
import type { State } from '../../../src/state/index.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory DistroProvider for registry tests. The methods are
 * stubs — registry tests don't invoke them, only check identity / lookup.
 */
function makeFakeProvider(name: string, displayName?: string): DistroProvider {
  return {
    name,
    displayName: displayName ?? `Fake ${name}`,
    defaultVersion: '1.0',
    supportedArches: ['aarch64'],
    minStorageMb: 1024,
    isInstalled: async () => false,
    install: async () => undefined,
    uninstall: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    shell: async () => undefined,
    info: async () => ({
      name,
      version: '1.0',
      arch: 'aarch64',
      installedAt: '2025-01-01T00:00:00.000Z',
      rootfsPath: '/tmp/fake',
      rootfsSha256: '0'.repeat(64),
      diskUsageMb: 0,
    }),
    update: async () => undefined,
    snapshot: async () => '/tmp/fake.tar.zst',
    restore: async () => undefined,
  };
}

/** Build a minimal `State` with `active_distro` set to `name` (or `''`). */
function makeState(activeDistro: string): State {
  return {
    schema_version: 1,
    linuxify_version: '0.1.0-test',
    active_distro: activeDistro,
    installed_distros: [],
    installed_runtimes: [],
    installed_packages: [],
    applied_patches: [],
    bootstrap_progress: {
      current_stage: 0,
      completed_stages: [],
      failed_stage: null,
      error: null,
      started_at: '2025-01-01T00:00:00.000Z',
      last_updated_at: '2025-01-01T00:00:00.000Z',
    },
    last_doctor_run: null,
    telemetry: { user_id: null, enabled: false, last_flush: null },
    plugins: [],
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
  };
}

// ---------------------------------------------------------------------------

describe('distros/provider — registry', () => {
  beforeEach(() => {
    _clearDistroRegistryForTests();
  });

  describe('registerDistro', () => {
    it('registers a provider that getDistro can look up by name', () => {
      const p = makeFakeProvider('ubuntu');
      registerDistro(p);
      expect(getDistro('ubuntu')).toBe(p);
    });

    it('rejects a provider with an empty name', () => {
      const p = makeFakeProvider('');
      expect(() => registerDistro(p)).toThrow(DistroError);
      try {
        registerDistro(p);
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_REGISTER_INVALID');
      }
    });

    it('overwrites a prior entry when re-registering the same name', () => {
      const first = makeFakeProvider('ubuntu', 'First');
      const second = makeFakeProvider('ubuntu', 'Second');
      registerDistro(first);
      registerDistro(second);
      expect(getDistro('ubuntu')).toBe(second);
      expect(getDistro('ubuntu').displayName).toBe('Second');
    });

    it('preserves insertion order across multiple registrations', () => {
      registerDistro(makeFakeProvider('ubuntu'));
      registerDistro(makeFakeProvider('debian'));
      registerDistro(makeFakeProvider('arch'));
      registerDistro(makeFakeProvider('alpine'));
      const names = listDistros().map((p) => p.name);
      expect(names).toEqual(['ubuntu', 'debian', 'arch', 'alpine']);
    });
  });

  describe('getDistro', () => {
    it('returns the registered provider', () => {
      const p = makeFakeProvider('arch');
      registerDistro(p);
      expect(getDistro('arch')).toBe(p);
    });

    it('throws DistroError with E_DISTRO_NOT_FOUND for an unknown name', () => {
      expect(() => getDistro('nonexistent')).toThrow(DistroError);
      try {
        getDistro('nonexistent');
      } catch (e) {
        const err = e as DistroError;
        expect(err.code).toBe('E_DISTRO_NOT_FOUND');
        expect(err.message).toContain('nonexistent');
        const details = err.details as { requested: string; registered: string[] };
        expect(details.requested).toBe('nonexistent');
        expect(Array.isArray(details.registered)).toBe(true);
      }
    });

    it('includes the list of registered names in the error details', () => {
      registerDistro(makeFakeProvider('ubuntu'));
      registerDistro(makeFakeProvider('debian'));
      try {
        getDistro('fedora');
      } catch (e) {
        const err = e as DistroError;
        const details = err.details as { registered: string[] };
        expect(details.registered).toEqual(['ubuntu', 'debian']);
      }
    });

    it('includes a fixCommand hint pointing at linuxify distros install', () => {
      try {
        getDistro('fedora');
      } catch (e) {
        const err = e as DistroError;
        expect(err.fixCommand).toContain('linuxify distros install');
      }
    });

    it('is case-sensitive (Ubuntu != ubuntu)', () => {
      registerDistro(makeFakeProvider('ubuntu'));
      expect(() => getDistro('Ubuntu')).toThrow(DistroError);
    });
  });

  describe('listDistros', () => {
    it('returns an empty array when the registry is empty', () => {
      expect(listDistros()).toEqual([]);
    });

    it('returns a new array (not the internal map) so callers cannot mutate the registry', () => {
      registerDistro(makeFakeProvider('ubuntu'));
      const list = listDistros();
      list.length = 0;
      // The internal registry is unaffected.
      expect(listDistros()).toHaveLength(1);
    });

    it('returns the provider instances, not just names', () => {
      const ubuntu = makeFakeProvider('ubuntu');
      const debian = makeFakeProvider('debian');
      registerDistro(ubuntu);
      registerDistro(debian);
      const list = listDistros();
      expect(list).toContain(ubuntu);
      expect(list).toContain(debian);
    });
  });

  describe('getActiveDistroName', () => {
    it('returns state.active_distro when set', () => {
      const state = makeState('ubuntu');
      expect(getActiveDistroName(state)).toBe('ubuntu');
    });

    it('returns the empty string when active_distro is empty', () => {
      const state = makeState('');
      expect(getActiveDistroName(state)).toBe('');
    });

    it('does NOT consult the registry — a stale active_distro is returned as-is', () => {
      // The distro 'ghost' is not registered, but getActiveDistroName is a
      // pure read of state and must not throw.
      const state = makeState('ghost');
      expect(getActiveDistroName(state)).toBe('ghost');
    });

    it('returns the empty string when active_distro is undefined (defensive)', () => {
      // Construct a state object that is missing active_distro entirely.
      // getActiveDistroName should default to '' rather than throw.
      const state = makeState('') as unknown as { active_distro: undefined };
      delete state.active_distro;
      expect(getActiveDistroName(state as unknown as State)).toBe('');
    });
  });
});
