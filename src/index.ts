/**
 * Public programmatic API for Linuxify.
 *
 * @module linuxify
 *
 * This barrel re-exports the parts of the CLI layer that downstream programs
 * (and tests) may want to import directly: the {@link runCli} entry point,
 * the {@link Output} formatter, the {@link CommandContext} bundle, and the
 * per-subsystem public types (config, state, packages, doctor, patcher,
 * registry, plugins, runtimes, distros, bootstrap, launcher, utils).
 *
 * Importing from `linuxify` (this module) gives callers the full surface;
 * importing from a specific subpath (e.g. `linuxify/config`) gives a
 * narrower dependency for tree-shaking.
 *
 * @packageDocumentation
 */

// CLI layer.
export { runCli } from './cli/router.js';
export { Output, type OutputOptions } from './cli/output.js';
export {
  createCommandContext,
  type CommandContext,
  type CreateCommandContextOptions,
  type TelemetryClient,
} from './cli/context.js';
export {
  GLOBAL_FLAGS,
  extractGlobalFlags,
  type GlobalFlagSpec,
  type ParsedGlobalFlags,
  DEFAULT_PARSED_FLAGS,
} from './cli/flags.js';

// Utils (the leaf of the dependency DAG; safe to re-export).
export {
  EXIT_CODES,
  LINUXIFY_VERSION,
  DEFAULT_DISTRO,
  DEFAULT_RUNTIME,
  SUPPORTED_DISTROS,
  SUPPORTED_RUNTIMES,
  SUPPORTED_ARCHS,
  type ExitCodeName,
  type ExitCodeValue,
} from './utils/constants.js';
export {
  LinuxifyError,
  BootstrapError,
  DistroError,
  RuntimeError,
  PackageError,
  PatcherError,
  DoctorError,
  LauncherError,
  PluginError,
  RegistryError,
  ConfigError,
  StateError,
  TelemetryError,
  SecurityError,
  NetworkError,
  StorageError,
  wrapError,
  isLinuxifyError,
  type ErrorCode,
  type LinuxifyErrorInit,
} from './utils/errors.js';
export { logger, createLogger, flushLogs, type Logger } from './utils/log.js';

// Config.
export { loadConfig, deepMerge, type LoadConfigOptions, DEFAULT_CONFIG } from './config/index.js';
export { ConfigSchema, type Config } from './config/index.js';

// State.
export { StateStore, defaultState, getStatePath, type State } from './state/index.js';

// Bootstrap.
export {
  bootstrap,
  stages,
  isBootstrapComplete,
  isLinuxifyHomePresent,
  type BootstrapOptions,
  type BootstrapResult,
  type BootstrapContext,
  type Stage,
  type StageId,
  type StageResult,
} from './bootstrap/index.js';

// Distros.
export {
  getDistro,
  listDistros,
  registerDistro,
  getActiveDistroName,
  registerBuiltInDistros,
  ubuntuProvider,
  debianProvider,
  archProvider,
  alpineProvider,
  type DistroProvider,
  type DistroInfo,
  type InstallOpts,
  type ExecOpts,
  type ShellOpts,
  type ExecResult,
} from './distros/index.js';

// Runtimes.
export {
  getRuntime,
  listRuntimes,
  registerRuntime,
  unregisterRuntime,
  registerBuiltInRuntimes,
  resetRuntimes,
  NodeRuntimeProvider,
  PythonRuntimeProvider,
  RustRuntimeProvider,
  GoRuntimeProvider,
  type RuntimeProvider,
  type InstalledRuntime,
} from './runtimes/index.js';

// Packages.
export {
  PackageManager,
  parsePackageYaml,
  loadPackageFromFile,
  lintPackage,
  lint,
  PackageSchema,
  type PackageDefinition,
  type InstallOpts as PackageInstallOpts,
  type InstallResult,
  type UninstallOpts,
  type UninstallResult,
  type PackageManagerOptions,
} from './packages/index.js';

// Patcher.
export {
  PatcherEngine,
  getPatcherEngine,
  verifyPatch,
  type PatchContext,
  type PatchResult,
  type ApplyPatchesOptions,
  type PatchType,
  type PatchDefinition,
} from './patcher/index.js';

// Launcher.
export {
  LauncherGenerator,
  getLauncherGenerator,
  standardTemplate,
  directTemplate,
  customTemplate,
  type LauncherSpec,
  type LauncherResult,
  type LauncherVariant,
} from './launcher/index.js';

// Doctor.
export {
  DoctorEngine,
  createDoctorEngine,
  formatReport,
  resolveFormat,
  ALL_PROFILES,
  isBuiltinProfile,
  checksForProfile,
  timeoutForProfile,
  ALL_CHECKS,
  type DoctorCheck,
  type DoctorContext,
  type DoctorOptions,
  type DoctorReport,
  type DoctorResult,
  type DoctorProfile,
  type DoctorStatus,
} from './doctor/index.js';

// Registry.
export {
  createRegistryClient,
  GitRegistryClient,
  RegistryCache,
  searchAndRank,
  fuzzyMatch,
  scorePackage,
  type RegistryClient,
  type RegistryEntry,
  type RegistryMetadata,
  type SearchResult,
  type SearchOpts,
} from './registry/index.js';

// Plugins.
export {
  createPluginSystem,
  PluginLoader,
  PluginRegistry,
  HookDispatcher,
  validateManifest,
  lintManifest,
  PluginManifestSchema,
  type PluginSystem,
  type PluginManifest,
  type Plugin,
  type LinuxifyContext,
} from './plugins/index.js';
