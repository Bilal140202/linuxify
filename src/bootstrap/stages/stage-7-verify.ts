// src/bootstrap/stages/stage-7-verify.ts
//
// Stage 7 — Verification.
//
// Runs the Linuxify doctor engine in-process with the `minimal` profile and
// verifies that every check passes (status `ok`/`skip`). Warnings do not
// block Stage 7; a `fail` or `missing` result does. If a check fails, the
// stage returns `success: false` with the failing check's name and message,
// and the orchestrator writes `stage-7.failed` and aborts the pipeline.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 7) and
// docs/07-doctor/doctor-engine.md for the doctor engine's API.
//
// Defensive design: if the doctor engine throws unexpectedly, Stage 7 falls
// back to an inline verification (proot-distro list, file existence, runtime
// exec) so the stage still provides value if the doctor subsystem regresses.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createDoctorEngine } from '../../doctor/index.js';
import { exists, readFile } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { State } from '../../state/index.js';
import type { BootstrapContext, StageResult } from '../types.js';

/** Hard timeout for the doctor invocation (per check). */
const DOCTOR_TIMEOUT_MS = 30_000;

/** Hard timeout for each inline verification exec. */
const INLINE_TIMEOUT_MS = 10_000;

/**
 * Bootstrap Stage 7: verification.
 *
 * Invokes the in-process {@link DoctorEngine} with `profile: 'minimal'`,
 * propagating the bootstrap context's `Config` and a freshly-loaded `State`.
 * Treats any check with `status: 'fail'` or `'missing'` as a Stage 7
 * failure (warnings do not block; `skip`/`ok` pass). If the doctor engine
 * throws unexpectedly, falls back to {@link runInlineVerification} so the
 * stage still provides value.
 *
 * @param ctx - Bootstrap context.
 */
