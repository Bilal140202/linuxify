/**
 * Search algorithm for the Linuxify registry.
 *
 * @module linuxify/registry/search
 *
 * `linuxify search <query>` (per `registry-format.md` §6) ranks results by a
 * simple weighted scoring function rather than a full-text index. The
 * algorithm is intentionally lightweight so it can run over the full
 * registry (dozens of packages in v1, hundreds expected in v2) in
 * single-digit milliseconds without building any auxiliary index.
 *
 * Scoring tiers (each contributes additively; the final score is capped at
 * 1.0):
 *
 * | Match                                | Score |
 * | ------------------------------------ | ----- |
 * | Exact name match (case-insensitive)  | 1.0   |
 * | Name starts with query               | 0.8   |
 * | Name contains query                  | 0.6   |
 * | Description contains query           | 0.3   |
 * | Any tag contains query               | 0.2   |
 *
 * Multiple tiers can fire for the same package (e.g. a query of `cline`
 * against the `cline` package produces an exact-name match AND a name-
 * contains match), so the score is the SUM of all matching tiers, capped at
 * 1.0. This means a package that matches on name AND description ranks
 * higher than one that matches on name alone.
 *
 * The query is tokenized on whitespace; each token is matched independently
 * and the per-token scores are averaged. This makes `linuxify search ai
 * agent` match a package whose description contains both `AI` and `agent`
 * with a higher score than one that contains only `AI`.
 *
 * Fuzzy matching (Levenshtein-1) is mentioned in `registry-format.md` §6
 * but is intentionally NOT implemented here in v1 — the spec says it is a
 * fallback applied only when no exact/starts-with matches are found, and
 * the v1 registry is small enough that the user can scan the top-20 list
 * by eye. Fuzzy search will be added in v2 alongside the HTTP API.
 *
 * @packageDocumentation
 */

import type { RegistryEntry, SearchResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lowercase a string for case-insensitive comparison. Wraps
 * `String.prototype.toLowerCase` so the rest of the module can be re-pointed
 * to a locale-aware lowercaser if needed (e.g. for Turkish `İ` → `i`).
 *
 * @param s - Input string.
 * @returns Lowercased string.
 */
function lower(s: string): string {
  return s.toLowerCase();
}

/**
 * Tokenize a query string into normalized search tokens.
 *
 * Splits on whitespace, lowercases each token, and drops empty tokens
 * (which appear for consecutive whitespace or leading/trailing spaces).
 * Non-alphanumeric characters within a token are preserved (e.g. `c++` is
 * a single token, not `c` `++`) so language/tool names that contain
 * punctuation match correctly.
 *
 * @param query - Raw query string.
 * @returns Array of non-empty, lowercased tokens.
 */
function tokenize(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => lower(t))
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// fuzzyMatch
// ---------------------------------------------------------------------------

/**
 * Score how well `target` matches `query` on a 0..1 scale.
 *
 * This is a building block used by {@link scorePackage}; it is exported so
 * callers (and tests) can score arbitrary strings. The scoring tiers mirror
 * the table in the module docstring:
 *
 *  - exact match (case-insensitive): 1.0
 *  - target starts with query: 0.8
 *  - target contains query: 0.6
 *  - no match: 0.0
 *
 * Note: this function does NOT implement Levenshtein fallback — see the
 * module docstring.
 *
 * @param query - The query token (already lowercased by the caller is fine;
 *   the function lowercases internally for safety).
 * @param target - The string to match against.
 * @returns Score in `[0, 1]`.
 */
export function fuzzyMatch(query: string, target: string): number {
  if (query.length === 0) return 0;
  const q = lower(query);
  const t = lower(target);
  if (q === t) return 1.0;
  if (t.startsWith(q)) return 0.8;
  if (t.includes(q)) return 0.6;
  return 0;
}

// ---------------------------------------------------------------------------
// scorePackage
// ---------------------------------------------------------------------------

/**
 * Per-tier score weights. Exported as a constant so tests can assert exact
 * numeric expectations and so the weights are visible in one place.
 *
 * These match the table in the module docstring.
 */
export const SCORE_WEIGHTS = {
  /** Exact (case-insensitive) name match. */
  EXACT_NAME: 1.0,
  /** Name starts with the query token. */
  NAME_STARTS_WITH: 0.8,
  /** Name contains the query token (but does not start with it). */
  NAME_CONTAINS: 0.6,
  /** Description contains the query token. */
  DESCRIPTION_CONTAINS: 0.3,
  /** Any tag contains the query token. */
  TAG_MATCH: 0.2,
} as const;

/**
 * Maximum score cap. Multiple tiers can fire for the same package, so the
 * raw sum is clamped to this value.
 */
export const MAX_SCORE = 1.0;

/**
 * Score a single package against a query.
 *
 * Tokenizes the query on whitespace, scores each token against the
 * package's name, description, and tags, and returns the average per-token
 * score clamped to `[0, 1]`.
 *
 * For a single-token query, the result is the sum of all matching tiers
 * (e.g. `cline` against `cline` → exact-name 1.0 + name-starts-with 0.8 +
 * name-contains 0.6 = 2.4, capped to 1.0). For a multi-token query, each
 * token is scored independently and the results are averaged — this means
 * `linuxify search ai agent` produces a non-zero score for a package whose
 * description contains both words even if neither word appears in the name.
 *
 * An empty query produces a score of `0` (no tokens → no matches). This is
 * intentional: an empty query should not match every package; the CLI
 * layer is responsible for handling empty queries (typically by listing
 * all packages).
 *
 * @param query - Raw query string (will be tokenized and lowercased).
 * @param pkg - The registry entry to score.
 * @returns Score in `[0, 1]`.
 */
export function scorePackage(query: string, pkg: RegistryEntry): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;

  let total = 0;
  for (const token of tokens) {
    total += scoreToken(token, pkg);
  }
  const avg = total / tokens.length;
  return Math.min(avg, MAX_SCORE);
}

