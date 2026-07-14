/**
 * Unit tests for `src/migrations/runner.ts` (the `MigrationRunner` class).
 *
 * Covers:
 *   - `run()` happy path: applies pending migrations in ascending semver
 *     order, updates `state.linuxify_version` to the target.
 *   - `run()` filters out migrations <= current version (already applied).
 *   - `run()` filters out migrations > target version (out of range).
 *   - `run()` with no pending migrations is a no-op.
 *   - `run()` records each applied migration's version in
 *     `result.migrationsApplied`.
 *   - `run()` on failure: rolls back via `down()` if defined.
 *   - `run()` on failure: restores the pre-migration backup if `down()` is
 *     undefined.
 *   - `run()` on failure: returns `success: false` with error message.
 *   - `run()` throws `E_MIGRATION_INVALID_VERSION` on bad target version.
 *   - `dryRun()` returns the list of pending migration versions.
 *   - `listPending()` returns the pending Migration objects.
 *
 * Uses real tmpdir + real StateStore; migrations are tiny stubs. The
 * logger is mocked.
 */

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { MigrationRunner } from '../../../src/migrations/runner.js';
import { StateStore, defaultState, type State } from '../../../src/state/index.js';
import type { Migration, MigrationResult } from '../../../src/migrations/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Set up a fresh tmpdir + state store with `state.linuxify_version = version`. */
async function freshState(version: string): Promise<{
  linuxifyHome: string;
  stateStore: StateStore;
}> {
  const linuxifyHome = await mkdtemp(join(tmpdir(), 'linuxify-migr-'));
  const statePath = join(linuxifyHome, 'state.json');
  const stateStore = new StateStore(statePath);
  const state = defaultState();
  state.linuxify_version = version;
  await stateStore.save(state);
  return { linuxifyHome, stateStore };
}

/**
 * Build a migration that records its execution in the supplied `ran` array
 * and returns the state unchanged. The `active_distro` field is set to a
 * sentinel value derived from `version` so the test can verify the migration
 * actually ran by inspecting the saved state.
 */
function makeMigration(
  version: string,
  ran: string[],
  opts: Partial<Migration> = {},
): Migration {
  return {
    version,
    description: `migration to ${version}`,
    up: async (state) => {
      ran.push(version);
      // `active_distro` is a free-form string in the state schema; use it
      // as a sentinel so we can verify the migration ran by reading state
      // back from disk (without needing to add an out-of-schema field that
      // the strict schema would reject).
      return { ...state, active_distro: `migrated-to-${version}` };
    },
    ...opts,
  };
}

