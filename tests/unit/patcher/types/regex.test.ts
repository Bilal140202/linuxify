/**
 * Unit tests for `src/patcher/types/regex.ts`.
 *
 * Exercises {@link applyRegexPatch} against a variety of inputs:
 *   - simple find/replace
 *   - no-match (returns success: false)
 *   - multiple matches (global flag)
 *   - capture groups ($1, $2)
 *   - invalid regex source (throws)
 *   - zero-width match guard (doesn't infinite-loop)
 *
 * Also exercises the {@link regexHandler} wrapper that the engine
 * dispatches to, ensuring it reads `patch.find`/`patch.replace` from a
 * {@link PatchDefinition}-shaped object.
 */

import { describe, it, expect } from 'vitest';

import { applyRegexPatch, regexHandler } from '../../../../src/patcher/types/regex.js';
import type { PatchDefinition } from '../../../../src/packages/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link PatchDefinition}-shaped object for the regex
 * handler tests. Only `id`, `patch_id`, `description`, `file`, `type`,
 * `find`, `replace`, `verify`, `rollback` are required by the schema;
 * the handler only reads `find`, `replace`, and `patch_id`.
 */
function makePatch(overrides: Partial<PatchDefinition> = {}): PatchDefinition {
  return {
    id: 'test-patch',
    patch_id: 'test-001',
    description: 'test patch',
    file: 'platform.js',
    type: 'regex',
    find: 'foo',
    replace: 'bar',
    verify: 'true',
    rollback: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applyRegexPatch
// ---------------------------------------------------------------------------

describe('applyRegexPatch', () => {
  describe('simple find/replace', () => {
    it('replaces a literal string', () => {
      const r = applyRegexPatch('hello world', 'world', 'linux');
      expect(r.success).toBe(true);
      expect(r.result).toBe('hello linux');
      expect(r.matches).toBe(1);
    });

    it('replaces a regex pattern', () => {
      const r = applyRegexPatch('process.platform === "linux"', 'linux', 'android');
      expect(r.success).toBe(true);
      expect(r.result).toBe('process.platform === "android"');
      expect(r.matches).toBe(1);
    });

    it('handles special regex characters in the pattern', () => {
      // `process\.platform` matches the literal `process.platform`.
      const r = applyRegexPatch(
        "return process.platform === 'linux';",
        "process\\.platform === 'linux'",
        "['linux','android'].includes(process.platform)",
      );
      expect(r.success).toBe(true);
      expect(r.result).toBe("return ['linux','android'].includes(process.platform);");
      expect(r.matches).toBe(1);
    });
  });

  describe('no match', () => {
    it('returns success=false with original content when pattern does not match', () => {
      const r = applyRegexPatch('hello world', 'goodbye', 'linux');
      expect(r.success).toBe(false);
      expect(r.result).toBe('hello world');
      expect(r.matches).toBe(0);
    });

    it('returns success=false on an empty file', () => {
      const r = applyRegexPatch('', 'foo', 'bar');
      expect(r.success).toBe(false);
      expect(r.matches).toBe(0);
    });
  });

  describe('multiple matches (global flag)', () => {
    it('replaces all occurrences of a literal', () => {
      const r = applyRegexPatch('foo bar foo baz foo', 'foo', 'qux');
      expect(r.success).toBe(true);
      expect(r.result).toBe('qux bar qux baz qux');
      expect(r.matches).toBe(3);
    });

    it('replaces all occurrences of a regex source string', () => {
      const r = applyRegexPatch('a1 b2 c3', '[a-z]\\d', 'X');
      expect(r.success).toBe(true);
      expect(r.result).toBe('X X X');
      expect(r.matches).toBe(3);
    });

    it('handles overlapping patterns correctly (non-overlapping replacements)', () => {
      // `aa` in `aaaa` should match twice (positions 0 and 2), not
      // three times (the engine advances past each match).
      const r = applyRegexPatch('aaaa', 'aa', 'b');
      expect(r.success).toBe(true);
      expect(r.matches).toBe(2);
      // `String.replace` with `g` replaces non-overlapping matches:
      // `aaaa` -> `bb`.
      expect(r.result).toBe('bb');
    });
  });

  describe('capture groups', () => {
    it('substitutes $1 from a capture group', () => {
      const r = applyRegexPatch('key: value', '(key): (value)', '$2: $1');
      expect(r.success).toBe(true);
      expect(r.result).toBe('value: key');
      expect(r.matches).toBe(1);
    });

    it('substitutes multiple capture groups', () => {
      const r = applyRegexPatch(
        'platform=linux arch=arm64',
        'platform=(\\w+) arch=(\\w+)',
        'arch=$2 platform=$1',
      );
      expect(r.success).toBe(true);
      expect(r.result).toBe('arch=arm64 platform=linux');
      expect(r.matches).toBe(1);
    });

    it('rewrites a process.platform check using a capture group', () => {
      // Rewrite `process.platform === "X"` to `["linux","android"].includes(...)`.
      const r = applyRegexPatch(
        'if (process.platform === "linux") return true;',
        'process\\.platform === ["\']([a-z]+)["\']',
        '["linux","android"].includes(process.platform)',
      );
      expect(r.success).toBe(true);
      expect(r.result).toContain('["linux","android"].includes(process.platform)');
    });
  });

  describe('invalid regex source', () => {
    it('throws on an unterminated character class', () => {
      expect(() => applyRegexPatch('foo', '[unclosed', 'bar')).toThrow(/Invalid regex/);
    });

    it('throws on an invalid quantifier', () => {
      expect(() => applyRegexPatch('foo', '*foo', 'bar')).toThrow(/Invalid regex/);
    });
  });

  describe('zero-width matches', () => {
    it('does not infinite-loop on a zero-width lookahead', () => {
      // `(?=foo)` matches the position before `foo` without consuming
      // any characters. Without the zero-width guard, `exec` would
      // loop forever on the same position.
      const r = applyRegexPatch('foo bar foo', '(?=foo)', 'X');
      expect(r.success).toBe(true);
      expect(r.matches).toBe(2); // before each `foo`
      // The `X` is inserted before each `foo`.
      expect(r.result).toBe('Xfoo bar Xfoo');
    });
  });

  describe('idempotency', () => {
    it('re-applying the same patch to already-patched content returns no match', () => {
      // First apply: `process.platform === "linux"` → `['linux','android'].includes(...)`.
      const original = "return process.platform === 'linux';";
      const first = applyRegexPatch(
        original,
        "process\\.platform === 'linux'",
        "['linux','android'].includes(process.platform)",
      );
      expect(first.success).toBe(true);

      // Second apply: the original pattern no longer matches.
      const second = applyRegexPatch(
        first.result,
        "process\\.platform === 'linux'",
        "['linux','android'].includes(process.platform)",
      );
      expect(second.success).toBe(false);
      expect(second.matches).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// regexHandler (PatchTypeHandler wrapper)
// ---------------------------------------------------------------------------

describe('regexHandler', () => {
  it('applies a patch via the handler interface', async () => {
    const patch = makePatch({
      find: 'world',
      replace: 'linux',
    });
    const r = await regexHandler.apply('hello world', patch, {
      packageInstallPath: '/tmp/test',
      distro: '',
      stateStore: {} as never,
    });
    expect(r.success).toBe(true);
    expect(r.result).toBe('hello linux');
  });

  it('throws when find is empty', async () => {
    const patch = makePatch({ find: '', replace: 'bar' });
    await expect(regexHandler.apply('foo', patch, {} as never)).rejects.toThrow(
      /empty find/,
    );
  });

  it('returns success=false via the handler when no match', async () => {
    const patch = makePatch({ find: 'nomatch', replace: 'bar' });
    const r = await regexHandler.apply('foo', patch, {} as never);
    expect(r.success).toBe(false);
  });

  it('uses empty string as replacement when patch.replace is empty', async () => {
    // The schema makes `replace` required, but defensive code allows
    // empty (treats it as a literal empty replacement).
    const patch = makePatch({ find: 'foo', replace: '' });
    const r = await regexHandler.apply('foo bar', patch, {} as never);
    expect(r.success).toBe(true);
    expect(r.result).toBe(' bar');
  });
});
