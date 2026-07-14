/**
 * Public API surface for the `doctor` module.
 *
 * @module linuxify/doctor
 *
 * Re-exports the engine, output formatters, profile definitions, type
 * definitions, and the check registry. The factory {@link createDoctorEngine}
 * returns a {@link DoctorEngine} pre-loaded with every built-in check.
 *
 * Downstream subsystems should import from here (`../doctor` or
 * `linuxify/doctor`) rather than reaching into individual files, so internal
 * layout changes don't ripple.
 *
 * @packageDocumentation
 */

import { ALL_CHECKS } from './checks/index.js';

import { DoctorEngine } from './engine.js';

export { DoctorEngine } from './engine.js';
export type { DoctorEngineOptions } from './engine.js';
export { partitionWaves, computeSummary, formatReport, resolveFormat } from './engine.js';

export {
  formatHuman,
  formatJson,
  formatMarkdown,
  formatQuiet,
  DOCTOR_JSON_SCHEMA,
} from './output.js';

export {
  PROFILE_CHECKS,
  PROFILE_TIMEOUT_MS,
  ALL_PROFILES,
  isBuiltinProfile,
  checksForProfile,
  timeoutForProfile,
} from './profiles.js';

export {
  ALL_CHECKS,
  registerCheck,
  registerAll,
  getCheck,
  listChecks,
  _clearCheckRegistryForTests,
} from './checks/index.js';

// Re-export individual check objects so callers can build custom engines
// with a subset of built-in checks.
export { hostTermuxCheck } from './checks/host-termux.js';
export { hostAndroidCheck } from './checks/host-android.js';
export { hostArchCheck } from './checks/host-arch.js';
export { hostStorageCheck } from './checks/host-storage.js';
export { hostMemoryCheck } from './checks/host-memory.js';
export { bootstrapCompletedCheck } from './checks/bootstrap-completed.js';
export { distroInstalledCheck } from './checks/distro-installed.js';
export { distroBootableCheck } from './checks/distro-bootable.js';
export { runtimeNodeCheck } from './checks/runtime-node.js';
export { runtimePythonCheck } from './checks/runtime-python.js';
export { runtimeGitCheck } from './checks/runtime-git.js';
export { pathLinuxifyBinCheck } from './checks/path-linuxify-bin.js';
export { pathTermuxPrefixCheck } from './checks/path-termux-prefix.js';
export { pathProotCheck } from './checks/path-proot.js';
export { compatPlatformCheck } from './checks/compat-platform.js';
export { networkDnsCheck } from './checks/network-dns.js';
export { networkGithubCheck } from './checks/network-github.js';
export { networkNpmCheck } from './checks/network-npm.js';

export type {
  DoctorStatus,
  DoctorCategory,
  DoctorProfile,
  DoctorResult,
  DoctorCheck,
  DoctorContext,
  DoctorOptions,
  DoctorReport,
} from './types.js';

/**
 * Cached default engine. Lazily created on first call to
 * {@link createDoctorEngine} so importing the doctor module does not pay
 * the cost of constructing the engine (and so tests can swap the engine
 * by mutating this variable via `_resetDoctorEngineForTests`).
 */
let _defaultEngine: DoctorEngine | undefined;

/**
 * Create (or return the cached) default {@link DoctorEngine}, pre-loaded
 * with every built-in check from {@link ALL_CHECKS}.
 *
 * The engine is constructed with the default concurrency (4). Callers
 * needing a different concurrency or a custom check list should construct
 * their own `new DoctorEngine({ checks, concurrency })`.
 *
 * @returns A shared {@link DoctorEngine} instance.
 */
export function createDoctorEngine(): DoctorEngine {
  if (!_defaultEngine) {
    _defaultEngine = new DoctorEngine({ checks: ALL_CHECKS });
  }
  return _defaultEngine;
}

/**
 * Reset the cached default engine. Exported for tests that want to
 * reconstruct the engine after registering plugin checks or swapping the
 * check list; not part of the public doctor API surface.
 *
 * @internal
 */
export function _resetDoctorEngineForTests(): void {
  _defaultEngine = undefined;
}