/** Build a migration whose `up()` throws. */
function makeFailingMigration(version: string, errMsg = 'boom'): Migration {
  return {
    version,
    description: `failing migration to ${version}`,
    up: async () => {
      throw new Error(errMsg);
    },
    down: async (state) => state,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MigrationRunner', () => {
  let linuxifyHome: string;

  beforeEach(() => {
    // linuxifyHome is set per-test in freshState; reset here so afterEach
    // can clean up.
    linuxifyHome = '';
  });

  afterEach(async () => {
    if (linuxifyHome) {
      await rm(linuxifyHome, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('throws if stateStore is missing', async () => {
      expect(
        () =>
          new MigrationRunner({
            // @ts-expect-error intentional
            stateStore: undefined,
            migrations: [],
          }),
      ).toThrow(/stateStore/);
    });

    it('throws if migrations is not an array', async () => {
      const { stateStore } = await freshState('0.1.0');
      expect(
        () =>
          new MigrationRunner({
            stateStore,
            // @ts-expect-error intentional
            migrations: 'not an array',
          }),
      ).toThrow(/migrations/);
    });
  });

  describe('run — happy path', () => {
    it('applies pending migrations in ascending semver order', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [
        makeMigration('0.3.0', ran),
        makeMigration('0.2.0', ran), // out of order; runner must sort
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const result = await runner.run('0.3.0');

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe('0.1.0');
      expect(result.toVersion).toBe('0.3.0');
      expect(result.migrationsApplied).toEqual(['0.2.0', '0.3.0']);
      expect(ran).toEqual(['0.2.0', '0.3.0']);

      const state = await env.stateStore.load();
      expect(state.linuxify_version).toBe('0.3.0');
      // The 0.3.0 migration ran last; its sentinel wins.
      expect(state.active_distro).toBe('migrated-to-0.3.0');
    });

    it('updates state.linuxify_version after each migration', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [
        makeMigration('0.2.0', ran),
        makeMigration('0.3.0', ran),
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      await runner.run('0.3.0');

      const state = await env.stateStore.load();
      expect(state.linuxify_version).toBe('0.3.0');
      expect(state.active_distro).toBe('migrated-to-0.3.0');
    });

    it('writes a pre-migration backup for each applied migration', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [makeMigration('0.2.0', ran), makeMigration('0.3.0', ran)];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      await runner.run('0.3.0');

      const backupsDir = join(linuxifyHome, 'backups');
      const backup020 = await readFile(join(backupsDir, 'pre-migration-0.2.0.json'), 'utf8');
      const backup030 = await readFile(join(backupsDir, 'pre-migration-0.3.0.json'), 'utf8');

      // The 0.2.0 backup should record linuxify_version=0.1.0 (the state
      // before the 0.2.0 migration ran).
      expect(JSON.parse(backup020).linuxify_version).toBe('0.1.0');
      // The 0.3.0 backup should record linuxify_version=0.2.0 (the state
      // after the 0.2.0 migration ran, before 0.3.0).
      expect(JSON.parse(backup030).linuxify_version).toBe('0.2.0');
    });
  });

  describe('run — filtering', () => {
    it('excludes migrations <= current version', async () => {
      const env = await freshState('0.2.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [
        makeMigration('0.1.0', ran),
        makeMigration('0.2.0', ran),
        makeMigration('0.3.0', ran),
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const result = await runner.run('0.3.0');

      expect(result.migrationsApplied).toEqual(['0.3.0']);
      expect(ran).toEqual(['0.3.0']);
    });

    it('excludes migrations > target version', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [
        makeMigration('0.2.0', ran),
        makeMigration('0.3.0', ran),
        makeMigration('0.4.0', ran),
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const result = await runner.run('0.3.0');

      expect(result.migrationsApplied).toEqual(['0.2.0', '0.3.0']);
      expect(ran).toEqual(['0.2.0', '0.3.0']);
    });

    it('is a no-op when no migrations are pending', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [makeMigration('0.1.0', ran)]; // equal to current
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const result = await runner.run('0.1.0');

      expect(result.success).toBe(true);
      expect(result.migrationsApplied).toEqual([]);
      expect(ran).toEqual([]);
      expect(result.fromVersion).toBe('0.1.0');
      expect(result.toVersion).toBe('0.1.0');
    });

    it('is a no-op when target == current and no migration matches', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const runner = new MigrationRunner({
        stateStore: env.stateStore,
        migrations: [makeMigration('0.5.0', ran)],
      });

      const result = await runner.run('0.1.0');
      expect(result.migrationsApplied).toEqual([]);
      expect(ran).toEqual([]);
      expect(result.success).toBe(true);
    });
  });

  describe('run — invalid target version', () => {
    it('throws E_MIGRATION_INVALID_VERSION on bad target', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const runner = new MigrationRunner({
        stateStore: env.stateStore,
        migrations: [],
      });

      await expect(runner.run('not-a-version')).rejects.toThrow(/not a valid semver/);
    });
  });

  describe('run — failures and rollback', () => {
    it('rolls back via down() when up() throws', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      let downCalled = false;
      const failing: Migration = {
        version: '0.2.0',
        description: 'failing',
        up: async () => {
          throw new Error('boom');
        },
        down: async (state) => {
          downCalled = true;
          return state;
        },
      };
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations: [failing] });

      const result = await runner.run('0.2.0');

      expect(result.success).toBe(false);
      expect(result.error).toContain('boom');
      expect(result.migrationsApplied).toEqual([]);
      expect(downCalled).toBe(true);
    });

    it('restores pre-migration backup when down() is undefined', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const failing: Migration = {
        version: '0.2.0',
        description: 'failing without down',
        up: async () => {
          throw new Error('up-broken');
        },
        // no down()
      };
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations: [failing] });

      const result = await runner.run('0.2.0');

      expect(result.success).toBe(false);
      // After rollback, the on-disk state should be back to 0.1.0.
      const state = await env.stateStore.load();
      expect(state.linuxify_version).toBe('0.1.0');
    });

    it('restores backup when down() also throws', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const failing: Migration = {
        version: '0.2.0',
        description: 'failing with failing down',
        up: async () => {
          throw new Error('up-broken');
        },
        down: async () => {
          throw new Error('down-broken');
        },
      };
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations: [failing] });

      const result = await runner.run('0.2.0');

      expect(result.success).toBe(false);
      expect(result.error).toContain('up-broken');
      // Backup should still have been restored despite down() failing.
      const state = await env.stateStore.load();
      expect(state.linuxify_version).toBe('0.1.0');
    });

    it('stops applying further migrations after a failure', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      let good_030_called = false;
      const migrations: Migration[] = [
        makeFailingMigration('0.2.0', 'first-fail'),
        {
          version: '0.3.0',
          description: 'should not run',
          up: async (state) => {
            good_030_called = true;
            return state;
          },
        },
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const result = await runner.run('0.3.0');

      expect(result.success).toBe(false);
      expect(good_030_called).toBe(false);
      expect(result.migrationsApplied).toEqual([]);
    });
  });

  describe('dryRun', () => {
    it('returns the pending migration versions in order', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const migrations = [
        makeMigration('0.3.0', ran),
        makeMigration('0.2.0', ran),
        makeMigration('0.5.0', ran),
      ];
      const runner = new MigrationRunner({ stateStore: env.stateStore, migrations });

      const pending = await runner.dryRun('0.3.0');
      expect(pending).toEqual(['0.2.0', '0.3.0']);
      expect(ran).toEqual([]);

      // Confirm dry-run did not modify state.
      const state = await env.stateStore.load();
      expect(state.linuxify_version).toBe('0.1.0');
    });

    it('returns empty array when no migrations are pending', async () => {
      const env = await freshState('0.5.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const runner = new MigrationRunner({
        stateStore: env.stateStore,
        migrations: [makeMigration('0.2.0', ran), makeMigration('0.3.0', ran)],
      });

      const pending = await runner.dryRun('0.5.0');
      expect(pending).toEqual([]);
      expect(ran).toEqual([]);
    });
  });

  describe('listPending', () => {
    it('returns the pending Migration objects sorted by version', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const m020 = makeMigration('0.2.0', ran);
      const m030 = makeMigration('0.3.0', ran);
      const runner = new MigrationRunner({
        stateStore: env.stateStore,
        migrations: [m030, m020], // out of order
      });

      const pending = await runner.listPending('0.3.0');
      expect(pending.map((m) => m.version)).toEqual(['0.2.0', '0.3.0']);
      expect(pending[0]).toBe(m020);
      expect(pending[1]).toBe(m030);
      expect(ran).toEqual([]); // listPending does not apply
    });
  });

  describe('result shape', () => {
    it('returns a MigrationResult with durationMs >= 0', async () => {
      const env = await freshState('0.1.0');
      linuxifyHome = env.linuxifyHome;
      const ran: string[] = [];
      const runner = new MigrationRunner({
        stateStore: env.stateStore,
        migrations: [makeMigration('0.2.0', ran)],
      });

      const result: MigrationResult = await runner.run('0.2.0');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });
  });
});
