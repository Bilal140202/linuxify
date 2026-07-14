// src/bootstrap/stages/stage-2-rootfs.ts
//
// Stage 2 — Download & verify the distro rootfs.
//
// Pre-downloads the Ubuntu 24.04 minimal rootfs tarball from a list of
// mirrors (with fallback), verifies its SHA-256 if a hash is pinned, then
// runs `proot-distro install --override <path> ubuntu` to extract the rootfs
// into `~/.linuxify/distros/ubuntu/`. Pre-downloading (rather than letting
// `proot-distro install` fetch the tarball itself) gives us mirror fallback
// and integrity verification that proot-distro does not provide.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 2).

import { rename, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { sha256File, verifySha256 } from '../../utils/crypto.js';
import { ensureDir, exists, readFile, writeFile } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import { exec, getArch } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Canonical Ubuntu 24.04 rootfs filename per architecture. Mirrors all
 * publish under the same path layout (`ubuntu-base/releases/24.04/release/`)
 * so the filename is arch-specific only.
 */
const ROOTFS_FILENAME_BY_ARCH: Record<string, string> = {
  aarch64: 'ubuntu-base-24.04-base-arm64.tar.gz',
  armv7l: 'ubuntu-base-24.04-base-armhf.tar.gz',
  x86_64: 'ubuntu-base-24.04-base-amd64.tar.gz',
};

/**
 * Mirror list, tried in order. The first mirror that serves a hash-matching
 * tarball wins. Pinned here (not in config.toml) so that a compromise of
 * config.toml cannot redirect downloads.
 */
const ROOTFS_MIRRORS: readonly string[] = [
  'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/',
  'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-base/releases/24.04/release/',
  'https://mirror.nju.edu.cn/ubuntu-base/releases/24.04/release/',
  'https://mirror.freedif.org/ubuntu-base/releases/24.04/release/',
];

/** Hard timeout for a single curl download attempt (5 minutes). */
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/** Hard timeout for `proot-distro install` extraction (10 minutes). */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Max curl retries per mirror. */
const CURL_RETRIES = 5;

/**
 * Bootstrap Stage 2: download & verify distro rootfs.
 *
 * Flow:
 * 1. Resolve the architecture-appropriate rootfs filename.
 * 2. If `~/.linuxify/.bootstrap/rootfs.tar.gz` already exists and (when a
 *    hash is pinned) matches the expected SHA-256, skip download. This is
 *    what makes Stage 2 cheap on re-runs.
 * 3. Otherwise, download via `curl -fL --retry 5 --retry-delay 2 -C -` from
 *    each mirror in turn. After each download, recompute the SHA-256; if it
 *    matches the pinned hash, accept; otherwise fall through to the next
 *    mirror.
 * 4. Run `proot-distro install --override <rootfs.tar.gz> ubuntu` to extract
 *    the rootfs into `~/.linuxify/distros/ubuntu/`.
 *
 * If every mirror fails or returns a wrong hash, Stage 2 fails with a hint
 * to use `linuxify init --offline --bundle <path>`.
 *
 * Idempotency: the existence + hash check at step 2 means a successful
 * Stage 2 is a no-op on re-run. A partial `.part` file from an interrupted
 * download is resumed via curl's `-C -` flag.
 *
 * @param ctx - Bootstrap context.
 */
export async function stage2Rootfs(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();
  const bootstrapDir = ctx.markersDir;
  const rootfsPath = join(bootstrapDir, 'rootfs.tar.gz');
  const rootfsPartPath = join(bootstrapDir, 'rootfs.tar.gz.part');

  try {
    await ensureDir(bootstrapDir);

    const arch = normaliseArch(getArch());
    const filename = ROOTFS_FILENAME_BY_ARCH[arch];
    if (!filename) {
      return fail(start, `No rootfs available for architecture '${arch}'.`, {
        arch,
        supported: Object.keys(ROOTFS_FILENAME_BY_ARCH),
      });
    }

    // Pinned SHA-256 for the canonical rootfs. Left undefined in v1 because
    // Ubuntu rotates the point release (24.04.1, 24.04.2, …) without
    // renaming the file. When a hash is provided via config
    // (`bootstrap.rootfsSha256`) it is honoured; otherwise verification is
    // skipped with a warning.
    const pinnedSha256 = (ctx.config.bootstrap as { rootfsSha256?: string }).rootfsSha256;

    // Offline mode: use the bundle-supplied rootfs.
    if (ctx.offline && ctx.bundlePath) {
      const bundled = join(ctx.bundlePath, filename);
      if (!(await exists(bundled))) {
        return fail(start, `Offline mode: rootfs not found in bundle at ${bundled}.`, {
          bundlePath: ctx.bundlePath,
          expected: filename,
        });
      }
      // Copy the bundled rootfs into the bootstrap dir (or symlink). We
      // symlink to avoid duplicating an 80 MB file.
      if (!(await exists(rootfsPath))) {
        await symlink(bundled, rootfsPath).catch(() => undefined);
      }
    } else if (await exists(rootfsPath)) {
      // Existing rootfs: verify hash if pinned.
      if (pinnedSha256) {
        const ok = await verifySha256(rootfsPath, pinnedSha256);
        if (ok) {
          logger.info('stage 2: existing rootfs verified, skipping download');
        } else {
          logger.warn('stage 2: existing rootfs hash mismatch, re-downloading');
          await removeFile(rootfsPath);
        }
      } else {
        logger.info('stage 2: existing rootfs found, skipping download (no hash pinned)');
      }
    }

    // Download if still missing.
    if (!(await exists(rootfsPath))) {
      const downloadResult = await downloadWithMirrors(
        ROOTFS_MIRRORS,
        filename,
        rootfsPath,
        rootfsPartPath,
        pinnedSha256,
      );
      if (!downloadResult.ok) {
        return fail(start, downloadResult.error, {
          mirrors: ROOTFS_MIRRORS,
          filename,
          attempts: downloadResult.attempts,
        });
      }
    }

    // Final hash verification (post-download / pre-install).
    const actualSha256 = await sha256File(rootfsPath);
    if (pinnedSha256 && actualSha256 !== pinnedSha256) {
      return fail(
        start,
        `Rootfs SHA-256 mismatch: expected ${pinnedSha256}, got ${actualSha256}.`,
        { expected: pinnedSha256, actual: actualSha256, rootfsPath },
      );
    }

    // Extract via proot-distro install --override.
    logger.info('stage 2: proot-distro install', { rootfsPath });
    const installResult = await exec(
      'proot-distro',
      ['install', '--override', rootfsPath, 'ubuntu'],
      { timeoutMs: INSTALL_TIMEOUT_MS, env: { TERM: 'dumb' } },
    );
    if (installResult.exitCode !== 0) {
      return fail(start, 'proot-distro install failed', {
        exitCode: installResult.exitCode,
        stderr: tail(installResult.stderr, 2000),
        stdout: tail(installResult.stdout, 500),
      });
    }

    // Stash a small provenance file alongside the tarball for diagnostics.
    await writeFile(
      join(bootstrapDir, 'rootfs.provenance.json'),
      JSON.stringify(
        {
          filename,
          arch,
          sha256: actualSha256,
          pinnedSha256: pinnedSha256 ?? null,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        rootfsPath,
        filename,
        arch,
        sha256: actualSha256,
        verified: pinnedSha256 ? actualSha256 === pinnedSha256 : false,
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

/**
 * Try each mirror in order until one yields a hash-matching tarball.
 *
 * @returns `{ ok: true }` on success, or `{ ok: false, error, attempts }`
 *   describing why every mirror failed.
 */
async function downloadWithMirrors(
  mirrors: readonly string[],
  filename: string,
  destPath: string,
  partPath: string,
  expectedSha256: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string; attempts: unknown[] }> {
  const attempts: unknown[] = [];
  for (const mirror of mirrors) {
    const url = mirror.endsWith('/') ? `${mirror}${filename}` : `${mirror}/${filename}`;
    logger.info('stage 2: downloading rootfs', { url });
    try {
      const result = await exec(
        'curl',
        [
          '-fL',
          '--retry',
          String(CURL_RETRIES),
          '--retry-delay',
          '2',
          '-C',
          '-',
          '--connect-timeout',
          '15',
          '--max-time',
          String(Math.floor(DOWNLOAD_TIMEOUT_MS / 1000)),
          '-o',
          partPath,
          url,
        ],
        { timeoutMs: DOWNLOAD_TIMEOUT_MS + 30_000 },
      );
      if (result.exitCode !== 0) {
        attempts.push({ mirror, url, exitCode: result.exitCode, stderr: tail(result.stderr, 500) });
        continue;
      }

      // Hash check (if pinned). If hash mismatch, try the next mirror.
      if (expectedSha256) {
        const ok = await verifySha256(partPath, expectedSha256);
        if (!ok) {
          const actual = await sha256File(partPath);
          attempts.push({ mirror, url, hashMismatch: true, actual });
          await removeFile(partPath);
          continue;
        }
      }

      // Accept — rename .part → final.
      await rename(partPath, destPath);
      return { ok: true };
    } catch (e) {
      attempts.push({ mirror, url, error: (e as Error).message });
    }
  }

  return {
    ok: false,
    error:
      'All rootfs mirrors failed. Try `linuxify init --offline --bundle <path>` to supply a local rootfs.',
    attempts,
  };
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

function normaliseArch(raw: string): string {
  const r = raw.toLowerCase().trim();
  if (r === 'arm64' || r === 'aarch64' || r === 'arm64-v8a') return 'aarch64';
  if (r === 'arm' || r === 'armv7l' || r === 'armv7-a') return 'armv7l';
  if (r === 'x64' || r === 'x86_64' || r === 'amd64') return 'x86_64';
  return r;
}

async function removeFile(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await unlink(path).catch(() => undefined);
}

/**
 * Read the provenance JSON written next to the rootfs (used by doctor /
 * `linuxify info` to surface the chosen mirror and hash).
 *
 * Exported for downstream consumers; not used inside this stage.
 */
export async function readRootfsProvenance(
  bootstrapDir: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(bootstrapDir, 'rootfs.provenance.json'));
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
