/**
 * Git-based v1 registry client.
 *
 * @module linuxify/registry/git-registry
 *
 * Implements {@link ./types.ts | RegistryClient} against a local git clone
 * of `github.com/linuxify/registry`. The clone lives at
 * `~/.linuxify/registry/`; `update()` synchronizes it with the upstream
 * `main` branch (or whatever branch is configured in
 * `~/.linuxify/config.toml`).
 *
 * Why git and not an HTTP API? See `docs/20-adrs/adr-011-git-based-registry-v1.md`:
 * the v1 package count is small (<100), the maintainer team is small, and a
 * git repo is free to operate (GitHub hosts it). The v2 HTTP API is future
 * work; the git clone remains the offline fallback.
 *
 * ## Update protocol
 *
 *  - First run (no local clone): `git clone --depth 1 --branch <branch>
 *    <url> <path>`. Shallow clone keeps the on-disk footprint small (a few
 *    hundred KB for dozens of YAMLs).
 *  - Subsequent runs: `git fetch origin && git reset --hard origin/<branch>`.
 *    The hard reset discards any local modifications (e.g. a contributor
 *    testing a YAML they are about to submit). The v1 client does NOT
 *    implement the stash-and-rebase flow described in
 *    `registry-format.md` §5 — that is a v1.1 enhancement; v1 simply
 *    force-syncs and warns if local changes were discarded.
 *
 * ## Self-signed certs
 *
 * If `trustSelfSigned` is true (set via `config.registry.trust_self_signed`),
 * the client sets `GIT_SSL_NO_VERIFY=1` in the process environment before
 * spawning git. This is INSECURE and intended only for CI behind a
 * corporate proxy; the config schema defaults it to `false`.
 *
 * ## Caching
 *
 * Hot paths (`listPackages`, `getPackage`, `search`) are wrapped with a
 * per-process {@link ./cache.ts | RegistryCache}. The cache is invalidated
 * wholesale on every successful `update()`. TTLs: package list 1h, package
 * detail 24h, search 5min (see `./cache.ts`).
 *
 * @packageDocumentation
 */

import { readdir, readFile as fsReadFile } from 'node:fs/promises';
import path from 'node:path';

import toml from '@iarna/toml';
import yaml from 'js-yaml';
import simpleGit, { ResetMode } from 'simple-git';

import { parsePackageYaml } from '../packages/parser.js';
import type { PackageDefinition } from '../packages/schema.js';
import { RegistryError } from '../utils/errors.js';
import { ensureDir, exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome } from '../utils/process.js';

import { RegistryCache, TTL_PACKAGE_LIST_MS, TTL_PACKAGE_DETAIL_MS, TTL_SEARCH_MS } from './cache.js';
import { searchAndRank } from './search.js';
import type { RegistryClient, RegistryEntry, RegistryMetadata, SearchOpts, SearchResult } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default upstream registry URL (matches `config/defaults.ts`). */
const DEFAULT_REGISTRY_URL = 'https://github.com/linuxify/registry';

/** Default registry branch. */
const DEFAULT_BRANCH = 'main';

/** Subdirectory of `~/.linuxify/` where the registry clone lives. */
const REGISTRY_SUBDIR = 'registry';

/** Subdirectory of the clone that holds per-package YAML files. */
const PACKAGES_SUBDIR = 'packages';

/** Filename of the registry metadata file at the clone root. */
const REGISTRY_TOML_FILENAME = 'registry.toml';

/** Filename of the timestamp file written on every successful update. */
const LAST_UPDATE_FILENAME = '.last-update';

/** Timeout for git operations (clone, fetch, reset) in milliseconds. */
const GIT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link GitRegistryClient.constructor}.
 *
 * All fields have defaults derived from the user's config, so a caller can
 * construct a client with `{}` for testing (the defaults point at the
 * official registry and `~/.linuxify/registry/`).
 */
