/**
 * Linuxify error hierarchy.
 *
 * @module linuxify/utils/errors
 *
 * Every error thrown by Linuxify extends {@link LinuxifyError}. The base
 * class carries the structured fields documented in
 * `docs/02-architecture/source-code-structure.md` §6 (code, message,
 * details, cause, fixCommand, docsUrl) plus an `exitCode` field that the
 * top-level CLI handler uses to pick the process exit code.
 *
 * The pattern is "throw, don't return error codes": a function that can
 * fail returns its success value; on failure it throws a LinuxifyError
 * subclass. The CLI's `main()` wraps dispatch in a `try/catch`, renders the
 * error to the user (human format by default, JSON under `--json`), and
 * exits with `error.exitCode`. Uncaught non-LinuxifyError exceptions are
 * reported as `E_INTERNAL_UNKNOWN` with exit code 70.
 *
 * Both the options-object form (`new BootstrapError(msg, { code, details })`)
 * and the legacy positional form (`new BootstrapError(msg, code, details,
 * cause, fixCommand, docsUrl)`) are accepted. New code should prefer the
 * options-object form; the positional form is supported so that subsystems
 * written against the source-code-structure doc continue to compile.
 */

import { EXIT_CODES } from './constants.js';

/**
 * Stable error-code string. Always starts with `E_` and follows the
 * `E_<SUBSYSTEM>_<DESCRIPTION>` convention (e.g. `E_PATCH_VERIFY_FAILED`).
 * Using a string literal (not an enum) means a `grep E_PATCH_VERIFY_FAILED`
 * across the codebase finds both the throw site and the test that asserts
 * it.
 */
export type ErrorCode = `E_${string}`;

/**
 * Options accepted by the {@link LinuxifyError} options-object constructor.
 * `code` and `message` are required so that every thrown error has a stable
 * identifier and a human-readable description; the remaining fields are
 * optional structured metadata.
 */
export interface LinuxifyErrorInit {
  /** Stable error code, e.g. `E_BOOTSTRAP_FDROID_REQUIRED`. Required. */
  readonly code: ErrorCode | string;
  /** Human-readable description of what failed. Required. */
  readonly message: string;
  /**
   * Process exit code to use. Defaults to {@link EXIT_CODES.GENERIC_ERROR}.
   * Subclasses override the default with their subsystem-specific value.
   */
  readonly exitCode?: number;
  /** Structured extra info surfaced in `--json` output. */
  readonly details?: unknown;
  /** Original error if this error wraps another (e.g. a network timeout). */
  readonly cause?: unknown;
  /** Suggested shell command the user can run to fix the issue. */
  readonly fixCommand?: string;
  /** Link to docs for more context. */
  readonly docsUrl?: string;
}

/**
 * Options accepted by subsystem-error constructors (e.g. {@link BootstrapError}).
 * `code` is optional here: if omitted, the subclass fills in a `*_GENERIC`
 * default; if provided without the `E_` prefix, the subclass prepends its
 * subsystem prefix (e.g. `FDROID_REQUIRED` → `E_BOOTSTRAP_FDROID_REQUIRED`).
 */
export interface SubsystemErrorOptions {
  /** Subsystem-specific code suffix; auto-prefixed if it lacks `E_`. */
  readonly code?: string;
  /** Override the subclass default exit code. */
  readonly exitCode?: number;
  /** Structured extra info surfaced in `--json` output. */
  readonly details?: unknown;
  /** Original error if this error wraps another. */
  readonly cause?: unknown;
  /** Suggested shell command the user can run to fix the issue. */
  readonly fixCommand?: string;
  /** Link to docs for more context. */
  readonly docsUrl?: string;
}

