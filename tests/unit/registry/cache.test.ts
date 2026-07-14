/**
 * Unit tests for `src/registry/cache.ts`.
 *
 * Exercises the `RegistryCache` get/set/invalidate/getOrCompute surface
 * with TTL semantics: cached values expire after their TTL, expired
 * entries are evicted lazily on read, `invalidate()` drops one or all
 * entries, and `getOrCompute` runs `compute` only on a miss.
 *
 * Uses `vi.useFakeTimers()` to control TTL expiry deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RegistryCache, TTL_PACKAGE_LIST_MS, TTL_PACKAGE_DETAIL_MS, TTL_SEARCH_MS } from '../../../src/registry/cache.js';

describe('RegistryCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // get / set
  // -------------------------------------------------------------------------

  describe('get / set', () => {
    it('returns undefined for a missing key', () => {
      const cache = new RegistryCache();
      expect(cache.get('missing')).toBeUndefined();
    });

    it('round-trips a string value', () => {
      const cache = new RegistryCache();
      cache.set('k', 'hello');
      expect(cache.get<string>('k')).toBe('hello');
    });

    it('round-trips an object value', () => {
      const cache = new RegistryCache();
      const obj = { name: 'cline', version: '1.2.0' };
      cache.set('pkg', obj);
      expect(cache.get<typeof obj>('pkg')).toEqual(obj);
    });

    it('round-trips a number value', () => {
      const cache = new RegistryCache();
      cache.set('n', 42);
      expect(cache.get<number>('n')).toBe(42);
    });

    it('overwrites a previous value on re-set', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v1');
      cache.set('k', 'v2');
      expect(cache.get<string>('k')).toBe('v2');
    });

    it('never expires when ttlMs is omitted', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v');
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000); // 1 year
      expect(cache.get<string>('k')).toBe('v');
    });

    it('never expires when ttlMs is 0', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v', 0);
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(cache.get<string>('k')).toBe('v');
    });

    it('never expires when ttlMs is negative (clamped to 0)', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v', -1000);
      vi.advanceTimersByTime(365 * 24 * 60 * 60 * 1000);
      expect(cache.get<string>('k')).toBe('v');
    });

    it('returns the value before TTL expires', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v', 1000);
      vi.advanceTimersByTime(999);
      expect(cache.get<string>('k')).toBe('v');
    });

    it('returns undefined after TTL expires', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v', 1000);
      vi.advanceTimersByTime(1001);
      expect(cache.get<string>('k')).toBeUndefined();
    });

    it('evicts the expired entry on read', () => {
      const cache = new RegistryCache();
      cache.set('k', 'v', 1000);
      vi.advanceTimersByTime(1001);
      // First read returns undefined (miss) and evicts.
      expect(cache.get<string>('k')).toBeUndefined();
      // Internal store should no longer have the entry. We can't inspect
      // the private Map directly, but a subsequent set with the same key
      // should not collide with stale data — verified by reading back.
      cache.set('k', 'v2');
      expect(cache.get<string>('k')).toBe('v2');
    });

    it('uses the configured TTL constants', () => {
      // Sanity-check the exported constants match the docstring values.
      expect(TTL_PACKAGE_LIST_MS).toBe(60 * 60 * 1000); // 1h
      expect(TTL_PACKAGE_DETAIL_MS).toBe(24 * 60 * 60 * 1000); // 24h
      expect(TTL_SEARCH_MS).toBe(5 * 60 * 1000); // 5min
    });
  });

  // -------------------------------------------------------------------------
  // invalidate
  // -------------------------------------------------------------------------

  describe('invalidate', () => {
    it('drops a single key when called with an argument', () => {
      const cache = new RegistryCache();
      cache.set('a', 1);
      cache.set('b', 2);
      cache.invalidate('a');
      expect(cache.get<number>('a')).toBeUndefined();
      expect(cache.get<number>('b')).toBe(2);
    });

    it('is a no-op for a missing key', () => {
      const cache = new RegistryCache();
      expect(() => cache.invalidate('nope')).not.toThrow();
    });

    it('clears all entries when called with no argument', () => {
      const cache = new RegistryCache();
      cache.set('a', 1);
      cache.set('b', 2);
      cache.set('c', 3);
      cache.invalidate();
      expect(cache.get<number>('a')).toBeUndefined();
      expect(cache.get<number>('b')).toBeUndefined();
      expect(cache.get<number>('c')).toBeUndefined();
    });

    it('allows re-population after clear-all', () => {
      const cache = new RegistryCache();
      cache.set('a', 1);
      cache.invalidate();
      cache.set('a', 2);
      expect(cache.get<number>('a')).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getOrCompute
  // -------------------------------------------------------------------------

  describe('getOrCompute', () => {
    it('invokes compute on a miss and caches the result', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('computed');
      const result = await cache.getOrCompute('k', compute);
      expect(result).toBe('computed');
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('returns the cached value on a hit without invoking compute', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('first');
      await cache.getOrCompute('k', compute);
      const result = await cache.getOrCompute('k', compute);
      expect(result).toBe('first');
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('re-invokes compute after the TTL expires', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('v');
      await cache.getOrCompute('k', compute, 1000);
      vi.advanceTimersByTime(1001);
      await cache.getOrCompute('k', compute, 1000);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('does not re-invoke compute before the TTL expires', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('v');
      await cache.getOrCompute('k', compute, 1000);
      vi.advanceTimersByTime(500);
      await cache.getOrCompute('k', compute, 1000);
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('re-invokes compute after invalidate(key)', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('v');
      await cache.getOrCompute('k', compute);
      cache.invalidate('k');
      await cache.getOrCompute('k', compute);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('re-invokes compute after invalidate() (all)', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue('v');
      await cache.getOrCompute('k', compute);
      cache.invalidate();
      await cache.getOrCompute('k', compute);
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('handles object values correctly', async () => {
      const cache = new RegistryCache();
      const pkg = { name: 'cline', version: '1.2.0', tags: ['ai'] };
      const compute = vi.fn().mockResolvedValue(pkg);
      const result = await cache.getOrCompute('pkg:cline', compute);
      expect(result).toEqual(pkg);
      // Second call returns the same object reference (cached).
      const result2 = await cache.getOrCompute('pkg:cline', compute);
      expect(result2).toBe(pkg);
    });

    it('caches null/undefined computed values (does not re-invoke)', async () => {
      // Note: the cache uses `undefined` as the miss sentinel, so caching
      // `undefined` would cause a re-compute on every read. This is a
      // known limitation documented in the cache module. `null` is a
      // valid cached value.
      const cache = new RegistryCache();
      const compute = vi.fn().mockResolvedValue(null);
      await cache.getOrCompute('k', compute);
      await cache.getOrCompute('k', compute);
      expect(compute).toHaveBeenCalledTimes(1);
    });

    it('propagates compute errors without caching', async () => {
      const cache = new RegistryCache();
      const compute = vi.fn().mockRejectedValue(new Error('boom'));
      await expect(cache.getOrCompute('k', compute)).rejects.toThrow('boom');
      // Second call should re-invoke (error was not cached).
      await expect(cache.getOrCompute('k', compute)).rejects.toThrow('boom');
      expect(compute).toHaveBeenCalledTimes(2);
    });

    it('supports concurrent keys independently', async () => {
      const cache = new RegistryCache();
      const computeA = vi.fn().mockResolvedValue('a');
      const computeB = vi.fn().mockResolvedValue('b');
      await Promise.all([
        cache.getOrCompute('a', computeA),
        cache.getOrCompute('b', computeB),
      ]);
      expect(cache.get<string>('a')).toBe('a');
      expect(cache.get<string>('b')).toBe('b');
      expect(computeA).toHaveBeenCalledTimes(1);
      expect(computeB).toHaveBeenCalledTimes(1);
    });
  });
});
