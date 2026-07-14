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
 * host. After installation, verifies that `proot-distro --version` exits 0
 * and reports a version >= 1.13. Failures (broken `pkg`, network down to
 * the Termux repo, etc.) are returned as `success: false` with the stderr
 * tail in `details.stderr`.
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

    // 3. Verify `proot-distro --version` and parse the version.
    const versionResult = await exec('proot-distro', ['version'], { timeoutMs: 5000 });
    if (versionResult.exitCode !== 0) {
      return fail(start, 'proot-distro not executable after install', {
        exitCode: versionResult.exitCode,
        stderr: tail(versionResult.stderr, 1000),
      });
    }
    const version = parseProotDistroVersion(versionResult.stdout);
    if (!version) {
      return {
        success: false,
        durationMs: Date.now() - start,
        error: `Could not parse proot-distro version from output: ${versionResult.stdout.trim()}`,
        details: { stdout: tail(versionResult.stdout, 500) },
      };
    }
    if (compareVersion(version, MIN_PROOT_DISTRO_VERSION) < 0) {
      return fail(
        start,
        `proot-distro ${version} is too old (>= ${MIN_PROOT_DISTRO_VERSION} required). Run 'pkg upgrade proot-distro'.`,
        { version, minVersion: MIN_PROOT_DISTRO_VERSION },
      );
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        packages: HOST_DEPS,
        prootDistroVersion: version,
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
