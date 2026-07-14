/**
 * Unit tests for `src/snapshot/manager.ts` (the `SnapshotManager` class).
 *
 * Covers:
 *   - `create()`:
 *     - happy path: produces a rootfs tarball (via mocked provider), a
 *       sidecar meta.tar.gz with config+state, and a manifest.json.
 *     - rejects path-traversal names (after sanitization still has `/`).
 *     - rejects names that sanitize to empty.
 *     - records the snapshot's metadata (name, distro, createdAt, path,
 *       sizeMb, linuxifyVersion, contents).
 *   - `list()`:
 *     - returns empty result when snapshotsDir does not exist.
 *     - returns snapshots sorted newest-first by createdAt.
 *     - skips malformed manifests.
 *   - `restore()`:
 *     - happy path: calls distroProvider.restore, extracts sidecar,
 *       regenerates launchers.
 *     - throws E_SNAPSHOT_NOT_FOUND when name is unknown.
 *   - `remove()`:
 *     - deletes manifest + sidecar + rootfs tarball.
 *     - throws E_SNAPSHOT_NOT_FOUND when name is unknown.
 *   - `prune()`:
 *     - keeps only the N most recent; deletes the rest.
 *     - no-op when total <= keepCount.
 *   - Budget enforcement: when total > budgetMb, prunes oldest.
 *
 * Uses real `tar` library and real tmpdir filesystem; the distro provider
 * is mocked so no proot-distro subprocess is spawned. The logger is mocked.
 */

import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import { SnapshotManager } from '../../../src/snapshot/manager.js';
import { StateStore, defaultState } from '../../../src/state/index.js';
import type { DistroProvider } from '../../../src/distros/index.js';
import type { Snapshot } from '../../../src/snapshot/types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Make a mock DistroProvider whose `snapshot()` writes a fake tarball. */
function makeMockProvider(snapshotsDir: string): {
  provider: DistroProvider;
  snapshotCalls: string[];
  restoreCalls: string[];
  setSnapshotBytes: (bytes: string) => void;
} {
  const snapshotCalls: string[] = [];
  const restoreCalls: string[] = [];
  let snapshotBytes = 'fake-rootfs-contents';
  const provider: DistroProvider = {
    name: 'ubuntu',
    displayName: 'Ubuntu 24.04 LTS',
    defaultVersion: '24.04',
    supportedArches: ['aarch64'],
    minStorageMb: 1024,
    isInstalled: async () => true,
    install: async () => undefined,
    uninstall: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    shell: async () => undefined,
    info: async () => ({
      name: 'ubuntu',
      version: '24.04',
      arch: 'aarch64',
      installedAt: new Date().toISOString(),
      rootfsPath: '/tmp/fake-rootfs',
      rootfsSha256: 'a'.repeat(64),
      diskUsageMb: 300,
    }),
    update: async () => undefined,
    snapshot: async (name: string) => {
      snapshotCalls.push(name);
      const p = join(snapshotsDir, `${name}.tar.zst`);
      await writeFile(p, snapshotBytes);
      return p;
    },
    restore: async (snapshotPath: string) => {
      restoreCalls.push(snapshotPath);
    },
  };
  return {
    provider,
    snapshotCalls,
    restoreCalls,
    setSnapshotBytes: (b: string) => {
      snapshotBytes = b;
    },
  };
}

/** Set up a fresh tmpdir and return the paths + helpers. */
async function freshTmp(): Promise<{
  linuxifyHome: string;
  snapshotsDir: string;
  stateStore: StateStore;
}> {
  const linuxifyHome = await mkdtemp(join(tmpdir(), 'linuxify-snap-'));
  const snapshotsDir = join(linuxifyHome, 'snapshots');
  const statePath = join(linuxifyHome, 'state.json');
  const stateStore = new StateStore(statePath);
  // Initialize state on disk so the manager can load it.
  await stateStore.save(defaultState());
  return { linuxifyHome, snapshotsDir, stateStore };
}

/** Read+parse a manifest JSON. */
async function readManifest(dir: string, name: string): Promise<Snapshot> {
  const p = join(dir, `${name}.manifest.json`);
  return JSON.parse(await readFile(p, 'utf8')) as Snapshot;
}

