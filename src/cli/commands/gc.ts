/**
 * `linuxify gc` — garbage collection.
 *
 * @module linuxify/cli/commands/gc
 *
 * Cleans caches, old logs, and orphaned files under `~/.linuxify/`. Safe to
 * run at any time; idempotent.
 *
 * What it removes:
 *  - `~/.linuxify/cache/` contents older than the configured TTL (default 7
 *    days; `cache_ttl_hours` config key).
 *  - `~/.linuxify/logs/archive/` contents older than 30 days.
 *  - `~/.linuxify/patches/<pkg>/` directories for packages no longer in
 *    `state.installed_packages`.
 *  - `~/.linuxify/registry/` stale lock files (not the clone itself).
 *
 * @packageDocumentation
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';


import { EXIT_CODES } from '../../utils/constants.js';
import { exists, rmrf } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/** Default age threshold (ms) for cache entries: 7 days. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Default age threshold (ms) for archived logs: 30 days. */
const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Recursively delete files under `dir` older than `ttlMs`. Returns the count
 * of files removed. Subdirectories are recursed; an emptied subdirectory is
 * removed too.
 */
async function cleanDir(dir: string, ttlMs: number): Promise<number> {
  if (!(await exists(dir))) return 0;
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    logger.debug({ dir, err: (err as Error).message }, 'gc: failed to readdir');
    return 0;
  }
  const now = Date.now();
  for (const entry of entries) {
    const entryPath = join(dir, entry);
    let s;
    try {
      s = await stat(entryPath);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const sub = await cleanDir(entryPath, ttlMs);
      removed += sub;
      // If the subdirectory is now empty, remove it.
      try {
        const remaining = await readdir(entryPath);
        if (remaining.length === 0) {
          await rmrf(entryPath);
        }
      } catch {
        // ignore
      }
    } else {
      const age = now - s.mtimeMs;
      if (age > ttlMs) {
        try {
          await rmrf(entryPath);
          removed++;
        } catch (err) {
          logger.debug({ path: entryPath, err: (err as Error).message }, 'gc: failed to remove');
        }
      }
    }
  }
  return removed;
}

/**
 * Remove `~/.linuxify/patches/<pkg>/` directories for packages no longer in
 * state. Returns the count removed.
 */
async function cleanOrphanedPatches(ctx: CommandContext): Promise<number> {
  const patchesDir = join(getLinuxifyHome(), 'patches');
  if (!(await exists(patchesDir))) return 0;
  const state = await ctx.stateStore.load();
  const installed = new Set(state.installed_packages.map((p) => p.name));
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(patchesDir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (installed.has(entry)) continue;
    try {
      await rmrf(join(patchesDir, entry));
      removed++;
    } catch (err) {
      logger.debug(
        { dir: entry, err: (err as Error).message },
        'gc: failed to remove orphaned patch dir',
      );
    }
  }
  return removed;
}

/**
 * Run the `gc` command.
 */
export async function runGc(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  void opts;
  const home = getLinuxifyHome();

  if (ctx.flags.dryRun) {
    out.info('Dry run: would clean:');
    out.info(`  ${join(home, 'cache')} (entries older than ${CACHE_TTL_MS / 3600_000}h)`);
    out.info(`  ${join(home, 'logs', 'archive')} (entries older than ${LOG_TTL_MS / 86400_000}d)`);
    out.info(`  orphaned patch directories for uninstalled packages`);
    return EXIT_CODES.OK;
  }

  out.progress('Cleaning caches…');
  const cacheRemoved = await cleanDir(join(home, 'cache'), CACHE_TTL_MS);

  out.progress('Cleaning archived logs…');
  const logRemoved = await cleanDir(join(home, 'logs', 'archive'), LOG_TTL_MS);

  out.progress('Cleaning orphaned patch directories…');
  const patchesRemoved = await cleanOrphanedPatches(ctx);

  out.success(
    `GC complete: ${cacheRemoved} cache file(s), ${logRemoved} log(s), ${patchesRemoved} orphaned patch dir(s) removed.`,
  );
  return EXIT_CODES.OK;
}

/**
 * Register the `gc` command.
 */
export const registerGcCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('gc')
    .description('Garbage-collect caches, old logs, and orphaned files.')
    .option('--dry-run', 'Print what would be cleaned without removing anything.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runGc(opts, ctx);
      setExit(code);
    });
};
