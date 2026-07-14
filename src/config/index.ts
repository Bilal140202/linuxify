/**
 * Public API surface for the `config` module.
 *
 * Re-exports the Zod schema, inferred `Config` type, default config object,
 * and the {@link loadConfig} loader. Subsystem code should import from here
 * (`../config` or `linuxify/config`) rather than reaching into individual
 * files, so internal layout changes don't ripple.
 *
 * @packageDocumentation
 */

export { loadConfig, deepMerge } from './loader.js';
export type { LoadConfigOptions } from './loader.js';

export { DEFAULT_CONFIG } from './defaults.js';

export {
  ConfigSchema,
  ProfileSchema,
  ProjectLocalSchema,
  BootstrapSchema,
  DistroSchema,
  RuntimeSchema,
  TelemetrySchema,
  SyncSchema,
  RegistrySchema,
  LoggingSchema,
  I18nSchema,
  ExperimentalSchema,
  PROJECT_LOCAL_ALLOWED_SECTIONS,
  PROJECT_LOCAL_FORBIDDEN_SECTIONS,
} from './schema.js';

export type {
  Config,
  ProfileConfig,
  BootstrapConfig,
  DistroConfig,
  RuntimeConfig,
  TelemetryConfig,
  SyncConfig,
  RegistryConfig,
  LoggingConfig,
  I18nConfig,
  ExperimentalConfig,
} from './schema.js';