/** Returns true if a file exists. */
async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SnapshotManager', () => {
  let linuxifyHome: string;
  let snapshotsDir: string;
  let stateStore: StateStore;

  beforeEach(async () => {
    const env = await freshTmp();
    linuxifyHome = env.linuxifyHome;
    snapshotsDir = env.snapshotsDir;
    stateStore = env.stateStore;
    process.env.LINUXIFY_HOME = linuxifyHome;
  });

  afterEach(async () => {
    delete process.env.LINUXIFY_HOME;
    if (linuxifyHome) {
      await rm(linuxifyHome, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('throws if stateStore is missing', () => {
      const { provider } = makeMockProvider(snapshotsDir);
      expect(
        () =>
          new SnapshotManager({
            // @ts-expect-error intentional
            stateStore: undefined,
            snapshotsDir,
            distroProvider: provider,
          }),
      ).toThrow(/stateStore/);
    });

    it('throws if snapshotsDir is missing', () => {
      const { provider } = makeMockProvider(snapshotsDir);
      expect(
        () =>
          new SnapshotManager({
            stateStore,
            // @ts-expect-error intentional
            snapshotsDir: undefined,
            distroProvider: provider,
          }),
      ).toThrow(/snapshotsDir/);
    });

    it('throws if distroProvider is missing', () => {
      expect(
        () =>
          new SnapshotManager({
            stateStore,
            snapshotsDir,
            // @ts-expect-error intentional
            distroProvider: undefined,
          }),
      ).toThrow(/distroProvider/);
    });

    it('applies default budgetMb and keepCount', () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });
      expect(mgr.budgetMb).toBe(5120);
      expect(mgr.keepCount).toBe(5);
    });

    it('honors custom budgetMb and keepCount', () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({
        stateStore,
        snapshotsDir,
        distroProvider: provider,
        budgetMb: 100,
        keepCount: 2,
      });
      expect(mgr.budgetMb).toBe(100);
      expect(mgr.keepCount).toBe(2);
    });
  });

  describe('create', () => {
    it('creates a snapshot with manifest + sidecar + rootfs tarball', async () => {
      const { provider, snapshotCalls } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      // Write a config.toml so the sidecar has something to bundle.
      await writeFile(join(linuxifyHome, 'config.toml'), '# test config\n');

      const snap = await mgr.create('pre-cline-install', 'ubuntu');

      expect(snap.name).toBe('pre-cline-install');
      expect(snap.distro).toBe('ubuntu');
      expect(snap.path).toBe(join(snapshotsDir, 'pre-cline-install.tar.zst'));
      expect(snap.sizeMb).toBeGreaterThanOrEqual(1);
      expect(snap.linuxifyVersion).toBeTypeOf('string');
      expect(snap.contents.config).toBe(true);
      expect(snap.contents.state).toBe(true);
      expect(snap.contents.packages).toEqual([]);
      expect(snap.contents.runtimes).toEqual([]);
      expect(snapshotCalls).toEqual(['pre-cline-install']);

      // Files on disk:
      expect(await exists(snap.path)).toBe(true);
      expect(await exists(join(snapshotsDir, 'pre-cline-install.meta.tar.gz'))).toBe(true);
      expect(await exists(join(snapshotsDir, 'pre-cline-install.manifest.json'))).toBe(true);

      // Manifest content matches the returned snapshot.
      const manifest = await readManifest(snapshotsDir, 'pre-cline-install');
      expect(manifest.name).toBe(snap.name);
      expect(manifest.distro).toBe(snap.distro);
      expect(manifest.path).toBe(snap.path);
    });

    it('sanitizes the name', async () => {
      const { provider, snapshotCalls } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      const snap = await mgr.create('My Snapshot!!', 'ubuntu');
      // sanitizeSnapshotName replaces non-[A-Za-z0-9._-] with _ and collapses.
      expect(snap.name).toBe('My_Snapshot');
      expect(snapshotCalls).toEqual(['My_Snapshot']);
    });

    it('throws E_SNAPSHOT_INVALID_NAME on names that sanitize to empty', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await expect(mgr.create('!!!', 'ubuntu')).rejects.toThrow(/sanitizes to an empty string/);
    });

    it('records installed packages and runtimes in the manifest', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      // Mutate state to include a fake package + runtime.
      await stateStore.update((s) => {
        s.installed_packages.push({
          name: 'cline',
          version: '1.0.0',
          distro: 'ubuntu',
          runtime: 'node',
          runtime_version: '22.0.0',
          install_date: new Date().toISOString(),
          launcher_path: '/usr/bin/cline',
          patches_applied: [],
        });
        s.installed_runtimes.push({
          name: 'node',
          version: '22.0.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: new Date().toISOString(),
          is_default: true,
        });
      });

      const snap = await mgr.create('with-pkgs', 'ubuntu');
      expect(snap.contents.packages).toEqual(['cline']);
      expect(snap.contents.runtimes).toEqual(['node']);
    });

    it('still creates a snapshot when config.toml is absent (no sidecar files)', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      // state.json exists (we wrote it in beforeEach); config.toml does not.
      const snap = await mgr.create('no-config', 'ubuntu');
      expect(snap.contents.config).toBe(false);
      expect(snap.contents.state).toBe(true);
      // Sidecar tarball is still created (state.json is bundled).
      expect(await exists(join(snapshotsDir, 'no-config.meta.tar.gz'))).toBe(true);
    });
  });

  describe('list', () => {
    it('returns empty when snapshotsDir does not exist', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      const result = await mgr.list();
      expect(result.snapshots).toEqual([]);
      expect(result.totalSizeMb).toBe(0);
    });

    it('returns snapshots sorted newest-first by createdAt', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      const first = await mgr.create('first', 'ubuntu');
      // Sleep 5ms to ensure createdAt differs.
      await new Promise((r) => setTimeout(r, 5));
      const second = await mgr.create('second', 'ubuntu');

      const result = await mgr.list();
      expect(result.snapshots).toHaveLength(2);
      expect(result.snapshots[0]?.name).toBe('second');
      expect(result.snapshots[1]?.name).toBe('first');
      expect(result.totalSizeMb).toBe(first.sizeMb + second.sizeMb);
    });

    it('skips malformed manifests', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await mgr.create('good', 'ubuntu');
      // Write a malformed manifest.
      await writeFile(join(snapshotsDir, 'bad.manifest.json'), '{not json');

      const result = await mgr.list();
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0]?.name).toBe('good');
    });
  });

  describe('restore', () => {
    it('calls distroProvider.restore and extracts sidecar', async () => {
      const { provider, restoreCalls } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await writeFile(join(linuxifyHome, 'config.toml'), '# original config\n');
      const snap = await mgr.create('to-restore', 'ubuntu');

      // Mutate the config so we can verify the restore overwrites it.
      await writeFile(join(linuxifyHome, 'config.toml'), '# mutated config\n');

      await mgr.restore('to-restore');

      expect(restoreCalls).toEqual([snap.path]);
      // Sidecar was extracted: config.toml should be back to '# original config'.
      const restored = await readFile(join(linuxifyHome, 'config.toml'), 'utf8');
      expect(restored).toBe('# original config\n');
    });

    it('throws E_SNAPSHOT_NOT_FOUND when name is unknown', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await expect(mgr.restore('never-existed')).rejects.toThrow(/no snapshot named/);
    });
  });

  describe('remove', () => {
    it('deletes manifest + sidecar + rootfs tarball', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      const snap = await mgr.create('to-remove', 'ubuntu');
      expect(await exists(snap.path)).toBe(true);
      expect(await exists(join(snapshotsDir, 'to-remove.manifest.json'))).toBe(true);
      expect(await exists(join(snapshotsDir, 'to-remove.meta.tar.gz'))).toBe(true);

      await mgr.remove('to-remove');

      expect(await exists(snap.path)).toBe(false);
      expect(await exists(join(snapshotsDir, 'to-remove.manifest.json'))).toBe(false);
      expect(await exists(join(snapshotsDir, 'to-remove.meta.tar.gz'))).toBe(false);
    });

    it('throws E_SNAPSHOT_NOT_FOUND when name is unknown', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await expect(mgr.remove('never-existed')).rejects.toThrow(/no snapshot named/);
    });
  });

  describe('prune', () => {
    it('keeps only the N most recent', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({
        stateStore,
        snapshotsDir,
        distroProvider: provider,
        // Set a generous budget so prune-keep-count is the only constraint.
        budgetMb: 100_000,
      });

      for (let i = 0; i < 5; i++) {
        await mgr.create(`snap-${i}`, 'ubuntu');
        await new Promise((r) => setTimeout(r, 5));
      }

      await mgr.prune(2);

      const result = await mgr.list();
      expect(result.snapshots).toHaveLength(2);
      // Newest-first: snap-4 and snap-3 should be the survivors.
      expect(result.snapshots[0]?.name).toBe('snap-4');
      expect(result.snapshots[1]?.name).toBe('snap-3');
    });

    it('no-op when total <= keepCount', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await mgr.create('only-one', 'ubuntu');
      await mgr.prune(5);

      const result = await mgr.list();
      expect(result.snapshots).toHaveLength(1);
    });

    it('deletes all when keepCount=0', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({
        stateStore,
        snapshotsDir,
        distroProvider: provider,
        budgetMb: 100_000,
      });

      await mgr.create('a', 'ubuntu');
      await mgr.create('b', 'ubuntu');
      await mgr.prune(0);

      const result = await mgr.list();
      expect(result.snapshots).toEqual([]);
    });
  });

  describe('budget enforcement', () => {
    it('prunes oldest when total size exceeds budget', async () => {
      const { provider, setSnapshotBytes } = makeMockProvider(snapshotsDir);
      // Make each tarball ~2 MB so we can blow a tiny budget.
      setSnapshotBytes('x'.repeat(2 * 1024 * 1024));

      const mgr = new SnapshotManager({
        stateStore,
        snapshotsDir,
        distroProvider: provider,
        budgetMb: 5, // tiny budget
        keepCount: 10, // large keep so budget is the active constraint
      });

      // Create 4 snapshots of ~2 MB each = 8 MB total, exceeds 5 MB budget.
      for (let i = 0; i < 4; i++) {
        await mgr.create(`snap-${i}`, 'ubuntu');
        await new Promise((r) => setTimeout(r, 5));
      }

      const result = await mgr.list();
      // After budget enforcement, total should be <= budgetMb (with at
      // least 1 snapshot remaining).
      expect(result.snapshots.length).toBeGreaterThanOrEqual(1);
      expect(result.totalSizeMb).toBeLessThanOrEqual(5);
    });

    it('never prunes below 1 snapshot even if a single one exceeds budget', async () => {
      const { provider, setSnapshotBytes } = makeMockProvider(snapshotsDir);
      setSnapshotBytes('x'.repeat(3 * 1024 * 1024));

      const mgr = new SnapshotManager({
        stateStore,
        snapshotsDir,
        distroProvider: provider,
        budgetMb: 1, // 1 MB; the 3 MB snapshot alone exceeds it
        keepCount: 10,
      });

      await mgr.create('only', 'ubuntu');
      const result = await mgr.list();
      expect(result.snapshots).toHaveLength(1);
    });
  });

  describe('directory creation', () => {
    it('creates snapshotsDir if it does not exist', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      // snapshotsDir does not exist yet (we only created linuxifyHome).
      expect(await exists(snapshotsDir)).toBe(false);

      await mgr.create('first', 'ubuntu');

      // Now it exists, and the snapshot files are in it.
      const entries = await readdir(snapshotsDir);
      expect(entries).toContain('first.manifest.json');
    });
  });

  describe('empty-nested directory handling', () => {
    it('list returns empty when snapshotsDir exists but is empty', async () => {
      const { provider } = makeMockProvider(snapshotsDir);
      const mgr = new SnapshotManager({ stateStore, snapshotsDir, distroProvider: provider });

      await mkdir(snapshotsDir, { recursive: true });
      const result = await mgr.list();
      expect(result.snapshots).toEqual([]);
    });
  });
});
