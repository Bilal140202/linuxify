/**
 * Doctor subsystem types.
 *
 * @module linuxify/doctor/types
 *
 * Every check produces a {@link DoctorResult}; every output format renders a
 * list of them. The shape is consistent with `docs/02-architecture/type-reference.md`
 * §7 and `docs/07-doctor/doctor-engine.md` §4.
 *
 * The `run` function's contract is **must not throw** — a thrown exception
 * from a check is treated as a bug in the check, and the doctor engine
 * wraps it in a `DoctorResult` with `status: 'fail'` and a `check crashed:
 * <error>` message. This keeps a buggy check from bringing down the whole
 * doctor run.
 *
 * @packageDocumentation
 */

import type { Config } from '../config/index.js';
import type { State } from '../state/index.js';

/**
 * Outcome of a single doctor check.
 *
 * Maps to colors in human output (green / yellow / red / magenta / gray) and
 * to exit-code contributions in CI mode: `ok` and `skip` contribute nothing;
 * `warn` sets the aggregate exit to 1 if no `fail` is present; `fail` and
 * `missing` set the aggregate exit to 2.
 */
export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'missing' | 'skip';

/**
 * Doctor check category. Each category maps to a wave in the scheduler (see
 * `docs/07-doctor/doctor-engine.md` §4): host → bootstrap → distro/runtime →
 * path → packages → compat → network → services.
 */
export type DoctorCategory =
  | 'host'
  | 'bootstrap'
  | 'distro'
  | 'runtime'
  | 'path'
  | 'packages'
  | 'compat'
  | 'network'
  | 'services';

/**
 * Named profile that selects a subset of checks. Profiles are chosen via
 * `--profile <name>` and the default is `standard`.
 */
export type DoctorProfile =
  | 'minimal'
  | 'standard'
  | 'deep'
  | 'pre-flight'
  | 'post-install'
  | 'ci';

/**
 * Result of running a single doctor check. Every check produces one; the
 * engine never throws — a thrown check is wrapped in a synthetic fail result.
 */
export interface DoctorResult {
  /** Stable check id, e.g. `runtime.node`. */
  id: string;
  /** Human-readable label, e.g. `Node.js version`. */
  name: string;
  /** Category bucket (host / bootstrap / distro / runtime / path / packages / compat / network / services). */
  category: DoctorCategory;
  /** Outcome of the check. */
  status: DoctorStatus;
  /** One-line human-readable summary, safe to print to a terminal. */
  message: string;
  /** Optional structured payload, rendered under `--verbose` or `--json`. */
  detail?: unknown;
  /** Suggested shell command the user can run to fix the issue. */
  fixCommand?: string;
  /** Link to docs for more context. */
  fixDocs?: string;
  /** Wall-clock duration of this check in milliseconds. */
  durationMs: number;
}

/**
 * Explanation metadata for a doctor check — the "why this matters" text shown
 * by `linuxify doctor --explain`. Each check provides this as a static field
 * so it can be displayed without running the check.
 *
 * The explanation is written for a new user who doesn't know what PATH is,
 * what proot does, or why `process.platform` matters. It answers:
 *   1. What does this check verify?
 *   2. Why does it matter for running Linux CLIs on Android?
 *   3. What happens if it's broken? (concrete consequence)
 *   4. What's the recommended fix?
 */
export interface DoctorExplanation {
  /** What this check verifies (1-2 sentences). */
  what: string;
  /** Why it matters for running Linux CLIs on Android (2-3 sentences). */
  why: string;
  /** Concrete consequence if broken (1 sentence, e.g. "Commands like `cline` won't be found"). */
  consequence: string;
  /** Recommended fix command (matches `DoctorResult.fixCommand` usually). */
  fix: string;
}

/**
 * A single doctor check. Checks are independent functions with a stable id,
 * grouped into profiles (see `profiles.ts`) and scheduled into waves by
 * category.
 *
 * The `run` function MUST NOT throw — wrap errors in a fail result instead.
 * The engine still wraps every `run()` call in a try/catch as a belt-and-
 * suspenders guard, but a check that throws is considered buggy.
 */
export interface DoctorCheck {
  /** Stable check id (e.g. `host.termux`). Renaming is a breaking change. */
  id: string;
  /** Human-readable name shown in human output. */
  name: string;
  /** Category bucket; determines which wave the check runs in. */
  category: DoctorCategory;
  /** Profiles this check belongs to. The engine filters by profile when one is specified. */
  profile: DoctorProfile[];
  /**
   * Execute the check. MUST NOT throw — return a fail result instead.
   *
   * @param ctx - Doctor context with config and state.
   * @returns A {@link DoctorResult}. The `durationMs` field is filled in by
   *   the engine if the check returns 0 or omits it.
   */
  run(ctx: DoctorContext): Promise<DoctorResult>;
  /**
   * Static explanation shown by `linuxify doctor --explain`. Provides the
   * "why this matters" context for new users. Optional but strongly
   * recommended for every check.
   */
  explain?: DoctorExplanation;
}

/**
 * Per-run context handed to every doctor check. Holds the resolved `Config`
 * and the current `State`. Checks MUST NOT read process environment
 * variables or global state directly — they go through the context (with the
 * narrow exception of host-platform probes that need `process.platform`,
 * `process.arch`, or shell-outs to `getprop` / `df`).
 */
export interface DoctorContext {
  /** Resolved configuration (config.toml + defaults + env overlay). */
  config: Config;
  /** Current Linuxify state (loaded from `~/.linuxify/state.json`). */
  state: State;
}

/**
 * Options accepted by {@link DoctorEngine.run}. All fields optional.
 */
export interface DoctorOptions {
  /** Profile to run; defaults to `standard`. */
  profile?: DoctorProfile;
  /** Emit JSON output (`linuxify.doctor.v1` schema). */
  json?: boolean;
  /** Emit Markdown output (suitable for GitHub issue bodies). */
  markdown?: boolean;
  /** Quiet output: only failures, plain text. */
  quiet?: boolean;
  /** Run only these check IDs (overrides profile filtering). */
  checkIds?: string[];
  /** Per-check timeout in milliseconds. Default 5000; deep profile default 15000. */
  timeoutMs?: number;
}

/**
 * Aggregate report returned by {@link DoctorEngine.run}. Contains every
 * check's result plus a summary of counts and run metadata.
 */
export interface DoctorReport {
  /** Every check result, in the order checks ran (wave order, then parallel within wave). */
  results: DoctorResult[];
  /** Counts of each status across `results`. */
  summary: { ok: number; warn: number; fail: number; missing: number; skip: number; total: number };
  /** Total wall-clock duration of the doctor run in milliseconds. */
  durationMs: number;
  /** Profile that was run. */
  profile: DoctorProfile;
  /** ISO 8601 timestamp of when the run completed. */
  timestamp: string;
  /** Linuxify version (matches `LINUXIFY_VERSION` in `utils/constants.ts`). */
  linuxifyVersion: string;
}
