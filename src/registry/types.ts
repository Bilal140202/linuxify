/**
 * Registry type definitions.
 *
 * @module linuxify/registry/types
 *
 * The Linuxify registry is the central listing of every CLI tool Linuxify
 * knows how to install (see `docs/09-registry/registry-format.md`). In v1 the
 * registry is a plain git repository at `github.com/linuxify/registry`; the
 * client clones or pulls it into `~/.linuxify/registry/` and reads package
 * YAMLs directly from the local filesystem.
 *
 * The types in this module are the public contract implemented by
 * {@link ./git-registry.ts | GitRegistryClient} and consumed by the CLI
 * surface (`linuxify search`, `linuxify info`, `linuxify update`). The
 * {@link RegistryClient} interface is exported so plugins can construct mock
 * clients for testing; production code uses the
 * {@link ./index.ts | createRegistryClient} factory which wires a
 * {@link ./cache.ts | RegistryCache} in front of a `GitRegistryClient`.
 *
 * Design notes:
 *  - {@link RegistryEntry} carries only the lightweight metadata needed by
 *    `linuxify search` and `linuxify list` — name, version, description,
 *    runtime, category, tags. The full install recipe is fetched on demand
 *    via {@link RegistryClient.getPackage} and parsed with
 *    {@link ../packages/parser.ts | parsePackageYaml} into a
 *    {@link ../packages/schema.ts | PackageDefinition}.
 *  - {@link SearchResult} extends `RegistryEntry` with a `score` field
 *    (0..1) computed by {@link ./search.ts | scorePackage}.
 *  - {@link SearchOpts} supports filtering by `runtime`, `category`, and
 *    `tags`, plus a `limit` (default 20, matching `registry-format.md` §6).
 *
 * See:
 *  - docs/09-registry/registry-format.md (registry layout, update protocol)
 *  - docs/20-adrs/adr-011-git-based-registry-v1.md (git chosen over HTTP)
 *  - docs/02-architecture/type-reference.md §10 (Registry types)
 *
 * @packageDocumentation
 */

import type { PackageDefinition } from '../packages/schema.js';

/**
 * Lightweight metadata for a single package in the registry. Constructed by
 * scanning `packages/*.yml` in the local clone and extracting only the fields
 * needed by `linuxify search` / `linuxify list` — the full install recipe is
 * fetched on demand via {@link RegistryClient.getPackage}.
 *
 * The `version` field is the current (latest, non-yanked) Linuxify package
 * version. Aliases (`alias_of`) are excluded from the listing; the alias's
 * target is what shows up.
 */
export interface RegistryEntry {
  /** Package name (`^[a-z][a-z0-9_-]{0,62}$`). */
  name: string;
  /** Current Linuxify package version (semver). */
  version: string;
  /** 1–200 char description shown in search/info output. */
  description: string;
  /** Language runtime the package's install commands expect. */
  runtime: string;
  /** Free-form category (`ai`, `dev`, `sec`, `net`, `util`, `data`, …). */
  category?: string;
  /** Free-form tags (lowercase, hyphenated). */
  tags: string[];
}

/**
 * Top-level registry metadata, read from `registry.toml` in the local clone
 * (see `registry-format.md` §3). The fields exposed here are the subset the
 * CLI surfaces in `linuxify info <pkg> --registry` and `linuxify update`
 * summary output; v2-only fields (`signing_keys`, `update_policy`,
 * `mirrors`) are intentionally omitted from the v1 client surface.
 */
export interface RegistryMetadata {
  /** Registry format schema version (bumps on layout changes). */
  schema_version: number;
  /** Registry name (e.g. `linuxify`). */
  registry_name: string;
  /** Maintainer GitHub handles or emails. */
  maintainers: string[];
  /** ISO 8601 timestamp of the most recent successful `update()`. */
  updated_at: string;
  /** Total package count (excludes aliases). */
  package_count: number;
}

/**
 * A single search hit. Extends {@link RegistryEntry} with a relevance `score`
 * in `[0, 1]` computed by {@link ./search.ts | scorePackage}. Results are
 * sorted by `score` descending; ties break alphabetically by name.
 */
export interface SearchResult {
  /** Package name. */
  name: string;
  /** Current Linuxify package version. */
  version: string;
  /** Description. */
  description: string;
  /** Relevance score in `[0, 1]` (1.0 = exact name match). */
  score: number;
  /** Language runtime. */
  runtime: string;
  /** Tags (forwarded from {@link RegistryEntry.tags}). */
  tags: string[];
}

/**
 * Options for {@link RegistryClient.search}. All fields optional except
 * `query`; omitted filters mean "do not filter".
 */
