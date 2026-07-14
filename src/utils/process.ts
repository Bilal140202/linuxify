/**
 * Process / environment / platform utilities.
 *
 * @module linuxify/utils/process
 *
 * Wraps `execa` for shell-out commands and exposes typed accessors for the
 * runtime environment (Termux detection, architecture, Android version).
 *
 * Conventions:
 *   - `exec` never throws on non-zero exit; callers inspect `exitCode`.
 *   - `execOrThrow` throws a `LinuxifyError` on non-zero exit, with the
 *     command, stdout, and stderr preserved on `details` for `--json` output.
 *   - No `process.exit` calls anywhere in this module. The CLI's top-level
 *     handler is the only place that exits.
 */

import { execa, type Options as ExecaOptions } from 'execa';

import { EXIT_CODES, LINUXIFY_HOME_DIRNAME, LINUXIFY_VERSION } from './constants.js';
import { LinuxifyError } from './errors.js';

/**
 * Result of an `execa` invocation. Mirrors the subset of fields the rest of
 * the codebase reads; intentionally narrow so callers don't reach into
 * execa internals.
 */
export interface ExecResult {
  /** The command's combined exit code. `0` means success; non-zero is a failure but not a throw. */
  readonly exitCode: number;
  /** Captured stdout (string, by default with trailing newline stripped by execa). */
  readonly stdout: string;
  /** Captured stderr (string). */
  readonly stderr: string;
  /** Whether the process failed to spawn or exited non-zero. */
  readonly failed: boolean;
  /** Whether the process was killed by a signal (e.g. SIGTERM). */
  readonly timedOut: boolean;
  /** The command that was run, joined for logging. */
  readonly command: string;
}

/**
 * Options accepted by {@link exec} and {@link execOrThrow}. These are a
 * superset of `execa.Options` plus Linuxify-specific conveniences.
 *
 * Both `timeout` (execa's native name) and `timeoutMs` (Linuxify's
 * canonical name) are accepted; if both are set, `timeoutMs` wins. New
 * code should prefer `timeoutMs` for consistency with `FetchOptions`.
 */
export interface ExecOptions extends ExecaOptions {
  /** Working directory for the child process. */
  readonly cwd?: string;
  /** Environment variables (merged with `process.env` unless `extendEnv: false`). */
  readonly env?: Record<string, string>;
  /** Timeout in milliseconds; the child is killed if it exceeds this. Alias for execa's `timeout`. */
  readonly timeoutMs?: number;
  /** Pipe stdin from the parent (default) or provide an explicit value. */
  readonly input?: string | Buffer;
}

/**
 * Run a command, capturing stdout/stderr without throwing on non-zero exit.
 *
 * Use this when the caller wants to inspect the exit code (e.g. for "is X
 * installed?" probes). Use {@link execOrThrow} when any non-zero exit is a
 * hard failure.
 *
 * @param cmd - The binary to invoke (e.g. `git`, `npm`, `proot-distro`).
 * @param args - Argument vector; each element is passed through unescaped.
 * @param opts - Optional {@link ExecOptions} (cwd, env, timeout, input).
 * @returns An {@link ExecResult} with stdout, stderr, and exitCode populated.
 */
export async function exec(
  cmd: string,
  args: readonly string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const { timeoutMs, ...rest } = opts;
  const execaOpts: Record<string, unknown> = { reject: false, ...rest };
  if (timeoutMs !== undefined) execaOpts.timeout = timeoutMs;
  const result = await execa(cmd, [...args], execaOpts as ExecaOptions);
  return {
    exitCode: result.exitCode ?? -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : String(result.stdout ?? ''),
    stderr: typeof result.stderr === 'string' ? result.stderr : String(result.stderr ?? ''),
    failed: result.failed,
    timedOut: result.timedOut === true,
    command: [cmd, ...args].join(' '),
  };
}

/**
 * Run a command and return its stdout (trimmed) on success, or throw a
 * `LinuxifyError` on non-zero exit. The thrown error's `details` carries
 * `{ command, args, exitCode, stdout, stderr }` so `--json` output can
 * surface the full failure context.
 *
 * @param cmd - The binary to invoke.
 * @param args - Argument vector.
 * @param opts - Optional {@link ExecOptions}.
 * @returns The trimmed stdout on success.
 * @throws {LinuxifyError} with code `E_EXEC_FAILED` and exit code 4 on non-zero exit.
 */
