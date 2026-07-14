/**
 * Sed-style patch-type handler.
 *
 * @module linuxify/patcher/types/sed
 *
 * Implements a small subset of `sed` syntax — enough for the substitution
 * expressions Linuxify patches actually use (`s/find/replace/` and
 * `s/find/replace/g`). We do NOT shell out to `/usr/bin/sed` (which may
 * not be installed on the host Termux, and whose GNU vs. BSD differences
 * are a recurring source of bugs); instead we parse the expression in
 * pure TypeScript and apply it via `String.prototype.replace`.
 *
 * Supported forms:
 *   - `s/PATTERN/REPLACEMENT/`       — replace first occurrence only.
 *   - `s/PATTERN/REPLACEMENT/g`      — replace all occurrences.
 *   - `s|PATTERN|REPLACEMENT|g`      — alternate delimiter (`|`, `#`,
 *                                       `,`, `:`, `;` also accepted).
 *
 * The PATTERN is treated as a JavaScript regex source (so `.` matches
 * any char, `\.` matches a literal dot, etc.). The REPLACEMENT is a
 * literal string with `$1`/`$2`/… for capture groups (matching JS
 * `String.prototype.replace` semantics, not sed's `\1`/`\2`).
 *
 * Unsupported (will throw on parse):
 *   - Address ranges (`1,5s/.../.../`).
 *   - Other commands (`d`, `p`, `y`, `!`).
 *   - The `i` / `m` / `s` flags (only `g` is honored).
 *
 * If you need any of the above, use the `shell` patch type and shell out
 * to a real `sed` (or `python-ast` / `ast-js` for structural edits).
 */

import type { PatchHandlerResult, PatchTypeHandler } from '../types.js';

/**
 * Delimiters accepted in place of `/` in a sed substitution. The first
 * character after the leading `s` becomes the delimiter; this set lists
 * the characters that are reasonable delimiters (anything else is likely
 * a typo and is rejected at parse time).
 */
const ALLOWED_DELIMITERS = new Set(['/', '|', '#', ',', ':', ';', '@', '~']);

/** Flags supported by the sed handler. Currently just `g` (global). */
const SUPPORTED_FLAGS = new Set(['g']);

/**
 * Parse a sed `s/.../.../...` expression.
 *
 * @param expression - The sed expression to parse (e.g. `s/foo/bar/g`).
 * @returns `{ pattern, replacement, global }` on success.
 * @throws {Error} if the expression is not a valid substitution form.
 */
function parseSedExpression(
  expression: string,
): { pattern: string; replacement: string; global: boolean } {
  const trimmed = expression.trim();
  if (!trimmed.startsWith('s')) {
    throw new Error(
      `sed expression must start with 's' (only substitution is supported): ${expression}`,
    );
  }

  const delimiter = trimmed[1];
  if (!delimiter || !ALLOWED_DELIMITERS.has(delimiter)) {
    throw new Error(
      `sed expression uses unsupported delimiter '${delimiter}'; ` +
        `allowed: ${[...ALLOWED_DELIMITERS].join(' ')}`,
    );
  }

  // Walk the rest of the string, splitting on unescaped `delimiter`.
  // Backslash-escaped delimiters (`\/`, `\|`) become literal delimiters
  // in the pattern/replacement.
  const parts: string[] = [];
  let current = '';
  for (let i = 2; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '\\' && i + 1 < trimmed.length) {
      // Preserve the next char literally (it might be the delimiter).
      current += ch + (trimmed[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === delimiter) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  // The trailing segment holds the flags (e.g. `g`) — push it last.
  parts.push(current);

  if (parts.length !== 3) {
    throw new Error(
      `sed substitution must have exactly 2 delimiter-separated sections ` +
        `(pattern, replacement, flags); got ${parts.length - 1} in: ${expression}`,
    );
  }

  const [pattern, replacement, flags] = parts;
  if (!pattern) {
    throw new Error(`sed substitution has empty pattern in: ${expression}`);
  }

  let global = false;
  for (const f of flags ?? '') {
    if (!SUPPORTED_FLAGS.has(f)) {
      throw new Error(
        `sed substitution has unsupported flag '${f}'; only 'g' is supported`,
      );
    }
    if (f === 'g') global = true;
  }

  return { pattern, replacement: replacement ?? '', global };
}

/**
 * Apply a sed-style substitution to `content`.
 *
 * @param content - The current file content.
 * @param expression - The sed expression (e.g. `s/foo/bar/g`).
 * @returns `{ success, result }`. `success` is `false` when the pattern
 *   matched zero occurrences — same semantics as the regex handler, so
 *   the engine can flag a stale patch.
 */
export function applySedPatch(
  content: string,
  expression: string,
): { success: boolean; result: string } {
  const { pattern, replacement, global } = parseSedExpression(expression);

  let re: RegExp;
  try {
    re = new RegExp(pattern, global ? 'g' : '');
  } catch (err) {
    throw new Error(
      `sed pattern /${pattern}/ is not a valid regex: ${(err as Error).message}`,
    );
  }

  // Detect zero-match via String.match (with global regex returns an
  // array of all matches, or null). For non-global, we just test once.
  if (global) {
    const matches = content.match(re);
    if (!matches || matches.length === 0) {
      return { success: false, result: content };
    }
  } else {
    if (!re.test(content)) {
      return { success: false, result: content };
    }
    // `re.test` advanced `lastIndex` for a global regex; reset before
    // replace (we're non-global here, so lastIndex is irrelevant, but
    // defensive).
    re.lastIndex = 0;
  }

  const result = content.replace(re, replacement);
  return { success: true, result };
}

/**
 * {@link PatchTypeHandler} implementation for the `sed` patch type.
 * Reads `patch.find` as the sed expression (or `patch.replace` for the
 * replacement if the user wants to split them). The convention is:
 *
 *   - If `patch.find` starts with `s`, treat it as a complete sed
 *     expression (`s/foo/bar/g`).
 *   - Otherwise, build the expression as `s/<find>/<replace>/g` so that
 *     YAML authors can use the same `find`/`replace` fields they use
 *     for `regex` patches.
 *
 * This dual-mode keeps the YAML authoring experience consistent across
 * `regex` and `sed` patches while still allowing full sed expressions
 * for advanced cases.
 */
export const sedHandler: PatchTypeHandler = {
  async apply(content, patch): Promise<PatchHandlerResult> {
    if (!patch.find) {
      throw new Error(`sed patch '${patch.patch_id}' has empty find`);
    }
    // If `find` already starts with `s` and contains a delimiter from
    // the allowed set, treat it as a full sed expression.
    const isFullExpression =
      patch.find.startsWith('s') &&
      patch.find.length > 1 &&
      ALLOWED_DELIMITERS.has(patch.find[1] ?? '');
    const expression = isFullExpression
      ? patch.find
      : `s/${patch.find}/${patch.replace ?? ''}/g`;
    const r = applySedPatch(content, expression);
    return { success: r.success, result: r.result };
  },
};
