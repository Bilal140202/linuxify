// src/bootstrap/preflight.ts
//
// Pre-bootstrap environment checks.
//
// `runPreflight()` is invoked by bootstrap Stage 0 and may also be called
// directly by `linuxify doctor` to surface the same set of checks. The
// function runs every check (even if an earlier one fails) so the user sees
// the complete picture in a single invocation, then throws a single
// `BootstrapError` summarising the first fatal failure if any check has
// status `'fail'`.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 0) for the full spec.

import { BootstrapError } from '../utils/errors.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { isReachable } from '../utils/net.js';
import { exec, getArch, getTermuxPrefix, isAndroid, isTermux } from '../utils/process.js';

/**
 * Identifier of a single preflight check. Stable across releases so that
 * downstream tooling (telemetry, doctor JSON output) can refer to checks by
 * id rather than by display name.
 */
export type PreflightCheckId =
  | 'termux-source'
  | 'android-version'
  | 'free-space'
  | 'architecture'
  | 'no-root'
  | 'network';

/**
 * Status of a single check.
 *
 * - `'pass'` — check passed.
 * - `'warn'` — check produced a warning but bootstrap may proceed.
 * - `'fail'` — check failed and bootstrap must abort.
 * - `'skipped'` — check was skipped (e.g. network check under `--offline`).
 */
export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skipped';

/**
 * Result of a single preflight check.
 */
