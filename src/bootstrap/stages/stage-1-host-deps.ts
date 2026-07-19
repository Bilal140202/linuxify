// src/bootstrap/stages/stage-1-host-deps.ts
//
// Stage 1 — Install host dependencies via `pkg install`.
//
// Ensures the Termux host itself has the tools Linuxify needs to drive the
// rest of the pipeline: proot, proot-distro, jq, curl, ca-certificates,
// openssh, git, tar, xz-utils. Runs `pkg update && pkg install -y <pkgs>`
// which is idempotent on Termux (installing an already-present package is a
// no-op).
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 1).

import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Packages installed on the Termux host by Stage 1.
 *
 * `proot-distro` is the workhorse that logs into the Ubuntu rootfs; `jq`
 * parses state.json; `curl` downloads rootfs tarballs and runtime installers;
 * `ca-certificates` makes HTTPS work; `openssh` provides `ssh-keygen`;
 * `git` is needed for `linuxify self-update`; `tar` and `xz-utils`
 * decompress the rootfs tarball.
 */
export const HOST_DEPS: readonly string[] = [
  'proot',
  'proot-distro',
  'jq',
  'curl',
  'ca-certificates',
  'openssh',
  'git',
  'tar',
  'xz-utils',
] as const;

/** Minimum `proot-distro` version we rely on (for the `--bind` syntax). */
const MIN_PROOT_DISTRO_VERSION = '1.13';

/** Hard timeout for the whole `pkg install` invocation (10 minutes). */
const PKG_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Bootstrap Stage 1: install host dependencies.
 *
 * Runs `pkg update` followed by `pkg install -y <packages>` on the Termux
 * host. After installation, verifies that `proot-distro` is actually usable
 * by running `proot-distro list` (which exits 0 if proot-distro is working).
 *
 * **Verification method:** We use `proot-distro list` (NOT `proot-distro
 * version` or `proot-distro --version` — neither of which is a supported
 * subcommand). The `list` subcommand is the canonical way to check that
 * proot-distro is installed and functional; it prints installed distros and
 * exits 0 on success.
 *
 * If `proot-distro list` succeeds, we also try to extract the version from
 * the package database (`dpkg -s proot-distro`) for logging, but we do NOT
 * fail if the version can't be parsed — the `list` success is sufficient.
 *
 * Idempotency: `pkg install <existing-package>` is a no-op, so re-running
 * Stage 1 is safe and fast.
 *
 * @param _ctx - Bootstrap context (unused — Stage 1 reads no config).
 */
