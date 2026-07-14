/**
 * Doctor engine — runs health checks in parallel waves and aggregates results.
 *
 * @module linuxify/doctor/engine
 *
 * The engine's job is to run a list of {@link DoctorCheck} objects, return a
 * {@link DoctorReport}, and never throw. A thrown exception from a check is
 * caught and converted to a `fail` result with a "check crashed: <error>"
 * message — the engine must produce a result for every check, even a buggy
 * one.
 *
 * Design decisions (see `docs/07-doctor/doctor-engine.md` §4 and
 * `docs/02-architecture/implementation-walkthroughs.md` §2):
 *
 * - **Concurrency limit of 4** (configurable). The doc recommends 8 to match
 *   the worker-pool size in component-diagrams §6; this engine defaults to 4
 *   to be conservative on memory-constrained Android devices. Each proot
 *   session opens ~10 file descriptors, so 4 concurrent proot spawns stay
 *   well under the per-process fd limit.
 * - **Waves are sequential**; within a wave, checks run in parallel. The
 *   wave structure lets the bootstrap wave short-circuit (if
 *   `bootstrap.completed` fails, all other bootstrap checks are skipped
 *   with `status: 'skip'`).
 * - **Per-check timeout** via `Promise.race`. Default 5s; deep profile 15s.
 *   A timed-out check produces a synthetic `fail` result with a "check
 *   timed out" message; the underlying check's promise is left to settle
 *   (Node's process will exit as soon as the engine returns; the dangling
 *   promise does not block).
 * - **Check contract: never throw.** The engine wraps every `run()` call in
 *   a try/catch; a thrown error becomes a `fail` result with a "check
 *   crashed" message and the error stack on `detail`.
 *
 * @packageDocumentation
 */

import pLimit from 'p-limit';

import { LINUXIFY_VERSION } from '../utils/constants.js';
import { logger } from '../utils/log.js';

import { checksForProfile, timeoutForProfile } from './profiles.js';
import { formatReport as formatReportImpl } from './output.js';
import type {
  DoctorCheck,
  DoctorContext,
  DoctorOptions,
  DoctorReport,
  DoctorResult,
} from './types.js';

/**
 * Category → wave index. Wave N must complete before wave N+1. Categories
 * not in the map default to wave 4 (the catch-all "package" wave) so plugin-
 * registered custom categories still run.
 *
 * Mirrors the table in `docs/07-doctor/doctor-engine.md` §4.
 */
const CATEGORY_TO_WAVE: Record<string, number> = {
  host: 0,
  bootstrap: 1,
  distro: 2,
  runtime: 2,
  path: 3,
  packages: 4,
  compat: 5,
  network: 6,
  services: 7,
};

/** Default worker-pool size for the engine. */
const DEFAULT_CONCURRENCY = 4;

/**
 * Options accepted by the {@link DoctorEngine} constructor.
 */
export interface DoctorEngineOptions {
  /** The full list of checks the engine can run. Typically `ALL_CHECKS`. */
  checks: DoctorCheck[];
  /** Max number of checks running concurrently within a wave. Default 4. */
  concurrency?: number;
}

/**
 * Doctor engine — runs checks in parallel waves, never throws.
 *
 * One engine instance is typically created per CLI invocation. The engine
 * is stateless between runs (it does not cache results); callers wanting
 * caching should layer it on top.
 */
export class DoctorEngine {
  /** The checks this engine knows about, in registration order. */
  readonly checks: DoctorCheck[];

  /** Max number of checks running concurrently within a wave. */
  private readonly concurrency: number;

  /** p-limit limiter instance (created lazily so tests can swap concurrency). */
  private readonly limit: ReturnType<typeof pLimit>;

  /**
   * @param opts - Constructor options. `checks` is required; `concurrency`
   *   defaults to 4.
   */
  constructor(opts: DoctorEngineOptions) {
    if (!opts.checks || opts.checks.length === 0) {
      throw new Error('DoctorEngine requires a non-empty checks array');
    }
    this.checks = [...opts.checks];
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.limit = pLimit(this.concurrency);
  }

