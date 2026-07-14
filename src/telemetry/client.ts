/**
 * Telemetry client — opt-in, privacy-preserving event collection and
 * transmission.
 *
 * @module linuxify/telemetry/client
 *
 * The {@link TelemetryClient} is the single entry point for emitting
 * telemetry events. It enforces the privacy contract from
 * `docs/24-telemetry/telemetry-privacy.md` and ADR-005:
 *
 *   - **Off by default.** `isEnabled()` returns `false` unless both
 *     `config.telemetry.enabled === true` AND the `LINUXIFY_TELEMETRY`
 *     environment variable is not set to `'0'`. The env-var override is
 *     the CI escape hatch (per telemetry-privacy.md §11).
 *   - **No work when disabled.** `track()` returns immediately without
 *     constructing the event, applying rate limiting, sampling, or
 *     touching the queue — saving CPU on the disabled path.
 *   - **Rate limited.** Max 1000 events / day / user_id and 100 events /
 *     minute / user_id (per event-catalog.md §6). Excess events are
 *     dropped with a single warning log per burst.
 *   - **Sampled.** High-volume events (currently just `cli.invoked`)
 *     are sampled at `config.telemetry.sample_rate` (default 0.1) using
 *     a deterministic hash of `event_id` so re-sends produce the same
 *     decision (per event-catalog.md §7).
 *   - **Redacted.** Every event passes through `redactEvent()` before
 *     being written to the queue, so a contributor adding a new field
 *     does not need to remember to redact — the redactor catches leaks.
 *   - **Durable queue.** Events are appended synchronously to
 *     `~/.linuxify/telemetry/queue.jsonl` (mode 0600) with `O_APPEND`,
 *     so they survive a crash mid-queue.
 *   - **Best-effort flush.** `flush()` POSTs the queue as NDJSON to
 *     `config.telemetry.endpoint`. On 200, the queue is cleared and
 *     `state.telemetry.last_flush` is updated. On 4xx, the queue is
 *     cleared (don't retry bad data). On 5xx, retries up to 3 times
 *     with exponential backoff; if all retries fail, the queue is
 *     kept for the next flush. On network error, the queue is kept.
 *
 * @packageDocumentation
 */

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type { Config } from '../config/index.js';
import type { StateStore } from '../state/index.js';
import { LINUXIFY_VERSION } from '../utils/constants.js';
import { sha256, randomId, uuidV4 } from '../utils/crypto.js';
import { logger } from '../utils/log.js';
import { getArch, getAndroidVersion } from '../utils/process.js';

import { redactEvent } from './redact.js';
import type { TelemetryEvent, TelemetryEventType } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Filesystem mode for the queue file and its parent directory. The queue
 * contains `user_id` (a UUID that, while not secret, is personally
 * identifiable), so it is owner-read/write only.
 */
const QUEUE_FILE_MODE = 0o600;
const QUEUE_DIR_MODE = 0o700;

/** Maximum events per user_id per UTC day (per event-catalog.md §6). */
const DAILY_LIMIT = 1000;

/** Maximum events per user_id per minute (per event-catalog.md §6). */
const MINUTE_LIMIT = 100;

/** Window (ms) for the per-minute rate limit. */
const MINUTE_WINDOW_MS = 60_000;

/** Window (ms) for the daily rate limit (24 hours). */
const DAY_WINDOW_MS = 86_400_000;

/**
 * Event types subject to client-side sampling (per event-catalog.md §7).
 * Only `cli.invoked` is sampled at v0.1; everything else is sent at full
 * fidelity.
 */
const SAMPLED_EVENT_TYPES: ReadonlySet<string> = new Set(['cli.invoked']);

/**
 * Exponential backoff schedule (ms) for 5xx retries. Three retries:
 * 100ms, 400ms, 1600ms. The total worst-case added latency for a fully-
 * failing flush is ~2.1s, which is acceptable for an opportunistic
 * background flush.
 */
const RETRY_BACKOFF_MS = [100, 400, 1600] as const;

/** Maximum number of 5xx retries before giving up and keeping the queue. */
const MAX_RETRIES = RETRY_BACKOFF_MS.length;

/** HTTP request timeout for `flush()` (ms). */
const FLUSH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// RateLimitTracker
// ---------------------------------------------------------------------------

