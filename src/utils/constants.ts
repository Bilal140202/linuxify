/**
 * Project-wide constants for Linuxify.
 *
 * @module linuxify/utils/constants
 *
 * This module is intentionally dependency-free (only Node built-ins allowed)
 * so that every other module can import from it without creating a cycle.
 * Constants here are stable for the v1 release; renaming or removing one is
 * a breaking change and requires a major version bump.
 */

/**
 * The Linuxify CLI version string. Must match the `version` field in
 * `package.json`. Embedded here so that the runtime can report its version
 * without reading `package.json` at runtime (which is fragile under bundlers).
 */
export const LINUXIFY_VERSION = '0.1.0-alpha.1';

/**
 * Directory name (relative to the user's home) where Linuxify keeps all of
 * its state, distros, runtimes, packages, logs, and cache.
 *
 * The absolute path is computed by {@link getLinuxifyHome} in `process.ts`
 * (honoring `LINUXIFY_HOME` as an override).
 */
export const LINUXIFY_HOME_DIRNAME = '.linuxify';

/** Default distro selected when the user runs `linuxify init` without `--distro`. */
export const DEFAULT_DISTRO = 'ubuntu';

/** Default runtime selected when the user runs `linuxify init` without `--runtime`. */
export const DEFAULT_RUNTIME = 'node';

/**
 * Built-in distro backends shipped with v1. Plugin-registered distros are
 * appended to this list at runtime; this constant is only the compiled-in set.
 */
export const SUPPORTED_DISTROS = ['ubuntu', 'debian', 'arch', 'alpine'] as const;

/** Built-in runtime backends shipped with v1. */
export const SUPPORTED_RUNTIMES = ['node', 'python', 'rust', 'go'] as const;

/**
 * CPU architectures Linuxify supports on Android hosts. `armv7l` is
 * best-effort (some packages may lack arm32 binaries); `aarch64` is primary.
 */
export const SUPPORTED_ARCHS = ['aarch64', 'armv7l', 'x86_64'] as const;

/**
 * Below this many megabytes free in `~/.linuxify/`, the CLI emits a warning
 * but continues. Mirrors the value in `cli-specification.md` §6 / doctor.
 */
export const STORAGE_WARNING_MB = 5120;

/**
 * Hard stop: below this many megabytes free, Linuxify refuses to start any
 * install or update step (rootfs downloads alone can exceed 1 GB).
 */
export const STORAGE_HARD_STOP_MB = 10240;

/**
 * Canonical exit-code table for Linuxify v1. Keys are symbolic names; values
 * are the numeric exit codes the CLI returns to the shell.
 *
 * This is the authoritative list used by `LinuxifyError.exitCode` and the
 * CLI's top-level error handler. Codes 0–9 mirror the v1 CLI spec §6;
 * codes 20–31 cover Linuxify-specific failures (storage, version, patch,
 * config, registry, security, network, telemetry, migration, proot, rootfs).
 *
 * Note: a small number of names below (`STATE_CORRUPT`, `REGISTRY_ERROR`,
 * `SIGNATURE_INVALID`, `MIGRATION_FAILED`, `PROOT_NOT_FOUND`) generalize the
 * narrower sysexits-style names that appear in `cli-specification.md` §6
 * (e.g. `CONFIG_PARSE_ERROR`, `SIGNATURE_FAILED`, `MIGRATION_FAILED`).
 * Subsystem code uses the broader names here; the CLI's error-renderer maps
 * them back to the spec names when emitting `--json` output. Code 29
 * (`MIGRATION_FAILED`) is reserved for v1.1 self-update migrations and is
 * included here so the type union compiles today.
 */
export const EXIT_CODES = {
  /** Success. */
  OK: 0,
  /** Failure not covered by a more specific code. */
  GENERIC_ERROR: 1,
  /** Package, distro, file, or config key not found. */
  NOT_FOUND: 2,
  /** Environment not initialized; run `linuxify init`. */
  ENV_NOT_READY: 3,
  /** An install/patch/repair step failed. */
  STEP_FAILED: 4,
  /** Package already installed; use `--force`. */
  ALREADY_INSTALLED: 5,
  /** Uninstall step failed; partial removal. */
  UNINSTALL_FAILED: 6,
  /** Could not enter proot. Usually a Termux/Android issue. */
  PROOT_ENTER_FAILED: 7,
  /** Launcher shim absent; rerun `linuxify patch <pkg>`. */
  LAUNCHER_MISSING: 8,
  /** Backup file missing or failed checksum. */
  BACKUP_CORRUPT: 9,
  /** Network unreachable or registry returned an error. */
  NETWORK_ERROR: 10,
  /** Insufficient disk space in `~/.linuxify/`. */
  STORAGE_FULL: 20,
  /** Package requires a newer Linuxify. */
  VERSION_INCOMPAT: 21,
  /** Patch definition is malformed. */
  PATCH_INVALID: 22,
  /** Idempotent re-patch; with `--revert`, nothing to undo. */
  PATCH_ALREADY_APPLIED: 23,
  /** Config key value failed schema validation. */
  CONFIG_INVALID: 24,
  /** State file (`state.json` / `manifest.json`) is corrupt. */
  STATE_CORRUPT: 25,
  /** Registry returned an error or is unreachable. */
  REGISTRY_ERROR: 26,
  /** Package signature verification failed. */
  SIGNATURE_INVALID: 27,
  /** Informational; telemetry disabled, emitted to stderr only. */
  TELEMETRY_DISABLED: 28,
  /** Self-update migration rolled back. */
  MIGRATION_FAILED: 29,
  /** proot binary missing; install with `pkg install proot`. */
  PROOT_NOT_FOUND: 30,
  /** Distro rootfs failed integrity check; rerun `linuxify use --create`. */
  ROOTFS_CORRUPT: 31,
} as const;

/** Union of all exit-code symbolic names (keys of {@link EXIT_CODES}). */
export type ExitCodeName = keyof typeof EXIT_CODES;

/** Union of all numeric exit-code values. */
export type ExitCodeValue = (typeof EXIT_CODES)[ExitCodeName];

/**
 * Field-name patterns that the logger redacts from every log record before
 * writing to stdout or to the on-disk log file. Each entry is a `pino`-style
 * redact path: `*token*` matches any key containing `token` at any depth.
 *
 * Extend this list as new sensitive field names appear in the codebase.
 * Never log raw `Authorization`, `Cookie`, `LINUXIFY_TOKEN`, etc.
 */
export const REDACT_PATTERNS = [
  '*token*',
  '*secret*',
  '*key*',
  '*password*',
  '*passwd*',
  'authorization',
  'cookie',
  '*api_key*',
  '*apikey*',
  '*bearer*',
];

/** Default User-Agent prefix used by all outbound HTTP requests. */
export const HTTP_USER_AGENT_PREFIX = 'linuxify';

/** Default timeout (ms) for `isReachable` HEAD probes. */
export const DEFAULT_REACHABILITY_TIMEOUT_MS = 5000;

/** Default request timeout (ms) for `fetchJson` and `download`. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30000;

/** Buffer size (bytes) for streaming downloads; throttles progress callbacks. */
export const DOWNLOAD_CHUNK_SIZE = 64 * 1024;