  /**
   * Run the doctor. Returns a {@link DoctorReport}; never throws.
   *
   * Steps:
   * 1. Resolve the profile (default `standard`).
   * 2. Filter checks: by profile (via {@link checksForProfile}), then by
   *    `opts.checkIds` (if set, overrides the profile filter — runs only
   *    those specific checks).
   * 3. Partition the filtered checks into waves by category.
   * 4. Run each wave in order; within a wave, run checks in parallel up to
   *    the engine's concurrency limit.
   * 5. Apply the bootstrap short-circuit: if `bootstrap.completed` fails,
   *    every other bootstrap check in the same wave is skipped.
   * 6. Compute the summary (counts of each status).
   * 7. Return the report.
   *
   * @param opts - Run options (profile, format, timeout, checkIds).
   * @param ctx - Doctor context (config + state).
   * @returns A {@link DoctorReport}. Always resolves; never rejects.
   */
  async run(opts: DoctorOptions, ctx: DoctorContext): Promise<DoctorReport> {
    const startOverall = Date.now();
    const profile = opts.profile ?? 'standard';
    const timeoutMs = opts.timeoutMs ?? timeoutForProfile(profile);

    // 1. Filter by profile (the profile gives us a list of check IDs in
    //    the order they should run).
    const profileIds = new Set(checksForProfile(profile));
    let selected: DoctorCheck[];
    if (opts.checkIds && opts.checkIds.length > 0) {
      // checkIds overrides the profile filter — run only these checks.
      const wanted = new Set(opts.checkIds);
      selected = this.checks.filter((c) => wanted.has(c.id));
      logger.debug('doctor: checkIds override active', {
        wanted: [...wanted],
        matched: selected.map((c) => c.id),
      });
    } else {
      selected = this.checks.filter((c) => profileIds.has(c.id));
    }

    // 2. Partition into waves.
    const waves = partitionWaves(selected);
    const results: DoctorResult[] = [];

    // 3. Run each wave in order.
    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx];
      if (!wave || wave.length === 0) continue;
      logger.debug('doctor wave starting', {
        wave: waveIdx,
        count: wave.length,
        checks: wave.map((c) => c.id),
      });

      // Bootstrap short-circuit: `bootstrap.completed` runs FIRST within
      // its wave (alone). If it fails, every other bootstrap check in the
      // wave is skipped with status 'skip' and a "bootstrap not complete"
      // message. If it passes (or is absent), the rest of the wave runs in
      // parallel as usual. This implements the "bootstrap.completed runs
      // first" contract from doctor-engine.md §4 (Wave 2).
      //
      // We identify the bootstrap wave by category membership (not by wave
      // index) because `partitionWaves` filters out empty waves, so the
      // bootstrap wave may land at any index in the returned array.
      const isBootstrapWave = wave.every((c) => c.category === 'bootstrap');
      if (isBootstrapWave) {
        const completedCheck = wave.find((c) => c.id === 'bootstrap.completed');
        if (completedCheck) {
          const completedResult = await this.limit(() =>
            runOneCheck(completedCheck, ctx, timeoutMs).catch(
              (err: unknown): DoctorResult => ({
                id: completedCheck.id,
                name: completedCheck.name,
                category: completedCheck.category,
                status: 'fail',
                message: `check crashed: ${(err as Error).message}`,
                detail: { stack: (err as Error).stack },
                durationMs: 0,
              }),
            ),
          );
          results.push(completedResult);

          if (completedResult.status !== 'ok') {
            for (const check of wave) {
              if (check.id === 'bootstrap.completed') continue;
              results.push({
                id: check.id,
                name: check.name,
                category: check.category,
                status: 'skip',
                message: 'bootstrap not complete — run linuxify init',
                durationMs: 0,
              });
            }
            continue;
          }

          // bootstrap.completed passed — run the rest of the bootstrap
          // wave in parallel.
          const rest = wave.filter((c) => c.id !== 'bootstrap.completed');
          if (rest.length > 0) {
            const restResults = await Promise.all(
              rest.map((check) =>
                this.limit(() =>
                  runOneCheck(check, ctx, timeoutMs).catch(
                    (err: unknown): DoctorResult => ({
                      id: check.id,
                      name: check.name,
                      category: check.category,
                      status: 'fail',
                      message: `check crashed: ${(err as Error).message}`,
                      detail: { stack: (err as Error).stack },
                      durationMs: 0,
                    }),
                  ),
                ),
              ),
            );
            results.push(...restResults);
          }
          continue;
        }
      }

      // Dispatch the wave's checks through the concurrency limiter.
      const waveResults = await Promise.all(
        wave.map((check) =>
          this.limit(() =>
            runOneCheck(check, ctx, timeoutMs).catch(
              (err: unknown): DoctorResult => ({
                id: check.id,
                name: check.name,
                category: check.category,
                status: 'fail',
                message: `check crashed: ${(err as Error).message}`,
                detail: { stack: (err as Error).stack },
                durationMs: 0,
              }),
            ),
          ),
        ),
      );
      results.push(...waveResults);
    }

    // 4. Compute summary + assemble report.
    const summary = computeSummary(results);
    const report: DoctorReport = {
      results,
      summary,
      durationMs: Date.now() - startOverall,
      profile,
      timestamp: new Date().toISOString(),
      linuxifyVersion: LINUXIFY_VERSION,
    };

    logger.debug('doctor run complete', {
      profile,
      total: summary.total,
      ok: summary.ok,
      warn: summary.warn,
      fail: summary.fail,
      missing: summary.missing,
      skip: summary.skip,
      durationMs: report.durationMs,
    });

    return report;
  }
}

