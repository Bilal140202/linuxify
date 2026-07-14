// src/bootstrap/stages/stage-7-verify.ts
//
// Stage 7 — Verification.
//
// Runs the Linuxify doctor engine in-process with the `minimal` profile and
// verifies that every "critical" check passes. Optional checks (e.g. `redis`
// for `aider-memory`) do not block Stage 7. If a critical check fails, the
// stage returns `success: false` with the failing check's name and message,
// and the orchestrator writes `stage-7.failed` and aborts the pipeline.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 7) and
// docs/07-doctor/doctor-engine.md for the doctor engine's API.
//
// Defensive design: the doctor subsystem (built by a parallel agent) may not
// be importable yet at the time Stage 7 is first exercised. We attempt a
// dynamic import; if the import fails, we fall back to a minimal inline
// verification (proot-distro list, file existence, runtime exec) so that
// Stage 7 still provides value during early integration.

import { homedir } from 'node:os';
import { join } from 'node:path';

import { exists, readFile } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/** Hard timeout for the doctor invocation. */
const DOCTOR_TIMEOUT_MS = 30_000;

/** Hard timeout for each inline verification exec. */
const INLINE_TIMEOUT_MS = 10_000;

/**
 * Bootstrap Stage 7: verification.
 *
 * Attempts to invoke the doctor subsystem with `profile: 'minimal'`. If the
 * doctor module is unavailable (parallel agent has not finished writing it),
 * falls back to an inline verification that checks:
 *  - `proot-distro list` reports the `ubuntu` distro as installed.
 *  - `~/.linuxify/bin/`, `config.toml`, `state.json` all exist.
 *  - The PATH block is present in `~/.bashrc`.
 *  - `node --version` and `python3 --version` execute inside the proot.
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

    // Fallback: inline verification.
    logger.info('stage 7: doctor module unavailable, running inline verification');
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
 * Attempt to dynamically import the doctor subsystem and run it with the
 * `minimal` profile. Returns `{ usedDoctor: true, stageResult }` on success
 * or `{ usedDoctor: false }` if the doctor module is unavailable.
 *
 * The import path is held in a variable so TypeScript does not try to
 * resolve it at compile time — the doctor module is built by a parallel
 * agent and may not exist when Stage 7 is first exercised.
 */
async function tryRunDoctor(
  _ctx: BootstrapContext,
): Promise<{ usedDoctor: true; stageResult: StageResult } | { usedDoctor: false }> {
  // The path is intentionally indirect: TS resolves string-literal dynamic
  // imports at compile time, which would fail with TS2307 if the doctor
  // module does not yet exist. By using a variable we defer resolution to
  // runtime, where vitest/Node will simply throw (caught below).
  const doctorModulePath = '../doctor/index.js';
  let doctorModule: { runDoctor?: (opts: unknown) => Promise<unknown> };
  try {
    doctorModule = (await import(/* @vite-ignore */ doctorModulePath)) as {
      runDoctor?: (opts: unknown) => Promise<unknown>;
    };
  } catch (e) {
    logger.debug('stage 7: doctor module not importable', { error: (e as Error).message });
    return { usedDoctor: false };
  }

  const runDoctor = doctorModule.runDoctor;
  if (typeof runDoctor !== 'function') {
    logger.debug('stage 7: doctor module has no runDoctor export');
    return { usedDoctor: false };
  }

  const start = Date.now();
  try {
    const result = (await runDoctor({ profile: 'minimal', timeoutMs: DOCTOR_TIMEOUT_MS })) as {
      ok?: boolean;
      exitCode?: number;
      checks?: Array<{ id: string; severity?: 'critical' | 'optional' | string; status?: string; message?: string }>;
    };

    const checks = result.checks ?? [];
    const critical = checks.filter((c) => c.severity === 'critical');
    const failingCritical = critical.filter((c) => c.status !== 'pass' && c.status !== 'ok');

    if (failingCritical.length > 0) {
      return {
        usedDoctor: true,
        stageResult: {
          success: false,
          durationMs: Date.now() - start,
          error: `Critical doctor check failed: ${failingCritical[0]?.id ?? 'unknown'} — ${failingCritical[0]?.message ?? ''}`,
          details: {
            failingChecks: failingCritical,
            allChecks: checks,
            exitCode: result.exitCode,
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
          ok: result.ok ?? true,
          checkCount: checks.length,
          criticalCount: critical.length,
        },
      },
    };
  } catch (e) {
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

  // 1. proot-distro list shows ubuntu.
  try {
    const r = await exec('proot-distro', ['list'], { timeoutMs: INLINE_TIMEOUT_MS });
    if (r.exitCode === 0 && /ubuntu/i.test(r.stdout)) {
      details.ubuntuListed = true;
    } else {
      failures.push('proot-distro list does not show ubuntu as installed');
      details.ubuntuListed = false;
      details.listStdout = r.stdout.slice(-500);
    }
  } catch (e) {
    failures.push(`proot-distro list threw: ${(e as Error).message}`);
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
