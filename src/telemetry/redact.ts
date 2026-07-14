/**
 * Privacy filter for telemetry events.
 *
 * @module linuxify/telemetry/redact
 *
 * Before an event is appended to the local queue
 * (`~/.linuxify/telemetry/queue.jsonl`), it passes through
 * {@link redactEvent} — a deterministic, side-effect-free function that
 * strips or masks any value that could carry user data. The rules are
 * documented in `docs/24-telemetry/event-catalog.md` §4 and
 * `docs/24-telemetry/telemetry-privacy.md` §3.
 *
 * The redactor is applied *after* the event is constructed, not at
 * field-write time, so a contributor adding a new field does not need to
 * remember to redact — the redactor catches it. The redactor is unit-tested
 * against a corpus of known-leaky inputs (real paths, real env vars, real
 * stack traces from prior bugs) and the test fails on any input that
 * produces a leak.
 *
 * Redaction rules:
 *   - **File paths** are replaced with `<path>`. A path is any string that
 *     looks like a Unix absolute path (`/foo/bar`), a Windows path
 *     (`C:\foo\bar`), a relative path with a slash (`foo/bar`), or a
 *     `~/.linuxify/...` reference. The replacement is structural — the
 *     original path is gone.
 *   - **Env var values** are replaced with `<redacted>`. Any value in a
 *     field named `env`, `environment`, or `env_vars` is replaced
 *     wholesale; env var *names* (the keys) are preserved because they are
 *     structural (`OPENAI_API_KEY` was set, but its value is secret).
 *   - **Command arguments** are replaced with `<args>`. Any field named
 *     `args` (an array) is replaced with `["<args>"]` of the same length,
 *     so the arg count is preserved without leaking the arg contents.
 *   - **URLs with authentication** are stripped of credentials:
 *     `https://user:pass@host/path` becomes `https://<redacted>@host/path`.
 *   - **Strings matching secret patterns** (`*_token*`, `*_secret*`,
 *     `*_key*`, `*_password*`, `authorization`, `cookie`, `*_bearer*`,
 *     `*_apikey*`, `*_api_key*`) — both the field key *and* the value —
 *     are replaced with `***REDACTED***`. The pattern list mirrors
 *     {@link REDACT_PATTERNS} in `src/utils/constants.ts` so the logger
 *     and the telemetry redactor stay in sync.
 *
 * @packageDocumentation
 */

import { REDACT_PATTERNS } from '../utils/constants.js';

import type { TelemetryEvent } from './types.js';

// ---------------------------------------------------------------------------
// Pattern compilation
// ---------------------------------------------------------------------------

/**
 * Substrings (lowercased) that mark a field as sensitive. A field whose
 * lowercased name contains any of these substrings has its value replaced
 * with `***REDACTED***`. Mirrors {@link REDACT_PATTERNS} in
 * `src/utils/constants.ts` (which uses pino-style `*token*` wildcards);
 * here we strip the leading/trailing `*` to get a plain substring match.
 */
const SECRET_SUBSTRINGS: readonly string[] = REDACT_PATTERNS.map((p) =>
  p.toLowerCase().replace(/^\*+|\*+$/g, ''),
);

/**
 * Field names (lowercased) whose *values* are replaced wholesale with
 * `<redacted>`. The keys are preserved (they are structural). Per
 * event-catalog.md §4, env-var values are stripped but env-var names are
 * kept.
 */
const ENV_FIELD_NAMES = new Set(['env', 'environment', 'env_vars']);

/**
 * Field names (lowercased) whose array values are replaced with
 * `["<args>"]` of the same length. The `cli.invoked` event deliberately
 * does not have an `args` field; if a future event type tried to add one,
 * the redactor would mask the contents while preserving the count.
 */
const ARGS_FIELD_NAMES = new Set(['args', 'argv']);

/**
 * Replacement token for redacted file paths.
 * @see {@link redactString}
 */
export const PATH_TOKEN = '<path>';

/**
 * Replacement token for redacted env-var values.
 * @see {@link redactObject}
 */
export const ENV_TOKEN = '<redacted>';

/**
 * Replacement token for redacted command-arg array elements.
 * @see {@link redactObject}
 */
export const ARGS_TOKEN = '<args>';

/**
 * Replacement token for redacted secret values.
 * @see {@link redactObject}
 */
export const SECRET_TOKEN = '***REDACTED***';

// ---------------------------------------------------------------------------
// Compiled regexes
// ---------------------------------------------------------------------------

