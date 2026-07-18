/**
 * Snapshot subsystem types.
 *
 * @module linuxify/snapshot/types
 *
 * A snapshot is a tarball of an entire distro rootfs at a point in time,
 * plus a small JSON manifest describing its contents. Snapshots are the
 * fastest restoration path (see `docs/22-operations/disaster-recovery.md`
 * §3 Level 3): restoring a snapshot reproduces the distro's installed
 * packages and applied patches byte-for-byte, modulo Android-version
 * differences that may require a follow-up `linuxify repair`.
 *
 * The snapshot subsystem is deliberately provider-agnostic: it delegates
 * rootfs tarball creation/extraction to {@link DistroProvider.snapshot} /
 * {@link DistroProvider.restore} and adds a manifest layer on top that
 * records what is in the tarball (which distro, which linuxify version,
 * whether config and state were included). The manifest is what
 * {@link SnapshotManager.list} reads to enumerate snapshots without having
 * to crack open every tarball.
 *
 * @packageDocumentation
 */

/**
 * Snapshot metadata. One of these is written next to every snapshot
 * tarball as `<name>.manifest.json` and returned by {@link
 * SnapshotManager.create} / read by {@link SnapshotManager.list}.
 */
export interface Snapshot {
  /** Snapshot name (filename-safe; sanitized via {@link SnapshotManager.create}). */
  name: string;
  /** Distro identifier this snapshot was taken from (e.g. `ubuntu`). */
  distro: string;
  /** ISO 8601 timestamp the snapshot was created. */
  createdAt: string;
  /** Absolute path to the rootfs tarball (`.tar.zst` or `.tar.gz`). */
  path: string;
  /** Tarball size in megabytes (1 MB = 1024 * 1024 bytes). */
  sizeMb: number;
  /** Linuxify version that created the snapshot (for compatibility checks on restore). */
  linuxifyVersion: string;
  /** What was captured in the snapshot, beyond the rootfs itself. */
  contents: SnapshotContents;
}

/**
 * Records what was captured in a snapshot, beyond the rootfs itself. Used
 * by {@link SnapshotManager.restore} to decide what to restore.
 */
export interface SnapshotContents {
  /** Package names recorded as installed at snapshot time (from `state.installed_packages`). */
  packages: string[];
  /** Runtime names recorded as installed at snapshot time (from `state.installed_runtimes`). */
  runtimes: string[];
  /** `true` if `~/.linuxify/config.toml` was bundled into the snapshot. */
  config: boolean;
  /** `true` if `~/.linuxify/state.json` was bundled into the snapshot. */
  state: boolean;
}

/**
 * Result of {@link SnapshotManager.list}: the snapshots sorted newest-first
 * plus the total on-disk size.
 */
export interface SnapshotListResult {
  /** Snapshots sorted by `createdAt` descending (newest first). */
  snapshots: Snapshot[];
  /** Sum of `sizeMb` across all listed snapshots, in megabytes. */
  totalSizeMb: number;
}

/**
 * Constructor options for {@link SnapshotManager}.
 */
export interface SnapshotManagerOptions {
  /** State store, used to read installed packages/runtimes for the manifest. */
  readonly stateStore: import('../state/index.js').StateStore;
  /**
   * Absolute path to the snapshots directory (typically
   * `~/.linuxify/snapshots/`). Created if missing.
   */
  readonly snapshotsDir: string;
  /** Distro provider used to create/restore the rootfs tarball. */
  readonly distroProvider: import('../distros/index.js').DistroProvider;
  /**
   * Maximum total size of all snapshots, in megabytes. When exceeded, the
   * oldest snapshots are pruned until the budget is met. Default 5120 (5 GB).
   */
  readonly budgetMb?: number;
  /**
   * Maximum number of snapshots to keep via {@link SnapshotManager.prune}.
   * Default 5. The prune-keep-count is independent of the budget: prune
   * enforces `keepCount`, the budget enforces `budgetMb`; both can apply.
   */
  readonly keepCount?: number;
}
