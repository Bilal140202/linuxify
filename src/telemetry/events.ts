/**
 * Event constructors for common telemetry events.
 *
 * @module linuxify/telemetry/events
 *
 * Convenience helpers that build fully-formed {@link TelemetryEvent}
 * objects for the most common event types. Each helper fills in the
 * envelope (`event_id`, `timestamp`, `linuxify_version`, `session_id`,
 * `os`) from a lazily-initialized per-process session context, and the
 * `fields` object from the helper's arguments.
 *
 * The helpers are *privacy-structured*: they take only the minimum
 * arguments needed, and never accept user-identifying data. For example:
 *
 *   - {@link cliInvoked} takes only the command name — never the args
 *     (which may contain file paths, API keys, or model names).
 *   - {@link errorThrown} takes only the error code — never the error
 *     message (which may contain user file paths or network URLs).
 *
 * The caller may still use `client.track(eventType, fields)` directly for
 * event types not covered here, or to pass additional fields. These
 * helpers exist to make the common cases readable and to encode the
 * privacy contract in the function signature (a contributor calling
 * `cliInvoked(process.argv)` would get a type error).
 *
 * The `user_id` field is left `null` by the helpers; the client's
 * `track()` method fills it in from `state.telemetry.user_id` when the
 * event is constructed. (If a caller wants to submit a helper-built
 * event directly, they should patch `user_id` themselves.)
 *
 * @packageDocumentation
 */

import { LINUXIFY_VERSION } from '../utils/constants.js';
import { randomId, sha256 } from '../utils/crypto.js';
import { getArch } from '../utils/process.js';

import type { TelemetryEvent, TelemetryEventType } from './types.js';

// ---------------------------------------------------------------------------
// Session context (lazy, per-process)
// ---------------------------------------------------------------------------

/**
 * Per-process session context. The `session_id` is generated once on
 * first use and reused for every event emitted during this CLI
 * invocation (per event-catalog.md §1). The OS metadata is probed
 * once; `android_version` is `null` until {@link refreshAndroidVersion}
 * is called (the client does this in its async `init()`).
 */
interface SessionContext {
  /** Per-process UUIDv7. */
  readonly session_id: string;
  /** Linuxify version (semver). */
  readonly linuxify_version: string;
  /** OS metadata. `android_version` is null off-Android or before refresh. */
  os: { android_version: string | null; arch: string };
}

/** Lazily-initialized session context singleton. */
let _session: SessionContext | null = null;

/**
 * Get (or lazily create) the per-process session context. The `session_id`
 * is a UUIDv7 generated via `randomId()`; `linuxify_version` is the
 * compiled-in constant; `os.arch` is read sync via `getArch()`;
 * `os.android_version` defaults to `null` and is filled in by
 * {@link refreshAndroidVersion} (called by the client's `init()`).
 *
 * @returns The shared session context.
 */
function getSession(): SessionContext {
  if (_session === null) {
    _session = {
      session_id: randomId(),
      linuxify_version: LINUXIFY_VERSION,
      os: { android_version: null, arch: getArch() },
    };
  }
  return _session;
}

/**
 * Update the session context's `android_version` field. Called by the
 * telemetry client after its async `getAndroidVersion()` probe completes.
 *
 * @param version - The Android version string (e.g. `"14"`) or `null`.
 */
export function refreshAndroidVersion(version: string | null): void {
  const s = getSession();
  s.os.android_version = version;
}

/**
 * Build the envelope (everything except `event_type` and `fields`) for a
 * new event. Uses the shared session context for `session_id`,
 * `linuxify_version`, and `os`; generates a fresh `event_id` (UUIDv7)
 * and `timestamp` (ISO 8601 UTC) per event; leaves `user_id` null (the
 * client fills it in).
 *
 * @returns A partial {@link TelemetryEvent} envelope.
 */