export interface GitRegistryClientOptions {
  /** Upstream registry git URL. Defaults to the official registry. */
  registryUrl?: string;
  /** Branch or tag to check out. Defaults to `main`. */
  branch?: string;
  /** Absolute path to the local clone. Defaults to `~/.linuxify/registry/`. */
  localPath?: string;
  /**
   * Whether to trust self-signed TLS certificates. When `true`, sets
   * `GIT_SSL_NO_VERIFY=1` in the process environment before git
   * operations. INSECURE — CI-only.
   */
  trustSelfSigned?: boolean;
  /**
   * Optional pre-constructed cache. Mainly for tests that want to inject
   * a fake clock or assert on cache state. A fresh {@link RegistryCache}
   * is created when omitted.
   */
  cache?: RegistryCache;
  /**
   * Per-operation git timeout in milliseconds. Defaults to 30s per the
   * task spec. Override in tests to avoid waiting 30s for a timeout.
   */
  gitTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// GitRegistryClient
// ---------------------------------------------------------------------------

/**
 * Git-based v1 registry client.
 *
 * See the module docstring for the update protocol, caching strategy, and
 * self-signed-cert handling.
 *
 * @example
 * ```ts
 * const client = new GitRegistryClient({
 *   registryUrl: 'https://github.com/linuxify/registry',
 *   branch: 'main',
 *   localPath: '/home/alice/.linuxify/registry',
 *   trustSelfSigned: false,
 * });
 * await client.update();
 * const pkg = await client.getPackage('cline');
 * const results = await client.search({ query: 'ai' });
 * ```
 */
export class GitRegistryClient implements RegistryClient {
  /** Upstream registry git URL. */
  protected readonly registryUrl: string;
  /** Branch or tag to check out. */
  protected readonly branch: string;
  /** Absolute path to the local clone. */
  protected readonly localPath: string;
  /** Whether self-signed TLS certs are trusted. */
  protected readonly trustSelfSigned: boolean;
  /** In-memory cache for hot paths. */
  protected readonly cache: RegistryCache;
  /** Per-operation git timeout in milliseconds. */
  protected readonly gitTimeoutMs: number;