export interface SearchOpts {
  /** Free-text query (matched against name, description, tags). */
  query: string;
  /** Filter to a specific runtime (`node`, `python`, …). */
  runtime?: string;
  /** Filter to a specific category (`ai`, `dev`, …). */
  category?: string;
  /** Filter to packages matching ALL of the given tags. */
  tags?: string[];
  /** Maximum results to return. Default `20` (per `registry-format.md` §6). */
  limit?: number;
}

/**
 * Client interface for the Linuxify registry.
 *
 * Implemented by {@link ./git-registry.ts | GitRegistryClient}; the
 * {@link ./index.ts | createRegistryClient} factory wraps the implementation
 * with a {@link ./cache.ts | RegistryCache} so repeated calls within a single
 * CLI invocation are served from memory.
 *
 * The interface is exported so plugins can construct mock clients (e.g. an
 * in-memory registry for testing a custom installer). Implementations must be
 * safe to call concurrently from multiple async contexts.
 */
export interface RegistryClient {
  /**
   * Synchronize the local clone with the upstream registry.
   *
   * If the local clone does not exist, performs a shallow clone
   * (`git clone --depth 1 --branch <branch>`). If it exists, performs a
   * force-sync (`git fetch origin && git reset --hard origin/<branch>`),
   * discarding any local modifications. Updates the `.last-update`
   * timestamp file on success.
   *
   * @throws {import('../utils/errors.js').RegistryError} with code
   *   `E_REGISTRY_UPDATE_FAILED` if the git clone or fetch fails.
   */
  update(): Promise<void>;

  /**
   * Fetch a single package's full definition by name.
   *
   * Looks for `packages/<name>.yml` in the local clone; if found, parses
   * it with `parsePackageYaml` and returns the validated
   * {@link PackageDefinition}. Returns `null` if the file does not exist
   * (so callers can fall back to alias resolution or surface a
   * user-friendly "package not found" message).
   *
   * @param name - Package name (e.g. `cline`).
   * @returns The parsed package definition, or `null` if not in the registry.
   * @throws {import('../utils/errors.js').RegistryError} with code
   *   `E_REGISTRY_NOT_INITIALIZED` if `update()` has never been run.
   * @throws {import('../utils/errors.js').PackageError} if the YAML is
   *   present but invalid (propagated from `parsePackageYaml`).
   */
  getPackage(name: string): Promise<PackageDefinition | null>;

  /**
   * List all packages in the registry (excluding aliases).
   *
   * Scans `packages/*.yml` in the local clone, parses each just enough to
   * extract the metadata fields in {@link RegistryEntry}, and returns the
   * array sorted alphabetically by name. Full schema validation is skipped
   * for speed; callers that need a fully-validated definition should use
   * {@link getPackage}.
   *
   * @returns Array of {@link RegistryEntry}, sorted by name.
   * @throws {import('../utils/errors.js').RegistryError} with code
   *   `E_REGISTRY_NOT_INITIALIZED` if `update()` has never been run.
   */
  listPackages(): Promise<RegistryEntry[]>;

  /**
   * Search the registry by query string.
   *
   * Filters the package list by `runtime`, `category`, and `tags` (all
   * optional; tags use AND semantics — a package matches if it has ALL of
   * the specified tags), then scores each remaining package against the
   * query using {@link ./search.ts | scorePackage} and returns the top
   * `limit` (default 20) sorted by score descending.
   *
   * @param opts - Search options; see {@link SearchOpts}.
   * @returns Array of {@link SearchResult}, sorted by score descending.
   *   Ties break alphabetically by name.
   * @throws {import('../utils/errors.js').RegistryError} with code
   *   `E_REGISTRY_NOT_INITIALIZED` if `update()` has never been run.
   */
  search(opts: SearchOpts): Promise<SearchResult[]>;

  /**
   * Read the registry's top-level metadata (`registry.toml`).
   *
   * @returns Parsed {@link RegistryMetadata}.
   * @throws {import('../utils/errors.js').RegistryError} with code
   *   `E_REGISTRY_NOT_INITIALIZED` if `update()` has never been run, or
   *   `E_REGISTRY_CORRUPT` if `registry.toml` is missing or invalid.
   */
  getInfo(): Promise<RegistryMetadata>;

  /**
   * Return the absolute filesystem path to the local clone.
   *
   * @returns Absolute path (e.g. `/home/alice/.linuxify/registry`).
   */
  getRegistryPath(): string;

  /**
   * Read the timestamp of the most recent successful `update()`.
   *
   * @returns ISO 8601 timestamp string, or `null` if `update()` has never
   *   run successfully.
   */
  getLastUpdate(): Promise<string | null>;
}
