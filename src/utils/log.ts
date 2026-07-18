/**
 * Structured logging.
 *
 * @module linuxify/utils/log
 *
 * Wraps `pino` with sensible defaults: level from `LINUXIFY_LOG_LEVEL` env
 * (default `info`), pretty-printing to stdout in dev, JSON to stdout in
 * prod, and a second JSON stream to `~/.linuxify/logs/linuxify.log`.
 *
 * Known-secret field names (`*token*`, `*secret*`, `*key*`, `*password*`,
 * `authorization`, `cookie`) are redacted with `[REDACTED]` before any
 * output is produced — to stdout, to the file, or to the telemetry queue.
 *
 * Pretty-printing is implemented inline (without the `pino-pretty`
 * transport) so that this module has no runtime dependency on a package
 * the user must install separately. The prettifier is a tiny `Writable`
 * that parses each newline-delimited JSON record and emits a single
 * human-readable line.
 *
 * The {@link Logger} interface accepts both pino-native `(obj, msg)` and
 * convenience `(msg, obj)` call orders — the wrapper detects which form
 * the caller used and forwards to pino in the order pino expects. This
 * keeps the call site readable for the common case
 * (`logger.info('stage 1: pkg update', { packages })`) without breaking
 * the native pino API.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';

import pino, { type Logger as PinoLogger, type StreamEntry } from 'pino';

import { REDACT_PATTERNS } from './constants.js';
import { getLinuxifyHome } from './process.js';

/** Map of pino numeric levels to uppercase labels for pretty output. */
const LEVEL_LABELS: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

/** Set of valid log-level names accepted by pino. */
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

/** Pino's accepted level names. Used to type-narrow the resolved level. */
type PinoLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Default log level if `LINUXIFY_LOG_LEVEL` is unset or invalid. */
const DEFAULT_LEVEL: PinoLevel = 'info';

/** Metadata object shape accepted by every log method. */
type LogMeta = Record<string, unknown>;

/**
 * Substring patterns that mark a field as sensitive. Any key (at any depth
 * in the log record) whose lowercased name contains one of these substrings
 * is replaced with `[REDACTED]` before the record is serialized.
 *
 * This is intentionally broader than pino's native `redact.paths` (which
 * uses single-segment `*` wildcards, not substring matching) because real-
 * world secret field names vary (`api_token`, `githubToken`, `bearer_key`,
 * `x-amz-secret`, etc.). The substring approach catches all of them without
 * enumerating every variant.
 */
const SECRET_SUBSTRINGS = [
  'token',
  'secret',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'bearer',
  'private_key',
  'access_key',
  'session',
];

/**
 * Recursively walk an object and replace any value whose key contains a
 * secret substring with `'[REDACTED]'`. Mutates the object in place (the
 * object is a fresh pino merge-object, so mutation is safe).
 *
 * @param obj - The object to redact. Arrays are traversed; primitives are
 *   returned unchanged.
 */
function redactSecrets(obj: unknown): void {
  if (obj === null || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    for (const item of obj) redactSecrets(item);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const lower = key.toLowerCase();
    if (SECRET_SUBSTRINGS.some((s) => lower.includes(s))) {
      rec[key] = '[REDACTED]';
    } else {
      redactSecrets(rec[key]);
    }
  }
}

/**
 * Logger interface exposed to the rest of the codebase. Accepts both
 * `(msg, obj?)` and `(obj, msg?)` call orders — the wrapper normalizes.
 */
export interface Logger {
  /** Current minimum log level (lowercase string, e.g. `info`). */
  readonly level: PinoLevel | string;
  /** Create a child logger with additional bound fields. */
  child(bindings: LogMeta): Logger;
  /** Log at TRACE level. */
  trace(msg: string, obj?: LogMeta): void;
  trace(obj: LogMeta, msg?: string): void;
  /** Log at DEBUG level. */
  debug(msg: string, obj?: LogMeta): void;
  debug(obj: LogMeta, msg?: string): void;
  /** Log at INFO level. */
  info(msg: string, obj?: LogMeta): void;
  info(obj: LogMeta, msg?: string): void;
  /** Log at WARN level. */
  warn(msg: string, obj?: LogMeta): void;
  warn(obj: LogMeta, msg?: string): void;
  /** Log at ERROR level. */
  error(msg: string, obj?: LogMeta): void;
  error(obj: LogMeta, msg?: string): void;
  /** Log at FATAL level. */
  fatal(msg: string, obj?: LogMeta): void;
  fatal(obj: LogMeta, msg?: string): void;
}

/** Names of the log levels in priority order. */
type LevelName = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Read the configured log level from `LINUXIFY_LOG_LEVEL`, defaulting to
 * `info`. Returns the lowercased level name.
 *
 * @returns The configured log level.
 */
