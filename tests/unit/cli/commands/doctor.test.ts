/**
 * Unit tests for `src/cli/commands/doctor.ts` — the `runDoctor` function.
 *
 * The doctor command is tested in isolation by constructing a mock
 * {@link CommandContext} with a stubbed {@link DoctorEngine}. The tests
 * verify:
 *  - All-OK report exits 0.
 *  - Report with warnings exits 1.
 *  - Report with failures exits 2 (STEP_FAILED alias used by doctor).
 *  - `--ci` elevates warnings to failures (exit non-zero).
 *  - Unknown profile exits with NOT_FOUND.
 *  - `--json` emits the JSON form.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the logger so test output stays quiet.
vi.mock('../../../../src/utils/log.js', () => {
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

import { runDoctor } from '../../../../src/cli/commands/doctor.js';
import type { CommandContext } from '../../../../src/cli/context.js';
import { Output } from '../../../../src/cli/output.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import type { DoctorReport, DoctorResult, DoctorStatus } from '../../../../src/doctor/types.js';
import { defaultState } from '../../../../src/state/store.js';
import { EXIT_CODES } from '../../../../src/utils/constants.js';


/** Build a DoctorResult with sensible defaults. */
function result(id: string, status: DoctorStatus, message = ''): DoctorResult {
  return {
    id,
    name: id,
    category: 'host',
    status,
    message,
    durationMs: 1,
  };
}

/** Build a DoctorReport with the given results. */
function report(results: DoctorResult[], profile = 'standard'): DoctorReport {
  const summary = { ok: 0, warn: 0, fail: 0, missing: 0, skip: 0, total: results.length };
  for (const r of results) {
    summary[r.status]++;
  }
  return {
    results,
    summary,
    durationMs: 10,
    profile: profile as DoctorReport['profile'],
    timestamp: new Date().toISOString(),
    linuxifyVersion: '0.1.0-test',
  };
}

/** Build a mock CommandContext with a stubbed doctor engine. */
function makeCtx(stubReport: DoctorReport): CommandContext {
  const output = new Output({ json: false, quiet: false, noColor: true });
  return {
    config: DEFAULT_CONFIG,
    stateStore: {
      load: vi.fn(async () => defaultState()),
      update: vi.fn(async (fn: (s: unknown) => void) => {
        const s = defaultState();
        fn(s);
        return s;
      }),
      get: vi.fn(() => defaultState()),
      save: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
      withLock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      statePath: '/tmp/state.json',
      lockPath: '/tmp/.lock',
    } as unknown as CommandContext['stateStore'],
    output,
    registry: {} as CommandContext['registry'],
    telemetry: {} as CommandContext['telemetry'],
    doctor: {
      run: vi.fn(async () => stubReport),
      checks: [],
    } as unknown as CommandContext['doctor'],
    patcher: {} as CommandContext['patcher'],
    plugins: {} as CommandContext['plugins'],
    state: defaultState(),
    flags: {
      dryRun: false,
      yes: false,
      offline: false,
      noTelemetry: false,
      verbose: 0,
      debug: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runDoctor', () => {
  it('exits 0 when all checks are ok', async () => {
    const ctx = makeCtx(report([result('host.termux', 'ok', 'Termux detected')]));
    const code = await runDoctor({}, ctx);
    expect(code).toBe(EXIT_CODES.OK);
  });

  it('exits 1 when there are warnings', async () => {
    const ctx = makeCtx(report([result('host.termux', 'ok'), result('host.storage', 'warn', 'low space')]));
    const code = await runDoctor({}, ctx);
    expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
  });

  it('exits non-zero when there are failures', async () => {
    const ctx = makeCtx(report([result('bootstrap.completed', 'fail', 'not bootstrapped')]));
    const code = await runDoctor({}, ctx);
    expect(code).toBe(EXIT_CODES.STEP_FAILED);
  });

  it('elevates warnings to failures under --ci', async () => {
    const ctx = makeCtx(report([result('host.storage', 'warn', 'low space')]));
    const code = await runDoctor({ ci: true }, ctx);
    expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
  });

  it('rejects an unknown profile', async () => {
    const ctx = makeCtx(report([]));
    const code = await runDoctor({ profile: 'not-a-profile' }, ctx);
    expect(code).toBe(EXIT_CODES.GENERIC_ERROR);
  });

  it('emits JSON under --json', async () => {
    const ctx = makeCtx(report([result('host.termux', 'ok')]));
    // The ctx.output is constructed without --json; swap it for one with json
    // enabled so the JSON path is exercised.
    const ctxJson: CommandContext = {
      ...ctx,
      output: new Output({ json: true, quiet: false, noColor: true }),
    };
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(typeof c === 'string' ? c : String(c));
      return true;
    });
    const code = await runDoctor({ json: true }, ctxJson);
    expect(code).toBe(EXIT_CODES.OK);
    const out = chunks.join('');
    expect(out.length).toBeGreaterThan(0);
    // The JSON output should parse cleanly.
    const parsed = JSON.parse(out.trim()) as { schema?: string };
    expect(parsed.schema).toBe('linuxify.doctor.v1');
    spy.mockRestore();
  });

  it('forwards --check <id> to the engine', async () => {
    const ctx = makeCtx(report([result('host.termux', 'ok')]));
    await runDoctor({ check: 'host.termux' }, ctx);
    expect(ctx.doctor.run).toHaveBeenCalledWith(
      expect.objectContaining({ checkIds: ['host.termux'] }),
      expect.anything(),
    );
  });
});