export interface PreflightCheckResult {
  /** Stable check id. */
  readonly id: PreflightCheckId;
  /** Outcome of the check. */
  readonly status: PreflightStatus;
  /** Human-readable summary, safe to print to a terminal. */
  readonly message: string;
  /** Optional structured payload for machine consumers (`--json`). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Aggregate result of `runPreflight()`. `ok` is `true` only when no check
 * has status `'fail'` (warnings do not block).
 */
export interface PreflightResult {
  /** True iff no check has status `'fail'`. */
  readonly ok: boolean;
  /** All check results, in execution order. */
  readonly checks: PreflightCheckResult[];
  /** Subset of `checks` with status `'warn'`. */
  readonly warnings: PreflightCheckResult[];
  /** Subset of `checks` with status `'fail'`. */
  readonly failures: PreflightCheckResult[];
}

/**
 * Options accepted by {@link runPreflight}. All fields optional.
 */
export interface PreflightOptions {
  /** Skip the network reachability check (e.g. `--offline`). */
  readonly offline?: boolean;
  /** Soft minimum free space in MiB; below this, emit a warning. Default 2048. */
  readonly minFreeSpaceMb?: number;
  /** Hard minimum free space in MiB; below this, fail. Default 500. */
  readonly hardMinFreeSpaceMb?: number;
  /** Network endpoints to probe. Default: Cloudflare + Ubuntu + Debian CDNs. */
  readonly networkEndpoints?: readonly string[];
  /** Per-endpoint TCP connect timeout in ms. Default 5000. */
  readonly networkTimeoutMs?: number;
  /** Minimum required Termux meta-package version. Default '0.118'. */
  readonly minTermuxVersion?: string;
  /** Minimum required Android API level. Default 28 (Android 9). */
  readonly minAndroidApiLevel?: number;
}

const DEFAULT_MIN_FREE_SPACE_MB = 2048;
const DEFAULT_HARD_MIN_FREE_SPACE_MB = 500;
const DEFAULT_NETWORK_ENDPOINTS = [
  'https://cdn.cloudflare.com',
  'https://cdimage.ubuntu.com',
  'https://deb.debian.org',
] as const;
const DEFAULT_NETWORK_TIMEOUT_MS = 5000;
const DEFAULT_MIN_TERMUX_VERSION = '0.118';
const DEFAULT_MIN_ANDROID_API_LEVEL = 28;

/**
 * Set of architectures Linuxify supports. Variants are normalised by
 * {@link normaliseArch} before this lookup so that `arm64` and `aarch64`
 * are treated as the same arch (Android reports `arm64-v8a` via getprop
 * but `aarch64` via `uname -m`).
 */
const SUPPORTED_ARCHS = new Set(['aarch64', 'armv7l', 'x86_64']);

/**
 * Run all preflight checks and return the aggregate result. Throws a
 * `BootstrapError` (code `E_BOOTSTRAP_FDROID_REQUIRED`,
 * `E_BOOTSTRAP_NOT_TERMUX`, `E_BOOTSTRAP_ANDROID_TOO_OLD`,
 * `E_BOOTSTRAP_UNSUPPORTED_ARCH`, `E_BOOTSTRAP_NO_SPACE`, or
 * `E_BOOTSTRAP_NO_NETWORK`) if any check has status `'fail'`. Warnings do
 * not throw.
 *
 * The function is defensive: a check that itself errors (e.g. `getprop` not
 * available) is recorded as `'fail'` with the underlying error in
 * `details.error`, rather than crashing the whole preflight.
 *
 * @param opts - Optional overrides for thresholds and endpoints.
 * @returns A {@link PreflightResult} summarising every check.
 * @throws {BootstrapError} when any check has status `'fail'`.
 */
export async function runPreflight(opts: PreflightOptions = {}): Promise<PreflightResult> {
  const minFreeSpaceMb = opts.minFreeSpaceMb ?? DEFAULT_MIN_FREE_SPACE_MB;
  const hardMinFreeSpaceMb = opts.hardMinFreeSpaceMb ?? DEFAULT_HARD_MIN_FREE_SPACE_MB;
  const endpoints = opts.networkEndpoints ?? DEFAULT_NETWORK_ENDPOINTS;
  const networkTimeoutMs = opts.networkTimeoutMs ?? DEFAULT_NETWORK_TIMEOUT_MS;
  const minTermuxVersion = opts.minTermuxVersion ?? DEFAULT_MIN_TERMUX_VERSION;
  const minAndroidApiLevel = opts.minAndroidApiLevel ?? DEFAULT_MIN_ANDROID_API_LEVEL;

  const checks: PreflightCheckResult[] = [];

  checks.push(await checkTermuxSource(minTermuxVersion));
  checks.push(await checkAndroidVersion(minAndroidApiLevel));
  checks.push(await checkFreeSpace(minFreeSpaceMb, hardMinFreeSpaceMb));
  checks.push(await checkArchitecture());
  checks.push(await checkNoRoot());
  checks.push(
    opts.offline
      ? {
          id: 'network',
          status: 'skipped',
          message: 'Network check skipped (--offline).',
        }
      : await checkNetwork(endpoints, networkTimeoutMs),
  );

  const warnings = checks.filter((c) => c.status === 'warn');
  const failures = checks.filter((c) => c.status === 'fail');
  const ok = failures.length === 0;

  if (!ok) {
    const first = failures[0];
    if (first) {
      throw new BootstrapError(
        `Preflight failed: ${first.message}`,
        errorCodeFor(first.id),
        { failures, warnings },
        undefined,
        fixCommandFor(first.id),
        'https://docs.linuxify.dev/05-bootstrap/bootstrap-design#stage-0',
      );
    }
  }

  return { ok, checks, warnings, failures };
}

/**
 * Check 1: Termux is installed and is the F-Droid build (not the Play Store
 * build, which is no longer updated and has a broken package repository).
 *
 * Heuristics:
 * 1. `isTermux()` must return true (PREFIX env var is set, or the canonical
 *    Termux data directory exists).
 * 2. `pkg` must be executable at `$PREFIX/bin/pkg`.
 * 3. The `com.termux` meta-package version (read via `dpkg -s com.termux`)
 *    must be >= `minTermuxVersion` (default 0.118). The Play Store build is
 *    frozen at 0.101, so this is a reliable signal.
 *
 * If `isTermux()` is false we fail with `E_BOOTSTRAP_NOT_TERMUX`; if the
 * version is too old we fail with `E_BOOTSTRAP_FDROID_REQUIRED`.
 */
async function checkTermuxSource(minTermuxVersion: string): Promise<PreflightCheckResult> {
  if (!isTermux()) {
    return fail('termux-source', 'Linuxify must run inside Termux.', {
      reason: 'isTermux() returned false',
    });
  }

  const prefix = getTermuxPrefix();
  const pkgPath = `${prefix}/bin/pkg`;
  if (!(await exists(pkgPath))) {
    return fail('termux-source', `Termux 'pkg' not found at ${pkgPath}.`, {
      prefix,
      pkgPath,
    });
  }

  // Read the com.termux meta-package version via dpkg. We tolerate exec
  // failures (e.g. on minimal Termux images without dpkg) and fall back to
  // a warning rather than a hard failure — `pkg` itself is the more
  // important signal.
  let version: string | undefined;
  try {
    const result = await exec('dpkg', ['-s', 'com.termux'], { timeoutMs: 5000 });
    if (result.exitCode === 0) {
      const match = /Version:\s*([0-9.]+)/.exec(result.stdout);
      version = match?.[1];
    }
  } catch (e) {
    logger.debug('dpkg -s com.termux failed', { error: (e as Error).message });
  }

  if (!version) {
    return {
      id: 'termux-source',
      status: 'warn',
      message:
        'Could not determine Termux version. Ensure you installed Termux from F-Droid (the Play Store build is unmaintained).',
      details: { prefix, pkgPath },
    };
  }

  if (compareVersion(version, minTermuxVersion) < 0) {
    return fail(
      'termux-source',
      `Termux ${version} is too old (>= ${minTermuxVersion} required). The Play Store build of Termux is unmaintained — install Termux from F-Droid.`,
      { version, minTermuxVersion, pkgPath },
    );
  }

  return pass('termux-source', `Termux ${version} detected at ${prefix}.`, {
    version,
    prefix,
  });
}

/**
 * Check 2: Android API level >= `minApiLevel` (default 28 = Android 9). Below
 * 28, proot's seccomp filter crashes on the `clone3` syscall.
 *
 * Reads `getprop ro.build.version.sdk` via the Android `getprop` tool. If
 * `getprop` is unavailable (non-Android host, e.g. developer laptop), the
 * check is skipped rather than failed — this lets unit tests run on Linux
 * macOS.
 */
async function checkAndroidVersion(minApiLevel: number): Promise<PreflightCheckResult> {
  if (!isAndroid()) {
    return {
      id: 'android-version',
      status: 'skipped',
      message: 'Android version check skipped (not running on Android).',
    };
  }

  let apiLevel: number | undefined;
  let release: string | undefined;
  try {
    const sdkResult = await exec('getprop', ['ro.build.version.sdk'], { timeoutMs: 3000 });
    if (sdkResult.exitCode === 0) {
      apiLevel = parseInt(sdkResult.stdout.trim(), 10);
    }
    const relResult = await exec('getprop', ['ro.build.version.release'], {
      timeoutMs: 3000,
    });
    if (relResult.exitCode === 0) {
      release = relResult.stdout.trim();
    }
  } catch (e) {
    logger.debug('getprop failed', { error: (e as Error).message });
  }

  if (apiLevel === undefined || Number.isNaN(apiLevel)) {
    return fail('android-version', 'Could not determine Android API level.', { release });
  }

  if (apiLevel < minApiLevel) {
    return fail(
      'android-version',
      `Android API level ${apiLevel} (Android ${release ?? '?'}) is too old. Linuxify requires Android ${apiLevelName(minApiLevel)} (API ${minApiLevel}) or newer.`,
      { apiLevel, release, minApiLevel },
    );
  }

  return pass(
    'android-version',
    `Android API level ${apiLevel} (Android ${release ?? '?'}).`,
    { apiLevel, release },
  );
}

/**
 * Check 3: Free space on the home filesystem.
 *
 * Reads `df -k ~` and parses the "Available" column (in 1-KiB blocks). Above
 * `minFreeSpaceMb` (default 2048 MiB) is a pass; between
 * `hardMinFreeSpaceMb` (default 500 MiB) and `minFreeSpaceMb` is a warn;
 * below `hardMinFreeSpaceMb` is a fail.
 */
async function checkFreeSpace(
  minFreeSpaceMb: number,
  hardMinFreeSpaceMb: number,
): Promise<PreflightCheckResult> {
  let availableMb: number | undefined;
  try {
    const result = await exec('df', ['-k', process.env.HOME ?? '~'], { timeoutMs: 5000 });
    if (result.exitCode === 0) {
      availableMb = parseDfAvailableMb(result.stdout);
    }
  } catch (e) {
    logger.debug('df failed', { error: (e as Error).message });
  }

  if (availableMb === undefined) {
    return {
      id: 'free-space',
      status: 'warn',
      message: 'Could not determine free disk space. Bootstrap will proceed; watch for ENOSPC errors.',
    };
  }

  if (availableMb < hardMinFreeSpaceMb) {
    return fail(
      'free-space',
      `Only ${availableMb} MiB free. Linuxify requires at least ${hardMinFreeSpaceMb} MiB to bootstrap (recommend ${minFreeSpaceMb} MiB).`,
      { availableMb, minFreeSpaceMb, hardMinFreeSpaceMb },
    );
  }

  if (availableMb < minFreeSpaceMb) {
    return {
      id: 'free-space',
      status: 'warn',
      message: `Low disk space: ${availableMb} MiB free (recommend ${minFreeSpaceMb} MiB). Bootstrap will proceed but may fail during apt install.`,
      details: { availableMb, minFreeSpaceMb, hardMinFreeSpaceMb },
    };
  }

  return pass('free-space', `${availableMb} MiB free.`, {
    availableMb,
    minFreeSpaceMb,
  });
}

/**
 * Check 4: Host architecture is supported. Linuxify supports aarch64 (the
 * primary target), armv7l (best-effort), and x86_64 (Chromebooks,
 * Android-x86). `i386` and `mips` are refused.
 */
async function checkArchitecture(): Promise<PreflightCheckResult> {
  const raw = getArch();
  const arch = normaliseArch(raw);
  if (!SUPPORTED_ARCHS.has(arch)) {
    return fail(
      'architecture',
      `Unsupported architecture '${raw}'. Linuxify supports aarch64, armv7l, and x86_64.`,
      { raw, normalised: arch, supported: [...SUPPORTED_ARCHS] },
    );
  }
  return pass('architecture', `Architecture: ${arch}.`, { arch });
}

/**
 * Check 5: Not running as root. We warn (rather than fail) because some
 * users run Termux via `tsu` deliberately; the warning reminds them that
 * proot semantics differ when EUID=0.
 */
async function checkNoRoot(): Promise<PreflightCheckResult> {
  // process.getuid is undefined on Windows; we only care about POSIX here.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid === 0) {
    return {
      id: 'no-root',
      status: 'warn',
      message:
        'Running as root. proot semantics differ when EUID=0; consider running Linuxify as a non-root user.',
      details: { uid },
    };
  }
  return pass('no-root', uid >= 0 ? `Running as uid ${uid}.` : 'Not running as root.', {
    uid,
  });
}