export async function execOrThrow(
  cmd: string,
  args: readonly string[] = [],
  opts: ExecOptions = {},
): Promise<string> {
  const result = await exec(cmd, args, opts);
  if (result.exitCode !== 0) {
    throw new LinuxifyError({
      code: 'E_EXEC_FAILED',
      message: `Command failed (exit ${result.exitCode}): ${result.command}`,
      exitCode: EXIT_CODES.STEP_FAILED,
      details: {
        command: result.command,
        args: [...args],
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    });
  }
  return result.stdout.trim();
}

/**
 * Read an environment variable, returning a default if unset or empty.
 *
 * @param name - Variable name (case-sensitive on POSIX).
 * @param defaultVal - Returned when the variable is unset or empty string.
 * @returns The variable value, or `defaultVal`.
 */
export function getEnv(name: string, defaultVal?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultVal ?? '';
  return v;
}

/**
 * Resolve the absolute path to the Linuxify home directory
 * (`~/.linuxify` by default; `LINUXIFY_HOME` overrides).
 *
 * The directory may not exist yet; callers should use `ensureDir` from
 * `fs.ts` before writing into it.
 *
 * @returns Absolute path to the Linuxify home directory.
 */
export function getLinuxifyHome(): string {
  const override = process.env.LINUXIFY_HOME;
  if (override && override.trim() !== '') return override;
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
  return `${home}/${LINUXIFY_HOME_DIRNAME}`;
}

/**
 * Resolve the Termux `$PREFIX` directory. Outside Termux this returns the
 * canonical Termux path (`/data/data/com.termux/files/usr`); callers that
 * care should gate on {@link isTermux}.
 *
 * @returns The Termux prefix path.
 */
export function getTermuxPrefix(): string {
  const prefix = process.env.PREFIX;
  if (prefix && prefix.trim() !== '') return prefix;
  return '/data/data/com.termux/files/usr';
}

/**
 * Detect whether the current process is running inside Termux.
 *
 * Heuristics, in order: presence of `TERMUX_VERSION` env var, presence of
 * `PREFIX` matching the Termux path, or `process.platform === 'android'`.
 *
 * @returns `true` if running in Termux.
 */
export function isTermux(): boolean {
  if (typeof process.env.TERMUX_VERSION !== 'undefined') return true;
  const prefix = process.env.PREFIX;
  if (prefix && prefix.includes('com.termux')) return true;
  return process.platform === 'android';
}

/**
 * Detect whether the host OS is Android (covers both Termux and a
 * hypothetical non-Termux Android shell).
 *
 * @returns `true` if `process.platform === 'android'`.
 */
export function isAndroid(): boolean {
  return process.platform === 'android';
}

/** Normalized CPU architecture. `unknown` if Node reports something we don't recognize. */
export type Arch = 'aarch64' | 'armv7l' | 'x86_64' | 'unknown';

/** Normalized OS/platform. Includes `android` even though Node reports `android` natively. */
export type Platform = 'android' | 'linux' | 'darwin' | 'win32';

/**
 * Normalize `process.arch` into the Linuxify-canonical form. Mapping:
 *   - `arm64` → `aarch64` (Linuxify uses the Linux kernel name, not Node's)
 *   - `arm`   → `armv7l`
 *   - `x64`   → `x86_64`
 *
 * @returns The normalized architecture, or `unknown` for unrecognized values.
 */
export function getArch(): Arch {
  switch (process.arch) {
    case 'arm64':
      return 'aarch64';
    case 'arm':
      return 'armv7l';
    case 'x64':
      return 'x86_64';
    default:
      return 'unknown';
  }
}

/**
 * Return the normalized platform. Wraps `process.platform` so callers don't
 * depend directly on the Node global.
 *
 * @returns The current platform.
 */
export function getPlatform(): Platform {
  switch (process.platform) {
    case 'android':
      return 'android';
    case 'linux':
      return 'linux';
    case 'darwin':
      return 'darwin';
    case 'win32':
      return 'win32';
    default:
      // Unknown platforms default to linux because Linuxify's whole purpose
      // is to run Linux tooling; on a host it doesn't recognize, treating
      // the host as linux is the least surprising fallback.
      return 'linux';
  }
}

/**
 * Read the Android version string via `getprop ro.build.version.release`,
 * if running inside Termux. Returns `null` outside Termux or if `getprop`
 * is unavailable.
 *
 * @returns The Android version (e.g. `13`, `14`) or `null`.
 */
export async function getAndroidVersion(): Promise<string | null> {
  if (!isTermux()) return null;
  try {
    const result = await exec('getprop', ['ro.build.version.release']);
    if (result.exitCode !== 0) return null;
    const v = result.stdout.trim();
    return v === '' ? null : v;
  } catch {
    return null;
  }
}

/**
 * Resolve a `Promise` after the given number of milliseconds. Implemented
 * with `setTimeout` (unref'd so it doesn't keep the event loop alive in
 * tests).
 *
 * @param ms - Milliseconds to wait.
 * @returns A `Promise` that resolves after `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Build the default User-Agent string for outbound HTTP requests.
 * Format: `linuxify/<version> (<platform> <arch>)`.
 *
 * @returns The User-Agent string.
 */
export function getDefaultUserAgent(): string {
  return `linuxify/${LINUXIFY_VERSION} (${getPlatform()} ${getArch()})`;
}
