/**
 * Doctor check: `bootstrap.completed`.
 *
 * @module linuxify/doctor/checks/bootstrap-completed
 *
 * Verifies that all 9 bootstrap stages (0 through 8) have been completed.
 * Reads the `stage-N.done` marker files directly from
 * `~/.linuxify/.bootstrap/` (the ground truth), NOT from `state.json`'s
 * `bootstrap_progress.completed_stages` cache. This avoids the stale-cache
 * bug where state.json doesn't exist yet on a fresh install but marker
 * files do.
 *
 * On failure, suggests `linuxify init` (idempotent — resumes from the last
 * completed stage automatically via the marker files).
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import { exists } from '../../utils/fs.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/** Total number of bootstrap stages (0 through 8, inclusive). */
const TOTAL_STAGES = 9;

/** All stage IDs that must be present. */
const REQUIRED_STAGES = Array.from({ length: TOTAL_STAGES }, (_, i) => i);

/** Human-readable stage names for error messages. */
const STAGE_NAMES = [
  'preflight',
  'host deps',
  'rootfs download',
  'first-boot apt',
  'runtimes',
  'home setup',
  'PATH wiring',
  'verify',
  'tips',
];

/**
 * Read the ground-truth bootstrap state from marker files on disk.
 *
 * Marker files live at `~/.linuxify/.bootstrap/stage-N.done` and
 * `~/.linuxify/.bootstrap/stage-N.failed`. The `.done` file is written
 * atomically after a stage completes; the `.failed` file is written if a
 * stage throws.
 *
 * We read from disk (not state.json) because:
 * 1. state.json may not exist yet (it's created in stage 5)
 * 2. state.json's `bootstrap_progress` cache can be stale if a stage
 *    completed but the state write failed
 * 3. The marker files are the authoritative record
 */
async function readMarkerState(): Promise<{
  done: number[];
  failed: number[];
}> {
  const bootstrapDir = join(getLinuxifyHome(), '.bootstrap');
  const done: number[] = [];
  const failed: number[] = [];
  for (let i = 0; i < TOTAL_STAGES; i++) {
    try {
      if (await exists(join(bootstrapDir, `stage-${i}.done`))) {
        done.push(i);
      }
      if (await exists(join(bootstrapDir, `stage-${i}.failed`))) {
        failed.push(i);
      }
    } catch {
      // Permission errors etc. — treat as not-done
    }
  }
  return { done, failed };
}

/**
 * The `bootstrap.completed` doctor check. Registered in `checks/index.ts`.
 */
export const bootstrapCompletedCheck: DoctorCheck = {
  id: 'bootstrap.completed',
  name: 'Bootstrap completed',
  category: 'bootstrap',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that all 9 bootstrap stages (preflight, host deps, rootfs, first-boot, runtimes, home setup, PATH, verify, tips) completed successfully.',
    why: 'Bootstrap is the one-time setup that turns a fresh Termux install into a working Linuxify environment. It installs proot, downloads the Ubuntu rootfs, installs Node and Python, and wires up your PATH. Without it, there is no Linux environment to run CLIs in.',
    consequence: 'If bootstrap is incomplete, no packages can be installed or run. `linuxify add cline` will fail because there is no distro to install into.',
    fix: 'linuxify init',
  },

  async run(_ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'bootstrap.completed',
      name: 'Bootstrap completed',
      category: 'bootstrap',
    };

    const { done, failed } = await readMarkerState();
    const missing = REQUIRED_STAGES.filter((s) => !done.includes(s));
    const hasAll = missing.length === 0;

    if (hasAll) {
      return {
        ...base,
        status: 'ok',
        message: `Bootstrap complete: all ${TOTAL_STAGES} stages done.`,
        detail: { done, total: TOTAL_STAGES, source: 'marker-files' },
        durationMs: Date.now() - start,
      };
    }

    // Build a helpful message that explains WHERE bootstrap stopped.
    const nextStage = missing[0];
    const nextName = STAGE_NAMES[nextStage] ?? `stage ${nextStage}`;
    const failedInfo =
      failed.length > 0
        ? ` Stages ${failed.map((s) => `${s} (${STAGE_NAMES[s] ?? 'unknown'})`).join(', ')} previously failed.`
        : '';
    const message = failed.length > 0
      ? `Bootstrap incomplete: ${done.length}/${TOTAL_STAGES} stages done, ${failed.length} failed.${failedInfo} Next: stage ${nextStage} (${nextName}).`
      : `Bootstrap incomplete: ${done.length}/${TOTAL_STAGES} stages done (missing: ${missing.join(', ')}). Next: stage ${nextStage} (${nextName}).`;

    return {
      ...base,
      status: 'fail',
      message,
      detail: {
        done,
        failed,
        missing,
        nextStage,
        nextStageName: nextName,
        source: 'marker-files',
      },
      // `linuxify init` is idempotent: it reads marker files and resumes from
      // the last completed stage. No need for `--from-stage` or `--resume`.
      fixCommand: 'linuxify init',
      fixDocs: 'https://docs.linuxify.dev/05-bootstrap/bootstrap-design',
      durationMs: Date.now() - start,
    };
  },
};
