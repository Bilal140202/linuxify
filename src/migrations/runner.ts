/**
 * Migration runner — applies pending migrations to `state.json`.
 *
 * @module linuxify/migrations/runner
 *
 * The runner is the implementation behind `linuxify self-update`'s migration
 * step (see `docs/14-cicd/release-pipeline.md` §8 and
 * `docs/22-operations/migration-guide.md` §8). It is also exposed as a
 * standalone API so `linuxify self-update --dry-run` can preview pending
 * migrations without applying them.
 *
 * Flow (see {@link MigrationRunner.run}):
 *   1. Load current state; read `state.linuxify_version` as the starting point.
 *   2. Filter the registered migrations to those with `version` > current
 *      AND `version` <= `targetVersion`. Sort ascending by semver.
 *   3. For each migration:
 *      a. Back up `state.json` to `~/.linuxify/backups/pre-migration-<version>.json`.
 *      b. Apply `up(state)`. If it throws, attempt `down(state)` (if
 *         defined) to undo, then restore the backup. Return a failed
 *         {@link MigrationResult}.
 *      c. Save the migrated state (without bumping `linuxify_version` yet).
 *   4. After all migrations applied successfully, set
 *      `state.linuxify_version = targetVersion` and save.
 *   5. Return the successful {@link MigrationResult}.
 *
 * The runner is **atomic at the migration level**: a migration that throws
 * is rolled back (via `down` or backup restore) before the runner returns.
 * The runner is NOT atomic at the run level: if migration 0.3.0 succeeds
 * but 0.4.0 fails, 0.3.0's effects remain applied. The `state.linuxify_version`
 * stays at the last successfully-applied version (the runner updates the
 * version field as part of each migration's save — see below).
 *
 * @packageDocumentation
 */

import { join, dirname } from 'node:path';

import { gte as semverGte, lte as semverLte, valid as semverValid, compare as semverCompare } from 'semver';

import { LinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import { ensureDir, writeJson, exists, copyFile } from '../utils/fs.js';

import type { Migration, MigrationResult, MigrationRunnerOptions } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directory under `~/.linuxify/` where pre-migration backups are stored. */
const BACKUPS_DIRNAME = 'backups';

// ---------------------------------------------------------------------------
// MigrationRunner
// ---------------------------------------------------------------------------

/**
 * Applies pending migrations to `state.json`. One instance is typically
 * created per `linuxify self-update` invocation.
 *
 * The runner is constructed with a list of migrations (typically the output
 * of {@link MigrationRegistry.list}). The list is filtered and sorted at
 * run time, so passing an unsorted list is fine.
 */
export class MigrationRunner {
  /** State store, used to load/save `state.json` and to find the backups dir. */
  readonly stateStore: import('../state/index.js').StateStore;
  /** Migrations available to apply (filtered + sorted per run). */
  readonly migrations: Migration[];

  /**
   * @param opts - Constructor options. `stateStore` and `migrations` are
   *   required.
   */
  constructor(opts: MigrationRunnerOptions) {
    if (!opts || !opts.stateStore) {
      throw new LinuxifyError({
        code: 'E_MIGRATION_INVALID_OPTS',
        message: 'MigrationRunner requires a stateStore',
      });
    }
    if (!opts || !Array.isArray(opts.migrations)) {
      throw new LinuxifyError({
        code: 'E_MIGRATION_INVALID_OPTS',
        message: 'MigrationRunner requires a migrations array',
      });
    }
    this.stateStore = opts.stateStore;
    this.migrations = [...opts.migrations];
  }

  /**
   * Run pending migrations up to and including `targetVersion`.
   *
   * @param targetVersion - The version to migrate to. Must be a valid semver.
   * @returns A {@link MigrationResult}. Never throws — migration failures
   *   are captured in `result.error` and `result.success = false`.
   * @throws {LinuxifyError} with code `E_MIGRATION_INVALID_VERSION` if
   *   `targetVersion` is not a valid semver (this is a caller bug, not a
   *   migration failure).
   */
  async run(targetVersion: string): Promise<MigrationResult> {
    if (semverValid(targetVersion) === null) {
      throw new LinuxifyError({
        code: 'E_MIGRATION_INVALID_VERSION',
        message: `target version '${targetVersion}' is not a valid semver`,
        details: { targetVersion },
      });
    }

    const start = Date.now();
    const state = await this.stateStore.load();
    const fromVersion = state.linuxify_version;

    const pending = this.pendingMigrations(fromVersion, targetVersion);

    logger.info('migration: run starting', {
      fromVersion,
      toVersion: targetVersion,
      pending: pending.map((m) => m.version),
    });

    const applied: string[] = [];
    let currentState = state;

    for (const migration of pending) {
      // 1. Back up state.json before applying this migration.
      await this.backupState(migration.version);

      try {
        logger.info('migration: applying', { version: migration.version });
        // 2. Apply up(). The migration returns the new state; we save it
        //    immediately so the on-disk state matches what we'd rollback
        //    from if the NEXT migration fails.
        const migrated = await migration.up(currentState);
        if (!migrated || typeof migrated !== 'object') {
          throw new Error(
            `migration ${migration.version} up() did not return a state object`,
          );
        }
        // 3. Bump linuxify_version to this migration's version, so a crash
        //    between migrations leaves the state consistent with the
        //    on-disk shape.
        migrated.linuxify_version = migration.version;
        await this.stateStore.save(migrated);
        currentState = migrated;
        applied.push(migration.version);
        logger.info('migration: applied', { version: migration.version });
      } catch (err) {
        // 4. Rollback: try down() on the failed migration, then restore
        //    the backup regardless.
        const errMsg = (err as Error).message ?? String(err);
        logger.error('migration: failed; rolling back', {
          version: migration.version,
          error: errMsg,
        });
        if (migration.down) {
          try {
            const rolledBack = await migration.down(currentState);
            if (rolledBack) {
              await this.stateStore.save(rolledBack);
              currentState = rolledBack;
            }
          } catch (downErr) {
            logger.warn('migration: down() also failed; restoring backup', {
              version: migration.version,
              downError: (downErr as Error).message,
            });
          }
        }
        // Restore the pre-migration backup (best-effort).
        await this.restoreBackup(migration.version);
        return {
          fromVersion,
          toVersion: migration.version,
          migrationsApplied: applied,
          success: false,
          error: `migration ${migration.version} failed: ${errMsg}`,
          durationMs: Date.now() - start,
        };
      }
    }

    // 5. Pin linuxify_version to the requested target. If `targetVersion`
    //    is below the highest-applied migration version (e.g. the user
    //    requested `0.2.0` but only `0.1.0` was pending), this is a no-op
    //    because the highest-applied migration already set the version.
    if (semverGte(targetVersion, currentState.linuxify_version)) {
      currentState.linuxify_version = targetVersion;
      await this.stateStore.save(currentState);
    }

    return {
      fromVersion,
      toVersion: targetVersion,
      migrationsApplied: applied,
      success: true,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Preview the migrations that would run, without applying them.
   *
   * @param targetVersion - The version to migrate to.
   * @returns An array of migration version strings, in execution order.
   *   Empty if no migrations are pending.
   */
  async dryRun(targetVersion: string): Promise<string[]> {
    const state = await this.stateStore.load();
    const pending = this.pendingMigrations(state.linuxify_version, targetVersion);
    return pending.map((m) => m.version);
  }

  /**
   * Return the pending migrations for a given target version.
   *
   * @param targetVersion - The version to migrate to.
   * @returns An array of {@link Migration} objects, sorted ascending by semver.
   */
  async listPending(targetVersion: string): Promise<Migration[]> {
    const state = await this.stateStore.load();
    return this.pendingMigrations(state.linuxify_version, targetVersion);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Compute the pending migrations: those with `version > currentVersion`
   * AND `version <= targetVersion`, sorted ascending by semver.
   *
   * A migration whose `version` equals `currentVersion` is considered
   * already-applied and excluded. A migration whose `version` equals
   * `targetVersion` is included (it is the final migration that brings
   * the state up to the requested target).
   *
   * @param currentVersion - The current `state.linuxify_version`.
   * @param targetVersion - The requested target version.
   * @returns Pending migrations, sorted ascending.
   */
  private pendingMigrations(currentVersion: string, targetVersion: string): Migration[] {
    return this.migrations
      .filter((m) => {
        const gtCurrent = semverCompare(m.version, currentVersion) > 0;
        const leTarget = semverLte(m.version, targetVersion);
        return gtCurrent && leTarget;
      })
      .sort((a, b) => semverCompare(a.version, b.version));
  }

  /**
   * Back up `state.json` to `~/.linuxify/backups/pre-migration-<version>.json`.
   *
   * @param version - The migration version about to be applied.
   */
  private async backupState(version: string): Promise<void> {
    const backupsDir = join(dirname(this.stateStore.statePath), BACKUPS_DIRNAME);
    await ensureDir(backupsDir);
    const backupPath = join(backupsDir, `pre-migration-${version}.json`);
    // Use `copyFile` so we get a byte-for-byte copy of the on-disk state
    // (in case the in-memory state has unsaved mutations).
    if (await exists(this.stateStore.statePath)) {
      await copyFile(this.stateStore.statePath, backupPath);
      logger.debug('migration: state backed up', { version, backupPath });
    } else {
      // No state.json yet — write an empty-object backup so restore can
      // at least delete the file we're about to create.
      await writeJson(backupPath, {});
      logger.debug('migration: no state.json; wrote empty backup', { version, backupPath });
    }
  }

  /**
   * Restore `state.json` from the pre-migration backup by copying the
   * backup file verbatim over `state.json`. Bypasses the state store's
   * `save()` so the restore is byte-for-byte (the schema may have been
   * different at backup time; we want to restore exactly what was there).
   *
   * @param version - The migration version whose backup should be restored.
   */
  private async restoreBackup(version: string): Promise<void> {
    const backupPath = join(
      dirname(this.stateStore.statePath),
      BACKUPS_DIRNAME,
      `pre-migration-${version}.json`,
    );
    if (!(await exists(backupPath))) {
      logger.warn('migration: no backup to restore', { version, backupPath });
      return;
    }
    try {
      await copyFile(backupPath, this.stateStore.statePath);
      logger.info('migration: state restored from backup', { version, backupPath });
    } catch (err) {
      logger.error('migration: failed to restore backup', {
        version,
        backupPath,
        error: (err as Error).message,
      });
    }
  }
}

// Re-export the helpers for tests; not part of the public API surface.
export { BACKUPS_DIRNAME };