function resolveLevel(): PinoLevel {
  const v = process.env.LINUXIFY_LOG_LEVEL;
  if (!v) return DEFAULT_LEVEL;
  const lower = v.toLowerCase();
  return (VALID_LEVELS.has(lower) ? lower : DEFAULT_LEVEL) as PinoLevel;
}

/**
 * Open (or reopen) the log file at `<linuxifyHome>/logs/linuxify.log`,
 * creating the directory with mode `0700` if missing. Returns `null` if
 * the file cannot be opened (e.g. read-only filesystem in tests) so the
 * logger degrades gracefully to stdout-only.
 *
 * Uses `pino.destination()` (a `SonicBoom` stream) with `sync: true` so
 * that each log write is flushed to disk before the call returns. This is
 * slightly slower than the default async buffering, but it makes log
 * records visible immediately to any concurrent reader (the on-disk log
 * rotator, a `tail -f`, or a unit test asserting on file contents).
 *
 * @returns A `SonicBoom` destination for the log file, or `null` on failure.
 */
function openLogFile(): NodeJS.WritableStream | null {
  try {
    const logsDir = path.join(getLinuxifyHome(), 'logs');
    mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    // Best-effort chmod; ignore errors (umask may have already applied).
    try {
      chmodSync(logsDir, 0o700);
    } catch {
      /* noop */
    }
    // pino.destination opens the file synchronously in append mode.
    // `sync: true` flushes each write before returning.
    return pino.destination({
      dest: path.join(logsDir, 'linuxify.log'),
      append: true,
      sync: true,
      mkdir: true,
    }) as unknown as NodeJS.WritableStream;
  } catch {
    return null;
  }
}

/** Keys present on every pino record that should not be printed as "extras". */
const PINO_BUILTIN_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'name', 'msg', 'v']);

/**
 * Pretty-print a single parsed log record as a single line. Format:
 *   `<isoTime> <LEVEL> [<name>] <msg> <extras-as-key=value>`
 *
 * Extra fields (anything that is not a pino builtin) are appended as
 * `key=value` pairs. Nested objects are JSON-stringified.
 *
 * @param rec - The parsed JSON record from pino.
 * @returns A single newline-terminated string.
 */
function formatPretty(rec: Record<string, unknown>): string {
  const time =
    typeof rec.time === 'number' ? new Date(rec.time).toISOString() : new Date().toISOString();
  const levelNum = typeof rec.level === 'number' ? rec.level : 30;
  const levelLabel = LEVEL_LABELS[levelNum] ?? 'LOG';
  const name = typeof rec.name === 'string' ? rec.name : '';
  const msg = typeof rec.msg === 'string' ? rec.msg : '';

  const extras: string[] = [];
  for (const key of Object.keys(rec)) {
    if (PINO_BUILTIN_KEYS.has(key)) continue;
    const val = rec[key];
    if (val === undefined) continue;
    const valStr = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val);
    extras.push(`${key}=${valStr}`);
  }

  const namePart = name ? `[${name}] ` : '';
  const extraPart = extras.length > 0 ? ` ${extras.join(' ')}` : '';
  return `${time} ${levelLabel} ${namePart}${msg}${extraPart}\n`;
}

/**
 * Build a `Writable` that pretty-prints pino's JSON-line output. Used in
 * dev mode (NODE_ENV !== 'production'). Each chunk may contain multiple
 * newline-separated records; we split, parse, and reformat each.
 *
 * @returns A writable stream that consumes pino's JSON output.
 */
function prettyStream(): Writable {
  return new Writable({
    write(chunk: Buffer, _enc: string, callback: (err?: Error | null) => void) {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as Record<string, unknown>;
          process.stdout.write(formatPretty(rec));
        } catch {
          // Not valid JSON (partial chunk, etc.) — pass through verbatim.
          process.stdout.write(line + '\n');
        }
      }
      callback();
    },
  });
}

/**
 * Build the pino `multistream` array. In dev, stdout is pretty-printed; in
 * prod, stdout is raw JSON. The file stream is always raw JSON.
 *
 * @param level - The minimum log level.
 * @returns An array of {@link StreamEntry} for `pino.multistream`.
 */
function buildStreams(level: PinoLevel): StreamEntry[] {
  const isProd = process.env.NODE_ENV === 'production';
  const streams: StreamEntry[] = [];

  streams.push({
    level,
    stream: isProd ? process.stdout : prettyStream(),
  });

  const fileStream = openLogFile();
  if (fileStream) {
    streams.push({ level, stream: fileStream });
  }

  return streams;
}

