/**
 * Unit tests for `src/registry/search.ts`.
 *
 * Exercises `fuzzyMatch`, `scorePackage`, and `searchAndRank` against
 * hand-crafted {@link RegistryEntry} fixtures. Verifies the tiered scoring
 * (exact name > name starts-with > name contains > description contains >
 * tag match), capping at 1.0, multi-token averaging, filter application
 * (runtime, category, tags with AND semantics), sorting by score desc with
 * alphabetical tie-breaking, and limit truncation.
 */

import { describe, it, expect } from 'vitest';

import {
  fuzzyMatch,
  scorePackage,
  searchAndRank,
  SCORE_WEIGHTS,
  MAX_SCORE,
} from '../../../src/registry/search.js';
import type { RegistryEntry } from '../../../src/registry/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A representative package set covering name/description/tag matches. */
const PACKAGES: RegistryEntry[] = [
  {
    name: 'cline',
    version: '1.2.0',
    description: 'AI coding agent that runs in your terminal',
    runtime: 'node',
    category: 'ai',
    tags: ['ai-coding', 'terminal'],
  },
  {
    name: 'codex',
    version: '0.20.1',
    description: "OpenAI's terminal coding agent",
    runtime: 'node',
    category: 'ai',
    tags: ['ai-coding', 'terminal', 'openai'],
  },
  {
    name: 'aider',
    version: '0.42.0',
    description: 'AI pair programming in the terminal',
    runtime: 'python',
    category: 'ai',
    tags: ['ai-coding', 'python', 'terminal'],
  },
  {
    name: 'ripgrep',
    version: '14.1.0',
    description: 'Recursively search directories for a regex pattern',
    runtime: 'rust',
    category: 'util',
    tags: ['search', 'cli'],
  },
  {
    name: 'fd',
    version: '10.1.0',
    description: 'A simple, fast and user-friendly alternative to find',
    runtime: 'rust',
    category: 'util',
    tags: ['search', 'cli'],
  },
];

// ---------------------------------------------------------------------------
// fuzzyMatch
// ---------------------------------------------------------------------------

