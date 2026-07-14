// src/bootstrap/types.ts
//
// Type definitions for the Linuxify bootstrap subsystem.
//
// The bootstrap pipeline turns a bare Termux install into a working Linuxify
// environment through nine idempotent stages (0 through 8). Each stage is a
// pure function of a `BootstrapContext` and returns a `StageResult` — never
// throws. The orchestrator (`bootstrap()` in `index.ts`) drives the pipeline,
// writes marker files for resumability, and surfaces a single
// `BootstrapResult` to the caller.
//
// See docs/05-bootstrap/bootstrap-design.md for the full stage-by-stage spec
// and docs/02-architecture/type-reference.md §1-§3 for the surrounding
// Config / State types these types compose with.

import type { Config } from '../config/index.js';
import type { StateStore } from '../state/index.js';

/**
 * Identifier of a bootstrap stage. Stages are numbered 0 through 8 and run in
 * strict order. The ordering is significant because each stage assumes the
 * side-effects of the previous one are present (e.g. Stage 4 assumes Stage 3
 * has installed `apt` and `curl` inside the proot).
 */
export type StageId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * A single stage in the bootstrap pipeline.
 *
 * Stages are intentionally simple: they carry their identity (`id`, `name`,
 * `description`) and a single `run()` method. All I/O, configuration, and
 * state access flows through the supplied `BootstrapContext`. A stage MUST
 * NOT throw on failure — it MUST return a `StageResult` with `success: false`
 * and a human-readable `error` string. The orchestrator handles marker
 * bookkeeping and aborts the pipeline on the first failure.
 */
export interface Stage {
  /** Numeric stage id (0-8). */
  readonly id: StageId;
  /** Short human-readable name (e.g. "First-Boot"). */
  readonly name: string;
  /** One-line description of what the stage does. */
  readonly description: string;
  /**
   * Execute the stage. MUST be idempotent (safe to re-run) and MUST NOT
   * throw on failure — wrap errors in a `StageResult` instead.
   */
  run(ctx: BootstrapContext): Promise<StageResult>;
}

/**
 * Outcome of running a single stage.
 *
 * `success: true` means the stage completed its contract and the orchestrator
 * may write the `stage-N.done` marker. `success: false` means the stage
 * failed; the orchestrator writes `stage-N.failed` with the error payload and
 * aborts the pipeline.
 */
export interface StageResult {
  /** Whether the stage succeeded. */
  readonly success: boolean;
  /** Wall-clock duration of the stage in milliseconds. */
  readonly durationMs: number;
  /** Human-readable error message; only present when `success` is false. */
  readonly error?: string;
  /** Optional structured details (mirror URL, package list, etc.). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Per-run context handed to every stage. Holds the resolved `Config`, the
 * open `StateStore`, the user's bootstrap flags (`--force`, `--from-stage`),
 * and the absolute path to the markers directory
 * (`~/.linuxify/.bootstrap/`).
 *
 * Stages MUST NOT read process environment variables or global state
 * directly — they go through the context. This keeps stages testable and
 * isolates them from CLI concerns.
 */
export interface BootstrapContext {
  /** Resolved configuration (config.toml + defaults + env overlay). */
  readonly config: Config;
  /** Open state store for `~/.linuxify/state.json`. */
  readonly stateStore: StateStore;
  /** True if `--force` was passed (re-run all stages regardless of markers). */
  readonly force: boolean;
  /** If `--from-stage N` was passed, the stage to resume from. */
  readonly fromStage?: StageId;
  /** Absolute path to `~/.linuxify/.bootstrap/`. */
  readonly markersDir: string;
  /** Absolute path to the Linuxify home (`~/.linuxify/`). */
  readonly linuxifyHome: string;
  /** True if `--offline` was passed (skip network checks, use bundle). */
  readonly offline: boolean;
  /** Optional path to an offline bundle (`--bundle ./x.tar.gz`). */
  readonly bundlePath?: string;
  /** Linuxify package version (e.g. "0.1.0-alpha.1"), recorded in markers. */
  readonly linuxifyVersion: string;
  /** Optional AbortSignal for cooperative cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Options accepted by {@link bootstrap}. All fields optional; sensible
 * defaults are applied by the orchestrator.
 */
export interface BootstrapOptions {
  /** Re-run all stages regardless of existing markers (`--force`). */
  readonly force?: boolean;
  /** Resume from a specific stage (`--from-stage N`). */
  readonly fromStage?: StageId;
  /** Run in offline mode using a pre-bundled tarball (`--offline`). */
  readonly offline?: boolean;
  /** Path to the offline bundle (`--bundle ./x.tar.gz`). */
  readonly bundlePath?: string;
  /** Optional AbortSignal forwarded into the BootstrapContext. */
  readonly signal?: AbortSignal;
}

/**
 * Aggregate result of a `bootstrap()` invocation. Consumed by the
 * `linuxify init` CLI command and by tests.
 */
export interface BootstrapResult {
  /** Stages that completed successfully (in run order). */
  readonly completedStages: StageId[];
  /** The stage that failed, if any; `null` when the pipeline succeeded. */
  readonly failedStage: StageId | null;
  /** Human-readable error string when `failedStage` is non-null. */
  readonly error: string | null;
  /** Total wall-clock duration of the pipeline in milliseconds. */
  readonly totalDurationMs: number;
  /** Per-stage durations, keyed by stage id. Missing entries = skipped. */
  readonly stageDurations: Readonly<Record<number, number>>;
}
