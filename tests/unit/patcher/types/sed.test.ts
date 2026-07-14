/**
 * Unit tests for `src/patcher/types/sed.ts`.
 *
 * Exercises {@link applySedPatch} against the supported sed substitution
 * forms (`s/find/replace/`, `s/find/replace/g`, alternate delimiters)
 * and the {@link sedHandler} wrapper that the engine dispatches to.
 *
 * Coverage:
 *   - basic substitution (first occurrence only without `g` flag)
 *   - global substitution (all occurrences with `g` flag)
 *   - alternate delimiters (`|`, `#`, `,`, `:`, `;`, `@`, `~`)
 *   - escaped delimiters in pattern and replacement
 *   - no-match (returns success: false)
 *   - invalid expression forms (throws)
 *   - the handler's dual-mode: full sed expression vs. find/replace
 *     fields from the YAML
 */

import { describe, it, expect } from 'vitest';

import { applySedPatch, sedHandler } from '../../../../src/patcher/types/sed.js';
import type { PatchDefinition } from '../../../../src/packages/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal {@link PatchDefinition} for the sed handler tests. */
function makePatch(overrides: Partial<PatchDefinition> = {}): PatchDefinition {
  return {
    id: 'test-patch',
    patch_id: 'test-001',
    description: 'test patch',
    file: 'platform.js',
    type: 'sed',
    find: 'foo',
    replace: 'bar',
    verify: 'true',
    rollback: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applySedPatch
// ---------------------------------------------------------------------------

describe('applySedPatch', () => {
  describe('basic substitution', () => {
    it('replaces the first occurrence only (no g flag)', () => {
      const r = applySedPatch('foo foo foo', 's/foo/bar/');
      expect(r.success).toBe(true);
      expect(r.result).toBe('bar foo foo');
    });

    it('replaces all occurrences with the g flag', () => {
      const r = applySedPatch('foo foo foo', 's/foo/bar/g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('bar bar bar');
    });

    it('handles regex metacharacters in the pattern', () => {
      // `.` matches any char, so `f.o` matches `foo`, `fao`, etc.
      const r = applySedPatch('foo fao fbo', 's/f.o/X/g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('X X X');
    });

    it('handles a literal dot via backslash escape', () => {
      // `\.` matches a literal dot.
      const r = applySedPatch('process.platform = x', 's/process\\.platform/P/g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('P = x');
    });
  });

  describe('alternate delimiters', () => {
    it('accepts | as a delimiter', () => {
      const r = applySedPatch('/usr/local/bin', 's|/usr/local|/opt|g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('/opt/bin');
    });

    it('accepts # as a delimiter', () => {
      // Useful when the pattern contains `/` (avoids backslash-escaping).
      const r = applySedPatch('/path/to/file', 's#/path/to#/new/path#g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('/new/path/file');
    });

    it('accepts , as a delimiter', () => {
      const r = applySedPatch('foo,bar', 's,foo,baz,');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz,bar');
    });

    it('accepts : as a delimiter', () => {
      const r = applySedPatch('foo:bar', 's:foo:baz:');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz:bar');
    });

    it('accepts ; as a delimiter', () => {
      const r = applySedPatch('foo;bar', 's;foo;baz;');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz;bar');
    });

    it('accepts @ as a delimiter', () => {
      const r = applySedPatch('foo@bar', 's@foo@baz@');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz@bar');
    });

    it('accepts ~ as a delimiter', () => {
      const r = applySedPatch('foo~bar', 's~foo~baz~');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz~bar');
    });
  });

  describe('escaped delimiters', () => {
    it('throws when the replacement contains an unescaped delimiter', () => {
      // The user wants pattern=`\/usr` (matches `/usr`) and replacement=`/opt`.
      // But the parser sees the unescaped `/` in `/opt` as a delimiter,
      // producing 4 sections instead of 3. The fix is to use an alternate
      // delimiter (see the next test).
      expect(() => applySedPatch('/usr/local', 's/\\/usr/local/opt/local/g')).toThrow(
        /exactly 2 delimiter-separated/,
      );
    });

    it('handles escaped delimiter in the pattern', () => {
      // Pattern `\|` (escaped `|`) matches a literal `|` in regex.
      // Replacement is `X`. Delimiter is `/`.
      const r = applySedPatch('a|b|c', 's/\\|/X/g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('aXbXc');
    });

    it('uses alternate delimiter to avoid escaping', () => {
      // The clean way to rewrite paths: use | as the delimiter so the
      // pattern and replacement can contain `/` without escaping.
      const r = applySedPatch('/usr/local/bin', 's|/usr/local/bin|/opt/bin|g');
      expect(r.success).toBe(true);
      expect(r.result).toBe('/opt/bin');
    });
  });

  describe('no match', () => {
    it('returns success=false when pattern does not match', () => {
      const r = applySedPatch('hello world', 's/goodbye/hi/');
      expect(r.success).toBe(false);
      expect(r.result).toBe('hello world');
    });

    it('returns success=false on empty input', () => {
      const r = applySedPatch('', 's/foo/bar/g');
      expect(r.success).toBe(false);
    });
  });

  describe('capture groups', () => {
    it('substitutes $1 in the replacement', () => {
      const r = applySedPatch('key=value', 's/(key)=(value)/$2=$1/');
      expect(r.success).toBe(true);
      expect(r.result).toBe('value=key');
    });
  });

  describe('invalid expressions', () => {
    it('throws when expression does not start with s', () => {
      expect(() => applySedPatch('foo', 'd/foo/d')).toThrow(/must start with 's'/);
    });

    it('throws when delimiter is not in the allowed set', () => {
      // `x` is not a valid delimiter.
      expect(() => applySedPatch('foo', 'sxfxbx')).toThrow(/unsupported delimiter/);
    });

    it('throws when there are too few sections', () => {
      // Missing the flags section: `s/foo` has only 1 section.
      expect(() => applySedPatch('foo', 's/foo')).toThrow(/exactly 2 delimiter-separated/);
    });

    it('throws when the pattern is empty', () => {
      expect(() => applySedPatch('foo', 's//bar/')).toThrow(/empty pattern/);
    });

    it('throws on unsupported flags', () => {
      // `i` (case-insensitive) is not supported in v0.1.
      expect(() => applySedPatch('foo', 's/foo/bar/i')).toThrow(/unsupported flag/);
    });

    it('throws when the pattern is an invalid regex', () => {
      expect(() => applySedPatch('foo', 's/*foo/bar/')).toThrow(/not a valid regex/);
    });
  });

  describe('whitespace handling', () => {
    it('trims leading/trailing whitespace from the expression', () => {
      const r = applySedPatch('foo bar', '  s/foo/baz/  ');
      expect(r.success).toBe(true);
      expect(r.result).toBe('baz bar');
    });
  });
});

// ---------------------------------------------------------------------------
// sedHandler (PatchTypeHandler wrapper)
// ---------------------------------------------------------------------------

describe('sedHandler', () => {
  it('treats find as a full sed expression when it starts with s + delimiter', async () => {
    const patch = makePatch({
      find: 's/foo/bar/g',
      replace: '',
    });
    const r = await sedHandler.apply('foo foo', patch, {} as never);
    expect(r.success).toBe(true);
    expect(r.result).toBe('bar bar');
  });

  it('builds s/find/replace/g when find is not a full expression', async () => {
    const patch = makePatch({
      find: 'foo',
      replace: 'bar',
    });
    const r = await sedHandler.apply('foo foo', patch, {} as never);
    expect(r.success).toBe(true);
    expect(r.result).toBe('bar bar');
  });

  it('throws when find is empty', async () => {
    const patch = makePatch({ find: '', replace: 'bar' });
    await expect(sedHandler.apply('foo', patch, {} as never)).rejects.toThrow(
      /empty find/,
    );
  });

  it('returns success=false when no match', async () => {
    const patch = makePatch({ find: 'nomatch', replace: 'bar' });
    const r = await sedHandler.apply('foo', patch, {} as never);
    expect(r.success).toBe(false);
  });

  it('handles alternate delimiters in full-expression mode', async () => {
    const patch = makePatch({
      find: 's|/usr/local|/opt|g',
      replace: '',
    });
    const r = await sedHandler.apply('/usr/local/bin', patch, {} as never);
    expect(r.success).toBe(true);
    expect(r.result).toBe('/opt/bin');
  });
});
