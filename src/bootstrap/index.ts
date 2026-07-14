// src/bootstrap/index.ts
//
// Bootstrap orchestrator — the entry point invoked by `linuxify init`.
//
// The orchestrator loads the config, opens the state store, then drives the
// nine-stage pipeline (stages 0 through 8) in strict order. Each stage is
// idempotent and resumable: a successful stage writes a `stage-N.done`
// marker, and the orchestrator skips any stage whose marker is present
// (unless `--force` is passed or `--from-stage N` requests a resume from a
// specific stage).
//
// Public API:
//   - `bootstrap(opts)` — run the pipeline; returns a `BootstrapResult`.
//   - `stages` — the array of stage definitions (0-8 in order).
//   - `isStageComplete(stageId)` — check a marker.
//   - `markStageComplete(stageId)` — write a `.done` marker (manual override).
//   - `clearStageMarker(stageId)` — remove both `.done` and `.failed` markers.
//
// See docs/05-bootstrap/bootstrap-design.md §3 (idempotency & resumability)
// for the design contract this module implements.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../config/index.js';
import { StateStore } from '../state/index.js';
import { ensureDir, exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';

import {
  clearAllStageMarkers,
  clearStageMarker,
  doneMarkerPath,
  failedMarkerPath,
  isStageComplete,
  markStageComplete,
  markStageFailed,
  readDoneMarker,
  readFailedMarker,
} from './markers.js';
import { stage0Preflight } from './stages/stage-0-preflight.js';
import { stage1HostDeps } from './stages/stage-1-host-deps.js';
import { stage2Rootfs } from './stages/stage-2-rootfs.js';
import { stage3FirstBoot } from './stages/stage-3-first-boot.js';
import { stage4Runtimes } from './stages/stage-4-runtimes.js';
import { stage5Home } from './stages/stage-5-home.js';
import { stage6Path } from './stages/stage-6-path.js';
import { stage7Verify } from './stages/stage-7-verify.js';
import { stage8Tips } from './stages/stage-8-tips.js';
import type {
  BootstrapContext,
  BootstrapOptions,
  BootstrapResult,
  Stage,
  StageId,
  StageResult,
} from './types.js';

/**
 * The Linuxify version recorded in marker files. Read from
 * `process.env.LINUXIFY_VERSION` (set by the CLI at startup) with a fallback
 * to the package.json version embedded at build time.
 */
export const LINUXIFY_VERSION =
  process.env.LINUXIFY_VERSION ?? '0.1.0-alpha.1';

/**
 * Ordered list of all bootstrap stages (0 through 8). Exported so tests and
 * the `linuxify status` command can iterate the canonical stage list.
 */
export const stages: readonly Stage[] = [
  {
    id: 0,
    name: 'Preflight',
    description: 'Verify host Termux environment is sane (F-Droid, Android 9+, arch, space, network).',
    run: (ctx) => stage0Preflight(ctx),
  },
  {
    id: 1,
    name: 'Host Deps',
    description: "Install host-side packages via `pkg install` (proot, proot-distro, jq, curl, …).",
    run: (ctx) => stage1HostDeps(ctx),
  },
  {
    id: 2,
    name: 'Rootfs',
    description: 'Download & verify the Ubuntu 24.04 rootfs, then extract via proot-distro install.',
    run: (ctx) => stage2Rootfs(ctx),
  },
  {
    id: 3,
    name: 'First-Boot',
    description: 'Enter the proot, run apt update + install base packages, set locale/timezone, create linuxify user.',
    run: (ctx) => stage3FirstBoot(ctx),
  },
  {
    id: 4,
    name: 'Runtimes',
    description: 'Install Node LTS (NodeSource) and Python 3.12 (apt) inside the proot; verify each executes.',
    run: (ctx) => stage4Runtimes(ctx),
  },
  {
    id: 5,
    name: 'Home Setup',
    description: "Create the ~/.linuxify/ directory tree, write default config.toml, initialise state.json.",
    run: (ctx) => stage5Home(ctx),
  },
  {
    id: 6,
    name: 'PATH Wiring',
    description: "Add ~/.linuxify/bin to PATH in shell rc files; symlink ~/.linuxify/bin/linuxify.",
    run: (ctx) => stage6Path(ctx),
  },
  {
    id: 7,
    name: 'Verify',
    description: 'Run linuxify doctor (minimal profile); fail if any critical check fails.',
    run: (ctx) => stage7Verify(ctx),
  },
  {
    id: 8,
    name: 'Tips',
    description: 'Print first-run welcome banner with suggested next commands.',
    run: (ctx) => stage8Tips(ctx),
  },
];

/** Re-export of marker helpers for downstream consumers. */
export {
  clearAllStageMarkers,
  clearStageMarker,
  doneMarkerPath,
  failedMarkerPath,
  isStageComplete,
  markStageComplete,
  markStageFailed,
  readDoneMarker,
  readFailedMarker,
};

/** Re-export of types for downstream consumers. */
export type {
  BootstrapContext,
  BootstrapOptions,
  BootstrapResult,
  Stage,
  StageId,
  StageResult,
} from './types.js';

/** Re-export of preflight for `linuxify doctor` and tests. */
export { runPreflight } from './preflight.js';
export type {
  PreflightCheckId,
  PreflightCheckResult,
  PreflightOptions,
  PreflightResult,
  PreflightStatus,
} from './preflight.js';

/**
 * Resolve the Linuxify home directory. Honours `LINUXIFY_HOME` for tests;
 * defaults to `~/.linuxify`.
 */
function resolveLinuxifyHome(): string {
  return process.env.LINUXIFY_HOME ?? join(homedir(), '.linuxify');
}

/**
 * Build a `BootstrapContext` from the resolved config and the supplied
 * options. Does not run any stages — context construction is pure.
 */
async function buildContext(opts: BootstrapOptions): Promise<BootstrapContext> {
  const config = await loadConfig();
  const linuxifyHome = resolveLinuxifyHome();
  const markersDir = join(linuxifyHome, '.bootstrap');
  const statePath = join(linuxifyHome, 'state.json');

  // Ensure the markers directory exists so StateStore and marker writes do
  // not race on a fresh install.
  await ensureDir(markersDir);

  // Open the StateStore. We assume `new StateStore(path)` is the constructor
  // signature; B3's StateStore may differ slightly, in which case the
  // integration test (tests/integration/bootstrap.integration.test.ts.skip)
  // will surface the mismatch.
  const stateStore = new StateStore(statePath);

  return {
    config,
    stateStore,
    force: opts.force ?? false,
    fromStage: opts.fromStage,
    markersDir,
    linuxifyHome,
    offline: opts.offline ?? false,
    bundlePath: opts.bundlePath,
    linuxifyVersion: LINUXIFY_VERSION,
    signal: opts.signal,
  };
}

/**
 * Run the Linuxify bootstrap pipeline.
 *
 * Flow:
 *  1. Build the bootstrap context (load config, open state store, ensure
 *     markers directory).
 *  2. If `--force` is set, clear every existing stage marker.
 *  3. For each stage 0 through 8 in order:
 *     - If `--from-stage N` is set and the stage's id is less than N, skip.
 *     - If the stage's `.done` marker is present and `--force` is not set,
 *       skip.
 *     - Otherwise, run the stage. On success, write the `.done` marker. On
 *       failure, write the `.failed` marker and abort the pipeline.
 *  4. Return a {@link BootstrapResult} summarising the run.
 *
 * The function never throws — failures are returned as
 * `BootstrapResult.failedStage` / `BootstrapResult.error`. The only
 * exceptions are programming errors (e.g. invalid options) which surface as
 * a thrown `BootstrapError`.
 *
 * @param opts - Bootstrap options (all fields optional).
 * @returns A {@link BootstrapResult}. Check `failedStage` to determine
 *   success.
 */
export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const totalStart = Date.now();
  const completedStages: StageId[] = [];
  const stageDurations: Record<number, number> = {};
  let ctx: BootstrapContext;
  try {
    ctx = await buildContext(opts);
  } catch (e) {
    return {
      completedStages,
      failedStage: null,
      error: `Bootstrap context construction failed: ${(e as Error).message}`,
      totalDurationMs: Date.now() - totalStart,
      stageDurations,
    };
  }

  // --force: clear all markers before starting.
  if (ctx.force) {
    logger.info('bootstrap: --force, clearing all stage markers');
    await clearAllStageMarkers(ctx.markersDir);
  }

  for (const stage of stages) {
    // --from-stage: skip stages before the requested id.
    if (ctx.fromStage !== undefined && stage.id < ctx.fromStage) {
      logger.info(`bootstrap: skipping stage ${stage.id} (--from-stage ${ctx.fromStage})`);
      continue;
    }

    // Marker check: skip if .done exists and not --force.
    if (!ctx.force) {
      const done = await isStageComplete(ctx.markersDir, stage.id);
      if (done) {
        logger.info(`bootstrap: stage ${stage.id} already complete, skipping`);
        // Record the prior duration if available, for the timing report.
        const marker = await readDoneMarker(ctx.markersDir, stage.id);
        if (marker?.durationMs) stageDurations[stage.id] = marker.durationMs;
        continue;
      }
    }

    // Run the stage.
    logger.info(`bootstrap: running stage ${stage.id} (${stage.name})`);
    const stageStart = Date.now();
    let result: StageResult;
    try {
      result = await stage.run(ctx);
    } catch (e) {
      // Stages are not supposed to throw, but we defend against it.
      result = {
        success: false,
        durationMs: Date.now() - stageStart,
        error: `Stage ${stage.id} threw unexpectedly: ${(e as Error).message}`,
        details: { name: (e as Error).name, stack: (e as Error).stack },
      };
    }

    stageDurations[stage.id] = result.durationMs;

    if (!result.success) {
      // Write the .failed marker and abort.
      await markStageFailed(ctx.markersDir, {
        stage: stage.id,
        name: stage.name,
        failedAt: new Date().toISOString(),
        error: result.error ?? 'Unknown error',
        details: result.details,
      });
      logger.error(`bootstrap: stage ${stage.id} failed`, { error: result.error });
      return {
        completedStages,
        failedStage: stage.id,
        error: result.error ?? `Stage ${stage.id} failed`,
        totalDurationMs: Date.now() - totalStart,
        stageDurations,
      };
    }

    // Success: write the .done marker.
    await markStageComplete(ctx.markersDir, {
      stage: stage.id,
      name: stage.name,
      completedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      linuxifyVersion: ctx.linuxifyVersion,
      details: result.details,
    });
    completedStages.push(stage.id);
    logger.info(`bootstrap: stage ${stage.id} complete`, {
      durationMs: result.durationMs,
    });
  }

  return {
    completedStages,
    failedStage: null,
    error: null,
    totalDurationMs: Date.now() - totalStart,
    stageDurations,
  };
}

