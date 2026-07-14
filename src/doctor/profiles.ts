/**
 * Doctor profile definitions.
 *
 * @module linuxify/doctor/profiles
 *
 * Profiles select a subset of checks. They are chosen via `--profile <name>`
 * and the default is `standard`. The built-in profiles are documented in
 * `docs/07-doctor/doctor-engine.md` §7.
 *
 * The check IDs listed here MUST match the `id` field of a registered
 * {@link DoctorCheck}. Unknown IDs are filtered out at run time (the engine
 * logs a debug message and skips them), so a profile may safely reference a
 * check that is not registered in a given build (e.g. a package-specific
 * plugin check that is not installed).
 *
 * @packageDocumentation
 */

import type { DoctorProfile } from './types.js';

/**
 * Maps each profile name to the ordered list of check IDs that belong to it.
 *
 * The order is preserved by the engine when it filters checks: results in
 * the report appear in the profile's declared order (modulo wave reordering,
 * which the engine applies after profile filtering).
 */
export const PROFILE_CHECKS: Record<DoctorProfile, string[]> = {
  /**
   * Quick smoke test, ≤1s. Only the four most critical checks: bootstrap
   * completed, active distro installed, Node on PATH, linuxify bin on PATH.
   * Use this in `preRun` hooks and shell prompts where speed matters more
   * than completeness.
   */
  minimal: ['bootstrap.completed', 'distro.installed', 'runtime.node', 'path.linuxify_bin'],

  /**
   * Default daily-driver profile. Most `host.*`, `bootstrap.*`, the active
   * distro, all runtimes, all path checks, compatibility, and (when
   * packages are installed) per-package checks. Excludes the network wave
   * (use `deep` for that) and `host.no_root` (which is informational only).
   */
  standard: [
    'host.termux',
    'host.android',
    'host.arch',
    'host.storage',
    'host.memory',
    'bootstrap.completed',
    'distro.installed',
    'distro.bootable',
    'runtime.node',
    'runtime.python',
    'runtime.git',
    'path.linuxify_bin',
    'path.termux_prefix',
    'path.proot',
    'compat.platform',
  ],

  /**
   * Thorough check including network probes. Adds the `network.*` wave and
   * surfaces every check; intended for `linuxify doctor --profile deep` when
   * diagnosing a tricky issue.
   */
  deep: [
    'host.termux',
    'host.android',
    'host.arch',
    'host.storage',
    'host.memory',
    'bootstrap.completed',
    'distro.installed',
    'distro.bootable',
    'runtime.node',
    'runtime.python',
    'runtime.git',
    'path.linuxify_bin',
    'path.termux_prefix',
    'path.proot',
    'compat.platform',
    'network.dns',
    'network.github',
    'network.npm',
  ],

  /**
   * Subset checked before `linuxify init`. Only the host checks that
   * determine whether the device can even attempt bootstrap: Termux
   * installed, Android version, supported arch, free storage. No bootstrap
   * or distro checks (those would all fail before init).
   */
  'pre-flight': ['host.termux', 'host.android', 'host.arch', 'host.storage'],

  /**
   * Subset checked after `linuxify init` or `linuxify add`. Verifies the
   * post-bootstrap environment: bootstrap completed, active distro
   * installed and bootable, runtimes on PATH, linuxify bin on PATH, and
   * platform shim reports `linux` inside proot.
   */
  'post-install': [
    'bootstrap.completed',
    'distro.installed',
    'distro.bootable',
    'runtime.node',
    'runtime.python',
    'runtime.git',
    'path.linuxify_bin',
    'path.termux_prefix',
    'path.proot',
    'compat.platform',
  ],

  /**
   * CI profile. Same check set as `deep`, but the CLI elevates `warn` to
   * `fail` for exit-code purposes when `--ci` is passed. Used in Linuxify's
   * own CI pipeline and in user-side post-install verification steps.
   */
  ci: [
    'host.termux',
    'host.android',
    'host.arch',
    'host.storage',
    'host.memory',
    'bootstrap.completed',
    'distro.installed',
    'distro.bootable',
    'runtime.node',
    'runtime.python',
    'runtime.git',
    'path.linuxify_bin',
    'path.termux_prefix',
    'path.proot',
    'compat.platform',
    'network.dns',
    'network.github',
    'network.npm',
  ],
};

/**
 * Default per-check timeout (ms) for each profile. The `deep` and `ci`
 * profiles get a longer budget because they include network probes and
 * per-package binary execution checks; `minimal` and `pre-flight` get a
 * shorter budget because they are made up entirely of cheap host probes.
 *
 * A specific check can override its own timeout by passing `timeoutMs` to
 * `exec` / `isReachable`; this value is the outer bound that the engine
 * enforces via `Promise.race`.
 */
export const PROFILE_TIMEOUT_MS: Record<DoctorProfile, number> = {
  minimal: 3000,
  standard: 5000,
  deep: 15000,
  'pre-flight': 3000,
  'post-install': 5000,
  ci: 15000,
};

/**
 * List of all built-in profile names. Stable, ordered from fastest to most
 * thorough. Useful for `linuxify doctor --profile=list` and for validation.
 *
 * Frozen with `Object.freeze` so callers cannot mutate the shared array.
 */
export const ALL_PROFILES: readonly DoctorProfile[] = Object.freeze([
  'minimal',
  'standard',
  'deep',
  'pre-flight',
  'post-install',
  'ci',
]);

/**
 * Return whether `name` is a known built-in profile.
 *
 * @param name - Candidate profile name.
 * @returns `true` if `name` is one of the built-in profiles.
 */
export function isBuiltinProfile(name: string): name is DoctorProfile {
  return ALL_PROFILES.includes(name as DoctorProfile);
}

/**
 * Resolve a profile name to its check ID list. Returns the `standard` list
 * for unknown names so callers always get a non-empty array (the engine
 * logs a warning when this fallback fires).
 *
 * @param name - Profile name (case-sensitive).
 * @returns The list of check IDs belonging to the profile.
 */
export function checksForProfile(name: DoctorProfile): string[] {
  return PROFILE_CHECKS[name] ?? PROFILE_CHECKS.standard;
}

/**
 * Resolve a profile name to its per-check timeout in milliseconds.
 *
 * @param name - Profile name.
 * @returns Timeout in milliseconds.
 */
export function timeoutForProfile(name: DoctorProfile): number {
  return PROFILE_TIMEOUT_MS[name] ?? PROFILE_TIMEOUT_MS.standard;
}
