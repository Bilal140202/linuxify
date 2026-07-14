/**
 * Regex patch-type handler.
 *
 * @module linuxify/patcher/types/regex
 *
 * The simplest patch type: find/replace with a JavaScript regex. The
 * `find` field is parsed as a regex source string (no surrounding `/`),
 * always with the `g` flag (so all matches in the file are replaced in a
 * single pass). The `replace` field is a literal string with `$1`, `$2`,
 * … `$9` substitution for capture groups, matching `String.prototype.replace`
 * semantics.
 *
 * If the pattern does not match, the handler returns `success: false` so
 * the engine can abort with `E_PATCH_NO_MATCH` — silently leaving the
 * file unchanged would mask a stale patch (the upstream file may have
 * been reformatted, requiring a patch update).
 *
 * See `docs/08-patcher/patcher-engine.md` §5.1 for the design rationale.
 */

import type { PatchHandlerResult, PatchTypeHandler } from '../types.js';

/**
 * Apply a regex find/replace to `content`.
 *
 * The `find` string is compiled as a regex source with the `g` flag. If
 * the caller wants case-insensitivity or multi-line mode, they include
 * the appropriate inline flag in the pattern (e.g. `(?i)foo` — though
 * note that the `i` flag must be set as part of the second `RegExp`
 * argument in older engines; for Node 20+ inline flags are supported).
 *
 * @param content - The current file content.
 * @param find - The regex source string (without surrounding `/`).
 * @param replace - The replacement string (`$1`/`$2`/… for captures).
 * @returns `{ success, result, matches }`. `success` is `false` when the
 *   pattern compiled but matched zero occurrences; the engine treats
 *   that as a stale-patch signal.
 */
export function applyRegexPatch(
  content: string,
  find: string,
  replace: string,
): { success: boolean; result: string; matches: number } {
  let re: RegExp;
  try {
    // The `g` flag is mandatory: a non-global regex would replace only
    // the first match, surprising the user. Callers who want a single
    // replacement should use a more specific pattern or the `sed` type
    // with an explicit address.
    re = new RegExp(find, 'g');
  } catch (err) {
    // Invalid regex source — surface as a thrown error so the engine
    // wraps it in PatcherError(E_PATCH_INVALID). The caller decides the
    // exact code; we just propagate the syntax-error message.
    throw new Error(`Invalid regex pattern /${find}/: ${(err as Error).message}`);
  }

  // Count matches by walking the regex manually — `String.replace` does
  // not expose match count, and running the regex twice (match + replace)
  // would double the cost on large files.
  let matches = 0;
  // `RegExp.exec` with a global regex advances `lastIndex` on each call
  // and returns `null` when exhausted. Reset first to be safe (the regex
  // was just constructed, but defensive code is cheap).
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches++;
    // Guard against zero-width matches (e.g. `/(?=foo)/`) which would
    // otherwise loop forever: advance by one character so `exec` makes
    // progress.
    if (m.index === re.lastIndex) {
      re.lastIndex++;
    }
  }

  if (matches === 0) {
    return { success: false, result: content, matches: 0 };
  }

  // Reset lastIndex again before replace — String.prototype.replace with
  // a global regex does its own walking, but a stale lastIndex could
  // confuse a buggy engine. Belt-and-suspenders.
  re.lastIndex = 0;
  const result = content.replace(re, replace);
  return { success: true, result, matches };
}

/**
 * {@link PatchTypeHandler} implementation for the `regex` patch type.
 * Wraps {@link applyRegexPatch} so it can be registered in the type
 * registry. Reads `patch.find` and `patch.replace` from the patch
 * definition.
 */
export const regexHandler: PatchTypeHandler = {
  async apply(content, patch): Promise<PatchHandlerResult> {
    // `find` and `replace` are required for `regex` patches per the
    // package YAML schema (PatchDefinitionSchema makes them non-optional
    // strings). Defensive guards below surface a clear error if the
    // schema were ever loosened.
    if (!patch.find) {
      throw new Error(`regex patch '${patch.patch_id}' has empty find`);
    }
    const r = applyRegexPatch(content, patch.find, patch.replace ?? '');
    return { success: r.success, result: r.result };
  },
};
