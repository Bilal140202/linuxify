/**
 * Filesystem utilities.
 *
 * @module linuxify/utils/fs
 *
 * All I/O is `Promise`-based; no `*Sync` calls. Failures are wrapped in
 * {@link LinuxifyError} so callers get a consistent error type regardless of
 * the underlying `node:fs` failure mode.
 *
 * Atomic writes (`writeFile`, `writeJson`) use the temp-file-then-rename
 * pattern so a crash mid-write never leaves a half-written file at the
 * final path.
 */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants, type Stats, createReadStream, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LinuxifyError } from './errors.js';
import { getLinuxifyHome } from './process.js';

/** Permission mode for `~/.linuxify` and other sensitive directories. */
const PRIVATE_DIR_MODE = 0o700;

/** Permission mode for sensitive files (config, state, keys). */
const PRIVATE_FILE_MODE = 0o600;

/**
 * Read a text file as UTF-8.
 *
 * @param filePath - Absolute or relative path to the file.
 * @returns The file contents as a string.
 * @throws {LinuxifyError} with code `E_FS_READ_FAILED` if the read fails
 *   (including ENOENT), with the original error preserved on `cause`.
 */
export async function readFile(filePath: string): Promise<string> {
  try {
    return await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_READ_FAILED',
      message: `Failed to read file: ${filePath}`,
      details: { path: filePath },
      cause: err,
    });
  }
}

/**
 * Read a JSON file and parse it.
 *
 * @typeParam T - The expected shape of the parsed JSON.
 * @param filePath - Path to the JSON file.
 * @returns The parsed value, typed as `T`. The cast is unchecked; callers
 *   that need validation should run the result through a Zod schema.
 * @throws {LinuxifyError} with code `E_FS_READ_FAILED` if the read fails.
 * @throws {LinuxifyError} with code `E_JSON_PARSE_FAILED` if the file is not valid JSON.
 */
export async function readJson<T>(filePath: string): Promise<T> {
  const text = await readFile(filePath);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_JSON_PARSE_FAILED',
      message: `Failed to parse JSON from ${filePath}: ${(err as Error).message}`,
      details: { path: filePath },
      cause: err,
    });
  }
}

/**
 * Atomically write a string to a file.
 *
 * Writes to `<path>.<random>.tmp` first, then renames into place. On
 * failure the temp file is removed. The parent directory must exist; use
 * {@link ensureDir} first if in doubt.
 *
 * @param filePath - Destination path.
 * @param content - String content to write.
 * @returns Resolves when the rename has completed.
 * @throws {LinuxifyError} with code `E_FS_WRITE_FAILED` on any I/O error.
 */
export async function writeFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup; ignore errors.
    await fsp.unlink(tmpPath).catch(() => {});
    throw new LinuxifyError({
      code: 'E_FS_WRITE_FAILED',
      message: `Failed to write file: ${filePath}`,
      details: { path: filePath },
      cause: err,
    });
  }
}

/**
 * Atomically write a value as JSON (pretty-printed with 2-space indent).
 *
 * @param filePath - Destination path.
 * @param data - Value to serialize.
 * @returns Resolves when the write has completed.
 * @throws {LinuxifyError} with code `E_JSON_SERIALIZE_FAILED` if `JSON.stringify` throws.
 * @throws {LinuxifyError} with code `E_FS_WRITE_FAILED` if the write fails.
 */
export async function writeJson(filePath: string, data: unknown): Promise<void> {
  let text: string;
  try {
    text = JSON.stringify(data, null, 2);
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_JSON_SERIALIZE_FAILED',
      message: `Failed to serialize JSON for ${filePath}: ${(err as Error).message}`,
      details: { path: filePath },
      cause: err,
    });
  }
  await writeFile(filePath, text);
}

/**
 * Create a directory and all missing parents (`mkdir -p`). Mode `0700` so
 * `~/.linuxify` and its subdirs are private to the current user.
 *
 * @param dirPath - Directory to create. Idempotent: no error if it exists.
 * @returns Resolves when the directory exists.
 * @throws {LinuxifyError} with code `E_FS_MKDIR_FAILED` on failure.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fsp.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
    // Re-chmod: mkdir's `mode` is masked by umask; chmod ensures 0700 regardless.
    await fsp.chmod(dirPath, PRIVATE_DIR_MODE).catch(() => {});
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_MKDIR_FAILED',
      message: `Failed to create directory: ${dirPath}`,
      details: { path: dirPath },
      cause: err,
    });
  }
}

/**
 * Check whether a file or directory exists. Slightly safer than
 * `fs.access` because it never throws — returns `false` for any error
 * including EACCES.
 *
 * @param p - Path to check.
 * @returns `true` if the path exists, `false` otherwise.
 */
