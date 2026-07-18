/**
 * Public API surface for the `registry` module.
 *
 * @module linuxify/registry
 *
 * Re-exports the registry types, the {@link GitRegistryClient} class and
 * its options, the {@link RegistryCache} class with its TTL constants, and
 * the search algorithm (`fuzzyMatch`, `scorePackage`, `searchAndRank`,
 * `SCORE_WEIGHTS`). Also exports the {@link createRegistryClient} factory
 * which is the canonical entry point for production code: it reads the
 * registry URL/branch/trust_self_signed flags from a {@link Config} and
 * returns a {@link RegistryClient} backed by a cached
 * {@link GitRegistryClient}.
 *
 * Downstream subsystems (CLI, package manager) should import exclusively
 * from here:
 *
 * ```ts
 * import {
 *   createRegistryClient,
 *   type RegistryClient,
 *   type RegistryEntry,
 * } from '../registry/index.js';
 * ```
 *
 * @packageDocumentation
 */

import path from 'node:path';

import type { Config } from '../config/schema.js';
import { getLinuxifyHome } from '../utils/process.js';

import { RegistryCache } from './cache.js';
import { GitRegistryClient, type GitRegistryClientOptions } from './git-registry.js';
import type { RegistryClient } from './types.js';

// ---------------------------------------------------------------------------
// Type re-exports
// ---------------------------------------------------------------------------

export type {
  RegistryEntry,
  RegistryMetadata,
  SearchResult,
  SearchOpts,
  RegistryClient,
} from './types.js';

// ---------------------------------------------------------------------------
// Cache re-exports
// ---------------------------------------------------------------------------

export { RegistryCache, TTL_PACKAGE_LIST_MS, TTL_PACKAGE_DETAIL_MS, TTL_SEARCH_MS } from './cache.js';

// ---------------------------------------------------------------------------
// Search re-exports
// ---------------------------------------------------------------------------

export {
  fuzzyMatch,
  scorePackage,
  searchAndRank,
  SCORE_WEIGHTS,
  MAX_SCORE,
} from './search.js';

// ---------------------------------------------------------------------------
// GitRegistryClient re-exports
// ---------------------------------------------------------------------------

export { GitRegistryClient, type GitRegistryClientOptions } from './git-registry.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a production-ready {@link RegistryClient} from a {@link Config}.
 *
 * Reads the registry URL, branch, and `trust_self_signed` flag from
 * `config.registry`, and resolves the local clone path to
 * `~/.linuxify/registry/` (honoring the `LINUXIFY_HOME` env var override).
 * Returns a {@link GitRegistryClient} with a fresh {@link RegistryCache}.
 *
 * The returned client is cached for the lifetime of the process — callers
 * should NOT construct multiple clients from the same config, because
 * each client creates its own cache and the second client's `update()`
 * would invalidate the first client's cache without the first knowing.
 *
 * @param config - The user's loaded config (from `loadConfig()`).
 * @returns A {@link RegistryClient} ready for `update()` / `getPackage()`
 *   / `search()` / `getInfo()`.
 *
 * @example
 * ```ts
 * import { loadConfig } from '../config/index.js';
 * import { createRegistryClient } from '../registry/index.js';
 *
 * const config = await loadConfig();
 * const client = createRegistryClient(config);
 * await client.update();
 * const cline = await client.getPackage('cline');
 * ```
 */
export function createRegistryClient(config: Config): RegistryClient {
  const opts: GitRegistryClientOptions = {
    registryUrl: config.registry.url,
    branch: config.registry.branch,
    trustSelfSigned: config.registry.trust_self_signed,
    localPath: path.join(getLinuxifyHome(), 'registry'),
    cache: new RegistryCache(),
  };
  return new GitRegistryClient(opts);
}
