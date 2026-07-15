/**
 * Repair engine — runs doctor, applies `fixCommand`s, re-runs doctor.
 *
 * @module linuxify/repair/engine
 *
 * The repair engine is the implementation behind `linuxify repair` and
 * `linuxify repair <subsystem>`. The high-level flow (see
 * `docs/22-operations/disaster-recovery.md` §7) is:
 *
 *   1. Run the doctor to get a {@link DoctorReport}.
 *   2. Filter results to those with `status: 'fail' | 'missing'` AND a
 *      non-empty `fixCommand`. Apply the optional `checkIds` filter on top.
 *   3. For each fix:
 *      - If `--yes` is not set, prompt the user via the `confirm` callback.
 *        A "no" skips the fix (recorded as `success: false`, `error:
 *        'skipped by user'`).
 *      - If `--dry-run` is set, record what would have run without spawning.
 *      - Otherwise, execute the `fixCommand` via `sh -c "<cmd>"` using
 *        `utils/process.exec`. Record exit code, duration, and any stderr.
 *   4. Re-run the doctor to capture the after state.
 *   5. Return a {@link RepairResult} with both reports and the per-fix
 *      results, so the CLI can render a before/after diff.
 *
 * The engine also exposes targeted repair entry points used by the
 * `linuxify repair <subsystem>` subcommands:
 *
 *   - {@link RepairEngine.fixState} — rebuild `state.json` from filesystem evidence.
 *   - {@link RepairEngine.fixLaunchers} — regenerate every launcher via `LauncherGenerator`.
 *   - {@link RepairEngine.fixPaths} — fix `$PATH` entries in shell rc files.
 *   - {@link RepairEngine.fixBootstrap} — re-run failed bootstrap stages.
 *
 * The engine is intentionally thin: the doctor engine does the heavy lifting
 * of identifying problems; the launcher / state / bootstrap modules do the
 * heavy lifting of fixing them. The repair engine is the orchestrator.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';
import { promises as fsp } from 'node:fs';

import { exec as realExec } from '../utils/process.js';
import { LinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import { ensureDir, exists, readJson } from '../utils/fs.js';
import { getLinuxifyHome } from '../utils/process.js';
import { LINUXIFY_VERSION } from '../utils/constants.js';
import { DEFAULT_CONFIG } from '../config/index.js';
import {
  DistroInstallSchema,
  RuntimeInstallSchema,
  type DistroInstall,
  type RuntimeInstall,
  type State,
  type StateStore,
} from '../state/index.js';
import { defaultState } from '../state/store.js';
import type { DoctorEngine } from '../doctor/engine.js';
import type { DoctorContext, DoctorReport, DoctorResult } from '../doctor/types.js';

import type {
  RepairEngineOptions,
  RepairExecFn,
  RepairFixResult,
  RepairOptions,
  RepairResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Statuses that count as "broken" for repair purposes. `warn` is excluded
 * because a warning is not necessarily fixable by a `fixCommand`; `ok` and
 * `skip` obviously need no fix.
 */
const BROKEN_STATUSES = new Set<DoctorResult['status']>(['fail', 'missing']);

/**
 * Build the default confirmation callback from the options. Returns a
 * callback that returns `opts.yes === true` for every fix, so
 * non-interactive callers must pass `--yes` to apply any fix.
 */
function defaultConfirm(opts: RepairOptions): (id: string, cmd: string) => Promise<boolean> {
  return async () => opts.yes === true;
}

/**
 * Priority order for repair fixes. Lower number = higher priority = runs first.
 *
 * Bootstrap failures are root causes for most other failures on a fresh
 * install, so they run first. Distro and runtime failures depend on bootstrap.
 * PATH and network failures are usually independent.
 */