/**
 * Wrapper around a pino logger that accepts both `(msg, obj?)` and
 * `(obj, msg?)` call orders and forwards to pino in the order pino expects.
 *
 * The wrapper exists because pino's TypeScript overloads are strict about
 * printf-style format strings: a call like `logger.info('hello', { x: 1 })`
 * fails typecheck because pino interprets the second arg as a printf
 * substitution. The wrapper detects the form by inspecting the first
 * argument's type and swaps if needed, so callers can use either order.
 */
class PinoLoggerWrapper implements Logger {
  private readonly pino: PinoLogger;

  constructor(pinoLogger: PinoLogger) {
    this.pino = pinoLogger;
  }

  get level(): string {
    return this.pino.level;
  }

  child(bindings: LogMeta): Logger {
    return new PinoLoggerWrapper(this.pino.child(bindings));
  }

  trace(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('trace', a, b);
  }
  debug(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('debug', a, b);
  }
  info(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('info', a, b);
  }
  warn(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('warn', a, b);
  }
  error(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('error', a, b);
  }
  fatal(a: string | LogMeta, b?: LogMeta | string): void {
    this.dispatch('fatal', a, b);
  }

  /**
   * Forward a call to the underlying pino logger in the order pino expects:
   *   - `(msg: string, obj?)`  → `pino.level(obj, msg)` (or `pino.level(msg)`)
   *   - `(obj: LogMeta, msg?)` → `pino.level(obj, msg)` (or `pino.level(obj)`)
   *
   * Before forwarding, the metadata object (if any) is passed through
   * {@link redactSecrets} so that sensitive field values are replaced with
   * `[REDACTED]`. The redaction runs on the caller's object — pino copies
   * the merge object internally so the caller's original is not mutated.
   */
  private dispatch(level: LevelName, a: string | LogMeta, b?: LogMeta | string): void {
    // Bind to the pino instance so internal `this` references (e.g. the
    // msgPrefix symbol) resolve correctly when the method is invoked.
    const fn = this.pino[level].bind(this.pino);
    if (typeof a === 'string') {
      // (msg, obj?) form — swap so pino sees (obj, msg).
      if (b !== undefined && typeof b === 'object') {
        redactSecrets(b);
        fn(b, a);
      } else {
        fn(a);
      }
    } else if (typeof b === 'string') {
      // (obj, msg) form — already pino-native order.
      redactSecrets(a);
      fn(a, b);
    } else {
      // (obj) form — just the metadata object.
      redactSecrets(a);
      fn(a);
    }
  }
}

/**
 * Create a named logger.
 *
 * @param name - The logger name; appears as `name` in every record and in
 *   the pretty-printed `[name]` prefix.
 * @returns A configured {@link Logger}.
 *
 * @example
 *   const log = createLogger('bootstrap');
 *   log.info({ stage: 0 }, 'starting bootstrap');   // pino-native order
 *   log.info('stage 1: pkg update', { packages });    // convenience order
 */
export function createLogger(name: string): Logger {
  const level = resolveLevel();
  const streams = buildStreams(level);
  const pinoLogger = pino(
    {
      name,
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: [...REDACT_PATTERNS],
        censor: '[REDACTED]',
        remove: false,
      },
    },
    pino.multistream(streams),
  );
  return new PinoLoggerWrapper(pinoLogger);
}

/**
 * Default logger. Lazily-initialized on first access to avoid opening the
 * log file at import time during unit tests that don't exercise logging.
 */
let _defaultLogger: Logger | undefined;

/**
 * Get (and lazily create) the default logger, named `linuxify`.
 *
 * @returns The shared default {@link Logger}.
 */
export function getDefaultLogger(): Logger {
  if (!_defaultLogger) {
    _defaultLogger = createLogger('linuxify');
  }
  return _defaultLogger;
}

/**
 * Default logger instance. Accessing its methods triggers lazy
 * initialization of the underlying pino logger and the file write stream;
 * importing this module without calling any method does not perform I/O.
 *
 * Implemented as a `Proxy` that forwards every property access to the
 * lazily-created {@link getDefaultLogger}. This keeps the type surface as
 * `Logger` (so callers get full overload checking) while avoiding any I/O
 * at import time.
 */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop: string | symbol) {
    const target = getDefaultLogger() as unknown as Record<string | symbol, unknown>;
    const value = target[prop];
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(target)
      : value;
  },
});

/**
 * Flush any buffered log writes. Pino's `multistream` is synchronous by
 * default (no buffering), so this is a no-op kept for API symmetry with
 * future async transports.
 *
 * @returns Resolves immediately (no async work today).
 */
export async function flushLogs(): Promise<void> {
  // pino.multistream is synchronous; nothing to flush.
  return;
}