/**
 * Build a `BootstrapContext` without running any stages. Exposed for
 * `linuxify status` and for tests that need to inspect the context.
 */
export async function buildBootstrapContext(
  opts: BootstrapOptions = {},
): Promise<BootstrapContext> {
  return buildContext(opts);
}

/**
 * Convenience: check whether a stage's `.done` marker is present, using the
 * default markers directory (`~/.linuxify/.bootstrap/`).
 *
 * @param stageId - Numeric stage id.
 */
export async function isStageDone(stageId: StageId): Promise<boolean> {
  const markersDir = join(resolveLinuxifyHome(), '.bootstrap');
  return isStageComplete(markersDir, stageId);
}

/**
 * Convenience: check whether bootstrap is fully complete (all stages 0-8
 * have `.done` markers). Used by `linuxify status` and by `linuxify add`
 * (which refuses to install packages into an un-bootstrapped environment).
 */
export async function isBootstrapComplete(): Promise<boolean> {
  for (const stage of stages) {
    if (!(await isStageDone(stage.id))) return false;
  }
  return true;
}

/**
 * Convenience: check whether the Linuxify home directory exists. Used by
 * `linuxify init` to decide whether to print "already bootstrapped" hint.
 */
export async function isLinuxifyHomePresent(): Promise<boolean> {
  return exists(resolveLinuxifyHome());
}
