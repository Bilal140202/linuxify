/**
 * StateStore — manages `~/.linuxify/state.json` with atomic writes, file
 * locking, and schema-validated typed access.
 *
 * ## Atomic writes
 *
 * `save()` serializes the state to a temp file `<path>.tmp.<pid>`,
 * `fsync`s it, then `rename`s it over the target. This guarantees that a
 * SIGKILL at any point leaves either the previous state or the new state —
 * never a half-written file (see system-architecture.md §4.2).
 *
 * ## File locking
 *
 * `lock()` writes `~/.linuxify/.lock` with the current PID. Before writing,
 * it checks whether a lock file already exists and, if so, whether the PID
 * recorded in it is still alive (`process.kill(pid, 0)`). A live PID causes
 * `E_STATE_LOCKED`; a dead PID (stale lock) is silently overwritten. The
 * lock file format is `{ pid: number, acquired_at: string }` JSON.
 *
 * ## Permissions
 *
 * `state.json` is written with mode `0600` because it contains
 * `telemetry.user_id` (a UUID that, while not secret, is personally
 * identifiable). The lock file is written with default permissions (it
 * contains only a PID and a timestamp).
 *
 * @packageDocumentation
 */

import { open, rename, unlink, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { LINUXIFY_VERSION } from '../utils/constants.js';
import { StateError } from '../utils/errors.js';
import { readJson, writeJson, ensureDir, exists, resolvePath } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome } from '../utils/process.js';

import { StateSchema, type State } from './schema.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Filesystem mode for `state.json` (owner read/write only). */
const STATE_FILE_MODE = 0o600;

/** Filename of the state file inside `~/.linuxify/`. */
const STATE_FILE_NAME = 'state.json';

/** Filename of the lock file inside `~/.linuxify/`. */
const LOCK_FILE_NAME = '.lock';

/** Current state schema version. */
const SCHEMA_VERSION = 1 as const;

/** Suggested fix command embedded in `E_STATE_CORRUPT` errors. */
const REPAIR_COMMAND = 'linuxify repair state';

// ---------------------------------------------------------------------------
// Lock file schema (internal — not part of state.json)
// ---------------------------------------------------------------------------

/** Zod schema for the `~/.linuxify/.lock` file payload. */
const LockFileSchema = z
  .object({
    pid: z.number().int().positive(),
    acquired_at: z.string(),
  })
  .strict();

/** Inferred type for {@link LockFileSchema}. */
type LockFile = z.infer<typeof LockFileSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the given PID is currently alive.
 *
 * Uses `process.kill(pid, 0)` — a signal-0 probe that succeeds if the process
 * exists and the caller has permission to signal it.
 *
 * - Success → alive.
 * - `ESRCH` (no such process) → dead.
 * - `EPERM` (operation not permitted) → alive but owned by another user
 *   (treated as alive conservatively so we never overwrite a lock we cannot
 *   verify is stale).
 * - Any other error → treated as alive (conservative).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM or any unexpected error — be conservative, treat as alive.
    return true;
  }
}

/**
 * Returns the default initial {@link State} for a fresh install.
 *
 * The default state has:
 * - `schema_version: 1`
 * - `linuxify_version` stamped with the current CLI version
 * - empty arrays for all install/patch/plugin lists
 * - `active_distro: ''` (no distro activated yet)
 * - `bootstrap_progress.current_stage: 0` (no bootstrap has run)
 * - `telemetry.enabled: false` (opt-in required)
 * - `last_doctor_run: null` (no doctor run yet)
 * - `created_at` / `updated_at` set to the current ISO timestamp
 *
 * Note: the default state is **not** written to disk by `load()` when the file
 * is missing — it is only returned in memory. Callers who want to persist it
 * must call `save()` explicitly.
 */
export function defaultState(): State {
  const now = new Date().toISOString();
  return {
    schema_version: SCHEMA_VERSION,
    linuxify_version: LINUXIFY_VERSION,
    active_distro: '',
    installed_distros: [],
    installed_runtimes: [],
    installed_packages: [],
    applied_patches: [],
    bootstrap_progress: {
      current_stage: 0,
      completed_stages: [],
      failed_stage: null,
      error: null,
      started_at: now,
      last_updated_at: now,
    },
    last_doctor_run: null,
    telemetry: {
      user_id: null,
      enabled: false,
      last_flush: null,
    },
    plugins: [],
    created_at: now,
    updated_at: now,
  };
}

