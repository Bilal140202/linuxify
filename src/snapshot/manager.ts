/**
 * Snapshot manager — create, restore, list, remove, prune distro snapshots.
 *
 * @module linuxify/snapshot/manager
 *
 * The snapshot manager is the implementation behind `linuxify snapshots
 * create|restore|list|delete|prune`. Each snapshot is a rootfs tarball
 * produced by the {@link DistroProvider.snapshot} method, plus a JSON
 * manifest recording the snapshot's metadata and a small sidecar tarball
 * bundling `~/.linuxify/config.toml` and `~/.linuxify/state.json` (so a
 * restore reproduces the Termux-side state alongside the proot-side state).
 *
 * Storage layout (flat; one set of files per snapshot):
 *
 *   <snapshotsDir>/<sanitized-name>.tar.zst        # rootfs tarball
 *   <snapshotsDir>/<sanitized-name>.meta.tar.gz    # config+state sidecar
 *   <snapshotsDir>/<sanitized-name>.manifest.json  # manifest (Snapshot)
 *
 * The flat layout (as opposed to the per-distro subdirectory layout shown
 * in `docs/05-bootstrap/distro-management.md` §8) is used here because the
 * snapshot manager is provider-agnostic: it does not know which rootfs path
 * the provider used, so it cannot reliably partition by distro. The distro
 * is recorded in the manifest instead.
 *
 * Snapshot budget (see `docs/22-operations/disaster-recovery.md` §10):
 *   - Default 5 GB total. When exceeded, the oldest snapshots are pruned.
 *   - Prune-keep-count defaults to 5; {@link SnapshotManager.prune} keeps
 *     only the N most recent.
 *   - The budget does NOT count against `~/.linuxify/` storage warning
 *     thresholds (snapshots are expected to be large).
 *
 * @packageDocumentation
 */

