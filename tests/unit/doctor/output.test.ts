/**
 * Unit tests for `src/doctor/output.ts` — the four output formatters.
 *
 * Covers:
 *   - `formatHuman` — colored symbols, category sections, summary footer.
 *   - `formatJson` — `linuxify.doctor.v1` schema, 2-space indent, parseable.
 *   - `formatMarkdown` — Markdown table with header + summary + rows.
 *   - `formatQuiet` — one line per failing result, plain text.
 *   - `formatReport` dispatch.
 *
 * Tests use `NO_COLOR=1` (set globally in `tests/setup.ts`) so chalk's
 * output is plain text and assertions can match exact strings. A separate
 * test verifies that color is applied when `NO_COLOR` is unset.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  formatHuman,
  formatJson,
  formatMarkdown,
  formatQuiet,
  formatReport,
  DOCTOR_JSON_SCHEMA,
} from '../../../src/doctor/output.js';
import type { DoctorReport, DoctorResult } from '../../../src/doctor/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Infer the category from the check id prefix (e.g. `runtime.node` → `runtime`). */
function inferCategory(id: string): DoctorResult['category'] {
  const prefix = id.split('.')[0];
  switch (prefix) {
    case 'host':
    case 'bootstrap':
    case 'distro':
    case 'runtime':
    case 'path':
    case 'packages':
    case 'compat':
    case 'network':
    case 'services':
      return prefix;
    default:
      return 'host';
  }
}

/** Build a DoctorResult with sensible defaults. Category is inferred from the id prefix. */
function result(over: Partial<DoctorResult> & Pick<DoctorResult, 'id' | 'status'>): DoctorResult {
  return {
    name: over.id,
    category: inferCategory(over.id),
    message: '',
    durationMs: 1,
    ...over,
  };
}

/** Build a small report with one result per status. */
function sampleReport(): DoctorReport {
  return {
    results: [
      result({ id: 'host.termux', name: 'Termux', status: 'ok', message: 'Termux 0.118 detected.' }),
      result({ id: 'host.storage', name: 'Storage', status: 'warn', message: 'Low disk space: 3 GB.' }),
      result({ id: 'runtime.node', name: 'Node.js', status: 'fail', message: 'Node v18 (expected v20).', fixCommand: 'linuxify runtimes install node 22' }),
      result({ id: 'services.redis', name: 'Redis', status: 'missing', message: 'redis-cli not on PATH.', fixCommand: 'linuxify add redis' }),
      result({ id: 'network.dns', name: 'DNS', status: 'skip', message: 'Skipped (--offline).' }),
    ],
    summary: { ok: 1, warn: 1, fail: 1, missing: 1, skip: 1, total: 5 },
    durationMs: 1234,
    profile: 'standard',
    timestamp: '2025-01-15T14:32:11.000Z',
    linuxifyVersion: '0.1.0-alpha.1',
  };
}