const CHECK_PRIORITY: Record<string, number> = {
  'bootstrap.completed': 0, // root cause — fix first
  'host.termux': 1, // environment prerequisite
  'host.android': 1,
  'host.arch': 1,
  'host.storage': 1,
  'host.memory': 1,
  'distro.installed': 2, // depends on bootstrap
  'path.proot': 3, // depends on host deps (bootstrap stage 1)
  'runtime.node': 3, // depends on bootstrap stage 4
  'runtime.python': 3,
  'runtime.git': 3,
  'path.linuxify_bin': 4, // depends on bootstrap stage 6
  'path.termux_prefix': 4,
  'compat.platform': 5, // depends on distro + runtimes
  'network.dns': 9, // independent
  'network.github': 9,
  'network.npm': 9,
};

/**
 * Default priority for checks not in the explicit map.
 */
const DEFAULT_PRIORITY = 5;

/**
 * Deduplicate and dependency-order a list of failing doctor results.
 *
 * Two transformations:
 *
 * 1. **Deduplication by fixCommand**: If multiple checks suggest the same
 *    fixCommand (e.g., both `bootstrap.completed` and `distro.installed`
 *    suggest `linuxify init` on a fresh install), only keep the first
 *    occurrence. The duplicate would either succeed trivially (already fixed)
 *    or fail identically.
 *
 * 2. **Dependency ordering**: Sort by {@link CHECK_PRIORITY} so bootstrap
 *    fixes run before distro fixes, which run before PATH fixes. This
 *    prevents the "stage 6 failed because stage 0 wasn't done" cascade.
 *
 * @param results - Failing doctor results with fixCommands.
 * @returns Deduplicated, priority-ordered subset.
 */