function buildEnvelope(): Omit<TelemetryEvent, 'event_type' | 'fields'> {
  const s = getSession();
  return {
    event_id: randomId(),
    timestamp: new Date().toISOString(),
    linuxify_version: s.linuxify_version,
    user_id: null,
    session_id: s.session_id,
    os: { ...s.os },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap events
// ---------------------------------------------------------------------------

/**
 * Build a `bootstrap.start` event. Emitted at the start of
 * `linuxify init` (or `linuxify install`).
 *
 * @param stagesPlanned - Number of stages the bootstrap pipeline will run (0-8).
 * @param resume - `true` if this is a resume from a partial bootstrap.
 * @param fromBundle - `true` if installing from a pre-bundled tarball.
 * @returns A `bootstrap.start` {@link TelemetryEvent}.
 */
export function bootstrapStart(
  stagesPlanned: number = 9,
  resume: boolean = false,
  fromBundle: boolean = false,
): TelemetryEvent {
  return {
    ...buildEnvelope(),
    event_type: 'bootstrap.start' as TelemetryEventType,
    fields: {
      stages_planned: stagesPlanned,
      resume,
      from_bundle: fromBundle,
    },
  };
}

/**
 * Build a `bootstrap.stage_complete` event. Emitted at the end of each
 * successful bootstrap stage.
 *
 * @param stage - Numeric stage id (0-8).
 * @param durationMs - Wall-clock duration of the stage in milliseconds.
 * @param stageName - Optional human-readable stage name (e.g. `"preflight"`).
 * @returns A `bootstrap.stage_complete` {@link TelemetryEvent}.
 */
export function bootstrapStageComplete(
  stage: number,
  durationMs: number,
  stageName?: string,
): TelemetryEvent {
  return {
    ...buildEnvelope(),
    event_type: 'bootstrap.stage_complete' as TelemetryEventType,
    fields: {
      stage,
      stage_name: stageName ?? null,
      duration_ms: durationMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Package events
// ---------------------------------------------------------------------------

/**
 * Build a `package.install_start` event. Emitted at the start of
 * `linuxify add <pkg>`.
 *
 * The package name is hashed (SHA-256) for the `package_hash` field per
 * the privacy contract (telemetry-privacy.md §5). v0.1 hashes without a
 * rotating salt (the salt-fetch infrastructure is a v2 feature); the
 * server can still aggregate by hash since it knows the package list.
 *
 * @param name - The package name (e.g. `"cline"`). Hashed before storage.
 * @param version - The upstream package version (e.g. `"1.2.0"`).
 * @returns A `package.install_start` {@link TelemetryEvent}.
 */
export function packageInstallStart(name: string, version: string): TelemetryEvent {
  return {
    ...buildEnvelope(),
    event_type: 'package.install_start' as TelemetryEventType,
    fields: {
      package_hash: hashPackageName(name),
      version,
    },
  };
}

/**
 * Build a `package.install_complete` event. Emitted on successful
 * package install.
 *
 * @param name - The package name. Hashed for `package_hash`.
 * @param version - The upstream package version.
 * @param durationMs - Wall-clock install duration in milliseconds.
 * @param patchesApplied - Number of patches applied during install (default 0).
 * @returns A `package.install_complete` {@link TelemetryEvent}.
 */
export function packageInstallComplete(
  name: string,
  version: string,
  durationMs: number,
  patchesApplied: number = 0,
): TelemetryEvent {
  return {
    ...buildEnvelope(),
    event_type: 'package.install_complete' as TelemetryEventType,
    fields: {
      package_hash: hashPackageName(name),
      version,
      duration_ms: durationMs,
      patches_applied: patchesApplied,
    },
  };
}

// ---------------------------------------------------------------------------
// Doctor events
// ---------------------------------------------------------------------------

/**
 * Shape of the doctor-run summary passed to {@link doctorRunComplete}.
 */
export interface DoctorRunSummary {
  /** Number of checks that passed. */
  readonly ok: number;
  /** Number of checks that warned. */
  readonly warn: number;
  /** Number of checks that failed. */
  readonly fail: number;
  /** Number of checks for missing optional dependencies. */
  readonly missing: number;
}

/**
 * Build a `doctor.run_complete` event. Emitted at the end of
 * `linuxify doctor`. Only aggregate counts are sent — check *names* are
 * not (they could reveal the installed package list).
 *
 * @param results - Aggregate counts from the doctor run.
 * @param durationMs - Wall-clock duration of the doctor run in milliseconds.
 * @returns A `doctor.run_complete` {@link TelemetryEvent}.
 */
export function doctorRunComplete(results: DoctorRunSummary, durationMs: number): TelemetryEvent {
  return {
    ...buildEnvelope(),
    event_type: 'doctor.run_complete' as TelemetryEventType,
    fields: {
      duration_ms: durationMs,
      pass_count: results.ok,
      warn_count: results.warn,
      fail_count: results.fail,
      missing_count: results.missing,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI events
// ---------------------------------------------------------------------------

/**
 * Build a `cli.invoked` event. Emitted at the start (or end — the
 * catalog allows either) of every CLI invocation. **Only the command
 * name is recorded** — never the args (which may contain file paths,
 * package names the user wants to keep private, model names, API keys,
 * etc.). This privacy property is encoded in the function signature: a
 * contributor calling `cliInvoked(process.argv)` would get a type error.
 *
 * Because `cli.invoked` is high-volume (every invocation), the client
 * samples it at 10% by default (see `client.ts` {@link TelemetryClient}).
 *
 * @param command - The subcommand name (e.g. `"add"`, `"doctor"`). NOT the args.
 * @param durationMs - Optional duration (only known if emitted at exit).
 * @returns A `cli.invoked` {@link TelemetryEvent}.
 */
export function cliInvoked(command: string, durationMs?: number): TelemetryEvent {
  const fields: Record<string, unknown> = { command };
  if (durationMs !== undefined) {
    fields.duration_ms = durationMs;
  }
  return {
    ...buildEnvelope(),
    event_type: 'cli.invoked' as TelemetryEventType,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Error events
// ---------------------------------------------------------------------------

/**
 * Build an `error.thrown` event. Emitted when a structured error (any
 * error with a `code`) is thrown. **Only the error code is recorded** —
 * never the error message (which may contain user file paths, package
 * names, or network URLs). This privacy property is encoded in the
 * function signature.
 *
 * @param code - The error code (e.g. `"E_PATCH_VERIFY_FAILED"`).
 * @param command - Optional: the CLI command that was running when the error threw.
 * @param exitCode - Optional: the exit code associated with the error.
 * @returns An `error.thrown` {@link TelemetryEvent}.
 */
export function errorThrown(
  code: string,
  command?: string,
  exitCode?: number,
): TelemetryEvent {
  const fields: Record<string, unknown> = { error_code: code };
  if (command !== undefined) fields.command = command;
  if (exitCode !== undefined) fields.exit_code = exitCode;
  return {
    ...buildEnvelope(),
    event_type: 'error.thrown' as TelemetryEventType,
    fields,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash a package name into the `package_hash` field. v0.1 uses SHA-256
 * without a rotating salt (the salt-fetch infrastructure is a v2
 * feature, per telemetry-privacy.md §5). The server can still aggregate
 * by hash since it knows the package list, and a one-way hash without
 * salt is sufficient to prevent casual reverse-lookup.
 *
 * @param name - The package name (e.g. `"cline"`).
 * @returns A 64-character lowercase hex SHA-256 digest.
 */
function hashPackageName(name: string): string {
  return sha256(name);
}
