/**
 * Migration registry — holds the registered migrations, sorted by version.
 *
 * @module linuxify/migrations/registry
 *
 * The registry is a thin wrapper around a `Map<version, Migration>` with
 * insertion validation (semver-parseable versions, no duplicate versions).
 * The runner queries the registry via {@link list} (sorted ascending by
 * semver) and {@link get} (lookup by version).
 *
 * Built-in migrations are registered at module import time by
 * {@link registerBuiltInMigrations}. Plugin-registered migrations can be
 * added at runtime via {@link MigrationRegistry.register}.
 *
 * @packageDocumentation
 */

import { valid as semverValid, compare as semverCompare } from 'semver';

import { LinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';

import type { Migration, MigrationRegistryOptions } from './types.js';

// ---------------------------------------------------------------------------
// Built-in migrations
// ---------------------------------------------------------------------------

/**
 * Built-in `0.1.0` migration. The initial release version. No state-shape
 * changes are needed (this is the version the state schema was authored
 * against); the migration exists so that a fresh install on v0.1.0 has a
 * migration to "apply" on first self-update, exercising the runner.
 *
 * Idempotent: a no-op.
 */
const migration_0_1_0: Migration = {
  version: '0.1.0',
  description: 'Initial release — no state changes required.',
  up: async (state) => state,
};

/**
 * Built-in `0.2.0` migration. Placeholder for the first planned minor
 * release. Per `docs/22-operations/migration-guide.md` §8, the actual
 * migration logic is added per-release when the state shape changes; this
 * stub exists so the registry has more than one entry and the runner can
 * be exercised end-to-end in tests.
 *
 * Idempotent: a no-op for now.
 */
const migration_0_2_0: Migration = {
  version: '0.2.0',
  description: 'Placeholder for v0.2.0 state-shape changes (no-op in alpha).',
  up: async (state) => state,
  down: async (state) => state,
};

/**
 * All built-in migrations, in registration order. The registry sorts them
 * by semver on `list()`, so the order here does not matter, but keeping
 * them in ascending version order makes the file readable.
 */
export const BUILT_IN_MIGRATIONS: readonly Migration[] = [
  migration_0_1_0,
  migration_0_2_0,
];

// ---------------------------------------------------------------------------
// MigrationRegistry
// ---------------------------------------------------------------------------

/**
 * Registry of migrations. Holds the registered migrations keyed by version
 * (semver). Provides `list()` (sorted ascending) and `get(version)` (lookup).
 *
 * One registry instance is typically created per CLI invocation and shared
 * across the runner and the `linuxify self-update --dry-run` preview. The
 * registry is append-only within a single process: once a migration is
 * registered, it cannot be unregistered (a process is short-lived).
 */
export class MigrationRegistry {
  /** Internal map: version → migration. */
  private readonly migrations = new Map<string, Migration>();

  /**
   * @param opts - Optional initial migrations.
   */
  constructor(opts: MigrationRegistryOptions = {}) {
    if (opts.migrations) {
      for (const m of opts.migrations) {
        this.register(m);
      }
    }
  }

  /**
   * Register a migration.
   *
   * @param migration - The migration to register. Its `version` must be a
   *   valid semver and must not already be registered.
   * @throws {LinuxifyError} with code `E_MIGRATION_INVALID_VERSION` if
   *   `migration.version` is not a valid semver.
   * @throws {LinuxifyError} with code `E_MIGRATION_DUPLICATE` if a migration
   *   with the same version is already registered.
   */
  register(migration: Migration): void {
    if (!migration || typeof migration.version !== 'string') {
      throw new LinuxifyError({
        code: 'E_MIGRATION_INVALID_VERSION',
        message: 'migration.version is required',
      });
    }
    if (semverValid(migration.version) === null) {
      throw new LinuxifyError({
        code: 'E_MIGRATION_INVALID_VERSION',
        message: `migration version '${migration.version}' is not a valid semver`,
        details: { version: migration.version },
      });
    }
    if (this.migrations.has(migration.version)) {
      throw new LinuxifyError({
        code: 'E_MIGRATION_DUPLICATE',
        message: `a migration for version '${migration.version}' is already registered`,
        details: { version: migration.version },
      });
    }
    this.migrations.set(migration.version, migration);
    logger.debug('migration registered', { version: migration.version });
  }

  /**
   * List all registered migrations, sorted ascending by semver.
   *
   * @returns A frozen array of migrations.
   */
  list(): Migration[] {
    return Array.from(this.migrations.values()).sort((a, b) =>
      semverCompare(a.version, b.version),
    );
  }

  /**
   * Look up a migration by version.
   *
   * @param version - The target version to look up.
   * @returns The migration, or `undefined` if no migration is registered
   *   for `version`.
   */
  get(version: string): Migration | undefined {
    return this.migrations.get(version);
  }

  /**
   * Returns the number of registered migrations. Useful for tests asserting
   * that all built-in migrations were registered.
   *
   * @returns The count.
   */
  get size(): number {
    return this.migrations.size;
  }
}

/**
 * Register every built-in migration on the given registry. Called by
 * `createMigrationRunner` (see `./index.ts`) so the runner has the full
 * built-in set. Plugin authors may call this explicitly if they need to
 * ensure built-ins are present before registering custom migrations.
 *
 * @param registry - The registry to populate.
 */
export function registerBuiltInMigrations(registry: MigrationRegistry): void {
  for (const m of BUILT_IN_MIGRATIONS) {
    // Use `register` only if not already present, so this is idempotent
    // across multiple calls (the registry throws on duplicate; we silently
    // skip).
    if (!registry.get(m.version)) {
      registry.register(m);
    }
  }
}