export async function stage1HostDeps(_ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  try {
    // 1. `pkg update` — refresh the apt index.
    logger.info('stage 1: pkg update');
    const updateResult = await exec('pkg', ['update', '-y'], {
      timeoutMs: PKG_INSTALL_TIMEOUT_MS,
      env: { TERM: 'dumb' },
    });
    if (updateResult.exitCode !== 0) {
      return fail(start, 'pkg update failed', {
        exitCode: updateResult.exitCode,
        stderr: tail(updateResult.stderr, 2000),
        stdout: tail(updateResult.stdout, 500),
      });
    }

    // 2. `pkg install` — install all host deps in one shot.
    logger.info('stage 1: pkg install', { packages: HOST_DEPS });
    const installResult = await exec(
      'pkg',
      ['install', '-y', ...HOST_DEPS],
      { timeoutMs: PKG_INSTALL_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );
    if (installResult.exitCode !== 0) {
      return fail(start, 'pkg install failed', {
        exitCode: installResult.exitCode,
        stderr: tail(installResult.stderr, 2000),
        stdout: tail(installResult.stdout, 500),
        packages: HOST_DEPS,
      });
    }

    // 3. Verify proot-distro is actually usable.
    //
    // We use `proot-distro list` because:
    // - `proot-distro version` is NOT a valid subcommand (causes exit 1)
    // - `proot-distro --version` is NOT supported either
    // - `proot-distro list` IS the canonical "is it working?" check —
    //   it prints installed distros and exits 0 on success
    //
    // If `proot-distro list` fails, we run the diagnostics engine to produce
    // a specific diagnosis (e.g., "bad interpreter after Python upgrade")
    // instead of the generic "not usable" message. This is the "AI mechanic"
    // the user asked for: understand what's wrong, explain why, and offer
    // a targeted repair.
    logger.info('stage 1: verifying proot-distro via `proot-distro list`');
    const verifyResult = await exec('proot-distro', ['list'], { timeoutMs: 10000 });
    if (verifyResult.exitCode !== 0) {
      // Run diagnostics to get a specific diagnosis.
      const { diagnoseError, formatDiagnosis } = await import('../../diagnostics/index.js');
      const diagnosis = diagnoseError({
        command: 'proot-distro list',
        exitCode: verifyResult.exitCode,
        stderr: verifyResult.stderr,
        stdout: verifyResult.stdout,
        packageName: 'proot-distro',
      });

      if (diagnosis) {
        // We have a specific diagnosis — include it in the error.
        const formatted = formatDiagnosis(diagnosis);
        logger.warn({ diagnosisId: diagnosis.id }, 'stage 1: diagnosed proot-distro failure');
        return fail(
          start,
          `proot-distro is broken — ${diagnosis.title}\n\n${formatted}\n\nRun: ${diagnosis.repair}`,
          {
            exitCode: verifyResult.exitCode,
            stderr: tail(verifyResult.stderr, 1000),
            stdout: tail(verifyResult.stdout, 500),
            diagnosis: {
              id: diagnosis.id,
              title: diagnosis.title,
              what: diagnosis.what,
              why: diagnosis.why,
              repair: diagnosis.repair,
              confidence: diagnosis.confidence,
              autoRepairable: diagnosis.autoRepairable,
            },
          },
        );
      }

      // No specific diagnosis — return the generic failure.
      return fail(start, 'proot-distro not usable after install (proot-distro list failed)', {
        exitCode: verifyResult.exitCode,
        stderr: tail(verifyResult.stderr, 1000),
        stdout: tail(verifyResult.stdout, 500),
      });
    }

    // 4. Try to extract version from dpkg for logging (non-blocking —
    //    don't fail if we can't parse it, the `list` success is sufficient).
    let prootDistroVersion: string | undefined;
    try {
      const dpkgResult = await exec('dpkg', ['-s', 'proot-distro'], { timeoutMs: 5000 });
      if (dpkgResult.exitCode === 0) {
        prootDistroVersion = parseProotDistroVersion(dpkgResult.stdout);
      }
    } catch {
      // Non-fatal — version is for logging only.
    }

    // 5. Check version if we got one (warn but don't fail — the user might
    //    have a custom build).
    if (prootDistroVersion && compareVersion(prootDistroVersion, MIN_PROOT_DISTRO_VERSION) < 0) {
      logger.warn(
        { version: prootDistroVersion, minVersion: MIN_PROOT_DISTRO_VERSION },
        'proot-distro version is below recommended minimum — proceeding anyway',
      );
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        packages: HOST_DEPS,
        prootDistroVersion: prootDistroVersion ?? 'unknown',
        installedDistros: parseInstalledDistros(verifyResult.stdout),
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 1 threw: ${(e as Error).message}`,
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

function parseProotDistroVersion(stdout: string): string | undefined {
  // proot-distro version output looks like "proot-distro v1.13.0" or just
  // "1.13.0". We accept any leading non-digit prefix.
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(stdout);
  return match?.[1];
}

/**
 * Parse the output of `proot-distro list` to extract installed distro names.
 *
 * Output looks like:
 * ```
 * Installed containers:
 *
 *   ubuntu
 *   debian
 *
 * Log in with: proot-distro login <name>
 * ```
 *
 * We extract the distro names (lines after "Installed containers:" that
 * are non-empty and don't start with "Log in").
 */
function parseInstalledDistros(stdout: string): string[] {
  const lines = stdout.split('\n');
  const distros: string[] = [];
  let inInstalledSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.toLowerCase().startsWith('installed containers')) {
      inInstalledSection = true;
      continue;
    }
    if (trimmed.toLowerCase().startsWith('log in with')) {
      inInstalledSection = false;
      continue;
    }
    if (inInstalledSection && !trimmed.includes(':')) {
      // This is a distro name
      distros.push(trimmed);
    }
  }
  return distros;
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = parseInt(pa[i] ?? '0', 10);
    const nb = parseInt(pb[i] ?? '0', 10);
    if (na !== nb) return na - nb;
  }
  return 0;
}