/**
 * Sliding-window rate-limit tracker. Records the timestamps of accepted
 * events and enforces the daily (1000/day) and per-minute (100/minute)
 * limits documented in event-catalog.md §6.
 *
 * The tracker is per-`user_id` (in practice: per process, since each CLI
 * invocation has one user_id). It is not persisted across processes —
 * the daily limit is also enforced server-side, so a process that
 * restarts mid-day and exceeds the client-side limit will simply have
 * the excess rejected by the server.
 */
class RateLimitTracker {
  /** Timestamps (ms since epoch) of accepted events, newest last. */
  private events: number[] = [];

  /**
   * Record an event at the given timestamp and return `true` if it was
   * accepted, `false` if it was dropped due to rate limiting.
   *
   * @param nowMs - The current time in milliseconds.
   * @returns `true` if the event was accepted; `false` if dropped.
   */
  record(nowMs: number): boolean {
    // Drop timestamps outside the daily window.
    const dayCutoff = nowMs - DAY_WINDOW_MS;
    while (this.events.length > 0 && this.events[0]! < dayCutoff) {
      this.events.shift();
    }

    // Count events in the last minute.
    const minuteCutoff = nowMs - MINUTE_WINDOW_MS;
    let minuteCount = 0;
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]! < minuteCutoff) break;
      minuteCount++;
    }

    if (minuteCount >= MINUTE_LIMIT) return false;
    if (this.events.length >= DAILY_LIMIT) return false;

    this.events.push(nowMs);
    return true;
  }

  /**
   * Returns the number of events accepted in the trailing day window.
   * Exposed for tests; not used by the client.
   */
  dayCount(nowMs: number): number {
    const cutoff = nowMs - DAY_WINDOW_MS;
    return this.events.filter((t) => t >= cutoff).length;
  }
}

// ---------------------------------------------------------------------------
// TelemetryClient
// ---------------------------------------------------------------------------

/**
 * Options accepted by the {@link TelemetryClient} constructor.
 */
export interface TelemetryClientOptions {
  /** Resolved Linuxify configuration (provides `telemetry.*` settings). */
  readonly config: Config;
  /** Open state store (provides `state.telemetry.user_id`). */
  readonly stateStore: StateStore;
  /** Absolute path to the queue file (`~/.linuxify/telemetry/queue.jsonl`). */
  readonly queuePath: string;
}

/**
 * Telemetry client. One instance per CLI process, constructed by
 * {@link createTelemetryClient} in `src/telemetry/index.ts`.
 *
 * The client is intentionally sync-by-default for `track()` (events are
 * appended to the queue with `appendFileSync`) so that events emitted
 * during a crash are not lost in an unflushed buffer. The `flush()`
 * method is async (it does network I/O).
 *
 * Usage:
 * ```ts
 * const client = createTelemetryClient(config, stateStore);
 * await client.init();        // generate user_id if opted-in and not set
 * client.track('bootstrap.start', { stages_planned: 9 });
 * await client.flush();       // send queued events to the server
 * ```
 */
export class TelemetryClient {
  /** Resolved config (provides telemetry.enabled, telemetry.endpoint, etc.). */
  private readonly config: Config;
  /** Open state store (for user_id read/write and last_flush update). */
  private readonly stateStore: StateStore;
  /** Absolute path to the queue file. */
  private readonly queuePath: string;
  /** Per-process session UUIDv7 (generated once, reused for every event). */
  private readonly sessionId: string;
  /** OS metadata cached once at construction (avoid repeated getprop calls). */
  private readonly os: { android_version: string | null; arch: string };
  /** Cached user_id (null until first read or until `init()` runs). */
  private userId: string | null = null;
  /** Whether `init()` has run (so we don't retry user_id generation). */
  private initDone = false;
  /** In-memory rate-limit tracker. */
  private readonly rateLimiter = new RateLimitTracker();
  /** Whether the rate-limit warning has been logged in the current burst. */
  private rateLimitWarned = false;

