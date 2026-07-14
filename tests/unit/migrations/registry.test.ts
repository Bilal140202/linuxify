/**
 * Unit tests for `src/migrations/registry.ts` (the `MigrationRegistry` class
 * and the built-in migrations).
 *
 * Covers:
 *   - `register()` happy path: stores the migration, retrievable via `get()`.
 *   - `register()` rejects invalid semver versions.
 *   - `register()` rejects duplicate versions.
 *   - `list()` returns migrations sorted ascending by semver (regardless of
 *     registration order).
 *   - `get()` returns `undefined` for unknown versions.
 *   - `size` reflects the count of registered migrations.
 *   - Constructor accepts initial migrations.
 *   - `registerBuiltInMigrations()` registers every built-in migration
 *     idempotently.
 *   - `BUILT_IN_MIGRATIONS` includes 0.1.0 and 0.2.0.
 *
 * No filesystem I/O. The logger is mocked.
 */

import { describe, it, expect, vi } from 'vitest';

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
  MigrationRegistry,
  registerBuiltInMigrations,
  BUILT_IN_MIGRATIONS,
} from '../../../src/migrations/registry.js';
import type { Migration } from '../../../src/migrations/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal migration stub for testing. */
function stub(version: string): Migration {
  return {
    version,
    description: `stub ${version}`,
    up: async (state) => state,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MigrationRegistry', () => {
  describe('register', () => {
    it('stores a migration retrievable via get()', () => {
      const r = new MigrationRegistry();
      const m = stub('0.2.0');
      r.register(m);
      expect(r.get('0.2.0')).toBe(m);
      expect(r.size).toBe(1);
    });

    it('rejects an invalid semver version', () => {
      const r = new MigrationRegistry();
      expect(() => r.register(stub('not-a-version'))).toThrow(/not a valid semver/);
    });

    it('rejects a duplicate version', () => {
      const r = new MigrationRegistry();
      r.register(stub('0.2.0'));
      expect(() => r.register(stub('0.2.0'))).toThrow(/already registered/);
    });

    it('rejects a migration with no version field', () => {
      const r = new MigrationRegistry();
      // Build a migration without a version by stripping it.
      const bad = stub('0.1.0') as Partial<Migration>;
      delete bad.version;
      expect(() => r.register(bad as Migration)).toThrow(/version is required/);
    });
  });

  describe('list', () => {
    it('returns migrations sorted ascending by semver', () => {
      const r = new MigrationRegistry();
      r.register(stub('0.3.0'));
      r.register(stub('0.1.0'));
      r.register(stub('0.2.0'));
      const list = r.list();
      expect(list.map((m) => m.version)).toEqual(['0.1.0', '0.2.0', '0.3.0']);
    });

    it('returns an empty array for an empty registry', () => {
      const r = new MigrationRegistry();
      expect(r.list()).toEqual([]);
    });

    it('returns a new array (callers can safely sort/mutate)', () => {
      const r = new MigrationRegistry();
      r.register(stub('0.1.0'));
      const a = r.list();
      const b = r.list();
      expect(a).not.toBe(b); // different array instances
      expect(a).toEqual(b); // same contents
    });

    it('sorts pre-release versions correctly (semver rules)', () => {
      const r = new MigrationRegistry();
      r.register(stub('0.2.0'));
      r.register(stub('0.2.0-alpha.1'));
      r.register(stub('0.1.0'));
      const list = r.list();
      // 0.1.0 < 0.2.0-alpha.1 < 0.2.0
      expect(list.map((m) => m.version)).toEqual([
        '0.1.0',
        '0.2.0-alpha.1',
        '0.2.0',
      ]);
    });
  });

  describe('get', () => {
    it('returns undefined for an unknown version', () => {
      const r = new MigrationRegistry();
      r.register(stub('0.2.0'));
      expect(r.get('0.3.0')).toBeUndefined();
    });

    it('returns the registered migration for a known version', () => {
      const r = new MigrationRegistry();
      const m = stub('0.2.0');
      r.register(m);
      expect(r.get('0.2.0')).toBe(m);
    });
  });

  describe('constructor with initial migrations', () => {
    it('accepts and stores initial migrations', () => {
      const r = new MigrationRegistry({
        migrations: [stub('0.1.0'), stub('0.2.0')],
      });
      expect(r.size).toBe(2);
      expect(r.get('0.1.0')).toBeDefined();
      expect(r.get('0.2.0')).toBeDefined();
    });

    it('rejects duplicate versions in initial migrations', () => {
      expect(
        () =>
          new MigrationRegistry({
            migrations: [stub('0.1.0'), stub('0.1.0')],
          }),
      ).toThrow(/already registered/);
    });
  });
});

describe('BUILT_IN_MIGRATIONS', () => {
  it('includes 0.1.0 and 0.2.0', () => {
    const versions = BUILT_IN_MIGRATIONS.map((m) => m.version);
    expect(versions).toContain('0.1.0');
    expect(versions).toContain('0.2.0');
  });

  it('every built-in migration has a description and an up() function', () => {
    for (const m of BUILT_IN_MIGRATIONS) {
      expect(typeof m.description).toBe('string');
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.up).toBe('function');
    }
  });

  it('every built-in migration is a no-op on a sample state (idempotency)', async () => {
    // Build a minimal sample state. We import the default-state factory
    // lazily so this test file does not pay the state-module import cost
    // when only the registry is being tested in isolation.
    const { defaultState } = await import('../../../src/state/index.js');
    const state = defaultState();
    for (const m of BUILT_IN_MIGRATIONS) {
      const out = await m.up(state);
      // No-op migrations return the input state (or a shallow clone).
      expect(out).toBeTruthy();
      expect(out.linuxify_version).toBe(state.linuxify_version);
    }
  });
});

describe('registerBuiltInMigrations', () => {
  it('registers every built-in migration on an empty registry', () => {
    const r = new MigrationRegistry();
    registerBuiltInMigrations(r);
    expect(r.size).toBeGreaterThanOrEqual(BUILT_IN_MIGRATIONS.length);
    for (const m of BUILT_IN_MIGRATIONS) {
      expect(r.get(m.version)).toBeDefined();
    }
  });

  it('is idempotent (calling twice does not throw)', () => {
    const r = new MigrationRegistry();
    registerBuiltInMigrations(r);
    expect(() => registerBuiltInMigrations(r)).not.toThrow();
    const afterFirst = r.size;
    registerBuiltInMigrations(r);
    expect(r.size).toBe(afterFirst);
  });

  it('returns migrations sorted when list() is called', async () => {
    const r = new MigrationRegistry();
    registerBuiltInMigrations(r);
    const list = r.list();
    const { compare } = await import('semver');
    // Verify ascending order.
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!.version;
      const curr = list[i]!.version;
      // semver: prev <= curr
      expect(compare(prev, curr)).toBeLessThanOrEqual(0);
    }
  });
});
