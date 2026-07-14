/**
 * Unit tests for `src/doctor/engine.ts` — the DoctorEngine class.
 *
 * Covers:
 *   - Constructor validation (empty checks array throws).
 *   - Profile filtering (only the checks in the profile's ID list run).
 *   - checkIds override (when set, ignores profile; runs only the named IDs).
 *   - Wave ordering (host → bootstrap → distro/runtime → path → ... → network).
 *   - Parallel execution within a wave (concurrency respected, all results
 *     collected).
 *   - Per-check timeout (a slow check produces a `fail` result with "timed
 *     out" message).
 *   - Bootstrap short-circuit (if bootstrap.completed fails, sibling
 *     bootstrap checks get `skip`).
 *   - Never-throws contract (a check that throws becomes a `fail` result
 *     with "check crashed" message).
 *   - Summary computation (ok/warn/fail/missing/skip/total counts).
 *   - Report metadata (profile, timestamp, linuxifyVersion, durationMs).
 *
 * All checks are mocked — no real subprocess or filesystem I/O. The logger
 * is mocked to keep test output quiet.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import { DoctorEngine, partitionWaves, computeSummary, resolveFormat } from '../../../src/doctor/engine.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { defaultState } from '../../../src/state/store.js';
import type {
  DoctorCheck,
  DoctorContext,
  DoctorResult,
  DoctorStatus,
} from '../../../src/doctor/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A no-op context with the default config and a fresh default state. */
function makeCtx(): DoctorContext {
  return {
    config: DEFAULT_CONFIG,
    state: defaultState(),
  };
}

/** Build a DoctorResult with the given fields and sensible defaults. */
function makeResult(
  id: string,
  status: DoctorStatus,
  message = '',
  durationMs = 1,
): DoctorResult {
  return {
    id,
    name: id,
    category: 'host',
    status,
    message,
    durationMs,
  };
}

/** Build a mock DoctorCheck that resolves with the given result. */
function mockCheck(
  id: string,
  category: DoctorCheck['category'],
  resultOrFn: DoctorResult | (() => DoctorResult | Promise<DoctorResult>),
): DoctorCheck {
  return {
    id,
    name: id,
    category,
    profile: ['standard'],
    run: async () => (typeof resultOrFn === 'function' ? await resultOrFn() : resultOrFn),
  };
}

