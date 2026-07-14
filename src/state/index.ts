/**
 * Public API for the `state` module.
 *
 * Re-exports the Zod schemas and inferred types from `schema.ts` and the
 * `StateStore` class plus helper functions from `store.ts`. Downstream
 * subsystems should import exclusively from here:
 *
 * ```ts
 * import { StateStore, getStatePath, StateSchema, type State } from '../state/index.js';
 * ```
 *
 * @packageDocumentation
 */

export {
  StateSchema,
  DistroInstallSchema,
  RuntimeInstallSchema,
  PackageInstallSchema,
  PatchApplicationSchema,
  BootstrapProgressSchema,
  LastDoctorRunSchema,
  TelemetrySchema,
  PluginInstallSchema,
} from './schema.js';

export type {
  State,
  DistroInstall,
  RuntimeInstall,
  PackageInstall,
  PatchApplication,
  BootstrapProgress,
  LastDoctorRun,
  Telemetry,
  PluginInstall,
} from './schema.js';

export { StateStore, defaultState, getStatePath } from './store.js';