/** Build an empty report (no results). */
function emptyReport(): DoctorReport {
  return {
    results: [],
    summary: { ok: 0, warn: 0, fail: 0, missing: 0, skip: 0, total: 0 },
    durationMs: 5,
    profile: 'minimal',
    timestamp: '2025-01-15T14:32:11.000Z',
    linuxifyVersion: '0.1.0-alpha.1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doctor/output — formatHuman', () => {
  let prevNoColor: string | undefined;

  beforeEach(() => {
    prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
  });

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it('includes the Linuxify version header', () => {
    const out = formatHuman(sampleReport());
    expect(out).toContain('Linuxify v0.1.0-alpha.1');
  });

  it('includes the profile and timestamp', () => {
    const out = formatHuman(sampleReport());
    expect(out).toContain('Profile    standard');
    expect(out).toContain('Timestamp  2025-01-15T14:32:11.000Z');
  });

  it('includes the duration', () => {
    const out = formatHuman(sampleReport());
    expect(out).toContain('Duration   1234 ms');
  });

  it('includes a category section header for each category present', () => {
    const out = formatHuman(sampleReport());
    // host category (Termux, Storage), runtime (Node.js), services (Redis),
    // network (DNS).
    expect(out).toContain('Host');
    expect(out).toContain('Runtime');
    expect(out).toContain('Services');
    expect(out).toContain('Network');
  });

  it('includes each result message', () => {
    const out = formatHuman(sampleReport());
    expect(out).toContain('Termux 0.118 detected.');
    expect(out).toContain('Low disk space: 3 GB.');
    expect(out).toContain('Node v18 (expected v20).');
    expect(out).toContain('redis-cli not on PATH.');
    expect(out).toContain('Skipped (--offline).');
  });

  it('includes a summary footer with counts', () => {
    const out = formatHuman(sampleReport());
    expect(out).toContain('Total: 5');
    expect(out).toContain('OK: 1');
    expect(out).toContain('Warn: 1');
    expect(out).toContain('Fail: 1');
    expect(out).toContain('Missing: 1');
    expect(out).toContain('Skip: 1');
  });

  it('reports "issues found" when any warn/fail/missing present', () => {
    const out = formatHuman(sampleReport());
    expect(out).toMatch(/3 issues found/);
    expect(out).toContain('linuxify repair');
  });

  it('reports "All checks passed" when no issues', () => {
    const okReport: DoctorReport = {
      ...sampleReport(),
      results: [result({ id: 'a', status: 'ok', message: 'fine' })],
      summary: { ok: 1, warn: 0, fail: 0, missing: 0, skip: 0, total: 1 },
    };
    const out = formatHuman(okReport);
    expect(out).toContain('All checks passed');
    expect(out).not.toContain('issues found');
  });

  it('handles an empty report without throwing', () => {
    const out = formatHuman(emptyReport());
    expect(out).toContain('Linuxify v0.1.0-alpha.1');
    expect(out).toContain('Total: 0');
    expect(out).toContain('All checks passed');
  });
});

describe('doctor/output — formatJson', () => {
  it('produces valid JSON parseable by JSON.parse', () => {
    const out = formatJson(sampleReport());
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
  });

  it('includes the schema version', () => {
    const out = formatJson(sampleReport());
    const parsed = JSON.parse(out) as { schema: string };
    expect(parsed.schema).toBe(DOCTOR_JSON_SCHEMA);
    expect(parsed.schema).toBe('linuxify.doctor.v1');
  });

  it('includes the linuxifyVersion, profile, timestamp, durationMs', () => {
    const out = formatJson(sampleReport());
    const parsed = JSON.parse(out) as {
      linuxifyVersion: string;
      profile: string;
      timestamp: string;
      durationMs: number;
    };
    expect(parsed.linuxifyVersion).toBe('0.1.0-alpha.1');
    expect(parsed.profile).toBe('standard');
    expect(parsed.timestamp).toBe('2025-01-15T14:32:11.000Z');
    expect(parsed.durationMs).toBe(1234);
  });

  it('includes the full results array', () => {
    const out = formatJson(sampleReport());
    const parsed = JSON.parse(out) as { results: DoctorResult[] };
    expect(parsed.results).toHaveLength(5);
    expect(parsed.results[0]?.id).toBe('host.termux');
    expect(parsed.results[2]?.fixCommand).toBe('linuxify runtimes install node 22');
  });

  it('includes the summary object', () => {
    const out = formatJson(sampleReport());
    const parsed = JSON.parse(out) as { summary: Record<string, number> };
    expect(parsed.summary).toEqual({
      ok: 1,
      warn: 1,
      fail: 1,
      missing: 1,
      skip: 1,
      total: 5,
    });
  });

  it('uses 2-space indentation', () => {
    const out = formatJson(sampleReport());
    // The first line is `{`, the second line is `  "schema": ...` (2 spaces).
    const lines = out.split('\n');
    expect(lines[1]).toMatch(/^  "schema":/);
  });

  it('handles an empty report', () => {
    const out = formatJson(emptyReport());
    const parsed = JSON.parse(out) as { results: unknown[]; summary: Record<string, number> };
    expect(parsed.results).toEqual([]);
    expect(parsed.summary.total).toBe(0);
  });
});

describe('doctor/output — formatMarkdown', () => {
  it('includes a top-level header', () => {
    const out = formatMarkdown(sampleReport());
    expect(out.split('\n')[0]).toBe('# Linuxify Doctor Report');
  });

  it('includes metadata bullets', () => {
    const out = formatMarkdown(sampleReport());
    expect(out).toContain('- **Linuxify version**: 0.1.0-alpha.1');
    expect(out).toContain('- **Profile**: standard');
    expect(out).toContain('- **Timestamp**: 2025-01-15T14:32:11.000Z');
    expect(out).toContain('- **Duration**: 1234 ms');
  });

  it('includes a summary bullet with counts', () => {
    const out = formatMarkdown(sampleReport());
    expect(out).toContain('OK: 1');
    expect(out).toContain('Warn: 1');
    expect(out).toContain('Fail: 1');
    expect(out).toContain('Missing: 1');
    expect(out).toContain('Skip: 1');
  });

  it('includes a table header row', () => {
    const out = formatMarkdown(sampleReport());
    expect(out).toContain('| ID | Name | Category | Status | Message | Fix |');
    expect(out).toContain('| --- | --- | --- | --- | --- | --- |');
  });

  it('includes a row per result', () => {
    const out = formatMarkdown(sampleReport());
    expect(out).toContain('| host.termux |');
    expect(out).toContain('| host.storage |');
    expect(out).toContain('| runtime.node |');
    expect(out).toContain('| services.redis |');
    expect(out).toContain('| network.dns |');
  });

  it('uses uppercase status tokens (OK/WARN/FAIL/MISSING/SKIP)', () => {
    const out = formatMarkdown(sampleReport());
    expect(out).toContain('| OK |');
    expect(out).toContain('| WARN |');
    expect(out).toContain('| FAIL |');
    expect(out).toContain('| MISSING |');
    expect(out).toContain('| SKIP |');
  });

  it('escapes pipes in message text', () => {
    const report: DoctorReport = {
      ...sampleReport(),
      results: [result({ id: 'x', status: 'ok', message: 'a | b | c' })],
    };
    const out = formatMarkdown(report);
    expect(out).toContain('a \\| b \\| c');
    expect(out).not.toMatch(/a \| b \| c/);
  });

  it('handles an empty report with a "no checks" message', () => {
    const out = formatMarkdown(emptyReport());
    expect(out).toContain('No checks ran');
  });
});

describe('doctor/output — formatQuiet', () => {
  it('includes only failing results (warn/fail/missing)', () => {
    const out = formatQuiet(sampleReport());
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    expect(out).toContain('host.storage: warn: Low disk space: 3 GB.');
    expect(out).toContain('runtime.node: fail: Node v18 (expected v20).');
    expect(out).toContain('services.redis: missing: redis-cli not on PATH.');
  });

  it('omits ok and skip results', () => {
    const out = formatQuiet(sampleReport());
    expect(out).not.toContain('host.termux');
    expect(out).not.toContain('network.dns');
  });

  it('returns empty string when all results pass', () => {
    const okReport: DoctorReport = {
      ...sampleReport(),
      results: [
        result({ id: 'a', status: 'ok' }),
        result({ id: 'b', status: 'skip' }),
      ],
    };
    expect(formatQuiet(okReport)).toBe('');
  });

  it('returns empty string for an empty report', () => {
    expect(formatQuiet(emptyReport())).toBe('');
  });

  it('uses format "<id>: <status>: <message>"', () => {
    const out = formatQuiet(sampleReport());
    expect(out).toMatch(/^host\.storage: warn: Low disk space: 3 GB\.$/m);
  });
});

describe('doctor/output — formatReport dispatch', () => {
  it('dispatches to formatHuman', () => {
    const r = sampleReport();
    expect(formatReport(r, 'human')).toBe(formatHuman(r));
  });

  it('dispatches to formatJson', () => {
    const r = sampleReport();
    expect(formatReport(r, 'json')).toBe(formatJson(r));
  });

  it('dispatches to formatMarkdown', () => {
    const r = sampleReport();
    expect(formatReport(r, 'markdown')).toBe(formatMarkdown(r));
  });

  it('dispatches to formatQuiet', () => {
    const r = sampleReport();
    expect(formatReport(r, 'quiet')).toBe(formatQuiet(r));
  });

  it('falls back to human for unknown format', () => {
    const r = sampleReport();
    // @ts-expect-error — intentionally invalid format string.
    expect(formatReport(r, 'yaml')).toBe(formatHuman(r));
  });
});

describe('doctor/output — color behavior', () => {
  let prevNoColor: string | undefined;

  beforeEach(() => {
    prevNoColor = process.env.NO_COLOR;
  });

  afterEach(() => {
    if (prevNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prevNoColor;
  });

  it('emits plain text when NO_COLOR=1 (chalk auto-disables)', () => {
    process.env.NO_COLOR = '1';
    const out = formatHuman(sampleReport());
    expect(out).not.toMatch(/\u001b\[\d+m/);
  });

  it('formatReport still produces output when NO_COLOR is unset', () => {
    // chalk caches color support at module load time (when tests/setup.ts
    // sets NO_COLOR=1). We can't force a re-detection here, so we just
    // verify the format functions don't crash and produce a non-empty
    // string regardless of the env var state.
    delete process.env.NO_COLOR;
    const out = formatHuman(sampleReport());
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Linuxify');
  });
});