/** A check that waits `ms` before resolving with the given result. */
function slowCheck(
  id: string,
  category: DoctorCheck['category'],
  ms: number,
  result: DoctorResult,
): DoctorCheck {
  return {
    id,
    name: id,
    category,
    profile: ['standard'],
    run: async () => {
      await new Promise((r) => setTimeout(r, ms));
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DoctorEngine', () => {
  describe('constructor', () => {
    it('throws on empty checks array', () => {
      expect(() => new DoctorEngine({ checks: [] })).toThrow(/non-empty/);
    });

    it('accepts a custom concurrency', () => {
      const c = mockCheck('a', 'host', makeResult('a', 'ok'));
      const eng = new DoctorEngine({ checks: [c], concurrency: 2 });
      expect(eng['concurrency']).toBe(2);
    });

    it('defaults concurrency to 4', () => {
      const c = mockCheck('a', 'host', makeResult('a', 'ok'));
      const eng = new DoctorEngine({ checks: [c] });
      expect(eng['concurrency']).toBe(4);
    });
  });

  describe('run — profile filtering', () => {
    it('runs only the checks whose IDs are in the checkIds list', async () => {
      const ran: string[] = [];
      const hostCheck = mockCheck('host.a', 'host', () => {
        ran.push('host.a');
        return makeResult('host.a', 'ok');
      });
      const netCheck = mockCheck('network.b', 'network', () => {
        ran.push('network.b');
        return makeResult('network.b', 'ok');
      });
      const eng = new DoctorEngine({ checks: [hostCheck, netCheck] });

      const report = await eng.run(
        { checkIds: ['host.a'], profile: 'standard' },
        makeCtx(),
      );
      expect(ran).toEqual(['host.a']);
      expect(report.results).toHaveLength(1);
      expect(report.results[0]?.id).toBe('host.a');
    });

    it('runs all built-in standard-profile checks when checkIds is unset', async () => {
      const { ALL_CHECKS } = await import('../../../src/doctor/checks/index.js');
      const { PROFILE_CHECKS } = await import('../../../src/doctor/profiles.js');
      const eng = new DoctorEngine({ checks: ALL_CHECKS });

      const report = await eng.run({ profile: 'standard' }, makeCtx());
      const expectedIds = PROFILE_CHECKS.standard;
      expect(report.results).toHaveLength(expectedIds.length);
      const gotIds = new Set(report.results.map((r) => r.id));
      for (const id of expectedIds) {
        expect(gotIds.has(id)).toBe(true);
      }
    });

    it('deep profile runs more checks than standard', async () => {
      const { ALL_CHECKS } = await import('../../../src/doctor/checks/index.js');
      const eng = new DoctorEngine({ checks: ALL_CHECKS });
      const std = await eng.run({ profile: 'standard' }, makeCtx());
      const deep = await eng.run({ profile: 'deep' }, makeCtx());
      expect(deep.results.length).toBeGreaterThan(std.results.length);
    });

    it('pre-flight profile runs only the host checks', async () => {
      const { ALL_CHECKS } = await import('../../../src/doctor/checks/index.js');
      const eng = new DoctorEngine({ checks: ALL_CHECKS });
      const report = await eng.run({ profile: 'pre-flight' }, makeCtx());
      expect(report.results).toHaveLength(4);
      for (const r of report.results) {
        expect(r.category).toBe('host');
      }
    });

    it('minimal profile runs only the 4 critical checks', async () => {
      const { ALL_CHECKS } = await import('../../../src/doctor/checks/index.js');
      const eng = new DoctorEngine({ checks: ALL_CHECKS });
      const report = await eng.run({ profile: 'minimal' }, makeCtx());
      expect(report.results).toHaveLength(4);
      const ids = new Set(report.results.map((r) => r.id));
      expect(ids.has('bootstrap.completed')).toBe(true);
      expect(ids.has('distro.installed')).toBe(true);
      expect(ids.has('runtime.node')).toBe(true);
      expect(ids.has('path.linuxify_bin')).toBe(true);
    });
  });

  describe('run — checkIds override', () => {
    it('checkIds overrides profile filter and runs only the named IDs', async () => {
      const ran: string[] = [];
      const a = mockCheck('a', 'host', () => {
        ran.push('a');
        return makeResult('a', 'ok');
      });
      const b = mockCheck('b', 'host', () => {
        ran.push('b');
        return makeResult('b', 'ok');
      });
      const eng = new DoctorEngine({ checks: [a, b] });

      await eng.run({ checkIds: ['b'], profile: 'standard' }, makeCtx());
      expect(ran).toEqual(['b']);
    });

    it('checkIds referring to unknown IDs runs nothing (no error)', async () => {
      const a = mockCheck('a', 'host', makeResult('a', 'ok'));
      const eng = new DoctorEngine({ checks: [a] });
      const report = await eng.run({ checkIds: ['does-not-exist'] }, makeCtx());
      expect(report.results).toHaveLength(0);
      expect(report.summary.total).toBe(0);
    });

    it('multiple checkIds all run', async () => {
      const ran: string[] = [];
      const checks: DoctorCheck[] = ['a', 'b', 'c'].map((id) =>
        mockCheck(id, 'host', () => {
          ran.push(id);
          return makeResult(id, 'ok');
        }),
      );
      const eng = new DoctorEngine({ checks });
      await eng.run({ checkIds: ['a', 'b', 'c'] }, makeCtx());
      expect(ran.sort()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('run — wave ordering', () => {
    it('runs host wave before runtime wave before network wave', async () => {
      const order: string[] = [];
      const host: DoctorCheck = {
        id: 'host.x',
        name: 'host.x',
        category: 'host',
        profile: ['standard'],
        run: async () => {
          order.push('host.x');
          return makeResult('host.x', 'ok');
        },
      };
      const runtime: DoctorCheck = {
        id: 'runtime.y',
        name: 'runtime.y',
        category: 'runtime',
        profile: ['standard'],
        run: async () => {
          order.push('runtime.y');
          return makeResult('runtime.y', 'ok');
        },
      };
      const network: DoctorCheck = {
        id: 'network.z',
        name: 'network.z',
        category: 'network',
        profile: ['standard'],
        run: async () => {
          order.push('network.z');
          return makeResult('network.z', 'ok');
        },
      };
      const eng = new DoctorEngine({ checks: [network, host, runtime] });
      await eng.run({ checkIds: ['network.z', 'host.x', 'runtime.y'] }, makeCtx());

      const hostIdx = order.indexOf('host.x');
      const rtIdx = order.indexOf('runtime.y');
      const netIdx = order.indexOf('network.z');
      expect(hostIdx).toBeLessThan(rtIdx);
      expect(rtIdx).toBeLessThan(netIdx);
    });
  });

  describe('run — parallel execution', () => {
    it('runs checks in the same wave in parallel', async () => {
      const a = slowCheck('a', 'host', 50, makeResult('a', 'ok'));
      const b = slowCheck('b', 'host', 50, makeResult('b', 'ok'));
      const eng = new DoctorEngine({ checks: [a, b] });
      const start = Date.now();
      await eng.run({ checkIds: ['a', 'b'] }, makeCtx());
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(120);
    });

    it('respects concurrency limit within a wave', async () => {
      const checks: DoctorCheck[] = [
        slowCheck('a', 'host', 50, makeResult('a', 'ok')),
        slowCheck('b', 'host', 50, makeResult('b', 'ok')),
        slowCheck('c', 'host', 50, makeResult('c', 'ok')),
        slowCheck('d', 'host', 50, makeResult('d', 'ok')),
      ];
      const eng = new DoctorEngine({ checks, concurrency: 2 });
      const start = Date.now();
      await eng.run({ checkIds: ['a', 'b', 'c', 'd'] }, makeCtx());
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(90);
      expect(elapsed).toBeLessThan(220);
    });
  });

  describe('run — per-check timeout', () => {
    it('a check that exceeds the timeout produces a fail result', async () => {
      const slow = slowCheck('slow', 'host', 200, makeResult('slow', 'ok'));
      const eng = new DoctorEngine({ checks: [slow] });
      const report = await eng.run(
        { checkIds: ['slow'], timeoutMs: 50 },
        makeCtx(),
      );
      expect(report.results).toHaveLength(1);
      const r = report.results[0]!;
      expect(r.status).toBe('fail');
      expect(r.message).toMatch(/timed out/);
    });

    it('a check that finishes before the timeout reports its own status', async () => {
      const fast = slowCheck('fast', 'host', 10, makeResult('fast', 'ok'));
      const eng = new DoctorEngine({ checks: [fast] });
      const report = await eng.run(
        { checkIds: ['fast'], timeoutMs: 200 },
        makeCtx(),
      );
      expect(report.results[0]?.status).toBe('ok');
    });
  });

  describe('run — never throws', () => {
    it('a check that throws becomes a fail result with "check crashed" message', async () => {
      const crasher: DoctorCheck = {
        id: 'crasher',
        name: 'crasher',
        category: 'host',
        profile: ['standard'],
        run: async () => {
          throw new Error('boom');
        },
      };
      const eng = new DoctorEngine({ checks: [crasher] });
      const report = await eng.run({ checkIds: ['crasher'] }, makeCtx());
      expect(report.results).toHaveLength(1);
      const r = report.results[0]!;
      expect(r.status).toBe('fail');
      expect(r.message).toMatch(/check crashed/);
      expect(r.message).toMatch(/boom/);
      expect(r.detail).toBeDefined();
    });

    it('engine.run never rejects even when multiple checks throw', async () => {
      const a: DoctorCheck = {
        id: 'a',
        name: 'a',
        category: 'host',
        profile: ['standard'],
        run: async () => {
          throw new Error('a');
        },
      };
      const b: DoctorCheck = {
        id: 'b',
        name: 'b',
        category: 'host',
        profile: ['standard'],
        run: async () => {
          throw new Error('b');
        },
      };
      const eng = new DoctorEngine({ checks: [a, b] });
      const report = await eng.run({ checkIds: ['a', 'b'] }, makeCtx());
      expect(report.results).toHaveLength(2);
      expect(report.results.every((r) => r.status === 'fail')).toBe(true);
    });
  });

  describe('run — bootstrap short-circuit', () => {
    it('if bootstrap.completed fails, sibling bootstrap checks get skip', async () => {
      const completed: DoctorCheck = {
        id: 'bootstrap.completed',
        name: 'Bootstrap completed',
        category: 'bootstrap',
        profile: ['standard'],
        run: async () => makeResult('bootstrap.completed', 'fail', 'incomplete'),
      };
      const otherBootstrap: DoctorCheck = {
        id: 'bootstrap.stage_5',
        name: 'Stage 5',
        category: 'bootstrap',
        profile: ['standard'],
        run: async () => makeResult('bootstrap.stage_5', 'ok'),
      };
      const eng = new DoctorEngine({ checks: [completed, otherBootstrap] });
      const report = await eng.run(
        { checkIds: ['bootstrap.completed', 'bootstrap.stage_5'] },
        makeCtx(),
      );
      const completedR = report.results.find((r) => r.id === 'bootstrap.completed');
      const otherR = report.results.find((r) => r.id === 'bootstrap.stage_5');
      expect(completedR?.status).toBe('fail');
      expect(otherR?.status).toBe('skip');
      expect(otherR?.message).toMatch(/bootstrap not complete/);
    });

    it('if bootstrap.completed passes, sibling bootstrap checks run normally', async () => {
      const completed = mockCheck(
        'bootstrap.completed',
        'bootstrap',
        makeResult('bootstrap.completed', 'ok'),
      );
      const other = mockCheck(
        'bootstrap.stage_5',
        'bootstrap',
        makeResult('bootstrap.stage_5', 'ok'),
      );
      const eng = new DoctorEngine({ checks: [completed, other] });
      const report = await eng.run(
        { checkIds: ['bootstrap.completed', 'bootstrap.stage_5'] },
        makeCtx(),
      );
      expect(report.results.find((r) => r.id === 'bootstrap.completed')?.status).toBe('ok');
      expect(report.results.find((r) => r.id === 'bootstrap.stage_5')?.status).toBe('ok');
    });
  });

  describe('run — summary computation', () => {
    it('counts each status correctly', async () => {
      const checks: DoctorCheck[] = [
        mockCheck('ok1', 'host', makeResult('ok1', 'ok')),
        mockCheck('ok2', 'host', makeResult('ok2', 'ok')),
        mockCheck('warn1', 'host', makeResult('warn1', 'warn')),
        mockCheck('fail1', 'host', makeResult('fail1', 'fail')),
        mockCheck('missing1', 'host', makeResult('missing1', 'missing')),
        mockCheck('skip1', 'host', makeResult('skip1', 'skip')),
      ];
      const eng = new DoctorEngine({ checks });
      const report = await eng.run({ checkIds: checks.map((c) => c.id) }, makeCtx());
      expect(report.summary).toEqual({
        ok: 2,
        warn: 1,
        fail: 1,
        missing: 1,
        skip: 1,
        total: 6,
      });
    });

    it('empty result set yields zeroed summary', async () => {
      const eng = new DoctorEngine({ checks: [mockCheck('a', 'host', makeResult('a', 'ok'))] });
      const report = await eng.run({ checkIds: ['unknown'] }, makeCtx());
      expect(report.summary).toEqual({
        ok: 0,
        warn: 0,
        fail: 0,
        missing: 0,
        skip: 0,
        total: 0,
      });
    });
  });

  describe('run — report metadata', () => {
    it('includes the profile, timestamp, and linuxifyVersion', async () => {
      const eng = new DoctorEngine({ checks: [mockCheck('a', 'host', makeResult('a', 'ok'))] });
      const report = await eng.run({ checkIds: ['a'], profile: 'deep' }, makeCtx());
      expect(report.profile).toBe('deep');
      expect(report.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(report.linuxifyVersion).toMatch(/^\d+\.\d+\./);
      expect(report.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('defaults profile to standard when unset', async () => {
      const eng = new DoctorEngine({ checks: [mockCheck('a', 'host', makeResult('a', 'ok'))] });
      const report = await eng.run({ checkIds: ['a'] }, makeCtx());
      expect(report.profile).toBe('standard');
    });
  });
});

describe('partitionWaves', () => {
  it('groups checks by category into ordered waves', () => {
    const checks: DoctorCheck[] = [
      mockCheck('h', 'host', makeResult('h', 'ok')),
      mockCheck('b', 'bootstrap', makeResult('b', 'ok')),
      mockCheck('d', 'distro', makeResult('d', 'ok')),
      mockCheck('r', 'runtime', makeResult('r', 'ok')),
      mockCheck('p', 'path', makeResult('p', 'ok')),
      mockCheck('c', 'compat', makeResult('c', 'ok')),
      mockCheck('n', 'network', makeResult('n', 'ok')),
      mockCheck('s', 'services', makeResult('s', 'ok')),
    ];
    const waves = partitionWaves(checks);
    // distro + runtime share wave 2; all others are solo. 7 waves total.
    expect(waves).toHaveLength(7);
    expect(waves[0]?.map((c) => c.id)).toEqual(['h']);
    expect(waves[1]?.map((c) => c.id)).toEqual(['b']);
    expect(waves[2]?.map((c) => c.id).sort()).toEqual(['d', 'r']);
    expect(waves[3]?.map((c) => c.id)).toEqual(['p']);
    expect(waves[4]?.map((c) => c.id)).toEqual(['c']);
    expect(waves[5]?.map((c) => c.id)).toEqual(['n']);
    expect(waves[6]?.map((c) => c.id)).toEqual(['s']);
  });

  it('filters out empty waves', () => {
    const checks: DoctorCheck[] = [mockCheck('h', 'host', makeResult('h', 'ok'))];
    const waves = partitionWaves(checks);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.map((c) => c.id)).toEqual(['h']);
  });

  it('unknown category defaults to wave 4 (packages)', () => {
    const checks: DoctorCheck[] = [
      {
        id: 'x',
        name: 'x',
        category: 'team' as DoctorCheck['category'],
        profile: ['standard'],
        run: async () => makeResult('x', 'ok'),
      },
    ];
    const waves = partitionWaves(checks);
    expect(waves).toHaveLength(1);
    expect(waves[0]?.map((c) => c.id)).toEqual(['x']);
  });
});

describe('computeSummary', () => {
  it('counts each status', () => {
    const results: DoctorResult[] = [
      makeResult('a', 'ok'),
      makeResult('b', 'ok'),
      makeResult('c', 'warn'),
      makeResult('d', 'fail'),
      makeResult('e', 'missing'),
      makeResult('f', 'skip'),
    ];
    expect(computeSummary(results)).toEqual({
      ok: 2,
      warn: 1,
      fail: 1,
      missing: 1,
      skip: 1,
      total: 6,
    });
  });

  it('empty array yields zeroed summary', () => {
    expect(computeSummary([])).toEqual({
      ok: 0,
      warn: 0,
      fail: 0,
      missing: 0,
      skip: 0,
      total: 0,
    });
  });
});

describe('resolveFormat', () => {
  it('returns json when json flag set', () => {
    expect(resolveFormat({ json: true })).toBe('json');
  });

  it('returns markdown when markdown flag set (and json not)', () => {
    expect(resolveFormat({ markdown: true })).toBe('markdown');
  });

  it('returns quiet when quiet flag set (and json/markdown not)', () => {
    expect(resolveFormat({ quiet: true })).toBe('quiet');
  });

  it('returns human when no format flag set', () => {
    expect(resolveFormat({})).toBe('human');
  });

  it('json takes precedence over markdown and quiet', () => {
    expect(resolveFormat({ json: true, markdown: true, quiet: true })).toBe('json');
  });

  it('markdown takes precedence over quiet', () => {
    expect(resolveFormat({ markdown: true, quiet: true })).toBe('markdown');
  });
});