/**
 * Match a Unix absolute path (`/foo/bar`), a Windows path (`C:\foo\bar`),
 * a `~`-prefixed home path, or a relative path containing a slash with a
 * file extension. We deliberately do NOT match bare `foo/bar` identifiers
 * (e.g. `distro/arch`) to avoid false positives on short tokens that
 * happen to contain a slash; we require either a leading `/`, `~`, or a
 * Windows drive letter, OR a path with a file extension (`.json`, `.js`,
 * etc.) which is a stronger signal that the string is a file path.
 *
 * The pattern is intentionally conservative: false negatives (leaking a
 * path) are worse than false positives (over-redacting a non-path), but
 * we still want to avoid turning every slash-containing string into
 * `<path>` because that would erase useful non-path data like
 * `node-22`/`ubuntu`/`aarch64`.
 *
 * Anchoring: the regex does NOT use `^` — paths can appear mid-string
 * (e.g. `"failed at /etc/passwd"`) and we redact the path token wherever
 * it appears. The negative lookbehind `(?<![\/\w:])` prevents matching
 * the path-like part of a URL (e.g. `https://example.com/v2/events`
 * is preserved, not redacted as `<path>`). The negative lookahead
 * `(?!\/)` on the first alternative prevents matching `//foo` (which
 * is a URL scheme separator, not a path root).
 */
const PATH_REGEX =
  /(?<![/\w:])(\/(?!\/)[^\s*]+?\/[^\s*]+)|(?<![/\w:])([A-Za-z]:[\\/][^\s*]+)|(?<![/\w:])(~\/[^\s*]+)|(?<![/\w:])([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s*]*[.][A-Za-z0-9]+)/g;

/**
 * Match credentials embedded in a URL: `scheme://user:pass@host`. We
 * capture the `user:pass@` part so we can replace it with
 * `<redacted>@`, leaving the scheme and host intact (the host is needed
 * for analytics; the credentials are never needed).
 */
const URL_CREDENTIALS_REGEX = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]+(?::[^\s/@]+)?)@/g;

/**
 * Match a `Bearer <token>` HTTP authorization header value. The whole
 * `Bearer xxx` is replaced with `Bearer ***REDACTED***`.
 */
const BEARER_TOKEN_REGEX = /(Bearer\s+)[^\s]+/g;

/**
 * Match common API-key formats: AWS `AKIA...` access keys, GitHub
 * `gh[pousr]_...` tokens, and `xox[baprs]-...` Slack tokens. These are
 * caught here as a defense-in-depth even if the field name didn't match
 * a secret substring (a leaky stack trace might print one inline).
 */
const INLINE_SECRET_REGEX =
  /(AKIA[0-9A-Z]{16})|(gh[pousr]_[A-Za-z0-9]{36,})|(xox[baprs]-[A-Za-z0-9-]+)/g;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the lowercased field name contains any of the
 * {@link SECRET_SUBSTRINGS}. Used to decide whether to replace the
 * field's value with `***REDACTED***`.
 */
function isSecretFieldName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_SUBSTRINGS.some((s) => s.length > 0 && lower.includes(s));
}

/**
 * Returns `true` if the lowercased field name is an env-var container
 * (`env`, `environment`, `env_vars`).
 */
function isEnvFieldName(name: string): boolean {
  return ENV_FIELD_NAMES.has(name.toLowerCase());
}

/**
 * Returns `true` if the lowercased field name is a command-args container
 * (`args`, `argv`).
 */
