/**
 * Migration subsystem types.
 *
 * @module linuxify/migrations/types
 *
 * The migration subsystem applies state-shape changes when the user upgrades
 * Linuxify across versions that introduce breaking changes to `state.json`,
 * `config.toml`, or the on-disk layout under `~/.linuxify/`. Migrations are
 * run by the self-update orchestrator (see `docs/14-cicd/release-pipeline.md`
 * §8 "Migration Hooks") after the new binary is downloaded and verified but
 * before it becomes the active binary.
 *
 * Each migration is identified by the **target** version it migrates TO. The
 * runner filters the registered migrations to those whose `version` is
 * greater than the current `state.linuxify_version` and less than or equal
 * to the requested target, then applies them in ascending semver order.
 *
 * Atomicity guarantees (see `docs/22-operations/migration-guide.md` §8):
 *   - Before applying any migration, the runner backs up `state.json` to
 *     `~/.linuxify/backups/pre-migration-<version>.json`.
 *   - If a migration throws, the runner attempts `down()` (if defined) to
 *     undo the partial application, then restores the backup.
 *   - The `state.linuxify_version` field is updated only after every
 *     migration has applied successfully.
 *
 * @packageDocumentation
 */

import type { State } from '../state/index.js';

/**
 * A single migration. One of these is registered per released version that
 * requires a state-shape change.
 *
 * The `version` field is the **target** version this migration migrates TO.
 * The runner applies migrations in ascending semver order, so a migration
 * for `0.2.0` runs before a migration for `0.3.0`.
 *
 * `up()` must be idempotent: running the same migration twice must produce
 * the same result as running it once (see release-pipeline.md §8). This is
 * critical because a user who self-updates, rolls back, then self-updates
 * again must not have the migration applied twice with side effects.
 *
 * `down()` is optional. When present, the runner calls it to undo the
 * migration on failure of a later migration in the same run. When absent,
 * the runner falls back to restoring the pre-migration backup.
 */
export interface Migration {
  /** Target version this migration migrates TO (e.g. `0.2.0`). Must be a valid semver. */
  readonly version: string;
  /** Human-readable one-line description, surfaced by `linuxify self-update --dry-run`. */
  readonly description: string;
  /**
   * Apply the migration. Receives the current state and returns the
   * migrated state. MUST be idempotent.
   *
   * The migration MUST NOT modify the filesystem outside `~/.linuxify/`
   * (see release-pipeline.md §8). Migrations that need to move files under
   * `~/.linuxify/` should do so via the standard `utils/fs` helpers.
   *
   * @param state - The pre-migration state. Implementations MUST NOT mutate
   *   this object; return a new (structured-cloned) object instead.
   * @returns The post-migration state.
   * @throws Any error — the runner catches, logs, and rolls back.
   */
  up(state: State): Promise<State>;
  /**
   * Optional rollback. Called by the runner when a LATER migration in the
   * same run fails, to undo this migration's effects.
   *
   * When `down` is absent, the runner falls back to restoring the
   * pre-migration `state.json` backup. Implementing `down` is recommended
   * for migrations that move files (filesystem effects are not captured by
   * the state backup).
   *
   * @param state - The post-migration state (the state that needs rolling back).
   * @returns The rolled-back state.
   */
  down?(state: State): Promise<State>;
}

/**
 * Result of {@link MigrationRunner.run}. Captures the from/to versions,
 * the list of migrations applied (in order), success/failure, and any
 * error message on failure.
 */
export interface MigrationResult {
  /** Version the run started from (`state.linuxify_version` before the run). */
  fromVersion: string;
  /** Version the run targeted. Equal to `state.linuxify_version` after a successful run. */
  toVersion: string;
  /** Versions of the migrations applied, in execution order. Empty if none ran. */
  migrationsApplied: string[];
  /** `true` if every migration applied without throwing. */
  success: boolean;
  /** Error message if `success` is `false`; `undefined` otherwise. */
  error?: string;
  /** Wall-clock duration of the entire run in milliseconds. */
  durationMs: number;
}

/**
 * Constructor options for {@link MigrationRunner}.
 */
export interface MigrationRunnerOptions {
  /** State store, used to load/save `state.json` and to find the backups dir. */
  readonly stateStore: import('../state/index.js').StateStore;
  /** Migrations to apply, in any order — the runner sorts by semver. */
  readonly migrations: Migration[];
}

/**
 * Constructor options for the migration registry.
 */
export interface MigrationRegistryOptions {
  /**
   * Optional initial migrations. The registry sorts them by semver on
   * `list()`; insertion order is not preserved.
   */
  readonly migrations?: Migration[];
}
