/**
 * Doctor check: `bootstrap.completed`.
 *
 * @module linuxify/doctor/checks/bootstrap-completed
 *
 * Verifies that all 9 bootstrap stages (0 through 8) have been completed.
 * Reads `state.bootstrap_progress.completed_stages` (the in-memory mirror
 * of the `stage-N.done` marker files under `~/.linuxify/.bootstrap/`).
 *
 * On failure, suggests `linuxify init --resume` to continue from the last
 * completed stage.
 *
 * @packageDocumentation
 */

import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/** Total number of bootstrap stages (0 through 8, inclusive). */
const TOTAL_STAGES = 9;

/** All stage IDs that must be present in `completed_stages`. */
const REQUIRED_STAGES = Array.from({ length: TOTAL_STAGES }, (_, i) => i);

/**
 * The `bootstrap.completed` doctor check. Registered in `checks/index.ts`.
 */
export const bootstrapCompletedCheck: DoctorCheck = {
  id: 'bootstrap.completed',
  name: 'Bootstrap completed',
  category: 'bootstrap',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'bootstrap.completed',
      name: 'Bootstrap completed',
      category: 'bootstrap',
    };

    const completed = ctx.state.bootstrap_progress.completed_stages;
    const missing = REQUIRED_STAGES.filter((s) => !completed.includes(s));
    const hasAll = missing.length === 0;

    if (!hasAll) {
      return {
        ...base,
        status: 'fail',
        message: `Bootstrap incomplete: ${completed.length}/${TOTAL_STAGES} stages done (missing: ${missing.join(', ')}).`,
        detail: { completed, missing, currentStage: ctx.state.bootstrap_progress.current_stage },
        fixCommand: 'linuxify init --resume',
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/bootstrap-design',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Bootstrap complete: all ${TOTAL_STAGES} stages done.`,
      detail: { completed, total: TOTAL_STAGES },
      durationMs: Date.now() - start,
    };
  },
};