  /**
   * @param opts - Constructor options. See {@link TelemetryClientOptions}.
   */
  constructor(opts: TelemetryClientOptions) {
    this.config = opts.config;
    this.stateStore = opts.stateStore;
    this.queuePath = opts.queuePath;
    this.sessionId = randomId();
    // getAndroidVersion is async (shells out to getprop on Termux); we
    // cache null at construction and let init() fill it in. The arch is
    // sync, so we read it here.
    this.os = { android_version: null, arch: getArch() };
  }

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  /**
   * Initialize the client. This is the async counterpart to the sync
   * constructor: it loads state, reads (or generates) the `user_id`, and
   * probes the Android version via `getprop`. The CLI should call this
   * once after construction, before any `track()` calls.
   *
   * If telemetry is disabled, `init()` is a no-op (it does not generate
   * a user_id).
   *
   * @returns Resolves when initialization is complete.
   */
  async init(): Promise<void> {
    if (this.initDone) return;
    this.initDone = true;

    // Probe Android version (no-op outside Termux).
    try {
      this.os.android_version = await getAndroidVersion();
    } catch {
      this.os.android_version = null;
    }

    if (!this.isEnabled()) return;

    // Load state and read or generate user_id.
    try {
      const state = await this.stateStore.load();
      if (state.telemetry.user_id === null) {
        // First opt-in: generate a UUIDv4 and persist.
        const newId = uuidV4();
        await this.stateStore.update((s) => {
          s.telemetry.user_id = newId;
          s.telemetry.enabled = true;
        });
        this.userId = newId;
        logger.debug({ user_id: newId }, 'telemetry: generated new user_id on first enable');
      } else {
        this.userId = state.telemetry.user_id;
      }
    } catch (err) {
      // State read failure — degrade gracefully with null user_id. The
      // server still accepts events with null user_id (per the schema).
      logger.debug({ err: (err as Error).message }, 'telemetry: state load failed; user_id=null');
      this.userId = null;
    }
  }

  // -------------------------------------------------------------------------
  // isEnabled()
  // -------------------------------------------------------------------------

  /**
   * Returns `true` if telemetry collection is enabled. Telemetry is on
   * only when *both* of the following hold:
   *
   *   1. `config.telemetry.enabled === true` (the user's persistent
   *      preference, set via `linuxify config telemetry true`).
   *   2. `LINUXIFY_TELEMETRY !== '0'` (the CI / shell-session escape
   *      hatch, per telemetry-privacy.md §11).
   *
   * If either is false, telemetry is off and `track()` short-circuits.
   *
   * @returns `true` if telemetry is enabled.
   */
  isEnabled(): boolean {
    if (process.env.LINUXIFY_TELEMETRY === '0') return false;
    return this.config.telemetry.enabled === true;
  }

  // -------------------------------------------------------------------------
  // track()
  // -------------------------------------------------------------------------