/**
 * Partition checks into waves by category. Wave N must complete before wave
 * N+1. Within a wave, checks run in parallel up to the engine's concurrency
 * limit. Empty waves are filtered out.
 *
 * @param checks - The checks to partition.
 * @returns An array of waves (each wave is an array of checks).
 */
export function partitionWaves(checks: readonly DoctorCheck[]): DoctorCheck[][] {
  const waves: DoctorCheck[][] = [[], [], [], [], [], [], [], []];
  for (const c of checks) {
    const idx = CATEGORY_TO_WAVE[c.category] ?? 4;
    waves[idx]?.push(c);
  }
  return waves.filter((w) => w.length > 0);
}

/**
 * Run a single check, with timing, timeout, and abort handling.
 *
 * The check's own `run` is wrapped in:
 * - A `Promise.race` against a timeout promise. If the timeout fires, the
 *   check gets a synthetic `fail` result with a "check timed out" message;
 *   the underlying `run` promise is left to settle (Node's process will
 *   exit when the engine returns).
 * - A `try/catch` so a thrown error becomes a `fail` result with a
 *   "check crashed" message.
 *
 * The returned `durationMs` is the check's own value if it set one,
 * otherwise the wall-clock time measured by this function.
 *
 * @param check - The check to run.
 * @param ctx - Doctor context.
 * @param timeoutMs - Per-check timeout in milliseconds.
 * @returns A {@link DoctorResult}; never rejects.
 */
async function runOneCheck(
  check: DoctorCheck,
  ctx: DoctorContext,
  timeoutMs: number,
): Promise<DoctorResult> {
  const start = Date.now();
  const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
    id: check.id,
    name: check.name,
    category: check.category,
  };

  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<DoctorResult>((resolve) => {
    timeoutId = setTimeout(
      () =>
        resolve({
          ...base,
          status: 'fail',
          message: `check timed out after ${timeoutMs} ms`,
          detail: { timeoutMs },
          durationMs: timeoutMs,
        }),
      timeoutMs,
    );
    // unref so the timer doesn't keep the event loop alive in tests.
    timeoutId.unref?.();
  });

  try {
    const result = await Promise.race([check.run(ctx), timeoutPromise]);
    return {
      ...result,
      durationMs: result.durationMs || Date.now() - start,
    };
  } catch (err) {
    return {
      ...base,
      status: 'fail',
      message: `check crashed: ${(err as Error).message}`,
      detail: { stack: (err as Error).stack },
      durationMs: Date.now() - start,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

/**
 * Compute the summary counts (ok / warn / fail / missing / skip / total)
 * from a list of results.
 *
 * @param results - The flat results list.
 * @returns The summary object.
 */
export function computeSummary(results: readonly DoctorResult[]): DoctorReport['summary'] {
  const summary = { ok: 0, warn: 0, fail: 0, missing: 0, skip: 0, total: results.length };
  for (const r of results) {
    switch (r.status) {
      case 'ok':
        summary.ok++;
        break;
      case 'warn':
        summary.warn++;
        break;
      case 'fail':
        summary.fail++;
        break;
      case 'missing':
        summary.missing++;
        break;
      case 'skip':
        summary.skip++;
        break;
      default:
        // Unknown status — count as skip for safety.
        summary.skip++;
        break;
    }
  }
  return summary;
}

/**
 * Convenience: format a {@link DoctorReport} as a string in the given
 * format. Re-exports {@link formatReport} from `output.ts` so callers can
 * import everything from `doctor/engine`.
 *
 * @param report - The report to format.
 * @param format - Output format.
 * @returns The formatted string.
 */
export function formatReport(
  report: DoctorReport,
  format: 'human' | 'json' | 'markdown' | 'quiet',
): string {
  return formatReportImpl(report, format);
}

/**
 * Resolve the format to use based on {@link DoctorOptions}.
 *
 * If multiple format flags are set, the precedence is `json` > `markdown` >
 * `quiet` > `human` (matching the CLI's flag precedence).
 *
 * @param opts - Doctor options.
 * @returns The format name.
 */
export function resolveFormat(opts: DoctorOptions): 'human' | 'json' | 'markdown' | 'quiet' {
  if (opts.json) return 'json';
  if (opts.markdown) return 'markdown';
  if (opts.quiet) return 'quiet';
  return 'human';
}