/**
 * Returns the absolute path to `~/.linuxify/state.json`.
 *
 * Uses `getLinuxifyHome()` (which honors `LINUXIFY_HOME` for tests) and
 * resolves the result to an absolute path via `resolvePath`.
 */
export function getStatePath(): string {
  return resolvePath(join(getLinuxifyHome(), STATE_FILE_NAME));
}

// ---------------------------------------------------------------------------
// StateStore
// ---------------------------------------------------------------------------

/**
 * StateStore manages a single `state.json` file with atomic writes, file
 * locking, and schema-validated typed access.
 *
 * One `StateStore` instance is typically created per CLI invocation and
 * shared across subsystems via the command context. The store caches the
 * last-loaded state in memory so that `get()` is synchronous and free after
 * the first `load()`.
 */
export class StateStore {
  /** Absolute path to the `state.json` file managed by this store. */
  readonly statePath: string;

  /** Absolute path to the `.lock` file (sibling of {@link statePath}). */
  readonly lockPath: string;

  /** Cached state from the most recent `load()` or `save()` call. */
  private cachedState: State | null = null;

  /**
   * @param statePath Absolute path to the `state.json` file. The lock file is
   * derived as `dirname(statePath)/.lock` so that tests using a tmpdir get the
   * lock in the same tmpdir (not in the real `~/.linuxify/`).
   */
  constructor(statePath: string) {
    this.statePath = statePath;
    this.lockPath = join(dirname(statePath), LOCK_FILE_NAME);
  }

  /**
   * Reads and validates `state.json`.
   *
   * - If the file is missing, returns {@link defaultState} (without writing
   *   it to disk).
   * - If the file exists but is not valid JSON, throws `StateError` with code
   *   `E_STATE_CORRUPT` and `fixCommand: 'linuxify repair state'`.
   * - If the file exists and is valid JSON but fails schema validation,
   *   throws `StateError` with code `E_STATE_CORRUPT` (same fix command).
   * - Otherwise, caches and returns the parsed {@link State}.
   *
   * Does **not** acquire the lock — read-only commands can call `load()`
   * concurrently without blocking (see system-architecture.md §4.3).
   */
  async load(): Promise<State> {
    if (!(await exists(this.statePath))) {
      logger.debug({ path: this.statePath }, 'state.json missing — returning default state');
      const def = defaultState();
      this.cachedState = def;
      return def;
    }

    let raw: unknown;
    try {
      raw = await readJson(this.statePath);
    } catch (error) {
      throw new StateError(
        `state.json at ${this.statePath} is not valid JSON: ${(error as Error).message}`,
        { code: 'E_STATE_CORRUPT', fixCommand: REPAIR_COMMAND, cause: error },
      );
    }

    const result = StateSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      logger.warn({ path: this.statePath, issues }, 'state.json failed schema validation');
      throw new StateError(
        `state.json at ${this.statePath} failed schema validation: ${issues}`,
        { code: 'E_STATE_CORRUPT', fixCommand: REPAIR_COMMAND, cause: result.error },
      );
    }