export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stat a path, wrapping `node:fs` errors in {@link LinuxifyError}.
 *
 * @param p - Path to stat.
 * @returns The `fs.Stats` object.
 * @throws {LinuxifyError} with code `E_FS_STAT_FAILED` on any error (including ENOENT).
 */
export async function stat(p: string): Promise<Stats> {
  try {
    return await fsp.stat(p);
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_STAT_FAILED',
      message: `Failed to stat: ${p}`,
      details: { path: p },
      cause: err,
    });
  }
}

/**
 * Change file/directory permissions.
 *
 * @param p - Path to chmod.
 * @param mode - Numeric mode (e.g. `0o755`).
 * @throws {LinuxifyError} with code `E_FS_CHMOD_FAILED` on failure.
 */
export async function chmod(p: string, mode: number): Promise<void> {
  try {
    await fsp.chmod(p, mode);
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_CHMOD_FAILED',
      message: `Failed to chmod ${p} to 0${mode.toString(8)}`,
      details: { path: p, mode },
      cause: err,
    });
  }
}

/**
 * Recursively delete a path. Never throws if the path is missing — that
 * counts as success. Wraps other failures in {@link LinuxifyError}.
 *
 * @param p - Path to delete (file, dir, or symlink).
 * @throws {LinuxifyError} with code `E_FS_RMRF_FAILED` on any failure other than ENOENT.
 */
export async function rmrf(p: string): Promise<void> {
  try {
    await fsp.rm(p, { recursive: true, force: true });
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_RMRF_FAILED',
      message: `Failed to remove ${p}`,
      details: { path: p },
      cause: err,
    });
  }
}

/**
 * Copy a file. Uses `node:fs.copyFile` (no shell-out to `cp`).
 *
 * @param src - Source path.
 * @param dst - Destination path.
 * @throws {LinuxifyError} with code `E_FS_COPY_FAILED` on failure.
 */
export async function copyFile(src: string, dst: string): Promise<void> {
  try {
    await fsp.copyFile(src, dst);
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_FS_COPY_FAILED',
      message: `Failed to copy ${src} -> ${dst}`,
      details: { src, dst },
      cause: err,
    });
  }
}

/**
 * Open a read stream for a file. Used by `sha256File` to hash large files
 * without loading them into memory.
 *
 * @param p - Path to read.
 * @returns A `fs.ReadStream`.
 */
export function readStream(p: string): ReturnType<typeof createReadStream> {
  return createReadStream(p);
}

/**
 * Resolve a path that may contain `~` (home directory) or `$VAR` / `${VAR}`
 * references. Both are expanded using the current process environment.
 *
 * - `~` at the start of the path expands to `os.homedir()`.
 * - `~user` syntax is not supported (only the bare `~`).
 * - `$VAR` and `${VAR}` are replaced with `process.env.VAR` (empty string if unset).
 *
 * @param p - The path to resolve.
 * @returns The expanded absolute path. If `p` is already absolute and
 *   contains no `$`, it is returned unchanged.
 *
 * @example
 *   resolvePath('~/.linuxify/config.toml'); // -> '/home/alice/.linuxify/config.toml'
 *   resolvePath('$PREFIX/bin/cline');        // -> '/data/data/com.termux/files/usr/bin/cline'
 */
export function resolvePath(p: string): string {
  let s = p;
  if (s.startsWith('~/')) {
    s = path.join(os.homedir(), s.slice(2));
  } else if (s === '~') {
    s = os.homedir();
  }
  // Expand ${VAR} and $VAR references.
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => process.env[name] ?? '');
  return s;
}

/**
 * Resolve the Linuxify logs directory (`<linuxifyHome>/logs`), creating it
 * if missing. Used by the logger.
 *
 * @returns Absolute path to the logs directory.
 */
export async function ensureLogsDir(): Promise<string> {
  const logsDir = path.join(getLinuxifyHome(), 'logs');
  await ensureDir(logsDir);
  return logsDir;
}