/**
 * Base class for every error thrown by Linuxify.
 *
 * Construct directly with a full {@link LinuxifyErrorInit} when no subsystem
 * subclass fits, or use one of the subclasses ({@link BootstrapError},
 * {@link PatcherError}, etc.) for known categories — the subclasses
 * auto-fill the code prefix and exit code.
 *
 * Both call styles are supported:
 *
 * ```ts
 * // Options-object form (preferred for new code):
 * throw new LinuxifyError({
 *   code: 'E_INTERNAL_UNKNOWN',
 *   message: 'unreachable',
 *   exitCode: 70,
 * });
 *
 * // Positional form (legacy, per source-code-structure.md §6):
 * throw new LinuxifyError('unreachable', 'E_INTERNAL_UNKNOWN');
 * ```
 */
export class LinuxifyError extends Error {
  /** Stable identifier, e.g. `E_BOOTSTRAP_FDROID_REQUIRED`. */
  readonly code: string;
  /** Numeric exit code; see {@link EXIT_CODES}. */
  readonly exitCode: number;
  /** Structured extra info for `--json` output. */
  readonly details?: unknown;
  /** Original error if this error wraps another. */
  readonly cause?: unknown;
  /** Suggested fix command, rendered as `Try: <fixCommand>`. */
  readonly fixCommand?: string;
  /** Link to docs, rendered as `Docs: <docsUrl>`. */
  readonly docsUrl?: string;

  /** Options-object constructor. */
  constructor(opts: LinuxifyErrorInit);
  /**
   * Positional constructor (legacy form, per source-code-structure.md §6).
   * `exitCode` cannot be set in this form; it defaults to
   * {@link EXIT_CODES.GENERIC_ERROR}. Use the options-object form to set
   * a custom exit code on a bare `LinuxifyError`.
   */
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    optsOrMessage: LinuxifyErrorInit | string,
    code?: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    const init: LinuxifyErrorInit =
      typeof optsOrMessage === 'string'
        ? {
            message: optsOrMessage,
            code: code ?? 'E_GENERIC',
            details,
            cause,
            fixCommand,
            docsUrl,
          }
        : optsOrMessage;
    super(init.message);
    this.name = new.target.name;
    this.code = normalizeErrorCode(init.code);
    this.exitCode = init.exitCode ?? EXIT_CODES.GENERIC_ERROR;
    this.details = init.details;
    this.cause = init.cause;
    this.fixCommand = init.fixCommand;
    this.docsUrl = init.docsUrl;
  }

  /**
   * Render this error as a JSON object suitable for `--json` output.
   *
   * @returns A plain object with `name`, `code`, `message`, `details`,
   *   `fixCommand`, `docsUrl`, and (if present) `cause` summary.
   */
  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      name: this.name,
      code: this.code,
      exitCode: this.exitCode,
      message: this.message,
    };
    if (this.details !== undefined) out.details = this.details;
    if (this.fixCommand !== undefined) out.fixCommand = this.fixCommand;
    if (this.docsUrl !== undefined) out.docsUrl = this.docsUrl;
    if (this.cause !== undefined) {
      out.cause =
        this.cause instanceof Error
          ? { name: this.cause.name, message: this.cause.message }
          : String(this.cause);
    }
    return out;
  }

  /**
   * Format this error for human-readable output. Includes the code, the
   * message, the suggested fix command (if any), and the docs link (if any).
   * The cause chain is appended on its own line.
   *
   * @returns A multi-line string starting with `<Name> [<code>]: <message>`.
   */
  toString(): string {
    const lines: string[] = [];
    lines.push(`${this.name} [${this.code}]: ${this.message}`);
    if (this.fixCommand) lines.push(`  Try: ${this.fixCommand}`);
    if (this.docsUrl) lines.push(`  Docs: ${this.docsUrl}`);
    if (this.cause instanceof Error && this.cause.message) {
      lines.push(`  Cause: ${this.cause.name}: ${this.cause.message}`);
    } else if (typeof this.cause === 'string' && this.cause) {
      lines.push(`  Cause: ${this.cause}`);
    }
    return lines.join('\n');
  }
}