    this.cachedState = result.data;
    logger.debug({ path: this.statePath }, 'state.json loaded');
    return result.data;
  }

  /**
   * Atomically writes `state` to `state.json`.
   *
   * Updates `state.updated_at` to the current ISO timestamp before writing.
   * The write is atomic: data is serialized to `<path>.tmp.<pid>`, `fsync`d,
   * then `rename`d over the target. The file is created with mode `0600`
   * (owner read/write only) because `state.json` may contain
   * `telemetry.user_id`.
   *
   * Does **not** acquire the lock — callers wrapping a read-modify-write
   * cycle should use {@link update} or {@link withLock} instead.
   */
  async save(state: State): Promise<void> {
    state.updated_at = new Date().toISOString();

    await ensureDir(dirname(this.statePath));

    const tmpPath = `${this.statePath}.tmp.${process.pid}`;
    const payload = JSON.stringify(state, null, 2) + '\n';

    try {
      const handle = await open(tmpPath, 'w', STATE_FILE_MODE);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmpPath, this.statePath);
      // `rename` preserves the temp file's mode (0600), but chmod explicitly
      // as belt-and-suspenders against umask surprises on exotic filesystems.
      await chmod(this.statePath, STATE_FILE_MODE);
    } catch (error) {
      // Best-effort cleanup of the temp file on any failure path.
      await unlink(tmpPath).catch(() => void 0);
      throw error;
    }

    this.cachedState = state;
    logger.debug({ path: this.statePath }, 'state.json saved atomically');
  }

  /**
   * Loads state, applies `updater` to mutate it in place, then saves.
   *
   * Acquires the lock for the duration of the load-mutate-save cycle, so
   * concurrent `update()` calls from other processes are serialized. Returns
   * the newly saved state.
   *
   * @example
   * ```ts
   * await store.update((state) => {
   *   state.installed_packages.push({ name: 'cline', ... });
   * });
   * ```
   */
  async update(updater: (state: State) => void): Promise<State> {
    return this.withLock(async () => {
      const state = await this.load();
      updater(state);
      await this.save(state);
      return state;
    });
  }

  /**
   * Returns the cached state from the most recent `load()` or `save()` call.
   *
   * @throws {StateError} with code `E_STATE_NOT_LOADED` if `load()` has not
   * been called yet (or `save()` has not been called since the store was
   * constructed).
   */
  get(): State {
    if (this.cachedState === null) {
      throw new StateError(
        `state has not been loaded yet; call load() before get() (path: ${this.statePath})`,
        { code: 'E_STATE_NOT_LOADED' },
      );
    }
    return this.cachedState;
  }

  /**
   * Acquires the state lock.
   *
   * If `~/.linuxify/.lock` already exists and the PID recorded in it is still
   * alive (checked via `process.kill(pid, 0)`), throws `StateError` with code
   * `E_STATE_LOCKED`. A stale lock (dead PID, corrupt lock file) is silently
   * overwritten.
   *
   * The lock file is written as `{ pid: <number>, acquired_at: <ISO string> }`
   * JSON via `writeJson` (not atomically — the stale-lock check above makes a
   * race-free write unnecessary for correctness).
   */
  async lock(): Promise<void> {
    if (await exists(this.lockPath)) {
      let existing: LockFile | null = null;
      try {
        const raw = await readJson(this.lockPath);
        const parsed = LockFileSchema.safeParse(raw);
        if (parsed.success) {
          existing = parsed.data;
        } else {
          logger.warn(
            { path: this.lockPath },
            'lock file is present but malformed — treating as stale',
          );
        }
      } catch (error) {
        logger.warn(
          { path: this.lockPath, error: (error as Error).message },
          'lock file is present but unreadable — treating as stale',
        );
      }

      if (existing !== null && isPidAlive(existing.pid)) {
        throw new StateError(
          `state is locked by live PID ${existing.pid}` +
            (existing.acquired_at ? ` (acquired at ${existing.acquired_at})` : ''),
          {
            code: 'E_STATE_LOCKED',
            fixCommand: `wait for PID ${existing.pid} to finish, or run: kill ${existing.pid}`,
          },
        );
      }

      if (existing !== null) {
        logger.info(
          { path: this.lockPath, pid: existing.pid },
          'overwriting stale state lock (recorded PID is no longer alive)',
        );
      }
    }

    await ensureDir(dirname(this.lockPath));
    const lockData: LockFile = {
      pid: process.pid,
      acquired_at: new Date().toISOString(),
    };
    await writeJson(this.lockPath, lockData);
    logger.debug({ path: this.lockPath, pid: process.pid }, 'state lock acquired');
  }

  /**
   * Releases the state lock by deleting `~/.linuxify/.lock`.
   *
   * Idempotent: if the lock file is already gone (e.g. a prior `unlock()` call
   * or an external `rm`), this is a no-op. Errors other than `ENOENT` are
   * rethrown.
   */
  async unlock(): Promise<void> {
    try {
      await unlink(this.lockPath);
      logger.debug({ path: this.lockPath }, 'state lock released');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Already gone — nothing to do.
        return;
      }
      throw error;
    }
  }

  /**
   * Acquires the lock, runs `fn`, and releases the lock in a `finally` block.
   *
   * Guarantees the lock is released even if `fn` throws. Returns whatever
   * `fn` returns.
   *
   * @example
   * ```ts
   * const result = await store.withLock(async () => {
   *   const state = await store.load();
   *   state.active_distro = 'debian';
   *   await store.save(state);
   *   return state.active_distro;
   * });
   * ```
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock();
    try {
      return await fn();
    } finally {
      await this.unlock();
    }
  }
}
