/**
 * In-memory TTL cache for registry lookups.
 *
 * @module linuxify/registry/cache
 *
 * The registry client reads every `packages/*.yml` from disk on every
 * `listPackages()` call. For a registry with dozens of packages that is ~10ms
 * per scan — fine for a single CLI invocation, but wasteful when the same
 * process issues many lookups (e.g. an install loop, `linuxify doctor` which
 * resolves every installed package's YAML).
 *
 * `RegistryCache` is a small `Map`-backed cache with per-entry TTL. The
 * {@link ./git-registry.ts | GitRegistryClient} wraps its hot paths
 * (`listPackages`, `getPackage`, `search`) with `getOrCompute` so a second
 * call within the TTL window returns the cached value without re-reading
 * disk. The cache is invalidated wholesale on every successful `update()`
 * (because the on-disk content may have changed).
 *
 * TTLs are intentionally short (minutes to hours, not days) because the
 * cache is process-local and not persisted to disk — a new CLI invocation
 * always starts cold. Persistent caching across invocations is unnecessary
 * in v1 because the local git clone IS the persistent cache; the in-memory
 * layer exists only to avoid redundant disk reads within a single run.
 *
 * The cache is not thread-safe in the multi-process sense (Node is
 * single-threaded so this is moot), but it IS safe for concurrent async
 * callers within one process: a slow `compute` function invoked twice with
 * the same key will run twice (the cache does not deduplicate in-flight
 * computations). Deduplication is intentionally omitted to keep the
 * implementation tiny and to avoid the deadlock risk of an in-flight
 * `Promise` whose `compute` recursively calls `getOrCompute` on the same
 * key.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Default TTLs (milliseconds)
// ---------------------------------------------------------------------------

/** Default TTL for the package list cache: 1 hour. */
export const TTL_PACKAGE_LIST_MS = 60 * 60 * 1000;

/** Default TTL for a single package's detail cache: 24 hours. */
export const TTL_PACKAGE_DETAIL_MS = 24 * 60 * 60 * 1000;

/** Default TTL for search results: 5 minutes. */
export const TTL_SEARCH_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

/**
 * Internal cache entry. Stores the value alongside its expiration timestamp
 * (epoch millis). Expired entries are evicted lazily — they remain in the
 * `Map` until the next `get` or `invalidate` call observes them, at which
 * point they are removed and treated as a miss.
 */
interface CacheEntry<T> {
  /** The cached value. */
  readonly value: T;
  /** Epoch millis at which this entry expires. `Infinity` = never expires. */
  readonly expiresAt: number;
}

// ---------------------------------------------------------------------------
// RegistryCache
// ---------------------------------------------------------------------------

/**
 * A per-process TTL cache for registry lookups.
 *
 * Use `getOrCompute(key, compute, ttlMs)` to read a cached value or invoke
 * `compute` and cache the result. Use `invalidate(key?)` to drop a single
 * entry or clear the whole cache (the registry client calls
 * `invalidate()` on every successful `update()`).
 *
 * @example
 * ```ts
 * const cache = new RegistryCache();
 * const packages = await cache.getOrCompute(
 *   'list',
 *   () => scanPackagesFromDisk(),
 *   TTL_PACKAGE_LIST_MS,
 * );
 * ```
 */
export class RegistryCache {
  /** Backing store. Keys are caller-supplied strings. */
  private readonly store: Map<string, CacheEntry<unknown>> = new Map();

  /**
   * Read a cached value by key.
   *
   * Returns `undefined` if the key is not in the cache or if the entry has
   * expired (in which case the expired entry is also evicted from the
   * backing store).
   *
   * @typeParam T - The expected value type. The cast is unchecked; callers
   *   that share a key across different value types will get whatever was
   *   last written.
   * @param key - Cache key.
   * @returns The cached value, or `undefined` on miss/expiry.
   */
  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt !== Infinity && Date.now() > entry.expiresAt) {
      // Lazy eviction: expired entries are removed on read.
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  /**
   * Write a value to the cache with an optional TTL.
   *
   * @typeParam T - The value type.
   * @param key - Cache key.
   * @param value - Value to cache.
   * @param ttlMs - Time-to-live in milliseconds. `0` or `undefined` means
   *   the entry never expires (use `Infinity` for the same effect
   *   explicitly). Negative values are clamped to `0` (never expires).
   */
  set<T>(key: string, value: T, ttlMs?: number): void {
    let expiresAt: number;
    if (ttlMs === undefined || ttlMs <= 0) {
      expiresAt = Infinity;
    } else {
      expiresAt = Date.now() + ttlMs;
    }
    this.store.set(key, { value, expiresAt });
  }

  /**
   * Invalidate one key or the entire cache.
   *
   * @param key - If provided, removes only that key (no-op if absent). If
   *   omitted, clears all entries.
   */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.store.clear();
    } else {
      this.store.delete(key);
    }
  }

  /**
   * Read a cached value, or compute and cache it if absent.
   *
   * If the key is present and not expired, returns the cached value
   * immediately. Otherwise invokes `compute()` and caches the result with
   * the given `ttlMs` before returning it.
   *
   * Note: concurrent calls with the same key (before the first `compute`
   * resolves) will both invoke `compute`. This is intentional — see the
   * module docstring.
   *
   * @typeParam T - The value type.
   * @param key - Cache key.
   * @param compute - Function that produces the value on miss.
   * @param ttlMs - TTL for the freshly-computed entry. Defaults to
   *   "never expires" (`Infinity`) when omitted.
   * @returns The cached or freshly-computed value.
   */
  async getOrCompute<T>(
    key: string,
    compute: () => Promise<T>,
    ttlMs?: number,
  ): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }
}
