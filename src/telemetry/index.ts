/**
 * Public API surface for the `telemetry` module.
 *
 * @module linuxify/telemetry
 *
 * Re-exports the {@link TelemetryClient} class, the event constructors,
 * the redactor, and the type definitions. Subsystem code should import
 * from here (`../telemetry` or `linuxify/telemetry`) rather than
 * reaching into individual files, so internal layout changes don't
 * ripple.
 *
 * The factory {@link createTelemetryClient} wires up the queue path from
 * `getLinuxifyHome()`; the singleton accessor {@link getTelemetryClient}
 * returns `null` if telemetry is disabled (so callers can write
 * `getTelemetryClient()?.track(...)` and have it no-op cleanly).
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import type { Config } from '../config/index.js';
import type { StateStore } from '../state/index.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome } from '../utils/process.js';

import { TelemetryClient } from './client.js';

export type { TelemetryEvent, TelemetryEventType, TelemetryOs } from './types.js';
export {
  redactEvent,
  redactObject,
  redactString,
  PATH_TOKEN,
  ENV_TOKEN,
  ARGS_TOKEN,
  SECRET_TOKEN,
} from './redact.js';
export { TelemetryClient, shouldSample } from './client.js';
export type { TelemetryClientOptions } from './client.js';
export {
  bootstrapStart,
  bootstrapStageComplete,
  packageInstallStart,
  packageInstallComplete,
  doctorRunComplete,
  cliInvoked,
  errorThrown,
  refreshAndroidVersion,
} from './events.js';
export type { DoctorRunSummary } from './events.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Default path to the telemetry queue file, relative to the Linuxify
 * home directory. The full path is
 * `~/.linuxify/telemetry/queue.jsonl` (or `$LINUXIFY_HOME/telemetry/
 * queue.jsonl` if `LINUXIFY_HOME` is set).
 */
const QUEUE_RELATIVE_PATH = 'telemetry/queue.jsonl';

/**
 * Construct a {@link TelemetryClient} wired up with the standard queue
 * path (`<linuxifyHome>/telemetry/queue.jsonl`). The caller must supply
 * the resolved {@link Config} and an open {@link StateStore}; the
 * client reads `config.telemetry.*` and `state.telemetry.user_id`
 * lazily on first use.
 *
 * The returned client is *not* automatically initialized — the caller
 * should `await client.init()` before calling `track()` to ensure
 * `user_id` is populated. (If `init()` is skipped, events are emitted
 * with `user_id: null`, which the server accepts but which limits
 * funnel/cohort analysis.)
 *
 * @param config - Resolved Linuxify configuration.
 * @param stateStore - Open state store.
 * @returns A new {@link TelemetryClient}.
 *
 * @example
 * ```ts
 * const config = await loadConfig();
 * const stateStore = new StateStore(getStatePath());
 * const client = createTelemetryClient(config, stateStore);
 * await client.init();
 * client.track('bootstrap.start', { stages_planned: 9 });
 * await client.flush();
 * ```
 */
export function createTelemetryClient(
  config: Config,
  stateStore: StateStore,
): TelemetryClient {
  const queuePath = join(getLinuxifyHome(), QUEUE_RELATIVE_PATH);
  return new TelemetryClient({ config, stateStore, queuePath });
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

/**
 * Cached singleton client. Set by {@link setTelemetryClient} (called by
 * the CLI on startup if telemetry is enabled) and returned by
 * {@link getTelemetryClient}. `null` until set or if telemetry is
 * disabled.
 */
let _singleton: TelemetryClient | null = null;

/**
 * Whether the singleton has been initialized (so repeated calls to
 * {@link getTelemetryClient} don't re-attempt setup).
 */
let _singletonInit = false;

/**
 * Get the shared telemetry client singleton, or `null` if telemetry is
 * disabled. The CLI calls this once on startup; subsystem code can call
 * it freely (it's idempotent after the first call).
 *
 * The singleton is created via {@link createTelemetryClient} using the
 * supplied config and state store. If `config.telemetry.enabled` is
 * false (or `LINUXIFY_TELEMETRY=0` is set), the function returns `null`
 * without creating a client — callers can write
 * `getTelemetryClient()?.track(...)` and have it no-op cleanly.
 *
 * @param config - Optional config for first-time setup. Required on the
 *   first call; ignored on subsequent calls.
 * @param stateStore - Optional state store for first-time setup. Required
 *   on the first call; ignored on subsequent calls.
 * @returns The shared {@link TelemetryClient}, or `null` if telemetry is
 *   disabled.
 */
export function getTelemetryClient(
  config?: Config,
  stateStore?: StateStore,
): TelemetryClient | null {
  if (_singletonInit) return _singleton;
  _singletonInit = true;
  if (!config || !stateStore) {
    // No config supplied — can't create a client. Return null.
    return null;
  }
  const client = createTelemetryClient(config, stateStore);
  if (!client.isEnabled()) {
    logger.debug('telemetry: singleton disabled; returning null');
    return null;
  }
  _singleton = client;
  return _singleton;
}

/**
 * Reset the singleton. Used by tests to get a clean state between test
 * cases. Not part of the public API; exported for test access only.
 */
export function resetTelemetryClient(): void {
  _singleton = null;
  _singletonInit = false;
}

// ---------------------------------------------------------------------------
// flushOnExit()
// ---------------------------------------------------------------------------

/**
 * Register a `process.on('beforeExit')` handler that flushes the
 * telemetry queue. This is the opportunistic end-of-process flush
 * described in event-catalog.md §8: a best-effort attempt to send
 * queued events before the process exits.
 *
 * The handler is idempotent — calling `flushOnExit()` multiple times
 * registers only one handler. The flush has a soft 2-second timeout
 * (per event-catalog.md §8); if it does not complete in time, the
 * events stay in the queue and will be flushed by the next invocation.
 *
 * @param client - Optional client to flush. If omitted, the singleton
 *   from {@link getTelemetryClient} is used.
 */
export function flushOnExit(client?: TelemetryClient): void {
  const target = client ?? _singleton;
  if (target === null) return;
  if (target === undefined) return;
  if (_exitHandlerRegistered) return;
  _exitHandlerRegistered = true;

  process.on('beforeExit', () => {
    // Fire-and-forget: `beforeExit` is the last chance to run async work
    // before the process exits. If the flush hangs, the process will
    // still exit (Node has a hard 2s ceiling on `beforeExit` handlers
    // before forcefully terminating).
    void target.flush().catch((err: unknown) => {
      logger.warn({ err: (err as Error).message }, 'telemetry: flush-on-exit failed');
    });
  });
}

/** Whether the `beforeExit` handler has been registered. */
let _exitHandlerRegistered = false;

/**
 * Reset the `beforeExit` handler registration flag. Used by tests to
 * allow re-registration after resetting the singleton. Not part of the
 * public API.
 */
export function resetFlushOnExit(): void {
  _exitHandlerRegistered = false;
}