function deduplicateAndOrderFixes(results: DoctorResult[]): DoctorResult[] {
  const seen = new Set<string>();
  const ordered = [...results].sort((a, b) => {
    const pa = CHECK_PRIORITY[a.id] ?? DEFAULT_PRIORITY;
    const pb = CHECK_PRIORITY[b.id] ?? DEFAULT_PRIORITY;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
  return ordered.filter((r) => {
    const key = r.fixCommand ?? '';
    if (seen.has(key)) {
      logger.info('repair: deduplicating fixCommand', {
        checkId: r.id,
        fixCommand: key,
      });
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Determine which downstream fixes should be skipped after a failure.
 *
 * If `bootstrap.completed` fails, everything downstream (distro, runtime,
 * path) will also fail — skip them. If `distro.installed` fails, runtime
 * and path checks that need a distro should be skipped.
 *
 * @param failedCheckId - The check that just failed.
 * @param remaining - All ordered fixes (we'll skip those after the current index).
 * @param currentIndex - Index of the failed fix in the ordered list.
 * @returns The fixes that should be skipped (empty if no dependencies).
 */
function skipDependentFixes(
  failedCheckId: string,
  remaining: DoctorResult[],
  currentIndex: number,
): DoctorResult[] {
  // If bootstrap failed, everything downstream is dependent.
  // If a host check failed, distro/runtime/path checks are dependent.
  // Otherwise, just continue — most fixes are independent.
  const isRootCause =
    failedCheckId === 'bootstrap.completed' || failedCheckId.startsWith('host.');
  if (!isRootCause) {
    return [];
  }
  return remaining.slice(currentIndex + 1);
}

/**
 * Repair engine — orchestrates doctor → fix → doctor.
 *
 * One instance is typically created per `linuxify repair` invocation. The
 * engine is stateless between calls (each `run()` is independent).
 */
export class RepairEngine {
  /** Doctor engine used for the before/after runs. */
  readonly doctor: DoctorEngine;
  /** State store, used by the targeted repair entry points. */
  readonly stateStore: StateStore;
  /** Exec function (overridable for tests). */
  private readonly execFn: RepairExecFn;

  /**
   * @param opts - Constructor options. `doctor` and `stateStore` are required;
   *   `execFn` defaults to the real `exec` from `utils/process`.
   */
  constructor(opts: RepairEngineOptions) {
    if (!opts || !opts.doctor) {
      throw new LinuxifyError({
        code: 'E_REPAIR_INVALID_OPTS',
        message: 'RepairEngine requires a doctor engine',
      });
    }
    if (!opts || !opts.stateStore) {
      throw new LinuxifyError({
        code: 'E_REPAIR_INVALID_OPTS',
        message: 'RepairEngine requires a stateStore',
      });
    }
    this.doctor = opts.doctor;
    this.stateStore = opts.stateStore;
    this.execFn = opts.execFn ?? ((cmd, args) => realExec(cmd, args));
  }

  /**
   * Run the full repair flow: doctor → fix → doctor.
   *
   * @param opts - Repair options (yes, checkIds, dryRun, confirm).
   * @param ctx - Doctor context (config + state). Used for both doctor runs.
   * @returns A {@link RepairResult} with before/after reports and per-fix
   *   results. Never throws — fix failures are recorded in
   *   {@link RepairFixResult.error}, not raised. (A failure of the doctor
   *   engine itself, by contrast, IS thrown, because doctor "never throws"
   *   by contract — so a throw here means a real bug.)
   */
  async run(opts: RepairOptions, ctx: DoctorContext): Promise<RepairResult> {
    const start = Date.now();
    const confirm = opts.confirm ?? defaultConfirm(opts);

    // 1. Run doctor (before).
    logger.info('repair: running before-doctor');
    const doctorBefore = await this.doctor.run({}, ctx);

    // 2. Filter to broken results with a fixCommand, then apply checkIds.
    const brokenWithFix = doctorBefore.results.filter(
      (r) => BROKEN_STATUSES.has(r.status) && r.fixCommand && r.fixCommand.trim() !== '',
    );
    const filtered =
      opts.checkIds && opts.checkIds.length > 0
        ? brokenWithFix.filter((r) => opts.checkIds!.includes(r.id))
        : brokenWithFix;

    // 2a. Deduplicate and dependency-order the fixes.
    //
    // If multiple failing checks would be fixed by the same command (e.g.,
    // bootstrap.completed, distro.installed, and path.linuxify_bin all
    // suggest `linuxify init` on a fresh install), only run it once.
    //
    // Additionally, if bootstrap.completed is failing, it's the root cause
    // for most other failures on a fresh install. We run it FIRST and skip
    // downstream fixes that would fail without bootstrap (their fixCommand
    // will be re-evaluated in the after-doctor run).
    const orderedFiltered = deduplicateAndOrderFixes(filtered);

    logger.info('repair: found problems', {
      totalBroken: brokenWithFix.length,
      filteredTo: filtered.length,
      orderedTo: orderedFiltered.length,
      dryRun: opts.dryRun === true,
    });

    // 3. Apply each fix.
    const results: RepairFixResult[] = [];
    for (const r of orderedFiltered) {
      const fixResult = await this.applyFix(r, opts, confirm);
      results.push(fixResult);
      // If a fix failed, skip downstream fixes that depend on it.
      // This prevents the cascade of "stage 6 failed because stage 0-5
      // weren't done" errors the user reported.
      if (!fixResult.success && !opts.dryRun) {
        const skipped = skipDependentFixes(r.id, orderedFiltered, results.length);
        if (skipped.length > 0) {
          logger.info('repair: skipping dependent fixes after failure', {
            failedCheck: r.id,
            skipped: skipped.map((s) => s.id),
          });
          break;
        }
      }
    }

    // 4. Run doctor (after). In dry-run we skip the after doctor (it would
    //    be identical to before) and reuse the before report.
    let doctorAfter: DoctorReport;
    if (opts.dryRun) {
      doctorAfter = doctorBefore;
    } else {
      logger.info('repair: running after-doctor');
      doctorAfter = await this.doctor.run({}, ctx);
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    const result: RepairResult = {
      problemsFound: filtered.length,
      fixesAttempted: results.length,
      fixesSucceeded: succeeded,
      fixesFailed: failed,
      results,
      doctorBefore,
      doctorAfter,
      durationMs: Date.now() - start,
    };

    logger.info('repair: complete', {
      problemsFound: result.problemsFound,
      succeeded: result.fixesSucceeded,
      failed: result.fixesFailed,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Apply (or simulate) a single fix.
   *
   * Flow:
   *   1. If not `--yes`, call `confirm(checkId, fixCommand)`. If it returns
   *      `false`, record a skipped result (`success: false`, `error:
   *      'skipped by user'`).
   *   2. If `--dry-run`, record what would have run with `success: true` and
   *      `durationMs: 0`.
   *   3. Otherwise, run `sh -c "<fixCommand>"` via `exec`. Record exit code
   *      0 as success; anything else as failure with stderr in the error.
   *
   * @param result - The doctor result to fix.
   * @param opts - Repair options.
   * @param confirm - Confirmation callback.
   * @returns A {@link RepairFixResult} describing what happened.
   */
  private async applyFix(
    result: DoctorResult,
    opts: RepairOptions,
    confirm: (id: string, cmd: string) => Promise<boolean>,
  ): Promise<RepairFixResult> {
    const fixCommand = result.fixCommand ?? '';

    // 1. Confirm (unless --yes).
    if (opts.yes !== true) {
      const ok = await confirm(result.id, fixCommand);
      if (!ok) {
        logger.info('repair: fix skipped by user', { checkId: result.id });
        return {
          checkId: result.id,
          fixCommand,
          success: false,
          error: 'skipped by user',
          durationMs: 0,
        };
      }
    }

    // 2. Dry-run: record without executing.
    if (opts.dryRun) {
      logger.info('repair: dry-run fix', { checkId: result.id, fixCommand });
      return {
        checkId: result.id,
        fixCommand,
        success: true,
        durationMs: 0,
      };
    }

    // 3. Execute via sh -c.
    const fixStart = Date.now();
    try {
      logger.info('repair: executing fix', { checkId: result.id, fixCommand });
      const execResult = await this.execFn('sh', ['-c', fixCommand]);
      const durationMs = Date.now() - fixStart;
      if (execResult.exitCode === 0) {
        return {
          checkId: result.id,
          fixCommand,
          success: true,
          durationMs,
        };
      }
      const errMsg =
        execResult.stderr && execResult.stderr.trim() !== ''
          ? `exit ${execResult.exitCode}: ${execResult.stderr.trim()}`
          : `exit ${execResult.exitCode}`;
      logger.warn('repair: fix failed', { checkId: result.id, exitCode: execResult.exitCode });
      return {
        checkId: result.id,
        fixCommand,
        success: false,
        error: errMsg,
        durationMs,
      };
    } catch (err) {
      const durationMs = Date.now() - fixStart;
      const errMsg = (err as Error).message ?? String(err);
      logger.error('repair: fix threw', { checkId: result.id, error: errMsg });
      return {
        checkId: result.id,
        fixCommand,
        success: false,
        error: errMsg,
        durationMs,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Targeted repair entry points
  // -------------------------------------------------------------------------

  /**
   * Repair corrupted `state.json` by rebuilding it from filesystem evidence.
   *
   * Implements `linuxify repair state` (see disaster-recovery.md §7.1).
   * Non-destructive: does not delete the existing state; if a backup of the
   * corrupted file is desired, the caller should move it aside first.
   *
   * The rebuild scans `~/.linuxify/distros/` and `~/.linuxify/runtimes/` for
   * `installed` / `runtime.json` marker files and reconstructs the
   * corresponding state arrays. The current state is loaded first so any
   * fields that cannot be re-derived (e.g. `telemetry.user_id`) are
   * preserved.
   *
   * @returns `true` if a rebuild was performed and saved; `false` if nothing
   *   needed rebuilding. (Currently always returns `true` after a successful
   *   save; the boolean is reserved for future early-exit cases.)
   */
  async fixState(): Promise<boolean> {
    logger.info('repair: fixState starting');
    let currentState: State;
    try {
      currentState = await this.stateStore.load();
    } catch (err) {
      // State is corrupt — start from default. The caller's `state.json`
      // remains on disk for forensic analysis; we save the rebuilt version
      // which atomically replaces it.
      logger.warn('repair: state.json corrupt, rebuilding from defaults', {
        error: (err as Error).message,
      });
      currentState = defaultState();
    }

    const distrosDir = join(getLinuxifyHome(), 'distros');
    const rebuiltDistros = await scanInstalledDistros(distrosDir);
    if (rebuiltDistros.length > 0) {
      currentState.installed_distros = rebuiltDistros;
    }

    const runtimesDir = join(getLinuxifyHome(), 'runtimes');
    const rebuiltRuntimes = await scanInstalledRuntimes(runtimesDir);
    if (rebuiltRuntimes.length > 0) {
      currentState.installed_runtimes = rebuiltRuntimes;
    }

    // Pin the linuxify_version to the current binary version (so a stale
    // version from a failed self-update doesn't survive a state rebuild).
    currentState.linuxify_version = LINUXIFY_VERSION;

    await this.stateStore.save(currentState);
    logger.info('repair: fixState complete', {
      distros: currentState.installed_distros.length,
      runtimes: currentState.installed_runtimes.length,
    });
    return true;
  }

  /**
   * Regenerate every launcher shim.
   *
   * Implements `linuxify repair launchers`. Delegates to
   * `LauncherGenerator.regenerateAll(state)` so each installed package gets
   * a fresh shim. Best-effort: per-package failures are logged and the
   * iteration continues (see launcher/generator.ts).
   *
   * The launcher module is lazily imported so the repair module does not
   * pay the launcher's import cost when only `fixState` is called.
   */
  async fixLaunchers(): Promise<void> {
    logger.info('repair: fixLaunchers starting');
    const { getLauncherGenerator } = await import('../launcher/index.js');
    const state = await this.stateStore.load();
    const gen = getLauncherGenerator();
    const results = await gen.regenerateAll(state);
    logger.info('repair: fixLaunchers complete', {
      total: state.installed_packages.length,
      regenerated: results.length,
    });
  }

  /**
   * Fix `$PATH` entries in shell rc files.
   *
   * Implements `linuxify repair paths`. Thin wrapper around {@link run}
   * that scopes the repair to the three path checks (`path.linuxify_bin`,
   * `path.termux_prefix`, `path.proot`) and passes `--yes` so the per-fix
   * confirmation prompt is skipped (path fixes are always safe to apply).
   */
  async fixPaths(): Promise<void> {
    logger.info('repair: fixPaths starting');
    const state = await this.stateStore.load();
    const ctx: DoctorContext = { config: DEFAULT_CONFIG, state };
    await this.run(
      {
        yes: true,
        checkIds: ['path.linuxify_bin', 'path.termux_prefix', 'path.proot'],
      },
      ctx,
    );
    logger.info('repair: fixPaths complete');
  }

  /**
   * Re-run failed bootstrap stages.
   *
   * Implements `linuxify repair bootstrap`. Delegates to the bootstrap
   * orchestrator's `bootstrap()` entry point. If `force` is true, the
   * orchestrator clears all bootstrap markers first (equivalent to
   * `linuxify init --force`); otherwise it resumes from the first stage
   * whose `.done` marker is missing.
   *
   * The bootstrap module is lazily imported so this method only pays the
   * import cost when actually called.
   *
   * @param force - If `true`, clear all bootstrap markers before re-running.
   */
  async fixBootstrap(force = false): Promise<void> {
    logger.info('repair: fixBootstrap starting', { force });
    const { bootstrap } = await import('../bootstrap/index.js');
    const result = await bootstrap({ force });
    if (result.failedStage !== null) {
      throw new LinuxifyError({
        code: 'E_REPAIR_BOOTSTRAP_FAILED',
        message: `bootstrap stage ${result.failedStage} failed: ${result.error ?? 'unknown error'}`,
        details: {
          failedStage: result.failedStage,
          error: result.error,
          completedStages: result.completedStages,
        },
      });
    }
    logger.info('repair: fixBootstrap complete', {
      completedStages: result.completedStages.length,
      durationMs: result.totalDurationMs,
    });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Scan `~/.linuxify/distros/` for `installed` marker files and reconstruct
 * the `installed_distros` array. Each marker is a JSON file written by the
 * distro provider's `install()` method; we read its fields directly and
 * validate via {@link DistroInstallSchema}.
 *
 * Markers that fail to parse are skipped (logged at warn) so a single
 * corrupted marker does not block state reconstruction.
 *
 * @param distrosDir - Absolute path to `~/.linuxify/distros/`.
 * @returns An array of {@link DistroInstall} entries (possibly empty).
 */
async function scanInstalledDistros(distrosDir: string): Promise<DistroInstall[]> {
  if (!(await exists(distrosDir))) return [];
  const found: DistroInstall[] = [];

  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(distrosDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const markerPath = join(distrosDir, entry.name, 'installed');
    if (!(await exists(markerPath))) continue;
    try {
      const raw = await readJson<unknown>(markerPath);
      const parsed = DistroInstallSchema.safeParse(raw);
      if (parsed.success) {
        found.push(parsed.data);
      } else {
        logger.warn('repair: skipping corrupt distro marker', {
          distro: entry.name,
          issues: parsed.error.issues.length,
        });
      }
    } catch (err) {
      logger.warn('repair: failed to read distro marker', {
        distro: entry.name,
        error: (err as Error).message,
      });
    }
  }
  return found;
}

/**
 * Scan `~/.linuxify/runtimes/<distro>/<runtime>/<version>/` and reconstruct
 * the `installed_runtimes` array. Each runtime directory should contain a
 * `runtime.json` marker with the install metadata; we validate each via
 * {@link RuntimeInstallSchema}.
 *
 * Directories without a marker are skipped. This is best-effort: if a runtime
 * was installed outside Linuxify's tracker (e.g. via `apt install nodejs`
 * inside the proot), it is not represented here.
 *
 * @param runtimesDir - Absolute path to `~/.linuxify/runtimes/`.
 * @returns An array of {@link RuntimeInstall} entries (possibly empty).
 */
async function scanInstalledRuntimes(runtimesDir: string): Promise<RuntimeInstall[]> {
  if (!(await exists(runtimesDir))) return [];
  const found: RuntimeInstall[] = [];

  // Layout: <distro>/<runtime>/<version>/runtime.json
  const distros = await safeReaddir(runtimesDir);
  for (const distro of distros) {
    const distroDir = join(runtimesDir, distro);
    if (!(await isDirectory(distroDir))) continue;
    const runtimes = await safeReaddir(distroDir);
    for (const runtime of runtimes) {
      const runtimeDir = join(distroDir, runtime);
      if (!(await isDirectory(runtimeDir))) continue;
      const versions = await safeReaddir(runtimeDir);
      for (const version of versions) {
        const markerPath = join(runtimeDir, version, 'runtime.json');
        if (!(await exists(markerPath))) continue;
        try {
          const raw = await readJson<unknown>(markerPath);
          const parsed = RuntimeInstallSchema.safeParse(raw);
          if (parsed.success) {
            found.push(parsed.data);
          } else {
            logger.warn('repair: skipping corrupt runtime marker', {
              distro,
              runtime,
              version,
              issues: parsed.error.issues.length,
            });
          }
        } catch (err) {
          logger.warn('repair: failed to read runtime marker', {
            distro,
            runtime,
            version,
            error: (err as Error).message,
          });
        }
      }
    }
  }
  return found;
}

/** Safe `readdir` that returns `[]` on any error (e.g. ENOENT). */
async function safeReaddir(p: string): Promise<string[]> {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

/** Returns `true` if `p` exists and is a directory. */
async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await fsp.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// Ensure `ensureDir` is referenced; it is exported via the index barrel for
// use by the migration runner's backup-directory creation. The import here
// keeps the dependency graph obvious.
void ensureDir;
