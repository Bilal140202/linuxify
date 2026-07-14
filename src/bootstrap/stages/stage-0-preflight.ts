// src/bootstrap/stages/stage-0-preflight.ts
//
// Stage 0 — Preflight checks.
//
// Delegates to `runPreflight()` (see ../preflight.ts) and converts the result
// into a `StageResult`. If preflight fails, the stage returns
// `success: false` with the failing check's message; the orchestrator writes
// `stage-0.failed` and aborts the pipeline. Warnings do not fail the stage
// but are surfaced in `details.warnings` for downstream consumers.

import { runPreflight } from '../preflight.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Bootstrap Stage 0: Preflight checks.
 *
 * Verifies the host Termux environment is sane enough to attempt bootstrap:
 * F-Droid Termux version, Android API level, free disk space, supported
 * architecture, not running as root, and network reachability. All checks
 * run even when an early one fails, so the user sees the complete picture.
 *
 * Idempotency: re-running Stage 0 is safe and cheap (each check is a
 * subprocess spawn or stat call). The stage does not mutate any state
 * outside the markers directory.
 *
 * @param ctx - Bootstrap context.
 * @returns A {@link StageResult}. `success` is `true` iff every check passed
 *   or only emitted warnings.
 */
export async function stage0Preflight(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();
  try {
    const result = await runPreflight({
      offline: ctx.offline,
    });

    if (!result.ok) {
      const first = result.failures[0];
      return {
        success: false,
        durationMs: Date.now() - start,
        error: first?.message ?? 'Preflight failed for an unknown reason.',
        details: {
          failures: result.failures,
          warnings: result.warnings,
        },
      };
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        warnings: result.warnings,
        checks: result.checks,
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: (e as Error).message,
      details: { name: (e as Error).name, code: (e as { code?: string }).code },
    };
  }
}