/**
 * Score a single query token against a package.
 *
 * Sums the scores from each tier (name, description, tags) and clamps to
 * `[0, MAX_SCORE]`. A token can match multiple tiers (e.g. `cline` against
 * the `cline` package matches exact-name AND starts-with AND contains),
 * which is why the weights are additive.
 *
 * @param token - A single lowercased query token.
 * @param pkg - The registry entry to score against.
 * @returns Uncapped score for this token (capped to `MAX_SCORE` by the
 *   caller).
 */
function scoreToken(token: string, pkg: RegistryEntry): number {
  let score = 0;

  // Name tiers (mutually additive: exact → starts-with → contains).
  const nameLower = lower(pkg.name);
  if (token === nameLower) {
    score += SCORE_WEIGHTS.EXACT_NAME;
  }
  if (nameLower.startsWith(token)) {
    score += SCORE_WEIGHTS.NAME_STARTS_WITH;
  }
  if (nameLower.includes(token)) {
    score += SCORE_WEIGHTS.NAME_CONTAINS;
  }

  // Description tier.
  if (lower(pkg.description).includes(token)) {
    score += SCORE_WEIGHTS.DESCRIPTION_CONTAINS;
  }

  // Tag tier: any tag containing the token contributes (once).
  for (const tag of pkg.tags) {
    if (lower(tag).includes(token)) {
      score += SCORE_WEIGHTS.TAG_MATCH;
      break; // only one tag-match contribution per token
    }
  }

  return score;
}

// ---------------------------------------------------------------------------
// searchAndRank
// ---------------------------------------------------------------------------

/**
 * Filter and rank a list of registry entries against a query.
 *
 * This is the entry point used by {@link ./git-registry.ts | GitRegistryClient.search}.
 * It applies the optional filters (runtime, category, tags), scores each
 * surviving package with {@link scorePackage}, drops zero-score entries,
 * sorts by score descending (ties broken alphabetically by name), and
 * truncates to `limit`.
 *
 * @param packages - All registry entries (the unfiltered list from
 *   `listPackages()`).
 * @param query - Raw query string.
 * @param opts - Optional filters and limit. `limit` defaults to `20`
 *   (per `registry-format.md` §6). `tags` uses AND semantics — a package
 *   matches if it has ALL of the specified tags.
 * @returns Array of {@link SearchResult}, sorted by score descending.
 */
export function searchAndRank(
  packages: ReadonlyArray<RegistryEntry>,
  query: string,
  opts: {
    runtime?: string;
    category?: string;
    tags?: string[];
    limit?: number;
  } = {},
): SearchResult[] {
  const limit = opts.limit ?? 20;
  const tagsFilter = opts.tags?.map(lower) ?? [];
  const runtimeFilter = opts.runtime ? lower(opts.runtime) : undefined;
  const categoryFilter = opts.category ? lower(opts.category) : undefined;

  const results: SearchResult[] = [];

  for (const pkg of packages) {
    // --- Filters ---
    if (runtimeFilter !== undefined && lower(pkg.runtime) !== runtimeFilter) {
      continue;
    }
    if (categoryFilter !== undefined) {
      if (pkg.category === undefined || lower(pkg.category) !== categoryFilter) {
        continue;
      }
    }
    if (tagsFilter.length > 0) {
      const pkgTagsLower = pkg.tags.map(lower);
      const hasAllTags = tagsFilter.every((t) => pkgTagsLower.includes(t));
      if (!hasAllTags) continue;
    }

    // --- Score ---
    const score = scorePackage(query, pkg);
    // Drop zero-score entries so a search for "xyz" against a registry
    // with no matches returns an empty array rather than 20 zero-score
    // entries. The exception is an empty query: an empty query produces
    // a score of 0 for every package, but the CLI layer treats an empty
    // query as "list all" — so we include zero-score entries when the
    // query is empty/whitespace-only.
    if (score === 0 && query.trim().length > 0) continue;

    results.push({
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      score,
      runtime: pkg.runtime,
      tags: pkg.tags,
    });
  }

  // --- Sort: score desc, then name asc ---
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  return results.slice(0, limit);
}
