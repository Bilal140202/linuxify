/**
 * Repair subsystem types.
 *
 * @module linuxify/repair/types
 *
 * The repair subsystem takes a {@link DoctorReport} (the output of a doctor
 * run) and applies the suggested `fixCommand` for each failing or missing
 * check, then re-runs the doctor to verify the fix. It also exposes targeted
 * repair entry points (`fixState`, `fixLaunchers`, `fixPaths`, `fixBootstrap`)
 * for the `linuxify repair <subsystem>` subcommands documented in
 * `docs/22-operations/disaster-recovery.md` §7.
 *
 * Design notes (see `docs/22-operations/disaster-recovery.md` §1, §7):
 *   - Repair is **non-destructive by default**: it only runs `fixCommand`s
 *     surfaced by doctor checks; it never deletes user state.
 *   - Each fix is recorded in a {@link RepairFixResult} so the CLI can show
 *     a per-fix summary (success / failure / error message).
 *   - The repair flow is **dry-run capable**: `--dry-run` records what would
 *     be fixed without executing any `fixCommand`.
 *   - Confirmation prompts are skipped when `--yes` is passed (CI mode);
 *     otherwise the engine calls an injectable `confirm` callback (the CLI
 *     wires this to a `readline` prompt; tests inject a stub).
 *
 * @packageDocumentation
 */

import type { DoctorReport } from '../doctor/types.js';
import type { DoctorEngine } from '../doctor/engine.js';
import type { StateStore } from '../state/index.js';
import type { ExecResult } from '../utils/process.js';

/**
 * Aggregate result of a {@link RepairEngine.run} call. Captures the before/
 * after doctor reports, every fix attempted, and the overall duration so the
 * CLI can render a before/after diff and a per-fix summary.
 */
export interface RepairResult {
  /** Number of failing/missing checks in the before report that had a `fixCommand`. */
  problemsFound: number;
  /** Number of fixes for which a `fixCommand` was attempted (or would be, in dry-run). */
  fixesAttempted: number;
  /** Number of fixes that returned exit code 0. */
  fixesSucceeded: number;
  /** Number of fixes that returned non-zero or threw. */
  fixesFailed: number;
  /** One entry per attempted fix, in execution order. */
  results: RepairFixResult[];
  /** Doctor report captured before any fix ran. */
  doctorBefore: DoctorReport;
  /** Doctor report captured after all fixes ran. Identical to `doctorBefore` in dry-run mode. */
  doctorAfter: DoctorReport;
  /** Wall-clock duration of the entire run (before doctor + fixes + after doctor) in ms. */
  durationMs: number;
}

/**
 * Result of executing (or simulating, in dry-run) a single `fixCommand`.
 *
 * One of these is appended to {@link RepairResult.results} for every fix the
 * engine attempts, regardless of success. Failures carry an `error` message;
 * successes leave it `undefined`.
 */
export interface RepairFixResult {
  /** The doctor check id this fix corresponds to (e.g. `runtime.node`). */
  checkId: string;
  /** The shell command that was (or would be) executed. */
  fixCommand: string;
  /** `true` if the command exited 0 (or in dry-run, if it would have been run). */
  success: boolean;
  /** Error message if the fix failed (non-zero exit or spawn error); `undefined` on success. */
  error?: string;
  /** Wall-clock duration of executing this fix in milliseconds. `0` in dry-run. */
  durationMs: number;
}

/**
 * Options accepted by {@link RepairEngine.run}. All fields optional.
 *
 * The CLI maps `--yes` → `yes`, `--dry-run` → `dryRun`, and
 * `--check <id>...` → `checkIds`.
 */
export interface RepairOptions {
  /** Skip confirmation prompts; assume "yes" for every fix. Default `false`. */
  yes?: boolean;
  /** Only fix these check IDs (overrides the natural filter of "everything failing with a fixCommand"). */
  checkIds?: string[];
  /** Show what would be fixed without applying any command. Default `false`. */
  dryRun?: boolean;
  /**
   * Optional confirmation callback. Defaults to a stub that returns `true`
   * when `yes` is set and `false` otherwise (so non-interactive callers must
   * pass `yes: true`). The CLI injects a `readline`-backed prompt.
   *
   * @param checkId - The check id being fixed.
   * @param fixCommand - The command about to be run.
   * @returns `true` to run the fix, `false` to skip it.
   */
  confirm?: (checkId: string, fixCommand: string) => Promise<boolean>;
}

/**
 * Function signature for the `exec` override accepted by
 * {@link RepairEngineOptions}. Mirrors the relevant subset of
 * `utils/process.exec`.
 */
export type RepairExecFn = (
  cmd: string,
  args: readonly string[],
) => Promise<ExecResult>;

/**
 * Constructor options for {@link RepairEngine}. The `doctor` and `stateStore`
 * dependencies are required; `execFn` is overridable for tests.
 */
export interface RepairEngineOptions {
  /** Doctor engine used to run the before/after health checks. */
  readonly doctor: DoctorEngine;
  /** State store used by `fixState` and `fixBootstrap`. */
  readonly stateStore: StateStore;
  /**
   * Optional override for the `exec` function used to run `fixCommand`s.
   * Defaults to the real `exec` from `utils/process`. Tests inject a stub.
   */
  readonly execFn?: RepairExecFn;
}
