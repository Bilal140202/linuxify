/**
 * Unit tests for `src/state/store.ts` (the `StateStore` class).
 *
 * These tests exercise the store against the real `src/utils/` modules (fs,
 * errors, process, constants) — only the logger is mocked, because pino's
 * lazy initializer does not play well with vitest's stdio capture and would
 * throw `TypeError: Cannot read properties of undefined (reading
 * 'Symbol(pino.msgPrefix)')` on the first `warn` call. Each test gets a fresh
 * tmpdir via `mkdtemp` and points `LINUXIFY_HOME` at it so that
 * `getStatePath()` resolves inside the tmpdir.
 */

import { mkdtemp, rm, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock only the logger — pino's lazy initializer crashes under vitest's stdio
// capture. The real fs/errors/process/constants modules are used as-is.
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

import { StateSchema, type State } from '../../../src/state/schema.js';
import { StateStore, defaultState, getStatePath } from '../../../src/state/store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Returns true if a file exists at `path`. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Returns the low 9 bits of the file mode (the permission bits). */
async function fileMode(path: string): Promise<number> {
  const s = await stat(path);
  return s.mode & 0o777;
}

/** Reads a JSON file and parses it (for test assertions on lock files). */
async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StateStore', () => {
  let tmpDir: string;
  let statePath: string;
  let lockPath: string;
  let store: StateStore;
  let originalLinuxifyHome: string | undefined;

  beforeEach(async () => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    tmpDir = await mkdtemp(join(tmpdir(), 'linuxify-state-'));
    process.env.LINUXIFY_HOME = tmpDir;
    statePath = join(tmpDir, 'state.json');
    lockPath = join(tmpDir, '.lock');
    store = new StateStore(statePath);
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) {
      delete process.env.LINUXIFY_HOME;
    } else {
      process.env.LINUXIFY_HOME = originalLinuxifyHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // load() — default state when missing
  // -------------------------------------------------------------------------

  describe('load()', () => {
    it('returns the default state when state.json does not exist', async () => {
      const state = await store.load();
      expect(state.schema_version).toBe(1);
      expect(state.active_distro).toBe('');
      expect(state.installed_distros).toEqual([]);
      expect(state.installed_runtimes).toEqual([]);
      expect(state.installed_packages).toEqual([]);
      expect(state.applied_patches).toEqual([]);
      expect(state.plugins).toEqual([]);
      expect(state.bootstrap_progress.current_stage).toBe(0);
      expect(state.telemetry.enabled).toBe(false);
      expect(state.telemetry.user_id).toBeNull();
      expect(state.last_doctor_run).toBeNull();
      expect(state.created_at).toBeTruthy();
      expect(state.updated_at).toBeTruthy();
    });

    it('does not write the default state to disk when the file is missing', async () => {
      await store.load();
      expect(await fileExists(statePath)).toBe(false);
    });

    it('throws StateError(E_STATE_CORRUPT) with fixCommand when JSON is invalid', async () => {
      await writeFile(statePath, '{ "schema_version": 1, broken', 'utf8');
      await expect(store.load()).rejects.toMatchObject({
        code: 'E_STATE_CORRUPT',
        fixCommand: 'linuxify repair state',
      });
    });

    it('throws StateError(E_STATE_CORRUPT) when JSON is valid but schema fails', async () => {
      await writeFile(statePath, JSON.stringify({ schema_version: 2 }), 'utf8');
      await expect(store.load()).rejects.toMatchObject({
        code: 'E_STATE_CORRUPT',
        fixCommand: 'linuxify repair state',
      });
    });
  });

  // -------------------------------------------------------------------------
  // save() + load() — round trip and atomic write
  // -------------------------------------------------------------------------

  describe('save()', () => {
    it('round-trips a state through save() then load()', async () => {
      const state = defaultState();
      state.active_distro = 'ubuntu';
      state.installed_distros.push({
        name: 'ubuntu',
        version: '24.04',
        installed_at: '2025-04-10T14:23:14Z',
        rootfs_sha256: 'a'.repeat(64),
      });
      await store.save(state);

      // Use a fresh store to bypass the in-memory cache.
      const store2 = new StateStore(statePath);
      const loaded = await store2.load();
      expect(loaded.active_distro).toBe('ubuntu');
      expect(loaded.installed_distros).toHaveLength(1);
      expect(loaded.installed_distros[0]!.name).toBe('ubuntu');
      expect(loaded.schema_version).toBe(1);
    });

    it('writes the file with mode 0600 (owner read/write only)', async () => {
      await store.save(defaultState());
      expect(await fileMode(statePath)).toBe(0o600);
    });

    it('updates updated_at on every save', async () => {
      const state = defaultState();
      const before = state.updated_at;
      // Ensure a measurable time difference.
      await new Promise((r) => setTimeout(r, 10));
      await store.save(state);
      const loaded = await store.load();
      expect(loaded.updated_at).not.toBe(before);
    });

    it('leaves no .tmp.* file behind after a successful save (atomic write)', async () => {
      await store.save(defaultState());
      const files = await readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toEqual([]);
    });

    it('creates the parent directory if it does not exist', async () => {
      const nestedPath = join(tmpDir, 'nested', 'deep', 'state.json');
      const nestedStore = new StateStore(nestedPath);
      await nestedStore.save(defaultState());
      expect(await fileExists(nestedPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // get() — cached access
  // -------------------------------------------------------------------------

  describe('get()', () => {
    it('returns the cached state after load()', async () => {
      await store.load();
      const cached = store.get();
      expect(cached.schema_version).toBe(1);
    });

    it('returns the cached state after save()', async () => {
      await store.save(defaultState());
      const cached = store.get();
      expect(cached.schema_version).toBe(1);
    });

    it('throws StateError(E_STATE_NOT_LOADED) before load() is called', () => {
      const fresh = new StateStore(statePath);
      expect(() => fresh.get()).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // update() — load-mutate-save under lock
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('loads, mutates, saves, and returns the new state', async () => {
      await store.save(defaultState());
      const result = await store.update((s) => {
        s.active_distro = 'debian';
        s.installed_packages.push({
          name: 'codex',
          version: '0.20.1',
          distro: 'debian',
          runtime: 'node',
          runtime_version: '22.11.0',
          install_date: '2025-04-11T08:01:12Z',
          launcher_path: '/x/codex',
          patches_applied: [],
        });
      });
      expect(result.active_distro).toBe('debian');
      expect(result.installed_packages).toHaveLength(1);

      // Verify persistence with a fresh store.
      const store2 = new StateStore(statePath);
      const reloaded = await store2.load();
      expect(reloaded.active_distro).toBe('debian');
      expect(reloaded.installed_packages[0]!.name).toBe('codex');
    });

    it('acquires and releases the lock during the update', async () => {
      await store.save(defaultState());
      await store.update((s) => {
        s.active_distro = 'arch';
      });
      // Lock should be released after update completes.
      expect(await fileExists(lockPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // lock() / unlock() / withLock()
  // -------------------------------------------------------------------------

  describe('lock()', () => {
    it('writes a .lock file with the current PID', async () => {
      await store.lock();
      expect(await fileExists(lockPath)).toBe(true);
      const raw = (await readJsonFile(lockPath)) as { pid: number; acquired_at: string };
      expect(raw.pid).toBe(process.pid);
      expect(raw.acquired_at).toBeTruthy();
    });

    it('throws StateError(E_STATE_LOCKED) when a live PID holds the lock', async () => {
      // Simulate another live process by writing the current PID into the lock.
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, acquired_at: '2025-01-01T00:00:00Z' }),
        'utf8',
      );
      await expect(store.lock()).rejects.toMatchObject({
        code: 'E_STATE_LOCKED',
      });
    });

    it('overwrites a stale lock (dead PID) without throwing', async () => {
      // PID 999999 is virtually guaranteed not to exist.
      await writeFile(
        lockPath,
        JSON.stringify({ pid: 999999, acquired_at: '2025-01-01T00:00:00Z' }),
        'utf8',
      );
      await store.lock(); // should not throw
      const raw = (await readJsonFile(lockPath)) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    });

    it('overwrites a corrupt lock file (unreadable JSON) without throwing', async () => {
      await writeFile(lockPath, '{ not valid json', 'utf8');
      await store.lock(); // should not throw
      const raw = (await readJsonFile(lockPath)) as { pid: number };
      expect(raw.pid).toBe(process.pid);
    });
  });

  describe('unlock()', () => {
    it('removes the lock file', async () => {
      await store.lock();
      expect(await fileExists(lockPath)).toBe(true);
      await store.unlock();
      expect(await fileExists(lockPath)).toBe(false);
    });

    it('is idempotent — no-op when the lock file is already gone', async () => {
      expect(await fileExists(lockPath)).toBe(false);
      await store.unlock(); // should not throw
    });
  });

  describe('withLock()', () => {
    it('runs the function and releases the lock on success', async () => {
      const result = await store.withLock(async () => 42);
      expect(result).toBe(42);
      expect(await fileExists(lockPath)).toBe(false);
    });

    it('releases the lock even when the function throws', async () => {
      await expect(
        store.withLock(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await fileExists(lockPath)).toBe(false);
    });

    it('releases the lock even when the function throws a non-Error', async () => {
      await expect(
        store.withLock(async () => {
          throw 'string error';
        }),
      ).rejects.toBe('string error');
      expect(await fileExists(lockPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getStatePath() helper
  // -------------------------------------------------------------------------

  describe('getStatePath()', () => {
    it('returns ~/.linuxify/state.json based on LINUXIFY_HOME', () => {
      const p = getStatePath();
      expect(p).toBe(join(tmpDir, 'state.json'));
    });
  });

  // -------------------------------------------------------------------------
  // defaultState() helper
  // -------------------------------------------------------------------------

  describe('defaultState()', () => {
    it('returns a state that passes the StateSchema', () => {
      const result = StateSchema.safeParse(defaultState());
      expect(result.success).toBe(true);
    });

    it('stamps created_at and updated_at with fresh ISO timestamps', () => {
      const before = new Date().toISOString();
      const state: State = defaultState();
      const after = new Date().toISOString();
      expect(state.created_at >= before).toBe(true);
      expect(state.created_at <= after).toBe(true);
      expect(state.updated_at).toBe(state.created_at);
    });
  });
});
