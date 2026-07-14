/**
 * Public API surface for the `snapshot` module.
 *
 * @module linuxify/snapshot
 *
 * Re-exports the {@link SnapshotManager} class, the snapshot types, the
 * default budget/keep-count constants, and a factory that wires the manager
 * to the active distro provider (looked up from the state's `active_distro`)
 * and a snapshots directory under `~/.linuxify/snapshots/`.
 *
 * Downstream subsystems should import from here (`../snapshot` or
 * `linuxify/snapshot`) rather than reaching into individual files.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import { getDistro, getActiveDistroName } from '../distros/index.js';
import { DistroError, LinuxifyError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome } from '../utils/process.js';
import { getStatePath, StateStore } from '../state/index.js';

import { SnapshotManager } from './manager.js';

export { SnapshotManager } from './manager.js';
export { DEFAULT_BUDGET_MB, DEFAULT_KEEP_COUNT } from './manager.js';
export type {
  Snapshot,
  SnapshotContents,
  SnapshotListResult,
  SnapshotManagerOptions,
} from './types.js';

/**
 * Cached default manager. Lazily created on first call to
 * {@link createSnapshotManager} so importing the snapshot module does not pay
 * the cost of looking up the active distro provider; tests can reset the
 * cache via `_resetSnapshotManagerForTests`.
 */
let _defaultManager: SnapshotManager | undefined;

/**
 * Create (or return the cached) default {@link SnapshotManager}.
 *
 * The default manager is wired to:
 *   - The {@link StateStore} pointed at {@link getStatePath}.
 *   - The snapshots directory at `<linuxifyHome>/snapshots/`.
 *   - The active distro's provider (looked up from `state.active_distro`).
 *
 * If no distro is active, the call throws `E_SNAPSHOT_NO_ACTIVE_DISTRO`; the
 * caller must `linuxify use <distro>` first.
 *
 * Tests that need a custom provider or snapshots directory should construct
 * their own `new SnapshotManager({ stateStore, snapshotsDir, distroProvider })`.
 *
 * @returns A shared {@link SnapshotManager} instance.
 * @throws {LinuxifyError} with code `E_SNAPSHOT_NO_ACTIVE_DISTRO` if no
 *   active distro is set in state.
 */
export async function createSnapshotManager(): Promise<SnapshotManager> {
  if (_defaultManager) return _defaultManager;

  const stateStore = new StateStore(getStatePath());
  const state = await stateStore.load();
  const activeName = getActiveDistroName(state);
  if (!activeName) {
    throw new LinuxifyError({
      code: 'E_SNAPSHOT_NO_ACTIVE_DISTRO',
      message:
        'no active distro set; run `linuxify use <distro>` before creating or restoring snapshots',
      details: { active_distro: state.active_distro },
      fixCommand: 'linuxify use ubuntu',
    });
  }
  let distroProvider;
  try {
    distroProvider = getDistro(activeName);
  } catch (err) {
    // Re-throw as a LinuxifyError so the CLI's error handler picks it up
    // uniformly. DistroError already extends LinuxifyError, so the cast is
    // usually a no-op.
    if (err instanceof DistroError) throw err;
    throw new LinuxifyError({
      code: 'E_SNAPSHOT_NO_ACTIVE_DISTRO',
      message: `active distro '${activeName}' is not registered: ${(err as Error).message}`,
      cause: err,
    });
  }
  const snapshotsDir = join(getLinuxifyHome(), 'snapshots');
  _defaultManager = new SnapshotManager({ stateStore, snapshotsDir, distroProvider });
  logger.debug('snapshot: default manager created', {
    distro: activeName,
    snapshotsDir,
  });
  return _defaultManager;
}

/**
 * Reset the cached default manager. Exported for tests that want to
 * reconstruct the manager after swapping the active distro or the snapshots
 * directory; not part of the public snapshot API surface.
 *
 * @internal
 */
export function _resetSnapshotManagerForTests(): void {
  _defaultManager = undefined;
}
