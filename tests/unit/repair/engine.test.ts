/**
 * Unit tests for `src/repair/engine.ts` (the `RepairEngine` class).
 *
 * Covers:
 *   - `run()` happy path: 1 broken result with a fixCommand, --yes, exec
 *     returns 0 → fix succeeds, before/after doctor reports captured.
 *   - `run()` with `--dry-run`: no exec call; after doctor report identical
 *     to before; result.results recorded with `success: true`, `durationMs: 0`.
 *   - `run()` with `checkIds` filter: only matching broken results are fixed.
 *   - `run()` skips results without a `fixCommand`.
 *   - `run()` skips `warn` / `ok` results (only `fail` / `missing` count).
 *   - `run()` fix failure: exec returns non-zero → result recorded with
 *     `success: false`, `error: 'exit <N>: ...'`.
 *   - `run()` fix throws (exec rejects) → caught, recorded with `success: false`.
 *   - `run()` confirmation callback: `false` → fix skipped with
 *     `error: 'skipped by user'`.
 *   - `run()` `--yes` bypasses the confirmation callback entirely.
 *   - Constructor validation: missing doctor / stateStore throws.
 *
 * All doctor / exec / state-store dependencies are mocked — no real
 * subprocess or filesystem I/O. The logger is mocked to keep test output
 * quiet (same pattern as the doctor and state tests).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the logger — pino's lazy initializer crashes under vitest's stdio
// capture (see tests/unit/state/store.test.ts for the same pattern).
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

import { RepairEngine } from '../../../src/repair/engine.js';
import type {
  DoctorCheck,
  DoctorContext,
  DoctorReport,
  DoctorResult,
} from '../../../src/doctor/types.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { defaultState } from '../../../src/state/store.js';
import type { ExecResult } from '../../../src/utils/process.js';
import type { StateStore } from '../../../src/state/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a DoctorResult with sensible defaults. */
function makeResult(
  id: string,
  status: DoctorResult['status'],
  opts: Partial<DoctorResult> = {},
): DoctorResult {
  return {
    id,
    name: id,
    category: 'host',
    status,
    message: '',
    durationMs: 1,
    ...opts,
  };
}

/** Build a DoctorReport containing the given results. */
function makeReport(results: DoctorResult[]): DoctorReport {
  return {
    results,
    summary: {
      ok: results.filter((r) => r.status === 'ok').length,
      warn: results.filter((r) => r.status === 'warn').length,
      fail: results.filter((r) => r.status === 'fail').length,
      missing: results.filter((r) => r.status === 'missing').length,
      skip: results.filter((r) => r.status === 'skip').length,
      total: results.length,
    },
    durationMs: 1,
    profile: 'standard',
    timestamp: new Date().toISOString(),
    linuxifyVersion: '0.1.0-alpha.1',
  };
}

/** Build a mock DoctorEngine whose `run()` resolves with the given report. */
function makeMockDoctor(report: DoctorReport): {
  doctor: import('../../../src/doctor/engine.js').DoctorEngine;
  setReport: (r: DoctorReport) => void;
  runCalls: number;
} {
  let currentReport = report;
  let runCalls = 0;
  const doctor = {
    checks: [] as DoctorCheck[],
    run: async () => {
      runCalls++;
      return currentReport;
    },
  } as unknown as import('../../../src/doctor/engine.js').DoctorEngine;
  return {
    doctor,
    setReport: (r: DoctorReport) => {
      currentReport = r;
    },
    runCalls: 0,
    get runCallsValue() {
      return runCalls;
    },
  };
}

/** Build a stub `StateStore` (only `load` / `save` are used by the engine). */
function makeMockStateStore(): StateStore {
  const state = defaultState();
  return {
    statePath: '/tmp/test-state.json',
    lockPath: '/tmp/.lock',
    load: async () => state,
    save: async () => undefined,
    get: () => state,
    update: async (fn: (s: typeof state) => void) => {
      fn(state);
      return state;
    },
    lock: async () => undefined,
    unlock: async () => undefined,
    withLock: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as StateStore;
}

/** Build a DoctorContext with the default config and a fresh default state. */
function makeCtx(): DoctorContext {
  return { config: DEFAULT_CONFIG, state: defaultState() };
}

/** Build a stub `exec` that resolves with the given ExecResult. */
function makeExecFn(result: ExecResult): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<ExecResult> => result);
}

