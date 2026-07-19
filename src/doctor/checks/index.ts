/**
 * Doctor check registry.
 *
 * @module linuxify/doctor/checks
 *
 * Aggregates every built-in {@link DoctorCheck} into a single `ALL_CHECKS`
 * array and exposes lookup / registration helpers. Plugins register custom
 * checks via {@link registerCheck}; the engine consults the registry when
 * filtering by profile or by `--check <id>`.
 *
 * The registry is process-global and append-only within a single CLI
 * invocation. Built-in checks are registered at module import time; plugin
 * checks are registered at load time by the plugin loader. Re-registering
 * an ID overwrites the prior entry (so plugins can override built-ins).
 *
 * @packageDocumentation
 */

import { logger } from '../../utils/log.js';
import type { DoctorCheck } from '../types.js';

import { bootstrapCompletedCheck } from './bootstrap-completed.js';
import { compatPlatformCheck } from './compat-platform.js';
import { distroBootableCheck } from './distro-bootable.js';
import { distroInstalledCheck } from './distro-installed.js';
import { hostAndroidCheck } from './host-android.js';
import { hostArchCheck } from './host-arch.js';
import { hostMemoryCheck } from './host-memory.js';
import { hostStorageCheck } from './host-storage.js';
import { hostTermuxCheck } from './host-termux.js';
import { networkDnsCheck } from './network-dns.js';
import { networkGithubCheck } from './network-github.js';
import { networkNpmCheck } from './network-npm.js';
import { pathLinuxifyBinCheck } from './path-linuxify-bin.js';
import { pathProotCheck } from './path-proot.js';
import { pathProotDistroUsableCheck } from './path-proot-distro-usable.js';
import { pathTermuxPrefixCheck } from './path-termux-prefix.js';
import { runtimeGitCheck } from './runtime-git.js';
import { runtimeNodeCheck } from './runtime-node.js';
import { runtimePythonCheck } from './runtime-python.js';

/**
 * Array of every built-in doctor check, in category order:
 * host → bootstrap → distro → runtime → path → compat → network.
 *
 * The engine re-orders by wave before running, so the order here is for
 * human readability (the doctor report's `results` array appears in wave
 * order, not in this array's order).
 */
export const ALL_CHECKS: DoctorCheck[] = [
  // host
  hostTermuxCheck,
  hostAndroidCheck,
  hostArchCheck,
  hostStorageCheck,
  hostMemoryCheck,
  // bootstrap
  bootstrapCompletedCheck,
  // distro
  distroInstalledCheck,
  distroBootableCheck,
  // runtime
  runtimeNodeCheck,
  runtimePythonCheck,
  runtimeGitCheck,
  // path
  pathLinuxifyBinCheck,
  pathTermuxPrefixCheck,
  pathProotCheck,
  pathProotDistroUsableCheck,
  // compat
  compatPlatformCheck,
  // network
  networkDnsCheck,
  networkGithubCheck,
  networkNpmCheck,
];

/**
 * Internal registry map. Process-global; populated by {@link registerAll}
 * at module import time and by plugins via {@link registerCheck}.
 *
 * Keys are check IDs (case-sensitive). Re-registering an ID overwrites the
 * prior entry (so plugins can override built-ins).
 */
const REGISTRY = new Map<string, DoctorCheck>();

/**
 * Register a single doctor check. Re-registering an existing ID overwrites
 * the prior entry (so plugins can override built-ins) and logs a warning.
 *
 * @param check - The check to register. Its `id` is used as the registry key.
 */
export function registerCheck(check: DoctorCheck): void {
  if (!check.id) {
    throw new Error('Cannot register a doctor check with an empty id');
  }
  if (REGISTRY.has(check.id)) {
    logger.warn('doctor check already registered; overwriting', { id: check.id });
  }
  REGISTRY.set(check.id, check);
  logger.debug('doctor check registered', { id: check.id, category: check.category });
}

/**
 * Register every built-in check in {@link ALL_CHECKS}. Called at module
 * import time; safe to call again (subsequent calls are a no-op because
 * the IDs are already in the registry).
 */
export function registerAll(): void {
  for (const check of ALL_CHECKS) {
    registerCheck(check);
  }
}

/**
 * Look up a registered check by ID.
 *
 * @param id - Check ID (case-sensitive).
 * @returns The registered check, or `undefined` if not found.
 */
export function getCheck(id: string): DoctorCheck | undefined {
  return REGISTRY.get(id);
}

/**
 * List all registered checks in insertion order.
 *
 * @returns A new array (callers may mutate without affecting the registry).
 */
export function listChecks(): DoctorCheck[] {
  return Array.from(REGISTRY.values());
}

/**
 * Clear the registry. Exported for tests so each test file can start with a
 * clean slate; not part of the public doctor API surface.
 *
 * @internal
 */
export function _clearCheckRegistryForTests(): void {
  REGISTRY.clear();
}

// Auto-register on import. Importing `linuxify/doctor/checks` (or anything
// that re-exports it) is sufficient to make `getCheck('host.termux')` work.
registerAll();
