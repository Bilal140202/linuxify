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
  DockerContainerSchema,
  DockerStateSchema,
  DEFAULT_DOCKER_STATE,
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
  DockerContainer,
  DockerState,
} from './schema.js';

export { StateStore, defaultState, getStatePath } from './store.js';
