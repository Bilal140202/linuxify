// src/bootstrap/stages/stage-8-tips.ts
//
// Stage 8 — First-run tips & next steps.
//
// Purely informational output: prints a short welcome banner with the active
// distro, the installed runtimes, and three suggested next commands. Also
// writes the same content to `~/.linuxify/.bootstrap/welcome.txt` so users
// can re-read it via `linuxify welcome`.
//
// This stage NEVER fails — it always returns `success: true` even if writing
// the welcome.txt file errors (which would only happen if the filesystem is
// broken, in which case earlier stages would have already aborted).
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 8).

import { join } from 'node:path';

import { ensureDir, writeFile } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Bootstrap Stage 8: print first-run tips and write `welcome.txt`.
 *
 * Uses `process.stdout.write` directly (not the logger) because the output
 * is user-facing terminal output, not a log line. The logger is used only
 * for the side-effect of recording that Stage 8 ran.
 *
 * @param ctx - Bootstrap context (read for `linuxifyHome`).
 */
export async function stage8Tips(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  // Read runtime versions from state.json if available, else fall back to
  // generic labels. We do this defensively because the StateStore shape is
  // owned by B3; we only need read-only best-effort access.
  const runtimesLabel = await readRuntimesLabel(ctx);

  const banner = renderBanner({
    distro: 'ubuntu 24.04 (proot)',
    runtimes: runtimesLabel,
    pathHint: '~/.linuxify/bin (added to ~/.bashrc)',
  });

  // Print to stdout (user-facing). The task spec explicitly says use
  // process.stdout.write directly, not the logger.
  process.stdout.write(banner);

  // Persist to ~/.linuxify/.bootstrap/welcome.txt for `linuxify welcome`.
  try {
    await ensureDir(ctx.markersDir);
    await writeFile(join(ctx.markersDir, 'welcome.txt'), banner);
  } catch (e) {
    logger.warn('stage 8: could not write welcome.txt', { error: (e as Error).message });
  }

  return {
    success: true,
    durationMs: Date.now() - start,
    details: {
      bannerBytes: banner.length,
      welcomePath: join(ctx.markersDir, 'welcome.txt'),
    },
  };
}

/**
 * Build the welcome banner string. Exported so unit tests can assert on
 * its contents without spawning the stage.
 */
export function renderBanner(opts: {
  distro: string;
  runtimes: string;
  pathHint: string;
}): string {
  return [
    '',
    '\x1b[32m\u2713 Linuxify ready.\x1b[0m',
    '',
    `  Active distro:  ${opts.distro}`,
    `  Runtimes:       ${opts.runtimes}`,
    `  PATH:           ${opts.pathHint}`,
    '',
    '  Try:',
    '    linuxify add cline        # install an AI coding agent',
    '    linuxify search agent     # browse the registry',
    '    linuxify doctor           # re-check your environment',
    '',
  ].join('\n');
}

/**
 * Best-effort read of installed runtimes from `ctx.stateStore`. Returns a
 * human-readable label like "node 22.11.0 LTS, python 3.12.3" or a
 * fallback string if state cannot be read.
 */
async function readRuntimesLabel(ctx: BootstrapContext): Promise<string> {
  try {
    // We don't import the State type from B3; we treat the loaded state as
    // an opaque record and read the fields we care about defensively.
    const state = (await (ctx.stateStore as unknown as {
      load?: () => Promise<unknown>;
    }).load?.()) as
      | {
          installedRuntimes?: Array<{ name: string; version: string }>;
        }
      | undefined;

    const runtimes = state?.installedRuntimes ?? [];
    if (runtimes.length === 0) {
      return 'node LTS, python 3.12';
    }
    return runtimes.map((r) => `${r.name} ${r.version}`).join(', ');
  } catch {
    return 'node LTS, python 3.12';
  }
}