export async function stage7Verify(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  try {
    // Try the in-process doctor first.
    const doctorResult = await tryRunDoctor(ctx);
    if (doctorResult.usedDoctor) {
      return doctorResult.stageResult;
    }

    // Fallback: inline verification (only reached if the doctor engine
    // threw during construction or context assembly).
    logger.info('stage 7: doctor engine unavailable, running inline verification');
    return await runInlineVerification(ctx, start);
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 7 threw: ${(e as Error).message}`,
      details: { name: (e as Error).name },
    };
  }
}

/**
 * Run the in-process {@link DoctorEngine} with the `minimal` profile.
 *
 * Constructs a `DoctorContext` from the bootstrap context's `config` and a
 * freshly-loaded `state` (Stage 5 has written `state.json` by this point in
 * the pipeline, so `stateStore.load()` returns the persisted state). Returns
 * `{ usedDoctor: true, stageResult }` on any outcome — including engine
 * errors, which are converted into a `success: false` StageResult so the
 * pipeline aborts with a useful message rather than a generic throw.
 *
 * The only path that returns `{ usedDoctor: false }` is a failure to load
 * state, in which case {@link stage7Verify} falls back to inline
 * verification so the stage still produces a result.
 */
async function tryRunDoctor(
  ctx: BootstrapContext,
): Promise<{ usedDoctor: true; stageResult: StageResult } | { usedDoctor: false }> {
  const start = Date.now();

  // Load state fresh for this doctor run. Stage 5 has written state.json by
  // now, so this returns the persisted state (or `defaultState()` if the
  // file is somehow still missing — that case still produces a valid
  // DoctorContext, so we let the doctor itself report the missing state).
  let state: State;
  try {
    state = await ctx.stateStore.load();
  } catch (e) {
    logger.debug('stage 7: state load failed for doctor run', { error: (e as Error).message });
    return { usedDoctor: false };
  }

  try {
    const engine = createDoctorEngine();
    const report = await engine.run(
      { profile: 'minimal', timeoutMs: DOCTOR_TIMEOUT_MS },
      { config: ctx.config, state },
    );

    // Failures and missing checks block Stage 7. Warnings and skips do not.
    const failing = report.results.filter(
      (r) => r.status === 'fail' || r.status === 'missing',
    );

    if (failing.length > 0) {
      const first = failing[0]!;
      return {
        usedDoctor: true,
        stageResult: {
          success: false,
          durationMs: Date.now() - start,
          error: `Doctor check failed: ${first.id} — ${first.message}`,
          details: {
            failingChecks: failing.map((r) => ({ id: r.id, status: r.status, message: r.message })),
            allChecks: report.results,
            summary: report.summary,
          },
        },
      };
    }

    return {
      usedDoctor: true,
      stageResult: {
        success: true,
        durationMs: Date.now() - start,
        details: {
          ok: report.summary.fail === 0 && report.summary.missing === 0,
          checkCount: report.results.length,
          summary: report.summary,
        },
      },
    };
  } catch (e) {
    // The doctor engine contract is "never throws" — a thrown error here is
    // a real bug. Surface it as a stage failure rather than a generic throw
    // so the orchestrator's marker writer can record `stage-7.failed`.
    return {
      usedDoctor: true,
      stageResult: {
        success: false,
        durationMs: Date.now() - start,
        error: `Doctor threw: ${(e as Error).message}`,
        details: { name: (e as Error).name },
      },
    };
  }
}

/**
 * Inline verification used when the doctor subsystem is unavailable. Performs
 * the minimum checks required to assert that the bootstrap contract has been
 * satisfied: distro installed, home tree present, PATH wired, runtimes
 * executable.
 */
async function runInlineVerification(ctx: BootstrapContext, start: number): Promise<StageResult> {
  const failures: string[] = [];
  const details: Record<string, unknown> = {};

  // 1. proot-distro list --quiet shows ubuntu (machine-readable, one name per line).
  // We use --quiet because the human-readable output format varies across
  // proot-distro versions and locales. --quiet prints only container names.
  try {
    const r = await exec('proot-distro', ['list', '--quiet'], { timeoutMs: INLINE_TIMEOUT_MS });
    if (r.exitCode === 0) {
      const containers = r.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
      if (containers.includes('ubuntu')) {
        details.ubuntuListed = true;
        details.installedContainers = containers;
      } else {
        failures.push(`proot-distro list --quiet does not show ubuntu as installed (found: ${containers.join(', ') || 'none'})`);
        details.ubuntuListed = false;
        details.installedContainers = containers;
      }
    } else {
      failures.push(`proot-distro list --quiet failed (exit ${r.exitCode})`);
      details.ubuntuListed = false;
      details.listStderr = r.stderr.slice(-500);
    }
  } catch (e) {
    failures.push(`proot-distro list --quiet threw: ${(e as Error).message}`);
  }

  // 2. Linuxify home tree exists.
  const binDir = join(ctx.linuxifyHome, 'bin');
  const configPath = join(ctx.linuxifyHome, 'config.toml');
  const statePath = join(ctx.linuxifyHome, 'state.json');
  for (const [name, path] of [
    ['bin', binDir],
    ['config.toml', configPath],
    ['state.json', statePath],
  ] as const) {
    if (!(await exists(path))) {
      failures.push(`Missing ${name} at ${path}`);
    }
  }
  details.homeTree = { binDir, configPath, statePath };

  // 3. PATH block present in ~/.bashrc.
  const bashrcPath = join(homedir(), '.bashrc');
  if (await exists(bashrcPath)) {
    const bashrc = await readFile(bashrcPath);
    const hasBlock = bashrc.includes('>>> linuxify bootstrap >>>');
    details.pathBlockPresent = hasBlock;
    if (!hasBlock) failures.push('PATH block missing from ~/.bashrc');
  } else {
    failures.push('~/.bashrc does not exist');
  }

  // 4. Runtimes execute inside proot.
  try {
    const nodeR = await exec(
      'proot-distro',
      ['login', 'ubuntu', '--', 'node', '--version'],
      { timeoutMs: INLINE_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );
    details.nodeVersion = nodeR.stdout.trim();
    if (nodeR.exitCode !== 0) failures.push(`node --version failed (exit ${nodeR.exitCode})`);
  } catch (e) {
    failures.push(`node --version threw: ${(e as Error).message}`);
  }
  try {
    const pyR = await exec(
      'proot-distro',
      ['login', 'ubuntu', '--', 'python3', '--version'],
      { timeoutMs: INLINE_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );
    details.pythonVersion = pyR.stdout.trim() || pyR.stderr.trim();
    if (pyR.exitCode !== 0) failures.push(`python3 --version failed (exit ${pyR.exitCode})`);
  } catch (e) {
    failures.push(`python3 --version threw: ${(e as Error).message}`);
  }

  if (failures.length > 0) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 7 verification failed: ${failures.join('; ')}`,
      details: { ...details, failures },
    };
  }

  return {
    success: true,
    durationMs: Date.now() - start,
    details,
  };
}
