/**
 * Telemetry event types.
 *
 * @module linuxify/telemetry/types
 *
 * Defines the {@link TelemetryEvent} envelope and the closed set of
 * {@link TelemetryEventType} strings that the client may emit. The envelope
 * matches the structure documented in
 * `docs/24-telemetry/event-catalog.md` §1 and the privacy contract in
 * `docs/24-telemetry/telemetry-privacy.md` §2-§3.
 *
 * Design notes:
 *   - `event_id` is UUIDv7 (time-ordered) generated via `randomId()` from
 *     `utils/crypto.ts`. v7 is sortable and dedup-able by the server without
 *     consulting a clock (see event-catalog.md §1).
 *   - `user_id` is `null` when the user has never opted in; once the user
 *     opts in, a UUIDv4 is generated and stored in
 *     `state.telemetry.user_id` (per telemetry-privacy.md §5).
 *   - `session_id` is a UUIDv7 generated once per CLI process and reused
 *     for every event emitted during that invocation (per event-catalog.md
 *     §1). This lets the server reconstruct event sequences without relying
 *     on timestamps alone.
 *   - `os` deliberately excludes device model, manufacturer, carrier, and
 *     any other hardware identifier — those would be fingerprinting vectors.
 *     The two fields present (`android_version`, `arch`) are the minimum
 *     needed for the compat matrix and ARM-specific regression detection.
 *   - `fields` is event-specific; see `docs/24-telemetry/event-catalog.md`
 *     §3 for the per-event-type contract. The redactor
 *     (`src/telemetry/redact.ts`) walks `fields` recursively before the
 *     event is written to the queue, so a contributor adding a new field
 *     does not need to remember to redact — the redactor catches leaks.
 *
 * @packageDocumentation
 */

/**
 * Operating-system metadata embedded in every telemetry event. Intentionally
 * minimal: only the two fields needed for compat-matrix segmentation.
 */
export interface TelemetryOs {
  /** Android marketing version (`"14"`, `"13"`, ...) or `null` off-Android. */
  android_version: string | null;
  /** CPU architecture: `aarch64` | `armv7l` | `x86_64` | `unknown`. */
  arch: string;
}

/**
 * The telemetry event envelope. One of these is serialized as a single
 * compact-JSON line in `~/.linuxify/telemetry/queue.jsonl` per event. The
 * `fields` object carries event-type-specific payload; the rest of the
 * envelope is fixed.
 *
 * @see {@link TelemetryEventType} for the closed set of `event_type` values.
 */
export interface TelemetryEvent {
  /** UUIDv7 (time-ordered, sortable, monotonically increasing). */
  event_id: string;
  /** Event type, e.g. `bootstrap.stage_complete`. See {@link TelemetryEventType}. */
  event_type: string;
  /** ISO 8601 UTC timestamp with millisecond precision. */
  timestamp: string;
  /** Linuxify CLI version (semver, e.g. `"0.1.0-alpha.1"`). */
  linuxify_version: string;
  /** Anonymized UUIDv4 from `state.telemetry.user_id`; `null` if not set. */
  user_id: string | null;
  /** Per-process UUIDv7; same across events from one CLI invocation. */
  session_id: string;
  /** OS metadata (android_version + arch only; no device fingerprinting). */
  os: TelemetryOs;
  /** Event-specific payload; recursively redacted before queue write. */
  fields: Record<string, unknown>;
}

/**
 * Closed set of telemetry event types. A contributor adding a new event
 * must add it to this union and to `docs/24-telemetry/event-catalog.md` §3
 * in the same PR; an event not in the catalog is a bug.
 *
 * Naming convention: `<subsystem>.<action>` where subsystem is one of
 * `bootstrap`, `distro`, `runtime`, `package`, `patch`, `doctor`,
 * `repair`, `run`, `update`, `self_update`, `cli`, `error`, `crash`.
 * The action is a verb or verb-phrase in `snake_case`.
 *
 * @see `docs/24-telemetry/event-catalog.md` §2 for the naming convention.
 */
export type TelemetryEventType =
  // Bootstrap subsystem
  | 'bootstrap.start'
  | 'bootstrap.stage_complete'
  | 'bootstrap.stage_failed'
  | 'bootstrap.complete'
  // Distro subsystem
  | 'distro.install_start'
  | 'distro.install_complete'
  | 'distro.uninstall'
  // Runtime subsystem
  | 'runtime.install_start'
  | 'runtime.install_complete'
  | 'runtime.uninstall'
  // Package subsystem
  | 'package.install_start'
  | 'package.install_complete'
  | 'package.install_failed'
  | 'package.uninstall'
  // Patch subsystem
  | 'patch.apply_start'
  | 'patch.apply_complete'
  | 'patch.apply_failed'
  | 'patch.rollback'
  // Doctor subsystem
  | 'doctor.run_start'
  | 'doctor.run_complete'
  | 'doctor.check_pass'
  | 'doctor.check_warn'
  | 'doctor.check_fail'
  // Repair subsystem
  | 'repair.start'
  | 'repair.complete'
  | 'repair.fix_applied'
  | 'repair.fix_failed'
  // Run subsystem
  | 'run.start'
  | 'run.complete'
  | 'run.failed'
  // Update / self-update subsystems
  | 'update.start'
  | 'update.complete'
  | 'update.failed'
  | 'self_update.start'
  | 'self_update.complete'
  | 'self_update.failed'
  // CLI subsystem (high-volume; sampled at 10% by default)
  | 'cli.invoked'
  // Error and crash subsystems
  | 'error.thrown'
  | 'crash.uncaught';