/**
 * Internal base for subsystem errors. Not exported: callers use one of the
 * concrete subclasses ({@link BootstrapError}, {@link PatcherError}, …).
 *
 * Each subclass passes its `subsystemPrefix` (e.g. `BOOTSTRAP`) and
 * `defaultExitCode` to this constructor; the prefix is used to auto-fill the
 * `code` field when the caller omits it or passes a bare suffix.
 */
class SubsystemError extends LinuxifyError {
  /** Options-object form. */
  constructor(
    subsystemPrefix: string,
    defaultExitCode: number,
    message: string,
    opts?: SubsystemErrorOptions,
  );
  /** Positional (legacy) form. */
  constructor(
    subsystemPrefix: string,
    defaultExitCode: number,
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    subsystemPrefix: string,
    defaultExitCode: number,
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    const opts: SubsystemErrorOptions | undefined =
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode;
    super({
      code: resolveSubsystemCode(opts?.code, subsystemPrefix),
      message,
      exitCode: opts?.exitCode ?? defaultExitCode,
      details: opts?.details,
      cause: opts?.cause,
      fixCommand: opts?.fixCommand,
      docsUrl: opts?.docsUrl,
    });
  }
}

/**
 * Ensure a code string starts with `E_`. Callers may pass either a fully
 * qualified code (`E_FOO_BAR`) or a bare suffix (`FOO_BAR`); the latter is
 * prefixed to keep the public API forgiving.
 */
function normalizeErrorCode(code: string): string {
  return code.startsWith('E_') ? code : `E_${code}`;
}

/**
 * Resolve a subsystem-scoped code. If the caller already provided a fully
 * qualified code (`E_*`), it is used verbatim. If the caller provided a
 * bare suffix that already starts with the subsystem prefix (e.g.
 * `BOOTSTRAP_FDROID_REQUIRED`), only the leading `E_` is added. Otherwise
 * the subsystem prefix is prepended (e.g. `FDROID_REQUIRED` →
 * `E_BOOTSTRAP_FDROID_REQUIRED`). If the caller omitted `code` entirely, a
 * `E_<SUBSYSTEM>_GENERIC` default is used.
 */
function resolveSubsystemCode(code: string | undefined, subsystemPrefix: string): string {
  if (!code) return `E_${subsystemPrefix}_GENERIC`;
  if (code.startsWith('E_')) return code;
  if (code.startsWith(`${subsystemPrefix}_`)) return `E_${code}`;
  return `E_${subsystemPrefix}_${code}`;
}

/**
 * Bootstrap errors: failures during `linuxify init` (stages 0–8), rootfs
 * fetch, proot-distro install, runtime bring-up, PATH configuration.
 * Default exit code: {@link EXIT_CODES.STEP_FAILED} (4); override with
 * `exitCode: 10` (network) or `30` (proot missing) where appropriate.
 */