/**
 * Check 6: At least one of the network endpoints is reachable. Skipped when
 * `opts.offline` is set (handled by the caller).
 *
 * Probes each endpoint with `isReachable` (a TCP connect on port 443 with a
 * short timeout). Returns `'pass'` on the first reachable endpoint;
 * `'fail'` only when every endpoint is unreachable.
 */
async function checkNetwork(
  endpoints: readonly string[],
  timeoutMs: number,
): Promise<PreflightCheckResult> {
  const probeResults = await Promise.all(
    endpoints.map(async (url) => ({ url, ok: await isReachable(url, { timeoutMs }) })),
  );
  const reachable = probeResults.filter((r) => r.ok);

  if (reachable.length === 0) {
    return fail(
      'network',
      `No network: could not reach any of ${endpoints.join(', ')}. Use 'linuxify init --offline --bundle <path>' for an air-gapped install.`,
      { endpoints: probeResults },
    );
  }

  return pass('network', `Network OK (reached ${reachable[0]?.url}).`, {
    reachable: reachable.map((r) => r.url),
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(
  id: PreflightCheckId,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PreflightCheckResult {
  return { id, status: 'pass', message, details };
}

function fail(
  id: PreflightCheckId,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): PreflightCheckResult {
  return { id, status: 'fail', message, details };
}

/**
 * Map a failing check id to the `BootstrapError` code the orchestrator
 * should throw. Kept in sync with `docs/02-architecture/type-reference.md`
 * §12 (Error Types) and the codes referenced in
 * `docs/22-operations/troubleshooting.md`.
 */
function errorCodeFor(id: PreflightCheckId): string {
  switch (id) {
    case 'termux-source':
      return 'E_BOOTSTRAP_FDROID_REQUIRED';
    case 'android-version':
      return 'E_BOOTSTRAP_ANDROID_TOO_OLD';
    case 'architecture':
      return 'E_BOOTSTRAP_UNSUPPORTED_ARCH';
    case 'free-space':
      return 'E_BOOTSTRAP_NO_SPACE';
    case 'network':
      return 'E_BOOTSTRAP_NO_NETWORK';
    case 'no-root':
      // no-root is warn-only; if we ever fail on it, use a generic code.
      return 'E_BOOTSTRAP_ROOT_FORBIDDEN';
  }
}

/**
 * Suggested remediation command for a failing check. Surfaced as
 * `error.fixCommand` so the CLI can print "Run: <fixCommand>".
 */
function fixCommandFor(id: PreflightCheckId): string | undefined {
  switch (id) {
    case 'termux-source':
      return 'Install Termux from F-Droid: https://f-droid.org/packages/com.termux/';
    case 'android-version':
      return undefined; // No command-line fix; user must upgrade Android.
    case 'architecture':
      return undefined;
    case 'free-space':
      return 'Free up space: rm -rf ~/.cache ~/Downloads/*.iso';
    case 'network':
      return 'linuxify init --offline --bundle ./linuxify-bundle-0.1.0.tar.gz';
    case 'no-root':
      return undefined;
  }
}

/**
 * Compare two dotted version strings like "0.118.1" vs "0.118". Returns
 * negative if `a < b`, zero if equal, positive if `a > b`. Non-numeric
 * components are compared lexicographically as a fallback.
 */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? '0', 10);
    const nb = parseInt(pb[i] ?? '0', 10);
    if (Number.isNaN(na) || Number.isNaN(nb)) {
      const cmp = (pa[i] ?? '').localeCompare(pb[i] ?? '');
      if (cmp !== 0) return cmp;
      continue;
    }
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Normalise the various names Android/Node report for the same architecture
 * into one of `aarch64`, `armv7l`, `x86_64` — the set Linuxify cares about.
 */
function normaliseArch(raw: string): string {
  const r = raw.toLowerCase().trim();
  if (r === 'arm64' || r === 'aarch64' || r === 'arm64-v8a') return 'aarch64';
  if (r === 'arm' || r === 'armv7l' || r === 'armv7-a') return 'armv7l';
  if (r === 'x64' || r === 'x86_64' || r === 'amd64') return 'x86_64';
  return r;
}

/**
 * Convert an Android API level to a marketing version name (e.g. 28 →
 * "9"). Used only for human-readable messages; not authoritative.
 */
function apiLevelName(level: number): string {
  const map: Record<number, string> = {
    28: '9',
    29: '10',
    30: '11',
    31: '12',
    32: '12L',
    33: '13',
    34: '14',
    35: '15',
  };
  return map[level] ?? `API ${level}`;
}

/**
 * Parse the "Available" column (1-KiB blocks) of `df -k <path>` output.
 * Returns MiB or `undefined` if parsing fails. The GNU and Busybox `df`
 * layouts are both supported; the column index is found by header.
 */
function parseDfAvailableMb(stdout: string): number | undefined {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return undefined;
  const header = lines[0]?.split(/\s+/) ?? [];
  const availIdx = header.findIndex((h) => h === 'Available' || h === 'avail');
  const fallbackIdx = header.length >= 4 ? 3 : -1;
  const idx = availIdx >= 0 ? availIdx : fallbackIdx;
  if (idx < 0) return undefined;
  const cells = lines[1]?.split(/\s+/) ?? [];
  const cell = cells[idx];
  if (!cell) return undefined;
  const kb = parseInt(cell, 10);
  if (Number.isNaN(kb)) return undefined;
  return Math.floor(kb / 1024);
}
