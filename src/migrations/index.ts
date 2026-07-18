/**
 * Public API surface for the `migrations` module.
 *
 * @module linuxify/migrations
 *
 * Re-exports the {@link MigrationRunner}, the {@link MigrationRegistry},
 * the built-in migrations, the migration types, and a factory
 * ({@link createMigrationRunner}) that wires the runner to the default
 * state store with every built-in migration registered.
 *
 * Downstream subsystems (the CLI's `linuxify self-update` command, the
 * doctor's migration-status check) should import from here (`../migrations`
 * or `linuxify/migrations`) rather than reaching into individual files.
 *
 * @packageDocumentation
 */

import { getStatePath, StateStore } from '../state/index.js';

import { MigrationRegistry, registerBuiltInMigrations, BUILT_IN_MIGRATIONS } from './registry.js';
import { MigrationRunner } from './runner.js';

export { MigrationRegistry, registerBuiltInMigrations, BUILT_IN_MIGRATIONS } from './registry.js';
export { MigrationRunner, BACKUPS_DIRNAME } from './runner.js';
export type {
  Migration,
  MigrationResult,
  MigrationRunnerOptions,
  MigrationRegistryOptions,
} from './types.js';

/**
 * Cached default registry. Lazily created on first call to
 * {@link createMigrationRunner} so importing the migrations module does
 * not pay the cost of constructing the registry (and so tests can swap the
 * registry via `_resetMigrationRunnerForTests`).
 */
let _defaultRegistry: MigrationRegistry | undefined;

/**
 * Create (or return the cached) default {@link MigrationRegistry},
 * pre-populated with every built-in migration from
 * {@link BUILT_IN_MIGRATIONS}.
 *
 * Tests that need a custom migration set should construct their own
 * `new MigrationRegistry({ migrations: [...] })`.
 *
 * @returns A shared {@link MigrationRegistry} instance.
 */
export function createMigrationRegistry(): MigrationRegistry {
  if (!_defaultRegistry) {
    _defaultRegistry = new MigrationRegistry();
    registerBuiltInMigrations(_defaultRegistry);
  }
  return _defaultRegistry;
}

/**
 * Create (or return the cached) default {@link MigrationRunner}, wired to
 * the default {@link StateStore} (pointed at {@link getStatePath}) and
 * pre-populated with every built-in migration.
 *
 * Tests that need a custom state store or migration set should construct
 * their own `new MigrationRunner({ stateStore, migrations: [...] })`.
 *
 * @returns A {@link MigrationRunner} instance.
 */
export function createMigrationRunner(): MigrationRunner {
  const registry = createMigrationRegistry();
  const stateStore = new StateStore(getStatePath());
  return new MigrationRunner({ stateStore, migrations: registry.list() });
}

/**
 * Reset the cached default registry. Exported for tests that want to
 * reconstruct the registry after registering custom migrations; not part
 * of the public migrations API surface.
 *
 * @internal
 */
export function _resetMigrationRunnerForTests(): void {
  _defaultRegistry = undefined;
}