/** Build a stub `exec` that rejects with the given error. */
function makeThrowingExecFn(err: Error): ReturnType<typeof vi.fn> {
  return vi.fn(async (): Promise<ExecResult> => {
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RepairEngine', () => {
  describe('constructor', () => {
    it('throws if doctor is missing', () => {
      expect(
        () =>
          new RepairEngine({
            // @ts-expect-error intentional missing doctor
            doctor: undefined,
            stateStore: makeMockStateStore(),
          }),
      ).toThrow(/doctor/);
    });

    it('throws if stateStore is missing', () => {
      const { doctor } = makeMockDoctor(makeReport([]));
      expect(
        () =>
          new RepairEngine({
            doctor,
            // @ts-expect-error intentional missing stateStore
            stateStore: undefined,
          }),
      ).toThrow(/stateStore/);
    });
  });

  describe('run — happy path', () => {
    it('applies one fix when --yes and exec returns 0', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const after = makeReport([makeResult('runtime.node', 'ok')]);
      const mock = makeMockDoctor(before);
      // Second call to doctor.run() returns the "after" report.
      let callCount = 0;
      mock.doctor.run = async () => {
        callCount++;
        return callCount === 1 ? before : after;
      };

      const execFn = makeExecFn({
        exitCode: 0,
        stdout: 'hello',
        stderr: '',
        failed: false,
        timedOut: false,
        command: 'echo hello',
      });

      const engine = new RepairEngine({
        doctor: mock.doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());

      expect(result.problemsFound).toBe(1);
      expect(result.fixesAttempted).toBe(1);
      expect(result.fixesSucceeded).toBe(1);
      expect(result.fixesFailed).toBe(0);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.checkId).toBe('runtime.node');
      expect(result.results[0]?.fixCommand).toBe('echo hello');
      expect(result.results[0]?.success).toBe(true);
      expect(result.results[0]?.error).toBeUndefined();
      expect(result.doctorBefore).toBe(before);
      expect(result.doctorAfter).toBe(after);
      expect(execFn).toHaveBeenCalledWith('sh', ['-c', 'echo hello']);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('includes missing-status results (not just fail)', async () => {
      const before = makeReport([
        makeResult('path.linuxify_bin', 'missing', { fixCommand: 'mkdir -p ~/.linuxify/bin' }),
      ]);
      const after = makeReport([makeResult('path.linuxify_bin', 'ok')]);
      let callCount = 0;
      const { doctor } = makeMockDoctor(before);
      doctor.run = async () => {
        callCount++;
        return callCount === 1 ? before : after;
      };
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.problemsFound).toBe(1);
      expect(result.fixesSucceeded).toBe(1);
    });
  });

  describe('run — filtering', () => {
    it('skips results without a fixCommand', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: '' }),
        makeResult('runtime.python', 'fail'), // no fixCommand at all
        makeResult('runtime.git', 'fail', { fixCommand: 'echo git' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.problemsFound).toBe(1); // only runtime.git
      expect(result.results[0]?.checkId).toBe('runtime.git');
    });

    it('skips ok and warn results', async () => {
      const before = makeReport([
        makeResult('host.termux', 'ok', { fixCommand: 'echo ok' }),
        makeResult('host.storage', 'warn', { fixCommand: 'echo warn' }),
        makeResult('runtime.node', 'fail', { fixCommand: 'echo fail' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.problemsFound).toBe(1);
      expect(result.results[0]?.checkId).toBe('runtime.node');
    });

    it('honors checkIds filter', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo node' }),
        makeResult('runtime.python', 'fail', { fixCommand: 'echo python' }),
        makeResult('runtime.git', 'fail', { fixCommand: 'echo git' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run(
        { yes: true, checkIds: ['runtime.python'] },
        makeCtx(),
      );
      expect(result.problemsFound).toBe(1);
      expect(result.results[0]?.checkId).toBe('runtime.python');
      // Only runtime.python's fixCommand should have been exec'd.
      expect(execFn).toHaveBeenCalledTimes(1);
      expect(execFn).toHaveBeenCalledWith('sh', ['-c', 'echo python']);
    });
  });

  describe('run — dry-run', () => {
    it('records fixes without calling exec and reuses the before report', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true, dryRun: true }, makeCtx());

      expect(execFn).not.toHaveBeenCalled();
      expect(result.fixesAttempted).toBe(1);
      expect(result.fixesSucceeded).toBe(1);
      expect(result.results[0]?.durationMs).toBe(0);
      expect(result.doctorAfter).toBe(before); // same reference, not re-run
    });
  });

  describe('run — fix failures', () => {
    it('records non-zero exit with stderr in error', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'false' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 1,
        stdout: '',
        stderr: 'some error',
        failed: true,
        timedOut: false,
        command: 'false',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.fixesSucceeded).toBe(0);
      expect(result.fixesFailed).toBe(1);
      expect(result.results[0]?.success).toBe(false);
      expect(result.results[0]?.error).toContain('exit 1');
      expect(result.results[0]?.error).toContain('some error');
    });

    it('records non-zero exit without stderr', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'false' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 2,
        stdout: '',
        stderr: '',
        failed: true,
        timedOut: false,
        command: 'false',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.results[0]?.success).toBe(false);
      expect(result.results[0]?.error).toBe('exit 2');
    });

    it('catches exec rejections', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'false' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeThrowingExecFn(new Error('spawn ENOENT'));

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.results[0]?.success).toBe(false);
      expect(result.results[0]?.error).toBe('spawn ENOENT');
    });
  });

  describe('run — confirmation', () => {
    it('skips fix when confirm returns false', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const confirm = vi.fn(async () => false);
      const result = await engine.run({ confirm }, makeCtx());

      expect(confirm).toHaveBeenCalledWith('runtime.node', 'echo hello');
      expect(execFn).not.toHaveBeenCalled();
      expect(result.results[0]?.success).toBe(false);
      expect(result.results[0]?.error).toBe('skipped by user');
    });

    it('applies fix when confirm returns true', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const confirm = vi.fn(async () => true);
      const result = await engine.run({ confirm }, makeCtx());

      expect(confirm).toHaveBeenCalled();
      expect(execFn).toHaveBeenCalled();
      expect(result.results[0]?.success).toBe(true);
    });

    it('--yes bypasses the confirm callback', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const confirm = vi.fn(async () => false); // would refuse
      const result = await engine.run({ yes: true, confirm }, makeCtx());

      expect(confirm).not.toHaveBeenCalled();
      expect(execFn).toHaveBeenCalled();
      expect(result.results[0]?.success).toBe(true);
    });
  });

  describe('run — summary', () => {
    it('reports zero problems when doctor is all-ok', async () => {
      const before = makeReport([
        makeResult('host.termux', 'ok'),
        makeResult('runtime.node', 'ok'),
      ]);
      const { doctor } = makeMockDoctor(before);
      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      const result = await engine.run({ yes: true }, makeCtx());
      expect(result.problemsFound).toBe(0);
      expect(result.fixesAttempted).toBe(0);
      expect(result.results).toEqual([]);
    });

    it('runs after-doctor exactly once on a non-dry-run with fixes', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      const after = makeReport([makeResult('runtime.node', 'ok')]);
      let runCount = 0;
      const { doctor } = makeMockDoctor(before);
      doctor.run = async () => {
        runCount++;
        return runCount === 1 ? before : after;
      };

      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      await engine.run({ yes: true }, makeCtx());
      expect(runCount).toBe(2); // before + after
    });

    it('runs doctor only once on a dry-run', async () => {
      const before = makeReport([
        makeResult('runtime.node', 'fail', { fixCommand: 'echo hello' }),
      ]);
      let runCount = 0;
      const { doctor } = makeMockDoctor(before);
      doctor.run = async () => {
        runCount++;
        return before;
      };

      const execFn = makeExecFn({
        exitCode: 0,
        stdout: '',
        stderr: '',
        failed: false,
        timedOut: false,
        command: '',
      });

      const engine = new RepairEngine({
        doctor,
        stateStore: makeMockStateStore(),
        execFn: execFn as unknown as (
          cmd: string,
          args: readonly string[],
        ) => Promise<ExecResult>,
      });

      await engine.run({ yes: true, dryRun: true }, makeCtx());
      expect(runCount).toBe(1); // before only
    });
  });
});
