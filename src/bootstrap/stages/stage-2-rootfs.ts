// src/bootstrap/stages/stage-2-rootfs.ts
//
// Stage 2 — Install the distro rootfs via proot-distro.
//
// Delegates to `proot-distro install ubuntu` which handles:
//   - Downloading the rootfs from the correct URL (maintained by proot-distro)
//   - SHA-256 verification
//   - Extraction into the proot-distro installed-rootfs directory
//
// This is more robust than maintaining our own mirror list because:
//   1. Ubuntu rotates point releases (24.04.1, 24.04.2, …) and changes URLs
//   2. proot-distro's built-in URLs are maintained by the Termux team
//   3. We don't need to track mirror availability
//
// If `proot-distro install ubuntu` fails, we run the diagnostics engine to
// produce a specific diagnosis (e.g., network error, disk full, etc.).
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 2).

import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/** Hard timeout for `proot-distro install` (download + extraction, 15 minutes). */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Bootstrap Stage 2: install the Ubuntu rootfs via proot-distro.
 *
 * Flow:
 * 1. Check if Ubuntu is already installed (`proot-distro list` shows it).
 *    If so, skip (idempotent).
 * 2. Run `proot-distro install ubuntu` — proot-distro handles the download,
 *    verification, and extraction.
 * 3. Verify the installation succeeded by checking `proot-distro list`.
 *
 * If the install fails, run the diagnostics engine for a specific diagnosis.
 *
 * @param ctx - Bootstrap context.
 */
export async function stage2Rootfs(_ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  try {
    // 1. Check if Ubuntu is already installed.
    const listResult = await exec('proot-distro', ['list'], { timeoutMs: 10000 });
    if (listResult.exitCode === 0 && /\bubuntu\b/im.test(listResult.stdout)) {
      logger.info('stage 2: ubuntu already installed, skipping');
      return {
        success: true,
        durationMs: Date.now() - start,
        details: {
          alreadyInstalled: true,
          prootDistroOutput: listResult.stdout.slice(0, 500),
        },
      };
    }

    // 2. Run `proot-distro install ubuntu` — let proot-distro handle the download.
    logger.info('stage 2: running proot-distro install ubuntu');
    const installResult = await exec(
      'proot-distro',
      ['install', 'ubuntu'],
      { timeoutMs: INSTALL_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );

    if (installResult.exitCode !== 0) {
      // Run diagnostics on the failure.
      const { diagnoseError, formatDiagnosis } = await import('../../diagnostics/index.js');
      const diagnosis = diagnoseError({
        command: 'proot-distro install ubuntu',
        exitCode: installResult.exitCode,
        stderr: installResult.stderr,
        stdout: installResult.stdout,
        packageName: 'proot-distro',
      });

      if (diagnosis) {
        const formatted = formatDiagnosis(diagnosis);
        logger.warn({ diagnosisId: diagnosis.id }, 'stage 2: diagnosed install failure');
        return fail(
          start,
          `proot-distro install ubuntu failed — ${diagnosis.title}\n\n${formatted}\n\nRun: ${diagnosis.repair}`,
          {
            exitCode: installResult.exitCode,
            stderr: tail(installResult.stderr, 2000),
            stdout: tail(installResult.stdout, 500),
            diagnosis: {
              id: diagnosis.id,
              title: diagnosis.title,
              repair: diagnosis.repair,
              confidence: diagnosis.confidence,
            },
          },
        );
      }

      return fail(start, 'proot-distro install ubuntu failed', {
        exitCode: installResult.exitCode,
        stderr: tail(installResult.stderr, 2000),
        stdout: tail(installResult.stdout, 500),
        hint: 'Check your network connection. If the issue persists, try: proot-distro install ubuntu manually to see the full error.',
      });
    }

    // 3. Verify installation.
    const verifyResult = await exec('proot-distro', ['list'], { timeoutMs: 10000 });
    if (verifyResult.exitCode !== 0 || !/\bubuntu\b/im.test(verifyResult.stdout)) {
      return fail(start, 'proot-distro install completed but ubuntu not found in list', {
        stdout: tail(verifyResult.stdout, 500),
        stderr: tail(verifyResult.stderr, 500),
      });
    }

    logger.info('stage 2: ubuntu rootfs installed successfully');

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        alreadyInstalled: false,
        installOutput: tail(installResult.stdout, 500),
        verified: true,
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 2 threw: ${(e as Error).message}`,
      details: { name: (e as Error).name },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(
  start: number,
  message: string,
  details: Readonly<Record<string, unknown>>,
): StageResult {
  return {
    success: false,
    durationMs: Date.now() - start,
    error: message,
    details,
  };
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `...${s.slice(-max)}`;
}