  /**
   * Construct a registry client.
   *
   * @param opts - See {@link GitRegistryClientOptions}. All fields optional.
   */
  constructor(opts: GitRegistryClientOptions = {}) {
    this.registryUrl = opts.registryUrl ?? DEFAULT_REGISTRY_URL;
    this.branch = opts.branch ?? DEFAULT_BRANCH;
    this.localPath = opts.localPath ?? path.join(getLinuxifyHome(), REGISTRY_SUBDIR);
    this.trustSelfSigned = opts.trustSelfSigned ?? false;
    this.cache = opts.cache ?? new RegistryCache();
    this.gitTimeoutMs = opts.gitTimeoutMs ?? GIT_TIMEOUT_MS;

    if (this.trustSelfSigned) {
      // Set the env var for the lifetime of the process. simple-git spawns
      // git as a child process which inherits process.env, so this is the
      // most reliable way to disable SSL verification per-invocation in v1.
      // The v2 HTTP client will use a per-request agent option instead.
      process.env.GIT_SSL_NO_VERIFY = '1';
      logger.warn(
        'GIT_SSL_NO_VERIFY=1 set — self-signed TLS certificates will be accepted. This is insecure; use only in CI.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async update(): Promise<void> {
    logger.info({ url: this.registryUrl, branch: this.branch, path: this.localPath }, 'updating registry');

    const localExists = await exists(this.localPath);
    try {
      if (!localExists) {
        await this.cloneWithTimeout();
      } else {
        await this.fetchAndResetWithTimeout();
      }
    } catch (err) {
      throw new RegistryError(
        `Failed to update registry from ${this.registryUrl}: ${(err as Error).message}`,
        {
          code: 'E_REGISTRY_UPDATE_FAILED',
          cause: err,
          details: { url: this.registryUrl, branch: this.branch, path: this.localPath },
          fixCommand: 'linuxify update',
          docsUrl: 'docs/09-registry/registry-format.md',
        },
      );
    }

    // Write the .last-update timestamp. Best-effort — a failure here does
    // not invalidate the update; getLastUpdate() will simply return null.
    await this.writeLastUpdate();

    // Invalidate the in-memory cache because the on-disk content may have
    // changed.
    this.cache.invalidate();
    logger.info('registry updated successfully');
  }

  /**
   * Perform the initial shallow clone with a timeout.
   *
   * Uses `--depth 1 --branch <branch>` to keep the on-disk footprint small.
   * The clone target directory must not exist (git refuses to clone into a
   * non-empty dir); the caller is responsible for ensuring `localPath` is
   * either absent or empty.
   */
  protected async cloneWithTimeout(): Promise<void> {
    const parentDir = path.dirname(this.localPath);
    await ensureDir(parentDir);

    // Use a fresh simple-git instance pointed at the parent dir, since the
    // localPath doesn't exist yet.
    const git = simpleGit(parentDir);
    const task = git.clone(this.registryUrl, this.localPath, [
      '--depth',
      '1',
      '--branch',
      this.branch,
    ]);
    await withTimeout(task, this.gitTimeoutMs, `git clone ${this.registryUrl}`);
  }

  /**
   * Fetch upstream and hard-reset the local branch to match.
   *
   * `git reset --hard origin/<branch>` discards any local modifications.
   * This matches the v1 protocol in `registry-format.md` §5 (the stash-
   * and-rebase flow is a v1.1 enhancement).
   */
  protected async fetchAndResetWithTimeout(): Promise<void> {
    const git = simpleGit(this.localPath);
    const fetchTask = git.fetch('origin', this.branch);
    await withTimeout(fetchTask, this.gitTimeoutMs, `git fetch origin ${this.branch}`);

    const resetTask = git.reset(ResetMode.HARD, [`origin/${this.branch}`]);
    await withTimeout(resetTask, this.gitTimeoutMs, `git reset --hard origin/${this.branch}`);
  }

  /**
   * Write the current ISO timestamp to `<localPath>/.last-update`.
   *
   * Best-effort: logs a warning on failure but does not throw, because a
   * missing timestamp file is recoverable (the next successful update will
   * create it) and should not fail the update itself.
   */
  protected async writeLastUpdate(): Promise<void> {
    const tsPath = path.join(this.localPath, LAST_UPDATE_FILENAME);
    const ts = new Date().toISOString();
    try {
      // Use node:fs directly (not utils/fs.writeFile) to avoid the atomic
      // temp-file dance — this is a tiny timestamp file written once per
      // update, and a partial write is harmless (getLastUpdate returns null
      // and the next update overwrites it).
      const { writeFile } = await import('node:fs/promises');
      await writeFile(tsPath, ts, 'utf8');
    } catch (err) {
      logger.warn(
        { path: tsPath, error: (err as Error).message },
        'failed to write .last-update timestamp (non-fatal)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // getPackage()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async getPackage(name: string): Promise<PackageDefinition | null> {
    await this.ensureInitialized();
    const cacheKey = `pkg:${name}`;
    return this.cache.getOrCompute(
      cacheKey,
      async () => {
        const filePath = path.join(this.localPath, PACKAGES_SUBDIR, `${name}.yml`);
        if (!(await exists(filePath))) return null;
        const text = await fsReadFile(filePath, 'utf8');
        // parsePackageYaml runs the full Zod schema; callers get a fully
        // validated PackageDefinition. Invalid YAML throws PackageError
        // (propagated to the caller).
        return parsePackageYaml(text);
      },
      TTL_PACKAGE_DETAIL_MS,
    );
  }

  // -------------------------------------------------------------------------
  // listPackages()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async listPackages(): Promise<RegistryEntry[]> {
    await this.ensureInitialized();
    return this.cache.getOrCompute(
      'list',
      () => this.scanPackagesFromDisk(),
      TTL_PACKAGE_LIST_MS,
    );
  }

  /**
   * Scan `packages/*.yml` in the local clone and extract lightweight
   * metadata (name, version, description, runtime, category, tags) for each.
   *
   * Uses `js-yaml.load()` directly (NOT `parsePackageYaml`) to skip the
   * full Zod validation pass — this is the "parse just metadata, skip full
   * validation for speed" optimization called out in the task spec. Invalid
   * YAMLs are logged at WARN and skipped (they do not fail the listing);
   * the registry CI lint workflow is responsible for keeping `main`
   * clean, and a single broken YAML should not break `linuxify search`.
   *
   * Aliases (`alias_of` present) are excluded from the listing per
   * `registry-format.md` §6 — the alias's target is what shows up.
   *
   * @returns Array of {@link RegistryEntry}, sorted alphabetically by name.
   */
  protected async scanPackagesFromDisk(): Promise<RegistryEntry[]> {
    const packagesDir = path.join(this.localPath, PACKAGES_SUBDIR);
    let files: string[];
    try {
      files = await readdir(packagesDir);
    } catch (err) {
      throw new RegistryError(
        `Failed to read packages directory: ${packagesDir}: ${(err as Error).message}`,
        {
          code: 'E_REGISTRY_CORRUPT',
          cause: err,
          details: { path: packagesDir },
          fixCommand: 'linuxify update',
        },
      );
    }

    const entries: RegistryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const filePath = path.join(packagesDir, file);
      try {
        const text = await fsReadFile(filePath, 'utf8');
        const raw = yaml.load(text) as unknown;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          logger.warn({ file }, 'skipping non-mapping package YAML');
          continue;
        }
        const obj = raw as Record<string, unknown>;
        // Skip aliases — their target is listed instead.
        if (typeof obj.alias_of === 'string') continue;

        const name = typeof obj.name === 'string' ? obj.name : '';
        const version = typeof obj.version === 'string' ? obj.version : '';
        const description = typeof obj.description === 'string' ? obj.description : '';
        const runtime = typeof obj.runtime === 'string' ? obj.runtime : '';
        if (!name || !version || !runtime) {
          logger.warn({ file }, 'skipping package YAML missing required metadata');
          continue;
        }
        const category = typeof obj.category === 'string' ? obj.category : undefined;
        const tags = Array.isArray(obj.tags)
          ? obj.tags.filter((t): t is string => typeof t === 'string')
          : [];
        entries.push({ name, version, description, runtime, category, tags });
      } catch (err) {
        logger.warn(
          { file, error: (err as Error).message },
          'failed to parse package YAML during listing (skipping)',
        );
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  }

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async search(opts: SearchOpts): Promise<SearchResult[]> {
    await this.ensureInitialized();
    const cacheKey = `search:${opts.query}:${opts.runtime ?? ''}:${opts.category ?? ''}:${(opts.tags ?? []).join(',')}:${opts.limit ?? ''}`;
    return this.cache.getOrCompute(
      cacheKey,
      async () => {
        const all = await this.listPackages();
        return searchAndRank(all, opts.query, opts);
      },
      TTL_SEARCH_MS,
    );
  }

  // -------------------------------------------------------------------------
  // getInfo()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  async getInfo(): Promise<RegistryMetadata> {
    await this.ensureInitialized();
    return this.cache.getOrCompute('info', () => this.readRegistryToml());
  }

  /**
   * Read and parse `registry.toml` from the local clone.
   *
   * Extracts `schema_version`, `registry_name`, and `maintainers` (the
   * `github` handle if present, else `name`, else `email`). The
   * `package_count` is computed by counting `packages/*.yml` (excluding
   * aliases) so it stays in sync even if `registry.toml`'s own count is
   * stale.
   *
   * @throws {RegistryError} with code `E_REGISTRY_CORRUPT` if the file is
   *   missing, unparseable, or missing required fields.
   */
  protected async readRegistryToml(): Promise<RegistryMetadata> {
    const tomlPath = path.join(this.localPath, REGISTRY_TOML_FILENAME);
    let text: string;
    try {
      text = await fsReadFile(tomlPath, 'utf8');
    } catch (err) {
      throw new RegistryError(
        `registry.toml not found at ${tomlPath}: ${(err as Error).message}`,
        {
          code: 'E_REGISTRY_CORRUPT',
          cause: err,
          details: { path: tomlPath },
          fixCommand: 'linuxify update',
        },
      );
    }

    let parsed: unknown;
    try {
      parsed = toml.parse(text);
    } catch (err) {
      throw new RegistryError(
        `Failed to parse registry.toml: ${(err as Error).message}`,
        {
          code: 'E_REGISTRY_CORRUPT',
          cause: err,
          details: { path: tomlPath },
          fixCommand: 'linuxify update',
        },
      );
    }

    const obj = parsed as Record<string, unknown>;
    const schemaVersion = obj.schema_version;
    const registryName = obj.registry_name;
    if (typeof schemaVersion !== 'number' || typeof registryName !== 'string') {
      throw new RegistryError(
        'registry.toml is missing required fields (schema_version, registry_name)',
        {
          code: 'E_REGISTRY_CORRUPT',
          details: { path: tomlPath, fields: { schema_version: typeof schemaVersion, registry_name: typeof registryName } },
          fixCommand: 'linuxify update',
        },
      );
    }

    // Maintaineners is an array of tables: [[maintainers]] name=... email=... github=...
    const maintainersRaw = Array.isArray(obj.maintainers) ? obj.maintainers : [];
    const maintainers: string[] = [];
    for (const m of maintainersRaw) {
      if (m !== null && typeof m === 'object' && !Array.isArray(m)) {
        const mo = m as Record<string, unknown>;
        const handle =
          typeof mo.github === 'string'
            ? mo.github
            : typeof mo.name === 'string'
              ? mo.name
              : typeof mo.email === 'string'
                ? mo.email
                : '';
        if (handle) maintainers.push(handle);
      }
    }

    // Compute package_count from disk so it's always accurate. If the
    // scan fails (e.g. packages directory is unreadable), fall back to 0
    // — getInfo() should not throw just because the count is unavailable.
    let packageCount: number;
    try {
      const packages = await this.scanPackagesFromDisk();
      packageCount = packages.length;
    } catch {
      packageCount = 0;
    }

    return {
      schema_version: schemaVersion,
      registry_name: registryName,
      maintainers,
      updated_at: await this.getLastUpdate().then((ts) => ts ?? ''),
      package_count: packageCount,
    };
  }

  // -------------------------------------------------------------------------
  // getRegistryPath() / getLastUpdate()
  // -------------------------------------------------------------------------

  /**
   * @inheritdoc
   */
  getRegistryPath(): string {
    return this.localPath;
  }

  /**
   * @inheritdoc
   */
  async getLastUpdate(): Promise<string | null> {
    const tsPath = path.join(this.localPath, LAST_UPDATE_FILENAME);
    try {
      const text = await fsReadFile(tsPath, 'utf8');
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Ensure the local clone exists and has been initialized.
   *
   * Called by every read method (`getPackage`, `listPackages`, `search`,
   * `getInfo`) before touching the filesystem. Throws
   * `E_REGISTRY_NOT_INITIALIZED` if the clone directory is absent — this
   * means `update()` has never been run.
   *
   * The check is intentionally a directory existence test (not a `git
   * rev-parse` call) so it is fast and does not require git to be
   * installed. A directory that exists but is not a git repo (e.g. the
   * user manually created `~/.linuxify/registry/`) will pass this check
   * and surface errors later when `packages/*.yml` reads fail.
   *
   * @throws {RegistryError} with code `E_REGISTRY_NOT_INITIALIZED` if the
   *   local clone directory does not exist.
   */
  protected async ensureInitialized(): Promise<void> {
    const localExists = await exists(this.localPath);
    if (!localExists) {
      throw new RegistryError(
        `Registry not initialized at ${this.localPath}. Run 'linuxify update' first.`,
        {
          code: 'E_REGISTRY_NOT_INITIALIZED',
          details: { path: this.localPath },
          fixCommand: 'linuxify update',
          docsUrl: 'docs/09-registry/registry-format.md',
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// withTimeout helper
// ---------------------------------------------------------------------------

/**
 * Race a promise against a timeout. Rejects with a {@link RegistryError}
 * (`E_REGISTRY_UPDATE_FAILED`) if the timeout fires first.
 *
 * simple-git does not expose a per-operation timeout option, so we wrap
 * each git call manually. The timeout is 30s per the task spec; a hung
 * clone (e.g. behind a corporate proxy) should not block the CLI
 * indefinitely.
 *
 * @param p - The promise to race.
 * @param ms - Timeout in milliseconds.
 * @param label - Human-readable label for the error message (e.g.
 *   `git clone <url>`).
 */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RegistryError(`Timed out after ${ms}ms: ${label}`, {
            code: 'E_REGISTRY_UPDATE_FAILED',
            details: { label, timeoutMs: ms },
          }),
        ),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