  /**
   * Emit a telemetry event. If telemetry is disabled, this is a no-op
   * (the event is not even constructed — saving CPU on the disabled
   * path, per the task spec). If enabled, the event is rate-limited,
   * sampled (for high-volume event types), constructed, redacted, and
   * appended to the queue file.
   *
   * The method is synchronous: the queue write uses `appendFileSync`
   * with `O_APPEND` so the event is durable before the method returns.
   * This is intentional — events emitted during a crash must not be
   * lost in an unflushed buffer.
   *
   * @param eventType - The event type (must be in {@link TelemetryEventType}).
   * @param fields - Event-specific payload. Redacted before queue write.
   * @returns `true` if the event was queued; `false` if it was dropped
   *   (disabled, rate-limited, or sampled out).
   */
  track(eventType: TelemetryEventType, fields: Record<string, unknown> = {}): boolean {
    if (!this.isEnabled()) return false;

    const now = Date.now();

    // Rate limiting.
    if (!this.rateLimiter.record(now)) {
      if (!this.rateLimitWarned) {
        logger.warn(
          { event_type: eventType },
          'telemetry: rate limit reached (1000/day or 100/min); dropping events',
        );
        this.rateLimitWarned = true;
      }
      return false;
    }
    // Reset the warning flag after a quiet minute so a future burst warns again.
    if (now % MINUTE_WINDOW_MS < 1000) {
      // cheap heuristic — see event-catalog.md §6
      this.rateLimitWarned = false;
    }

    // Construct event (we need the event_id for sampling decision).
    const event: TelemetryEvent = {
      event_id: randomId(),
      event_type: eventType,
      timestamp: new Date(now).toISOString(),
      linuxify_version: LINUXIFY_VERSION,
      user_id: this.userId,
      session_id: this.sessionId,
      os: { ...this.os },
      fields,
    };

    // Sampling (deterministic per event_id, only for high-volume types).
    if (SAMPLED_EVENT_TYPES.has(eventType)) {
      if (!shouldSample(event.event_id, this.config.telemetry.sample_rate)) {
        return false;
      }
    }

    // Redact.
    const redacted = redactEvent(event);

    // Append to queue (sync, durable).
    try {
      this.appendToQueue(redacted);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message, queuePath: this.queuePath },
        'telemetry: failed to append to queue; event lost',
      );
      return false;
    }

    logger.debug({ event_id: redacted.event_id, event_type: redacted.event_type }, 'telemetry: event queued');
    return true;
  }

  // -------------------------------------------------------------------------
  // flush()
  // -------------------------------------------------------------------------

  /**
   * Flush the queue: read all queued events, POST them as NDJSON to
   * `config.telemetry.endpoint`, and on success clear the queue and
   * update `state.telemetry.last_flush`.
   *
   * Response handling (per event-catalog.md §9):
   *   - **200 / 204**: success. Queue cleared, `last_flush` updated.
   *   - **4xx** (including 429): the server has decided the batch is
   *     bad or rate-limited. Log an error and clear the queue (don't
   *     retry bad data).
   *   - **5xx**: server error. Retry up to 3 times with exponential
   *     backoff (100ms, 400ms, 1600ms). If all retries fail, keep the
   *     queue for the next flush.
   *   - **Network error** (fetch throws): keep the queue, try next flush.
   *
   * The endpoint URL is `${config.telemetry.endpoint}/events` (the
   * config provides the base URL `https://telemetry.linuxify.sh/v2`).
   *
   * @returns Resolves when the flush attempt is complete. Never throws —
   *   flush failures are logged and the queue is preserved for retry.
   */
  async flush(): Promise<void> {
    const events = this.show();
    if (events.length === 0) {
      logger.debug('telemetry: flush called with empty queue');
      return;
    }

    const endpoint = this.config.telemetry.endpoint.replace(/\/$/, '');
    const url = `${endpoint}/events`;
    const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';

    // Attempt the POST with retry on 5xx.
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(url, body, FLUSH_TIMEOUT_MS);
      } catch (err) {
        // Network error — keep queue, try next flush.
        logger.warn(
          { err: (err as Error).message, attempt },
          'telemetry: flush network error; keeping queue',
        );
        return;
      }

      if (response.status >= 200 && response.status < 300) {
        // Success — clear queue, update last_flush.
        await this.clearQueue();
        await this.updateLastFlush();
        logger.info(
          { count: events.length, status: response.status },
          'telemetry: flush succeeded',
        );
        return;
      }

      if (response.status >= 400 && response.status < 500) {
        // 4xx — bad data or rate-limited. Clear queue (don't retry bad data).
        logger.error(
          { status: response.status, count: events.length },
          'telemetry: flush rejected (4xx); clearing queue to prevent retry loop',
        );
        await this.clearQueue();
        return;
      }

      // 5xx — retry with backoff.
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS[attempt]!;
        logger.warn(
          { status: response.status, attempt: attempt + 1, backoff_ms: backoff },
          'telemetry: flush got 5xx; retrying with backoff',
        );
        await sleep(backoff);
      } else {
        // Out of retries — keep queue for next flush.
        logger.warn(
          { status: response.status, attempts: attempt + 1 },
          'telemetry: flush exhausted retries; keeping queue',
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // show()
  // -------------------------------------------------------------------------

  /**
   * Read and return the events currently in the local queue. Used by
   * `linuxify telemetry show` to display what would be sent on the next
   * flush. Returns an empty array if the queue file does not exist.
   *
   * Lines that fail to parse as JSON are skipped (with a debug log) so a
   * corrupt queue does not break the command.
   *
   * @returns An array of {@link TelemetryEvent} objects.
   */
  show(): TelemetryEvent[] {
    if (!existsSync(this.queuePath)) return [];
    let text: string;
    try {
      text = readFileSync(this.queuePath, 'utf8');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'telemetry: failed to read queue');
      return [];
    }
    const events: TelemetryEvent[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as TelemetryEvent);
      } catch {
        logger.debug({ line }, 'telemetry: skipping unparseable queue line');
      }
    }
    return events;
  }

  // -------------------------------------------------------------------------
  // purge()
  // -------------------------------------------------------------------------

  /**
   * Delete the local queue file. Used by `linuxify telemetry purge`.
   * Already-sent events (which are no longer on the client) are not
   * affected; use `linuxify telemetry purge-remote` for those.
   *
   * Idempotent: no error if the queue file does not exist.
   *
   * @returns Resolves when the queue file has been deleted (or was
   *   already absent).
   */
  async purge(): Promise<void> {
    try {
      rmSync(this.queuePath, { force: true });
      logger.info({ queuePath: this.queuePath }, 'telemetry: queue purged');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'telemetry: purge failed');
    }
  }

  // -------------------------------------------------------------------------
  // export()
  // -------------------------------------------------------------------------

  /**
   * Export the queue as a pretty-printed JSON string. Used by
   * `linuxify telemetry export` to produce a file the user can inspect
   * or share with maintainers for debugging.
   *
   * @returns A JSON string containing an array of {@link TelemetryEvent}.
   */
  async export(): Promise<string> {
    const events = this.show();
    return JSON.stringify(events, null, 2);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Append a single event (as a compact-JSON line) to the queue file.
   * Creates the parent directory with mode 0700 if missing, and ensures
   * the queue file is mode 0600. Uses `appendFileSync` with `O_APPEND`
   * so the write is durable before the method returns.
   */
  private appendToQueue(event: TelemetryEvent): void {
    const dir = dirname(this.queuePath);
    mkdirSync(dir, { recursive: true, mode: QUEUE_DIR_MODE });
    try {
      chmodSync(dir, QUEUE_DIR_MODE);
    } catch {
      /* umask may have already applied; ignore */
    }
    const line = JSON.stringify(event) + '\n';
    appendFileSync(this.queuePath, line, { encoding: 'utf8', mode: QUEUE_FILE_MODE });
    // Best-effort chmod on the file (mode option only applies on create).
    try {
      chmodSync(this.queuePath, QUEUE_FILE_MODE);
    } catch {
      /* ignore */
    }
  }

  /**
   * Clear the queue file. Truncates rather than deletes so the file
   * retains its mode 0600 across clears.
   */
  private async clearQueue(): Promise<void> {
    try {
      writeFileSync(this.queuePath, '', { encoding: 'utf8', mode: QUEUE_FILE_MODE });
      try {
        chmodSync(this.queuePath, QUEUE_FILE_MODE);
      } catch {
        /* ignore */
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'telemetry: failed to clear queue');
    }
  }

  /**
   * Update `state.telemetry.last_flush` to the current ISO timestamp.
   * Best-effort: failures are logged but do not fail the flush.
   */
  private async updateLastFlush(): Promise<void> {
    try {
      await this.stateStore.update((s) => {
        s.telemetry.last_flush = new Date().toISOString();
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'telemetry: failed to update last_flush');
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic sampling decision. Computes
 * `parseInt(sha256(event_id).slice(0, 8), 16) % 1000 / 1000.0` and
 * returns `true` if the result is less than `sampleRate`.
 *
 * The hash is deterministic so a re-send of the same event (e.g. after
 * a network failure) produces the same sampling decision, which lets
 * the server deduplicate by `event_id` (per event-catalog.md §7).
 *
 * @param eventId - The event's UUIDv7 `event_id`.
 * @param sampleRate - A number in `[0, 1]`. `0` drops all; `1` keeps all.
 * @returns `true` if the event should be queued; `false` if sampled out.
 */
export function shouldSample(eventId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const hash = sha256(eventId).slice(0, 8);
  const num = parseInt(hash, 16);
  return (num % 1000) / 1000.0 < sampleRate;
}

/**
 * Fetch with a timeout. Wraps the global `fetch` with an `AbortController`
 * so a hung server does not block the flush indefinitely.
 *
 * @param url - The URL to POST to.
 * @param body - The NDJSON body.
 * @param timeoutMs - Timeout in milliseconds.
 * @returns The `Response` from the server.
 */
async function fetchWithTimeout(url: string, body: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        'User-Agent': `linuxify/${LINUXIFY_VERSION}`,
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve after `ms` milliseconds. Unref'd so the timer does not keep
 * the event loop alive in tests.
 *
 * @param ms - Milliseconds to wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