export class BootstrapError extends SubsystemError {
  /** Options-object form. */
  constructor(message: string, opts?: SubsystemErrorOptions);
  /** Positional (legacy) form: `(message, code, details?, cause?, fixCommand?, docsUrl?)`. */
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'BOOTSTRAP',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Distro-provider errors (rootfs corrupt, snapshot failed, switch failed). Default exit: 4. */
export class DistroError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'DISTRO',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/**
 * Runtime-provider errors (node/python/rust/go install or version mismatch).
 * Default exit: 4.
 */
export class RuntimeError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'RUNTIME',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/**
 * Package install / uninstall / upgrade errors. Default exit: 4; override
 * with `2` (not installed) or `5` (already installed) where appropriate.
 */
export class PackageError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'PACKAGE',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Patcher errors: malformed patch, verify failed, rollback failed. Default exit: 22. */
export class PatcherError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'PATCHER',
      EXIT_CODES.PATCH_INVALID,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Doctor errors: health-check engine failures. Default exit: 4. */
export class DoctorError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'DOCTOR',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Launcher errors: shim generation, removal, or `linuxify run` dispatch. Default exit: 8. */
export class LauncherError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'LAUNCHER',
      EXIT_CODES.LAUNCHER_MISSING,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Plugin loader / hook dispatch errors. Default exit: 4. */
export class PluginError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'PLUGIN',
      EXIT_CODES.STEP_FAILED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Registry errors: index fetch, signature verification, cache miss. Default exit: 26. */
export class RegistryError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'REGISTRY',
      EXIT_CODES.REGISTRY_ERROR,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Config errors: schema validation, parse failure. Default exit: 24. */
export class ConfigError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'CONFIG',
      EXIT_CODES.CONFIG_INVALID,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** State errors: `state.json` / `manifest.json` corruption, lock failure. Default exit: 25. */
export class StateError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'STATE',
      EXIT_CODES.STATE_CORRUPT,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/**
 * Telemetry errors. Usually silent (telemetry must never block the CLI):
 * the queue logs at `debug` and drops the event. Exit code 28 is reserved
 * for the rare case where telemetry failure must be surfaced (e.g. an
 * explicit `linuxify telemetry flush` subcommand).
 */
export class TelemetryError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'TELEMETRY',
      EXIT_CODES.TELEMETRY_DISABLED,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Security errors: signature verification, key derivation, encrypt/decrypt. Default exit: 27. */
export class SecurityError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'SECURITY',
      EXIT_CODES.SIGNATURE_INVALID,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Network errors: unreachable host, timeout, HTTP 5xx. Default exit: 10. */
export class NetworkError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'NETWORK',
      EXIT_CODES.NETWORK_ERROR,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/** Storage errors: insufficient disk, write failure. Default exit: 20. */
export class StorageError extends SubsystemError {
  constructor(message: string, opts?: SubsystemErrorOptions);
  constructor(
    message: string,
    code: string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  );
  constructor(
    message: string,
    optsOrCode?: SubsystemErrorOptions | string,
    details?: unknown,
    cause?: unknown,
    fixCommand?: string,
    docsUrl?: string,
  ) {
    super(
      'STORAGE',
      EXIT_CODES.STORAGE_FULL,
      message,
      typeof optsOrCode === 'string'
        ? { code: optsOrCode, details, cause, fixCommand, docsUrl }
        : optsOrCode,
    );
  }
}

/**
 * Convert an unknown caught value into a {@link LinuxifyError}. If the value
 * is already a LinuxifyError, it is returned unchanged (so callers can
 * `throw wrapError(err, 'E_FOO')` without clobbering structured info). If it
 * is a plain `Error`, the message and stack are preserved on `cause`. If it
 * is a string or anything else, it is stringified.
 *
 * @param err - The caught value (typically from a `try/catch`).
 * @param code - The error code to assign if `err` is not already a LinuxifyError.
 * @param message - Optional override message; defaults to `err.message` or `String(err)`.
 * @returns A LinuxifyError suitable for re-throwing or logging.
 *
 * @example
 *   try {
 *     await risky();
 *   } catch (e) {
 *     throw wrapError(e, 'E_REGISTRY_TIMEOUT', 'failed to fetch package index');
 *   }
 */
export function wrapError(err: unknown, code: string, message?: string): LinuxifyError {
  if (err instanceof LinuxifyError) return err;
  let msg: string;
  if (message) {
    msg = message;
  } else if (err instanceof Error) {
    msg = err.message;
  } else if (typeof err === 'string') {
    msg = err;
  } else if (err === null) {
    msg = 'null';
  } else if (err === undefined) {
    msg = 'undefined';
  } else {
    // For arbitrary objects, JSON.stringify gives a more useful message than
    // '[object Object]'. If it fails (circular refs), fall back to String.
    try {
      msg = JSON.stringify(err);
    } catch {
      msg = String(err);
    }
  }
  return new LinuxifyError({
    code,
    message: msg,
    exitCode: EXIT_CODES.GENERIC_ERROR,
    cause: err,
  });
}

/**
 * Type-guard: returns true if the value is a {@link LinuxifyError}.
 * Useful in `catch` blocks where the value is typed as `unknown`.
 */
export function isLinuxifyError(err: unknown): err is LinuxifyError {
  return err instanceof LinuxifyError;
}