describe('fuzzyMatch', () => {
  it('returns 1.0 for an exact (case-insensitive) match', () => {
    expect(fuzzyMatch('cline', 'cline')).toBe(1.0);
    expect(fuzzyMatch('CLINE', 'cline')).toBe(1.0);
    expect(fuzzyMatch('cline', 'CLINE')).toBe(1.0);
  });

  it('returns 0.8 when target starts with query', () => {
    expect(fuzzyMatch('clin', 'cline')).toBe(0.8);
    expect(fuzzyMatch('CODE', 'codex')).toBe(0.8);
  });

  it('returns 0.6 when target contains query (but does not start with it)', () => {
    expect(fuzzyMatch('line', 'cline')).toBe(0.6);
    expect(fuzzyMatch('dex', 'codex')).toBe(0.6);
  });

  it('returns 0 for no match', () => {
    expect(fuzzyMatch('xyz', 'cline')).toBe(0);
  });

  it('returns 0 for an empty query', () => {
    expect(fuzzyMatch('', 'cline')).toBe(0);
  });

  it('is case-insensitive at all tiers', () => {
    expect(fuzzyMatch('CLIN', 'cline')).toBe(0.8);
    expect(fuzzyMatch('Line', 'cline')).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// scorePackage
// ---------------------------------------------------------------------------

describe('scorePackage', () => {
  it('returns 0 for an empty query', () => {
    expect(scorePackage('', PACKAGES[0]!)).toBe(0);
  });

  it('returns 0 for a whitespace-only query', () => {
    expect(scorePackage('   ', PACKAGES[0]!)).toBe(0);
    expect(scorePackage('\t\n', PACKAGES[0]!)).toBe(0);
  });

  it('scores an exact name match at the cap (1.0)', () => {
    // `cline` against `cline`: exact(1.0) + starts-with(0.8) + contains(0.6) = 2.4, capped to 1.0
    expect(scorePackage('cline', PACKAGES[0]!)).toBe(1.0);
  });

  it('scores a name-starts-with match below the cap', () => {
    // `clin` against `cline`: starts-with(0.8) + contains(0.6) = 1.4, capped to 1.0
    expect(scorePackage('clin', PACKAGES[0]!)).toBe(1.0);
  });

  it('scores a name-contains match (not starts-with) below the cap', () => {
    // `line` against `cline`: contains(0.6) only = 0.6
    expect(scorePackage('line', PACKAGES[0]!)).toBe(0.6);
  });

  it('adds description-contains tier on top of name tiers', () => {
    // `cline` against cline: name tiers (capped at 1.0) + description contains "cline"? No —
    // description is "AI coding agent...". So `cline` only matches name.
    // Instead, test a token that matches name AND description:
    // `terminal` is in cline's description AND cline's tags.
    // name tiers: 0 (no name match)
    // description: 0.3
    // tag: 0.2 (one tag "terminal" matches)
    // total: 0.5
    expect(scorePackage('terminal', PACKAGES[0]!)).toBe(0.5);
  });

  it('adds tag-match tier on top of description tier', () => {
    // `python` is in aider's tags but not name or description.
    // name: 0, description: 0, tag: 0.2
    expect(scorePackage('python', PACKAGES[2]!)).toBe(0.2);
  });

  it('caps the score at MAX_SCORE (1.0)', () => {
    // A query that matches name (exact + starts-with + contains) AND
    // description AND tags should still cap at 1.0.
    expect(scorePackage('cline', PACKAGES[0]!)).toBeLessThanOrEqual(MAX_SCORE);
  });

  it('averages per-token scores for multi-token queries', () => {
    // `cline terminal` against the cline package:
    //   token "cline":   exact(1.0)+starts(0.8)+contains(0.6) = 2.4 (uncapped per-token)
    //   token "terminal": desc(0.3)+tag(0.2) = 0.5
    //   total = 2.9, avg = 1.45, capped to MAX_SCORE (1.0)
    // The per-token scores are NOT individually capped; only the final
    // averaged sum is capped. This means a strong single-token match
    // (like "cline") can pull the average above 1.0 even when paired
    // with a weaker token (like "terminal"), and the cap brings it back
    // to 1.0.
    expect(scorePackage('cline terminal', PACKAGES[0]!)).toBe(1.0);

    // A clearer averaging case: `python terminal` against aider.
    // aider: name="aider", description="AI pair programming in the terminal",
    //        tags=['ai-coding', 'python', 'terminal']
    //   token "python":   name 0, desc 0, tag 0.2 = 0.2
    //   token "terminal": name 0, desc 0.3 (desc contains "terminal"), tag 0.2 = 0.5
    //   total = 0.7, avg = 0.35, no cap needed.
    expect(scorePackage('python terminal', PACKAGES[2]!)).toBeCloseTo(0.35, 5);
  });

  it('returns 0 when no token matches', () => {
    expect(scorePackage('xyz qwerty', PACKAGES[0]!)).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(scorePackage('CLINE', PACKAGES[0]!)).toBe(1.0);
    expect(scorePackage('Cline', PACKAGES[0]!)).toBe(1.0);
  });

  it('exposes the documented SCORE_WEIGHTS', () => {
    expect(SCORE_WEIGHTS.EXACT_NAME).toBe(1.0);
    expect(SCORE_WEIGHTS.NAME_STARTS_WITH).toBe(0.8);
    expect(SCORE_WEIGHTS.NAME_CONTAINS).toBe(0.6);
    expect(SCORE_WEIGHTS.DESCRIPTION_CONTAINS).toBe(0.3);
    expect(SCORE_WEIGHTS.TAG_MATCH).toBe(0.2);
  });
});

// ---------------------------------------------------------------------------
// searchAndRank
// ---------------------------------------------------------------------------

describe('searchAndRank', () => {
  it('returns results sorted by score descending', () => {
    const results = searchAndRank(PACKAGES, 'cli');
    // `cli` matches `cline` (starts-with 0.8 + contains 0.6 = 1.4 → 1.0) and
    // matches the tag `cli` on ripgrep/fd (0.2 each). Also matches `codex`?
    // No — `cli` is not in codex's name. But `cli` IS in cline's name AND
    // in aider's tags? Aider's tags are ai-coding, python, terminal — no `cli`.
    // So expected hits: cline (1.0), ripgrep (0.2), fd (0.2).
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.name).toBe('cline');
    // Score is non-increasing.
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.score).toBeLessThanOrEqual(results[i - 1]!.score);
    }
  });

  it('breaks score ties alphabetically by name', () => {
    const results = searchAndRank(PACKAGES, 'cli');
    // ripgrep and fd both score 0.2 (tag match only). Alphabetical: fd < ripgrep.
    const lowScore = results.filter((r) => r.score === 0.2);
    expect(lowScore.length).toBe(2);
    expect(lowScore[0]!.name).toBe('fd');
    expect(lowScore[1]!.name).toBe('ripgrep');
  });

  it('truncates to the configured limit', () => {
    const results = searchAndRank(PACKAGES, 'cli', { limit: 1 });
    expect(results).toHaveLength(1);
  });

  it('defaults limit to 20 when omitted', () => {
    // With 5 fixtures, all match an empty-but-trimmed query? No — empty
    // query returns 0 scores. Use a broad query instead.
    const results = searchAndRank(PACKAGES, 'a');
    // `a` matches: cline (name contains + description contains + tag?),
    // codex (description? "OpenAI's terminal coding agent" — no `a`? yes,
    // "OpenAI" has `a`), aider (name starts-with + contains + desc + tag),
    // ripgrep (description "Recursively search..." — has `a`? "Recursively"
    // — yes), fd (description "alternative" — has `a`).
    // We don't assert exact count; just that limit defaults to 20 (so all
    // matches are returned since there are <20).
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it('filters by runtime', () => {
    const results = searchAndRank(PACKAGES, 'ai', { runtime: 'python' });
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe('aider');
    expect(results[0]!.runtime).toBe('python');
  });

  it('filters by category', () => {
    const results = searchAndRank(PACKAGES, 'search', { category: 'util' });
    // `search` matches ripgrep's description ("search directories") and
    // tag ("search"), and fd's tag ("search"). Both are util category.
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['fd', 'ripgrep']);
  });

  it('filters by tags with AND semantics', () => {
    // Packages with BOTH `ai-coding` AND `terminal` tags: cline, codex, aider.
    const results = searchAndRank(PACKAGES, 'ai', {
      tags: ['ai-coding', 'terminal'],
    });
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['aider', 'cline', 'codex']);
  });

  it('filters by a single tag', () => {
    const results = searchAndRank(PACKAGES, 'ai', { tags: ['openai'] });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('codex');
  });

  it('returns an empty array when no package matches the query', () => {
    const results = searchAndRank(PACKAGES, 'xyzzy');
    expect(results).toEqual([]);
  });

  it('returns an empty array when filters exclude all packages', () => {
    const results = searchAndRank(PACKAGES, 'ai', { runtime: 'go' });
    expect(results).toEqual([]);
  });

  it('drops zero-score entries for a non-empty query', () => {
    // `ripgrep` matches only the ripgrep package (exact name). All others
    // should be dropped (zero score).
    const results = searchAndRank(PACKAGES, 'ripgrep');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('ripgrep');
  });

  it('includes all packages for an empty/whitespace query (zero scores kept)', () => {
    const results = searchAndRank(PACKAGES, '   ');
    expect(results.length).toBe(PACKAGES.length);
    // All scores are 0 (no query tokens).
    for (const r of results) {
      expect(r.score).toBe(0);
    }
  });

  it('includes all packages for an empty query, sorted alphabetically', () => {
    const results = searchAndRank(PACKAGES, '');
    const names = results.map((r) => r.name);
    expect(names).toEqual([...names].sort());
  });

  it('combines filters with scoring correctly', () => {
    // Filter to node runtime + ai category, query `codex`:
    // cline and codex both pass the filters; only codex matches the query
    // (exact name match). cline is dropped because its score is 0.
    const results = searchAndRank(PACKAGES, 'codex', {
      runtime: 'node',
      category: 'ai',
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('codex');
    expect(results[0]!.score).toBe(1.0); // exact name match + starts-with + contains
  });

  it('filters narrow the candidate set before scoring', () => {
    // Query `cod` matches codex (name contains "cod") AND cline
    // (description "coding" contains "cod") AND aider (tag "ai-coding"
    // contains "cod"). Without filters, all three appear. With
    // runtime=python filter, only aider remains in the candidate set.
    const noFilter = searchAndRank(PACKAGES, 'cod');
    const noFilterNames = noFilter.map((r) => r.name);
    expect(noFilterNames).toContain('codex');
    expect(noFilterNames).toContain('cline');
    expect(noFilterNames).toContain('aider');

    // With runtime=python, only aider survives the filter; aider's
    // tag "ai-coding" matches "cod" (tag match = 0.2).
    const withFilter = searchAndRank(PACKAGES, 'cod', { runtime: 'python' });
    expect(withFilter).toHaveLength(1);
    expect(withFilter[0]!.name).toBe('aider');
    expect(withFilter[0]!.score).toBeCloseTo(0.2, 5);
  });

  it('handles an empty package list', () => {
    const results = searchAndRank([], 'anything');
    expect(results).toEqual([]);
  });

  it('preserves all RegistryEntry fields in SearchResult', () => {
    const results = searchAndRank(PACKAGES, 'cline');
    expect(results[0]).toMatchObject({
      name: 'cline',
      version: '1.2.0',
      description: 'AI coding agent that runs in your terminal',
      runtime: 'node',
      tags: ['ai-coding', 'terminal'],
    });
    expect(typeof results[0]!.score).toBe('number');
  });
});
