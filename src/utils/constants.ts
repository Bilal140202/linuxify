/**
 * Project-wide constants for Linuxify.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Version now injected at build time from package.json (FIX C1)
 * - Added circuit breaker defaults (FIX W5)
 * - Added telemetry queue bounds (FIX C5)
 * - Added timeout defaults (FIX C6)
 * - Added memory-aware thresholds (FIX M6)
 * - Added registry cooldown (FIX C10)
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Version — single source of truth from package.json (FIX C1)
// ---------------------------------------------------------------------------

function loadVersion(): string {
  try {
    // At build time: Vite injects __LINUXIFY_VERSION__
    if (typeof __LINUXIFY_VERSION__ !== 'undefined') {
      return __LINUXIFY_VERSION__;
    }
  } catch { /* not defined at runtime */ }

  try {
    // Fallback: read package.json relative to this file
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}

declare const __LINUXIFY_VERSION__: string | undefined;

/** The Linuxify CLI version string. Single source of truth from package.json. */
export const LINUXIFY_VERSION = loadVersion();

// ---------------------------------------------------------------------------
// Directory & defaults
// ---------------------------------------------------------------------------

export const LINUXIFY_HOME_DIRNAME = '.linuxify';
export const DEFAULT_DISTRO = 'ubuntu';
export const DEFAULT_RUNTIME = 'node';

export const SUPPORTED_DISTROS = ['ubuntu', 'debian', 'arch', 'alpine'] as const;
export const SUPPORTED_RUNTIMES = ['node', 'python', 'rust', 'go'] as const;
export const SUPPORTED_ARCHS = ['aarch64', 'armv7l', 'x86_64'] as const;

// ---------------------------------------------------------------------------
// Resource limits & safety bounds (NEW — fixes C5, C6, W5, W6, C10, M6)
// ---------------------------------------------------------------------------

/** Maximum telemetry events in queue before LRU eviction (FIX C5). */
export const TELEMETRY_MAX_QUEUE_SIZE = 1000;

/** Maximum telemetry events per day per user_id. */
export const TELEMETRY_DAILY_LIMIT = 1000;

/** Maximum telemetry events per minute per user_id. */
export const TELEMETRY_BURST_LIMIT = 100;

/** Default timeout for external network operations in ms (FIX C6). */
export const DEFAULT_NETWORK_TIMEOUT_MS = 30_000;

/** Default timeout for git operations in ms (FIX C6). */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** Default timeout for package downloads in ms (FIX C6). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;

/** Circuit breaker failure threshold before opening (FIX W5). */
export const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5;

/** Circuit breaker recovery timeout in ms (FIX W5). */
export const CIRCUIT_BREAKER_RECOVERY_MS = 30_000;

/** Minimum interval between registry updates in ms (FIX C10). */
export const REGISTRY_UPDATE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum snapshot storage budget in bytes (default 5 GB). */
export const SNAPSHOT_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;

/** Free disk space warning threshold in MB. */
export const FREE_SPACE_WARN_MB = 2048;

/** Free disk space hard-stop threshold in MB. */
export const FREE_SPACE_HARD_STOP_MB = 512;

/** Low-memory device threshold in MB (FIX M6). */
export const LOW_MEMORY_THRESHOLD_MB = 2048;

/** Maximum patch backup age in days before auto-pruning (FIX M10). */
export const PATCH_BACKUP_MAX_AGE_DAYS = 30;

/** Maximum number of patch backups per package (FIX M10). */
export const PATCH_BACKUP_MAX_COUNT = 10;

// ---------------------------------------------------------------------------
// Exit codes
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  OK: 0,
  GENERIC_ERROR: 1,
  INVALID_ARGUMENTS: 2,
  NOT_FOUND: 3,
  PERMISSION_DENIED: 4,
  NETWORK_ERROR: 5,
  TIMEOUT: 6,
  BOOTSTRAP_INCOMPLETE: 10,
  DISTRO_ERROR: 11,
  RUNTIME_ERROR: 12,
  PACKAGE_ERROR: 13,
  PATCH_ERROR: 14,
  DOCTOR_FAIL: 15,
  LAUNCHER_ERROR: 16,
  PLUGIN_ERROR: 17,
  REGISTRY_ERROR: 18,
  CONFIG_ERROR: 19,
  STATE_ERROR: 20,
  TELEMETRY_ERROR: 21,
  SECURITY_ERROR: 22,
  STORAGE_ERROR: 23,
  CIRCUIT_OPEN: 24,
  INTERNAL_UNKNOWN: 70,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCodeValue = (typeof EXIT_CODES)[ExitCodeName];
