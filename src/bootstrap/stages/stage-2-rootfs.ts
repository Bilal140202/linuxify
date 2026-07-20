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
    // 1. Check if Ubuntu is already installed using --quiet (machine-readable).
    const listResult = await exec('proot-distro', ['list', '--quiet'], { timeoutMs: 10000 });
    if (listResult.exitCode === 0) {
      const containers = listResult.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
      if (containers.includes('ubuntu')) {
        logger.info('stage 2: ubuntu already installed, skipping');
        return {
          success: true,
          durationMs: Date.now() - start,
          details: {
            alreadyInstalled: true,
            adopted: true,
            containers,
          },
        };
      }
    }

    // 2. Run `proot-distro install ubuntu` — let proot-distro handle the download.
    logger.info('stage 2: running proot-distro install ubuntu');
    const installResult = await exec(
      'proot-distro',
      ['install', 'ubuntu'],
      { timeoutMs: INSTALL_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );

    if (installResult.exitCode !== 0) {
      // Check if the error is "container already exists" — this is NOT a real
      // failure; it means Ubuntu is already installed and we should adopt it.
      const combinedOutput = `${installResult.stderr}\n${installResult.stdout}`;
      if (/already exists/i.test(combinedOutput)) {
        logger.info('stage 2: proot-distro reports ubuntu already exists — adopting existing installation');
        // Verify it's actually there.
        const verifyResult = await exec('proot-distro', ['list', '--quiet'], { timeoutMs: 10000 });
        if (verifyResult.exitCode === 0) {
          const containers = verifyResult.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
          if (containers.includes('ubuntu')) {
            logger.info('stage 2: existing ubuntu confirmed, adopting');
            return {
              success: true,
              durationMs: Date.now() - start,
              details: {
                alreadyInstalled: true,
                adopted: true,
                containers,
                note: 'Adopted existing Ubuntu container (proot-distro reported "already exists")',
              },
            };
          }
        }
      }

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

    // 3. Verify installation using --quiet.
    const verifyResult = await exec('proot-distro', ['list', '--quiet'], { timeoutMs: 10000 });
    if (verifyResult.exitCode !== 0) {
      return fail(start, 'proot-distro list --quiet failed after install', {
        stdout: tail(verifyResult.stdout, 500),
        stderr: tail(verifyResult.stderr, 500),
      });
    }
    const containers = verifyResult.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean);
    if (!containers.includes('ubuntu')) {
      return fail(start, 'proot-distro install completed but ubuntu not found in list', {
        stdout: tail(verifyResult.stdout, 500),
        stderr: tail(verifyResult.stderr, 500),
        containers,
      });
    }

    logger.info('stage 2: ubuntu rootfs installed successfully');

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        alreadyInstalled: false,
        adopted: false,
        installOutput: tail(installResult.stdout, 500),
        verified: true,
        containers,
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