import { promises as fsp, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';

import { create as tarCreate, extract as tarExtract } from 'tar';

import { LinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import { ensureDir, exists, readJson, writeJson, rmrf, stat } from '../utils/fs.js';
import { LINUXIFY_VERSION } from '../utils/constants.js';
import { sanitizeSnapshotName } from '../distros/proot-base.js';
import type { DistroProvider } from '../distros/index.js';
import type { StateStore } from '../state/index.js';

import type {
  Snapshot,
  SnapshotContents,
  SnapshotListResult,
  SnapshotManagerOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default snapshot budget in megabytes (5 GB; see disaster-recovery.md §10). */
export const DEFAULT_BUDGET_MB = 5120;

/** Default prune keep-count (see disaster-recovery.md §10). */
export const DEFAULT_KEEP_COUNT = 5;

/** Bytes per megabyte (1024 * 1024) — used for size conversion. */
const BYTES_PER_MB = 1024 * 1024;

/** Suffix for the rootfs tarball (recorded in the manifest; created by the provider). */
const ROOTFS_TARBALL_SUFFIX = '.tar.zst';

/** Suffix for the config+state sidecar tarball. */
const META_TARBALL_SUFFIX = '.meta.tar.gz';

/** Suffix for the manifest JSON. */
const MANIFEST_SUFFIX = '.manifest.json';

// ---------------------------------------------------------------------------
// SnapshotManager
// ---------------------------------------------------------------------------

/**
 * Manages distro snapshots under `<snapshotsDir>/`. One instance is
 * typically created per `linuxify snapshots` invocation. The manager is
 * stateless between calls — each `create` / `restore` / `list` /
 * `remove` / `prune` is independent.
 */
export class SnapshotManager {
  /** State store, used to read installed packages/runtimes for the manifest. */
  readonly stateStore: StateStore;
  /** Absolute path to the snapshots directory. */
  readonly snapshotsDir: string;
  /** Distro provider used to create/restore the rootfs tarball. */
  readonly distroProvider: DistroProvider;
  /** Maximum total size of all snapshots, in MB. */
  readonly budgetMb: number;
  /** Default prune keep-count. */
  readonly keepCount: number;

  /**
   * @param opts - Constructor options. `stateStore`, `snapshotsDir`, and
   *   `distroProvider` are required; `budgetMb` defaults to 5120 (5 GB) and
   *   `keepCount` defaults to 5.
   */
  constructor(opts: SnapshotManagerOptions) {
    if (!opts || !opts.stateStore) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_INVALID_OPTS',
        message: 'SnapshotManager requires a stateStore',
      });
    }
    if (!opts || !opts.snapshotsDir) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_INVALID_OPTS',
        message: 'SnapshotManager requires a snapshotsDir',
      });
    }
    if (!opts || !opts.distroProvider) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_INVALID_OPTS',
        message: 'SnapshotManager requires a distroProvider',
      });
    }
    this.stateStore = opts.stateStore;
    this.snapshotsDir = opts.snapshotsDir;
    this.distroProvider = opts.distroProvider;
    this.budgetMb = opts.budgetMb ?? DEFAULT_BUDGET_MB;
    this.keepCount = opts.keepCount ?? DEFAULT_KEEP_COUNT;
  }

  /**
   * Create a snapshot.
   *
   * Flow:
   *   1. Sanitize the name (reject path traversal; collapse illegal chars).
   *   2. Ensure `snapshotsDir` exists.
   *   3. Call `distroProvider.snapshot(name)` to produce the rootfs tarball.
   *   4. Bundle `~/.linuxify/config.toml` and `~/.linuxify/state.json` into
   *      a sidecar `<name>.meta.tar.gz`.
   *   5. Write `<name>.manifest.json` with the snapshot metadata.
   *   6. Enforce the budget: if total size exceeds `budgetMb`, prune oldest.
   *   7. Return the {@link Snapshot} metadata.
   *
   * @param name - Snapshot name. Sanitized to a filename-safe string.
   * @param distro - Distro identifier (recorded in the manifest; the actual
   *   tarball is created by `distroProvider.snapshot(name)`).
   * @returns The created {@link Snapshot}.
   * @throws {LinuxifyError} with code `E_SNAPSHOT_INVALID_NAME` if the
   *   sanitized name is empty or contains a path separator after sanitization.
   * @throws {DistroError} if `distroProvider.snapshot()` fails (propagated).
   */
  async create(name: string, distro: string): Promise<Snapshot> {
    const safeName = sanitizeSnapshotName(name);
    if (!safeName) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_INVALID_NAME',
        message: `snapshot name '${name}' sanitizes to an empty string`,
        details: { original: name },
      });
    }
    // Defense-in-depth: even after sanitization, reject any name that still
    // contains a path separator (sanitizeSnapshotName already replaces them
    // with `_`, but this catches future regressions in the sanitizer).
    if (safeName.includes('/') || safeName.includes('\\')) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_INVALID_NAME',
        message: `snapshot name '${safeName}' contains a path separator`,
        details: { name: safeName },
      });
    }

    await ensureDir(this.snapshotsDir);

    logger.info('snapshot: creating', { name: safeName, distro });

    // 1. Rootfs tarball via the distro provider.
    const rootfsPath = await this.distroProvider.snapshot(safeName);

    // 2. Sidecar tarball with config.toml + state.json.
    const linuxifyHome = dirname(this.stateStore.statePath);
    const configPath = join(linuxifyHome, 'config.toml');
    const statePath = this.stateStore.statePath;
    const configExists = await exists(configPath);
    const stateExists = await exists(statePath);

    const metaPath = join(this.snapshotsDir, `${safeName}${META_TARBALL_SUFFIX}`);
    const sidecarFiles: string[] = [];
    if (configExists) sidecarFiles.push('config.toml');
    if (stateExists) sidecarFiles.push('state.json');

    if (sidecarFiles.length > 0) {
      // `tar.create` with `gzip: true` produces a `.tar.gz`. Passing
      // relative filenames with `cwd: linuxifyHome` archives the files at
      // the tarball's root, so restore can extract them straight back into
      // the linuxify home.
      await tarCreate(
        {
          gzip: true,
          file: metaPath,
          cwd: linuxifyHome,
          prefix: '',
        },
        sidecarFiles,
      );
    }

    // 3. Compute rootfs tarball size.
    const rootfsStats = await stat(rootfsPath);
    const sizeMb = Math.max(1, Math.round(rootfsStats.size / BYTES_PER_MB));

    // 4. Build the manifest. Read the (post-snapshot) state for the
    //    packages/runtimes list.
    const state = await this.stateStore.load();
    const contents: SnapshotContents = {
      packages: state.installed_packages.map((p) => p.name),
      runtimes: state.installed_runtimes.map((r) => r.name),
      config: configExists,
      state: stateExists,
    };

    const snapshot: Snapshot = {
      name: safeName,
      distro,
      createdAt: new Date().toISOString(),
      path: rootfsPath,
      sizeMb,
      linuxifyVersion: LINUXIFY_VERSION,
      contents,
    };

    const manifestPath = join(this.snapshotsDir, `${safeName}${MANIFEST_SUFFIX}`);
    await writeJson(manifestPath, snapshot);

    logger.info('snapshot: created', {
      name: safeName,
      distro,
      path: rootfsPath,
      sizeMb,
    });

    // 5. Enforce budget.
    await this.enforceBudget();

    return snapshot;
  }

  /**
   * Restore a snapshot.
   *
   * Flow:
   *   1. Find the snapshot by name (read its manifest).
   *   2. Restore the rootfs via `distroProvider.restore(snapshot.path)`.
   *   3. Extract the sidecar tarball (if present) to restore config.toml
   *      and state.json.
   *   4. Regenerate launchers (the rootfs replaced the binaries the
   *      launchers point at; regenerate to be safe).
   *
   * @param name - Snapshot name (sanitized).
   * @throws {LinuxifyError} with code `E_SNAPSHOT_NOT_FOUND` if no snapshot
   *   with the given name exists.
   * @throws {DistroError} if `distroProvider.restore()` fails (propagated).
   */
  async restore(name: string): Promise<void> {
    const safeName = sanitizeSnapshotName(name);
    const snapshot = await this.findSnapshot(safeName);

    logger.info('snapshot: restoring', { name: safeName, distro: snapshot.distro });

    // 1. Rootfs.
    await this.distroProvider.restore(snapshot.path);

    // 2. Sidecar (config + state).
    const metaPath = join(this.snapshotsDir, `${safeName}${META_TARBALL_SUFFIX}`);
    if (await exists(metaPath)) {
      const targetDir = dirname(this.stateStore.statePath);
      await ensureDir(targetDir);
      await tarExtract({
        file: metaPath,
        cwd: targetDir,
      });
      logger.info('snapshot: restored config + state sidecar', { targetDir });
    }

    // 3. Regenerate launchers (best-effort).
    try {
      const { getLauncherGenerator } = await import('../launcher/index.js');
      const state = await this.stateStore.load();
      const gen = getLauncherGenerator();
      await gen.regenerateAll(state);
    } catch (err) {
      // Launcher regeneration is best-effort; log and continue.
      logger.warn('snapshot: launcher regeneration failed (non-fatal)', {
        error: (err as Error).message,
      });
    }

    logger.info('snapshot: restore complete', { name: safeName });
  }

  /**
   * List all snapshots, sorted newest-first.
   *
   * Reads every `*.manifest.json` in `snapshotsDir` and returns the parsed
   * manifests. Manifests that fail to parse are skipped (logged at warn).
   *
   * @returns A {@link SnapshotListResult} with the snapshots and total size.
   */
  async list(): Promise<SnapshotListResult> {
    if (!(await exists(this.snapshotsDir))) {
      return { snapshots: [], totalSizeMb: 0 };
    }

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.snapshotsDir, { withFileTypes: true });
    } catch {
      return { snapshots: [], totalSizeMb: 0 };
    }

    const snapshots: Snapshot[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(MANIFEST_SUFFIX)) continue;
      const manifestPath = join(this.snapshotsDir, entry.name);
      try {
        const snap = await readJson<Snapshot>(manifestPath);
        // Basic shape validation: must have name, distro, path.
        if (
          snap &&
          typeof snap.name === 'string' &&
          typeof snap.distro === 'string' &&
          typeof snap.path === 'string'
        ) {
          snapshots.push(snap);
        } else {
          logger.warn('snapshot: skipping malformed manifest', { path: manifestPath });
        }
      } catch (err) {
        logger.warn('snapshot: failed to read manifest', {
          path: manifestPath,
          error: (err as Error).message,
        });
      }
    }

    // Sort newest-first by createdAt.
    snapshots.sort((a, b) => {
      const ta = Date.parse(a.createdAt) || 0;
      const tb = Date.parse(b.createdAt) || 0;
      return tb - ta;
    });

    const totalSizeMb = snapshots.reduce((sum, s) => sum + (s.sizeMb || 0), 0);
    return { snapshots, totalSizeMb };
  }

  /**
   * Remove a snapshot.
   *
   * Deletes the rootfs tarball, the sidecar, and the manifest. Idempotent
   * for the sidecar and rootfs (which may already be gone), but throws
   * `E_SNAPSHOT_NOT_FOUND` if the manifest itself is missing — so callers
   * can distinguish "nothing to remove" from "the named snapshot never
   * existed".
   *
   * @param name - Snapshot name (sanitized).
   * @throws {LinuxifyError} with code `E_SNAPSHOT_NOT_FOUND` if no manifest
   *   exists for `name`.
   */
  async remove(name: string): Promise<void> {
    const safeName = sanitizeSnapshotName(name);
    const manifestPath = join(this.snapshotsDir, `${safeName}${MANIFEST_SUFFIX}`);
    if (!(await exists(manifestPath))) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_NOT_FOUND',
        message: `no snapshot named '${safeName}' in ${this.snapshotsDir}`,
        details: { name: safeName, dir: this.snapshotsDir },
      });
    }

    // Read the manifest to find the rootfs tarball path (it may live
    // outside snapshotsDir — the distro provider chooses where to write it).
    let snapshot: Snapshot | null = null;
    try {
      snapshot = await readJson<Snapshot>(manifestPath);
    } catch {
      // Manifest corrupt — best-effort: still try to delete the standard
      // paths derived from the name.
    }

    const metaPath = join(this.snapshotsDir, `${safeName}${META_TARBALL_SUFFIX}`);

    await rmrf(manifestPath);
    await rmrf(metaPath);
    if (snapshot && snapshot.path) {
      await rmrf(snapshot.path);
    }

    logger.info('snapshot: removed', { name: safeName });
  }

  /**
   * Prune snapshots, keeping only the N most recent.
   *
   * Default `keepCount` is the manager's `keepCount` (5 by default). The
   * oldest snapshots beyond the keep-count are deleted (manifest + sidecar
   * + rootfs tarball).
   *
   * @param keepCount - Override the default keep-count. If `0`, all
   *   snapshots are deleted.
   */
  async prune(keepCount: number = this.keepCount): Promise<void> {
    const { snapshots } = await this.list();
    if (snapshots.length <= keepCount) {
      logger.info('snapshot: prune nothing to do', {
        total: snapshots.length,
        keepCount,
      });
      return;
    }
    const toRemove = snapshots.slice(keepCount); // oldest, since list is newest-first
    logger.info('snapshot: pruning', {
      total: snapshots.length,
      keepCount,
      removing: toRemove.length,
    });
    for (const snap of toRemove) {
      try {
        await this.remove(snap.name);
      } catch (err) {
        logger.warn('snapshot: prune failed for one snapshot', {
          name: snap.name,
          error: (err as Error).message,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Find a snapshot by name. Reads the manifest and returns it.
   *
   * @param safeName - Sanitized snapshot name.
   * @returns The parsed {@link Snapshot}.
   * @throws {LinuxifyError} with code `E_SNAPSHOT_NOT_FOUND` if the manifest
   *   is missing or unreadable.
   */
  private async findSnapshot(safeName: string): Promise<Snapshot> {
    const manifestPath = join(this.snapshotsDir, `${safeName}${MANIFEST_SUFFIX}`);
    if (!(await exists(manifestPath))) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_NOT_FOUND',
        message: `no snapshot named '${safeName}' in ${this.snapshotsDir}`,
        details: { name: safeName, dir: this.snapshotsDir },
      });
    }
    try {
      return await readJson<Snapshot>(manifestPath);
    } catch (err) {
      throw new LinuxifyError({
        code: 'E_SNAPSHOT_NOT_FOUND',
        message: `manifest for snapshot '${safeName}' is unreadable: ${(err as Error).message}`,
        details: { name: safeName, path: manifestPath },
        cause: err,
      });
    }
  }

  /**
   * Enforce the snapshot budget. If the total size exceeds `budgetMb`,
   * prune the oldest snapshots until the budget is met.
   *
   * Never prunes below 1 snapshot (so a single large snapshot doesn't get
   * deleted entirely by the auto-prune; the user can still remove it
   * explicitly via {@link remove}).
   */
  private async enforceBudget(): Promise<void> {
    const { snapshots, totalSizeMb } = await this.list();
    if (totalSizeMb <= this.budgetMb) return;
    if (snapshots.length <= 1) return;

    logger.info('snapshot: over budget, pruning oldest', {
      totalSizeMb,
      budgetMb: this.budgetMb,
      count: snapshots.length,
    });

    // Iterate oldest-first (list is newest-first) and delete until under budget.
    for (let i = snapshots.length - 1; i >= 1; i--) {
      if (totalSizeMb <= this.budgetMb) break;
      const snap = snapshots[i];
      if (!snap) continue;
      try {
        await this.remove(snap.name);
      } catch (err) {
        logger.warn('snapshot: budget prune failed for one snapshot', {
          name: snap.name,
          error: (err as Error).message,
        });
        continue;
      }
    }
  }
}

// `ROOTFS_TARBALL_SUFFIX` is referenced in JSDoc above; keep the export so
// the constant is discoverable for downstream tools.
void ROOTFS_TARBALL_SUFFIX;