function isArgsFieldName(name: string): boolean {
  return ARGS_FIELD_NAMES.has(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------

/**
 * Apply path / URL-credentials / Bearer / inline-secret redaction to a
 * single string. This is the leaf-level redactor; the object walker
 * ({@link redactObject}) calls this for every string value it encounters
 * that is not already inside a secret/env/args field (those are replaced
 * wholesale without inspecting the value).
 *
 * The replacements are applied in order: URL credentials → Bearer tokens
 * → inline API keys → file paths. Each pass is independent; the order
 * ensures a path-like string inside a URL credential is not double-
 * redacted.
 *
 * @param s - The string to redact.
 * @returns A new string with all sensitive substrings replaced.
 *
 * @example
 *   redactString('/data/data/com.termux/files/home/.linuxify/state.json');
 *   // => '<path>'
 *
 *   redactString('https://alice:hunter2@registry.example.com/v2/events');
 *   // => 'https://<redacted>@registry.example.com/v2/events'
 *
 *   redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...');
 *   // => 'Authorization: Bearer ***REDACTED***'
 */
export function redactString(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return s;

  // 1. Strip URL credentials (user:pass@host → <redacted>@host).
  let out = s.replace(URL_CREDENTIALS_REGEX, (_m, scheme: string) => `${scheme}<redacted>@`);

  // 2. Replace `Bearer <token>` with `Bearer ***REDACTED***`.
  out = out.replace(BEARER_TOKEN_REGEX, (_m, prefix: string) => `${prefix}${SECRET_TOKEN}`);

  // 3. Replace inline AWS / GitHub / Slack tokens.
  out = out.replace(INLINE_SECRET_REGEX, SECRET_TOKEN);

  // 4. Replace file paths with `<path>`.
  out = out.replace(PATH_REGEX, PATH_TOKEN);

  return out;
}

// ---------------------------------------------------------------------------
// redactObject
// ---------------------------------------------------------------------------

/**
 * Recursively walk an object and apply redaction rules. Returns a *new*
 * object (the input is not mutated) with:
 *   - Secret-named fields' values replaced with `***REDACTED***`.
 *   - Env-named fields' values replaced with `<redacted>` (keys preserved).
 *   - Args-named array fields' elements replaced with `<args>` (length
 *     preserved).
 *   - All other string values passed through {@link redactString}.
 *
 * Arrays are traversed element-by-element; primitives other than strings
 * are returned unchanged.
 *
 * @param value - The value to redact (object, array, or primitive).
 * @returns A redacted deep copy of `value`.
 */
export function redactObject<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as unknown as T;
  }

  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (isSecretFieldName(key)) {
      // Secret field — replace the value wholesale, regardless of type.
      out[key] = SECRET_TOKEN;
    } else if (isEnvFieldName(key) && v !== null && typeof v === 'object') {
      // Env-var container — replace each value with `<redacted>`, keep keys.
      out[key] = redactEnvValues(v);
    } else if (isArgsFieldName(key) && Array.isArray(v)) {
      // Args array — replace each element with `<args>`, preserve length.
      out[key] = v.map(() => ARGS_TOKEN);
    } else {
      out[key] = redactObject(v);
    }
  }
  return out as unknown as T;
}

/**
 * Walk an env-var container object and replace every value with
 * `<redacted>`, preserving the keys. Nested objects are walked
 * recursively (in case of `env_vars: { nested: { KEY: 'val' } }`).
 *
 * @param envObj - The env-var container (value of a field named `env` etc.).
 * @returns A new object (or array) with the same shape but redacted values.
 */
function redactEnvValues(envObj: unknown): unknown {
  if (envObj === null || typeof envObj !== 'object') {
    return envObj;
  }
  if (Array.isArray(envObj)) {
    return envObj.map(() => ENV_TOKEN);
  }
  const obj = envObj as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') {
      // Nested env container — recurse to preserve structure.
      out[key] = redactEnvValues(v);
    } else {
      out[key] = ENV_TOKEN;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// redactEvent
// ---------------------------------------------------------------------------

/**
 * Apply the full redaction pipeline to a {@link TelemetryEvent}. Returns a
 * *new* event object (the input is not mutated) with:
 *   - `fields` recursively redacted via {@link redactObject}.
 *   - Envelope fields (`event_id`, `event_type`, `timestamp`,
 *     `linuxify_version`, `user_id`, `session_id`) left intact — these are
 *     structural and do not carry user data. `user_id` is a UUID, not a
 *     user identity; `session_id` is a per-process UUID.
 *   - `os.android_version` and `os.arch` left intact (per the privacy
 *     contract, these are the minimum needed for compat-matrix
 *     segmentation).
 *
 * The `fields` object is the only field that carries event-type-specific
 * payload, so it is the only field that needs recursive redaction.
 *
 * @param event - The event to redact.
 * @returns A new {@link TelemetryEvent} with `fields` redacted.
 *
 * @example
 *   const redacted = redactEvent({
 *     event_id: '...',
 *     event_type: 'package.install_failed',
 *     ...
 *     fields: {
 *       package_hash: '9f8d...',
 *       version: '1.2.0',
 *       error_message: 'failed at /home/alice/.linuxify/patches/cline/001.json',
 *     },
 *   });
 *   // redacted.fields.error_message === 'failed at <path>'
 */
export function redactEvent(event: TelemetryEvent): TelemetryEvent {
  return {
    ...event,
    fields: redactObject(event.fields),
  };
}
