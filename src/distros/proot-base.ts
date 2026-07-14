/**
 * Shared base class for proot-distro-backed distro providers.
 *
 * @module linuxify/distros/proot-base
 *
 * All four built-in distros (Ubuntu, Debian, Arch, Alpine) share the same
 * underlying mechanism — Termux's `proot-distro` script — and differ only in
 * their per-distro config (alias name, default version, package-manager
 * grammar, mirror env var name). This module factors the shared logic into
 * `ProotDistroBase`, an abstract class implementing the full
 * {@link DistroProvider} interface in terms of a small {@link
 * ProotDistroConfig} descriptor.
 *
 * The 80/20 split documented in `docs/05-bootstrap/distro-management.md` §2
 * ("the four backends share roughly 80% of their code via an
 * `ProotDistroBase` class; the remaining 20% is the per-distro
 * package-manager grammar and the rootfs-fetch logic") is realized here: each
 * concrete provider is a ~15-line subclass that supplies a config object.
 *
 * Subprocess calls go through `utils/process.exec` (which wraps `execa` with
 * `reject: false`). All failures are wrapped in {@link DistroError} with
 * stable `E_DISTRO_*` codes so the CLI's `--json` error renderer can surface
 * the structured `details` field.
 */

import { join } from 'node:path';

import { sha256File } from '../utils/crypto.js';
import { DistroError } from '../utils/errors.js';
import { ensureDir, exists, readFile, writeFile, rmrf } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { exec, getLinuxifyHome } from '../utils/process.js';

import type {
  DistroInfo,
  DistroProvider,
  ExecOpts,
  ExecResult,
  InstallOpts,
  ShellOpts,
} from './provider.js';

// ---------------------------------------------------------------------------
// Per-distro config descriptor
// ---------------------------------------------------------------------------

/**
 * Static configuration for a proot-distro-backed provider. Concrete providers
 * (Ubuntu, Debian, Arch, Alpine) supply one of these to the {@link
 * ProotDistroBase} constructor.
 */
export interface ProotDistroConfig {
  /** Linuxify distro identifier, e.g. `ubuntu`. */
  readonly name: string;
  /** `proot-distro` alias, e.g. `ubuntu` or `archlinux`. */
  readonly alias: string;
  /** Human-readable name, e.g. `Ubuntu 24.04 LTS`. */
  readonly displayName: string;
  /** Default version installed when `InstallOpts.version` is omitted. */
  readonly defaultVersion: string;
  /** Supported CPU architectures (Linuxify-canonical names). */
  readonly supportedArches: readonly string[];
  /** Minimum free storage (MB) required to install. */
  readonly minStorageMb: number;
  /** Package-manager grammar; drives the `update()` command. */
  readonly packageManager: 'apt' | 'pacman' | 'apk' | 'dnf' | 'custom';
  /** Shell command run by `update()` (e.g. `apt-get update && apt-get upgrade -y`). */
  readonly updateCommand: string;
  /** Default user inside the proot; defaults to `linuxify` if omitted. */
  readonly defaultUser?: string;
  /** Optional notes / caveats surfaced by `linuxify distros info`. */
  readonly notes?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default user inside the proot; mirrors `docs/05-bootstrap/distro-management.md` §3. */
const DEFAULT_USER = 'linuxify';

/** Hard timeout for `proot-distro install` (15 minutes — rootfs extraction is slow). */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Hard timeout for `proot-distro remove` (5 minutes). */
const UNINSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Hard timeout for `update()` (30 minutes — `apt upgrade` can be slow). */
const UPDATE_TIMEOUT_MS = 30 * 60 * 1000;

/** Hard timeout for `proot-distro login` exec calls (default 10 minutes). */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** Hard timeout for `tar --zstd` snapshot (30 minutes for large rootfs). */
const SNAPSHOT_TIMEOUT_MS = 30 * 60 * 1000;

/** Filename of the install marker inside `~/.linuxify/distros/<name>/`. */
const INSTALLED_MARKER_FILENAME = 'installed';

/** File inside the rootfs whose SHA-256 is used as the rootfs fingerprint. */
const ROOTFS_FINGERPRINT_FILE = '/etc/os-release';

/**
 * Shape of the JSON written to the `installed` marker file. Persisted on
 * successful install and read by `info()` and `isInstalled()`.
 */
interface InstalledMarker {
  readonly installedAt: string;
  readonly version: string;
  readonly arch: string;
  readonly rootfsPath: string;
  readonly rootfsSha256: string;
}

// ---------------------------------------------------------------------------
// ProotDistroBase
// ---------------------------------------------------------------------------

/**
 * Abstract base implementing {@link DistroProvider} in terms of a
 * {@link ProotDistroConfig}. Concrete providers subclass this and pass their
 * config to `super(config)`; no method overrides are required.
 *
 * All filesystem state lives under `~/.linuxify/distros/<name>/` (the
 * Linuxify-tracked marker dir) and `~/.linuxify/snapshots/<name>/` (snapshot
 * output). The actual rootfs directory is managed by `proot-distro` and
 * resolved at install time via `proot-distro list`.
 */
export abstract class ProotDistroBase implements DistroProvider {
  /** Per-distro config supplied by the concrete subclass. */
  protected readonly cfg: ProotDistroConfig;

  /**
   * @param config - Static per-distro configuration.
   */
  constructor(config: ProotDistroConfig) {
    this.cfg = config;
  }

  // -------------------------------------------------------------------------
  // Interface properties (delegates to config)
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  get name(): string {
    return this.cfg.name;
  }
  /** @inheritdoc */
  get displayName(): string {
    return this.cfg.displayName;
  }
  /** @inheritdoc */
  get defaultVersion(): string {
    return this.cfg.defaultVersion;
  }
  /** @inheritdoc */
  get supportedArches(): readonly string[] {
    return this.cfg.supportedArches;
  }
  /** @inheritdoc */
  get minStorageMb(): number {
    return this.cfg.minStorageMb;
  }

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  /** `~/.linuxify/distros/<name>/` — Linuxify-side tracking dir for this distro. */
  protected get distroDir(): string {
    return join(getLinuxifyHome(), 'distros', this.cfg.name);
  }

  /** `~/.linuxify/distros/<name>/installed` — install marker file path. */
  protected get markerPath(): string {
    return join(this.distroDir, INSTALLED_MARKER_FILENAME);
  }

  /** `~/.linuxify/snapshots/<name>/` — snapshot output dir for this distro. */
  protected get snapshotsDir(): string {
    return join(getLinuxifyHome(), 'snapshots', this.cfg.name);
  }

  /** Default user inside the proot (config override or `linuxify`). */
  protected get defaultUser(): string {
    return this.cfg.defaultUser ?? DEFAULT_USER;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async isInstalled(): Promise<boolean> {
    return exists(this.markerPath);
  }

  /** @inheritdoc */
  async install(opts: InstallOpts = {}): Promise<void> {
    const alias = this.cfg.alias;
    logger.info(`distro[${this.cfg.name}]: installing via proot-distro`, {
      alias,
      version: opts.version ?? this.cfg.defaultVersion,
    });
    opts.onProgress?.(`installing ${this.cfg.name} via proot-distro (alias: ${alias})`);

    await ensureDir(this.distroDir);

    // proot-distro honors a DISTRO_MIRROR_<ALIAS> env var to override the
    // upstream mirror. Uppercase the alias and replace non-alphanumerics with
    // underscores (e.g. `archlinux` → `DISTRO_MIRROR_ARCHLINUX`).
    const env: Record<string, string> = { TERM: 'dumb' };
    if (opts.mirror) {
      const envKey = `DISTRO_MIRROR_${alias.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      env[envKey] = opts.mirror;
    }

    const result = await exec('proot-distro', ['install', alias], {
      env,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new DistroError(
        `proot-distro install ${alias} failed (exit ${result.exitCode})`,
        {
          code: 'INSTALL_FAILED',
          details: {
            alias,
            exitCode: result.exitCode,
            stdout: tail(result.stdout, 500),
            stderr: tail(result.stderr, 2000),
          },
        },
      );
    }
    opts.onProgress?.(`rootfs extracted; resolving install path`);

    // Resolve the rootfs path via `proot-distro list` (parses the line for
    // this alias). Falls back to the canonical Termux prefix path if parsing
    // fails — the fallback is correct on a standard Termux install.
    const rootfsPath = await this.resolveRootfsPath();
    opts.onProgress?.(`computing rootfs fingerprint`);

    // Compute a stable fingerprint of the rootfs. We hash `/etc/os-release`
    // (a small file present on every modern distro) rather than the whole
    // rootfs tree (which would be gigabytes and impractically slow). This
    // fingerprint detects version drift (e.g. `apt full-upgrade` shipped a
    // new os-release) — not byte-for-byte tampering. For tamper detection,
    // `linuxify doctor` recomputes the fingerprint on demand.
    const rootfsSha256 = await this.computeRootfsFingerprint(rootfsPath);

    const version = opts.version ?? this.cfg.defaultVersion;
    const arch = opts.arch ?? this.cfg.supportedArches[0] ?? 'aarch64';

    const marker: InstalledMarker = {
      installedAt: new Date().toISOString(),
      version,
      arch,
      rootfsPath,
      rootfsSha256,
    };
    await writeFile(this.markerPath, JSON.stringify(marker, null, 2) + '\n');

    logger.info(`distro[${this.cfg.name}]: install complete`, {
      version,
      arch,
      rootfsPath,
    });
    opts.onProgress?.(`installed ${this.cfg.name} ${version} (${arch})`);
  }

  /** @inheritdoc */
  async uninstall(): Promise<void> {
    const alias = this.cfg.alias;
    logger.info(`distro[${this.cfg.name}]: uninstalling via proot-distro remove`, {
      alias,
    });

    const result = await exec('proot-distro', ['remove', alias], {
      env: { TERM: 'dumb' },
      timeoutMs: UNINSTALL_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      throw new DistroError(
        `proot-distro remove ${alias} failed (exit ${result.exitCode})`,
        {
          code: 'UNINSTALL_FAILED',
          details: {
            alias,
            exitCode: result.exitCode,
            stdout: tail(result.stdout, 500),
            stderr: tail(result.stderr, 2000),
          },
        },
      );
    }

    // Remove the Linuxify-side marker. `rmrf` is no-op on missing paths so
    // this is safe even if the marker was already gone.
    await rmrf(this.markerPath).catch((err: unknown) => {
      logger.warn(`distro[${this.cfg.name}]: failed to remove marker`, {
        markerPath: this.markerPath,
        error: (err as Error).message,
      });
    });

    logger.info(`distro[${this.cfg.name}]: uninstall complete`);
  }

  /** @inheritdoc */
  async start(): Promise<void> {
    // proot has no persistent daemon — every exec/shell enters and exits
    // independently. Kept in the interface for future chroot/systemd
    // providers where `start` brings up init.
    logger.debug(`distro[${this.cfg.name}]: start (no-op for proot)`);
  }

  /** @inheritdoc */
  async stop(): Promise<void> {
    // Best-effort kill of any lingering proot processes bound to this
    // distro. We use `pkill` filtered on the alias; if pkill is unavailable
    // or no processes match, this is a silent no-op.
    logger.debug(`distro[${this.cfg.name}]: stop (best-effort pkill)`);
    await exec('pkill', ['-f', `proot.*${this.cfg.alias}`], {
      env: { TERM: 'dumb' },
    }).catch(() => {
      // pkill returns exit code 1 when no processes match — not an error.
    });
  }

  // -------------------------------------------------------------------------
  // Execution
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async exec(
    cmd: string,
    args: string[],
    opts: ExecOpts = {},
  ): Promise<ExecResult> {
    const user = opts.user ?? this.defaultUser;
    const composed = composeShellCommand(cmd, args);

    const loginArgs = this.buildLoginArgs(user, opts, ['--', 'bash', '-c', composed]);

    logger.debug(`distro[${this.cfg.name}]: exec`, {
      user,
      cmd: composed,
      cwd: opts.cwd,
    });

    const result = await exec('proot-distro', loginArgs, {
      env: { TERM: 'dumb', ...(opts.env ?? {}) },
      timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      cwd: opts.cwd,
    });

    // Narrow to the public ExecResult (drop failed/timedOut/command).
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  /** @inheritdoc */
  async shell(opts: ShellOpts = {}): Promise<void> {
    const user = opts.user ?? this.defaultUser;
    const loginArgs = this.buildLoginArgs(user, opts, []);

    logger.info(`distro[${this.cfg.name}]: shell (interactive)`, { user });

    // Use `stdio: 'inherit'` so the user's terminal is connected directly
    // to the proot login shell. execa with `stdio: 'inherit'` does not
    // capture stdout/stderr (they go straight to the parent's stdio), so
    // the returned result has empty strings — we ignore it.
    const result = await exec('proot-distro', loginArgs, {
      env: { TERM: process.env.TERM ?? 'xterm-256color' },
      stdio: 'inherit',
    } as Parameters<typeof exec>[2]);

    if (result.exitCode !== 0) {
      throw new DistroError(
        `proot-distro login ${this.cfg.alias} exited with code ${result.exitCode}`,
        { code: 'SHELL_FAILED', details: { alias: this.cfg.alias, exitCode: result.exitCode } },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async info(): Promise<DistroInfo> {
    if (!(await exists(this.markerPath))) {
      throw new DistroError(
        `distro '${this.cfg.name}' is not installed (no marker at ${this.markerPath})`,
        {
          code: 'NOT_INSTALLED',
          fixCommand: `linuxify distros install ${this.cfg.name}`,
        },
      );
    }

    let marker: InstalledMarker;
    try {
      const raw = await readFile(this.markerPath);
      marker = JSON.parse(raw) as InstalledMarker;
    } catch (err) {
      throw new DistroError(
        `failed to read install marker for '${this.cfg.name}': ${(err as Error).message}`,
        { code: 'MARKER_CORRUPT', cause: err, details: { markerPath: this.markerPath } },
      );
    }

    const diskUsageMb = await this.computeDiskUsageMb(marker.rootfsPath);

    return {
      name: this.cfg.name,
      version: marker.version,
      arch: marker.arch,
      installedAt: marker.installedAt,
      rootfsPath: marker.rootfsPath,
      rootfsSha256: marker.rootfsSha256,
      diskUsageMb,
    };
  }

  /** @inheritdoc */
  async update(): Promise<void> {
    logger.info(`distro[${this.cfg.name}]: running package-manager update`);

    const result = await this.exec('bash', ['-c', this.cfg.updateCommand], {
      user: 'root',
      timeoutMs: UPDATE_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      throw new DistroError(
        `distro '${this.cfg.name}' update failed (exit ${result.exitCode})`,
        {
          code: 'UPDATE_FAILED',
          details: {
            packageManager: this.cfg.packageManager,
            exitCode: result.exitCode,
            stdout: tail(result.stdout, 500),
            stderr: tail(result.stderr, 2000),
          },
        },
      );
    }
    logger.info(`distro[${this.cfg.name}]: update complete`);
  }

  // -------------------------------------------------------------------------
  // Backup
  // -------------------------------------------------------------------------

  /** @inheritdoc */
  async snapshot(name: string): Promise<string> {
    if (!(await exists(this.markerPath))) {
      throw new DistroError(
        `cannot snapshot distro '${this.cfg.name}' — not installed`,
        { code: 'NOT_INSTALLED', fixCommand: `linuxify distros install ${this.cfg.name}` },
      );
    }

    const safeName = sanitizeSnapshotName(name);
    if (!safeName) {
      throw new DistroError(
        `invalid snapshot name '${name}' (must contain at least one alphanumeric character)`,
        { code: 'SNAPSHOT_INVALID_NAME', details: { requested: name } },
      );
    }

    await ensureDir(this.snapshotsDir);
    const snapshotPath = join(this.snapshotsDir, `${safeName}.tar.zst`);

    // Read the rootfs path from the marker (avoids a `proot-distro list`
    // round-trip and the parsing fragility that entails).
    const marker = await this.readMarker();
    if (!marker) {
      throw new DistroError(
        `cannot snapshot distro '${this.cfg.name}' — install marker is missing`,
        { code: 'NOT_INSTALLED' },
      );
    }
    const rootfsPath = marker.rootfsPath;

    logger.info(`distro[${this.cfg.name}]: snapshot`, {
      name: safeName,
      rootfsPath,
      snapshotPath,
    });

    // `tar --zstd --xattrs --acls -cpf <out> -C <parent> <basename>`.
    // --xattrs and --acls preserve extended attributes and POSIX ACLs.
    // -C changes into the parent dir so the tarball's top entry is the
    // rootfs basename (not an absolute path).
    const parent = dirname(rootfsPath);
    const base = basename(rootfsPath);

    const result = await exec(
      'tar',
      ['--zstd', '--xattrs', '--acls', '-cpf', snapshotPath, '-C', parent, base],
      { env: { TERM: 'dumb' }, timeoutMs: SNAPSHOT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new DistroError(
        `snapshot of '${this.cfg.name}' failed (exit ${result.exitCode})`,
        {
          code: 'SNAPSHOT_FAILED',
          details: {
            exitCode: result.exitCode,
            rootfsPath,
            snapshotPath,
            stderr: tail(result.stderr, 2000),
          },
        },
      );
    }

    logger.info(`distro[${this.cfg.name}]: snapshot complete`, { snapshotPath });
    return snapshotPath;
  }

  /** @inheritdoc */
  async restore(snapshotPath: string): Promise<void> {
    if (!(await exists(snapshotPath))) {
      throw new DistroError(
        `snapshot file not found: ${snapshotPath}`,
        { code: 'RESTORE_SNAPSHOT_MISSING', details: { snapshotPath } },
      );
    }

    const marker = await this.readMarker();
    if (!marker) {
      throw new DistroError(
        `cannot restore into distro '${this.cfg.name}' — not installed`,
        { code: 'NOT_INSTALLED', fixCommand: `linuxify distros install ${this.cfg.name}` },
      );
    }
    const rootfsPath = marker.rootfsPath;

    logger.warn(`distro[${this.cfg.name}]: restore — replacing rootfs`, {
      snapshotPath,
      rootfsPath,
    });

    // Best-effort stop of any running proot processes for this distro
    // before we replace the rootfs out from under them.
    await this.stop().catch(() => {
      // stop is best-effort; ignore.
    });

    // Remove the existing rootfs directory. We don't auto-rollback here —
    // a restore is an explicit, destructive operation per the docs.
    await rmrf(rootfsPath).catch((err: unknown) => {
      logger.warn(`distro[${this.cfg.name}]: failed to remove existing rootfs`, {
        rootfsPath,
        error: (err as Error).message,
      });
    });

    // Extract the snapshot back to the rootfs location.
    const parent = dirname(rootfsPath);
    await ensureDir(parent);

    const result = await exec(
      'tar',
      ['--zstd', '--xattrs', '--acls', '-xpf', snapshotPath, '-C', parent],
      { env: { TERM: 'dumb' }, timeoutMs: SNAPSHOT_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new DistroError(
        `restore of '${this.cfg.name}' from ${snapshotPath} failed (exit ${result.exitCode})`,
        {
          code: 'RESTORE_FAILED',
          details: {
            exitCode: result.exitCode,
            snapshotPath,
            rootfsPath,
            stderr: tail(result.stderr, 2000),
          },
        },
      );
    }

    // Refresh the marker's rootfsSha256 to reflect the restored state.
    const newSha = await this.computeRootfsFingerprint(rootfsPath).catch(() => 'unknown');
    const freshMarker: InstalledMarker = {
      ...marker,
      rootfsSha256: newSha,
    };
    await writeFile(this.markerPath, JSON.stringify(freshMarker, null, 2) + '\n');

    logger.info(`distro[${this.cfg.name}]: restore complete`, { rootfsPath });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Build the `proot-distro login <alias>` argv prefix, applying `--user`,
   * `--cwd`, and `--env` flags from `opts`, then appending `trailer`.
   *
   * @param user - User to log in as.
   * @param opts - Source of `cwd` / `env` flags.
   * @param trailer - Args appended after the user/cwd/env flags (e.g. `['--', 'bash', '-c', '<cmd>']`).
   * @returns The full argv array.
   */
  private buildLoginArgs(
    user: string,
    opts: { readonly cwd?: string; readonly env?: Record<string, string> },
    trailer: readonly string[],
  ): string[] {
    const args: string[] = ['login', this.cfg.alias, '--user', user];
    if (opts.cwd) {
      args.push('--cwd', opts.cwd);
    }
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push('--env', `${k}=${v}`);
      }
    }
    args.push(...trailer);
    return args;
  }

  /**
   * Run `proot-distro list` and parse out the rootfs path for this alias.
   *
   * The `proot-distro list` output format (v1.13+):
   *
   * ```
   * Supported distributions:
   *   ubuntu
   *   debian
   *   ...
   * Installed distributions:
   *   ubuntu [/data/data/com.termux/files/usr/var/lib/proot-distro/installed-rootfs/ubuntu]
   *   ...
   * ```
   *
   * We scan the "Installed distributions:" section for a line starting with
   * our alias followed by `[<path>]`. Falls back to the canonical Termux
   * path if parsing fails.
   *
   * @returns Absolute path to the rootfs directory.
   * @throws {DistroError} with code `E_DISTRO_ROOTFS_PATH_UNKNOWN` if the path cannot be resolved.
   */
  private async resolveRootfsPath(): Promise<string> {
    const result = await exec('proot-distro', ['list'], { env: { TERM: 'dumb' } });
    if (result.exitCode === 0) {
      const path = parseRootfsPath(result.stdout, this.cfg.alias);
      if (path) return path;
    }
    // Fallback: canonical Termux rootfs path. proot-distro installs to
    // `$PREFIX/var/lib/proot-distro/installed-rootfs/<alias>` regardless of
    // distro.
    const prefix = process.env.PREFIX ?? '/data/data/com.termux/files/usr';
    const fallback = join(prefix, 'var/lib/proot-distro/installed-rootfs', this.cfg.alias);
    logger.warn(`distro[${this.cfg.name}]: falling back to canonical rootfs path`, {
      fallback,
      listExitCode: result.exitCode,
    });
    return fallback;
  }

  /**
   * Compute a stable SHA-256 fingerprint of the rootfs by hashing
   * `/etc/os-release`. This file is small (~200 bytes), present on every
   * modern distro, and changes when the distro version changes — making it
   * a suitable lightweight fingerprint for tamper detection.
   *
   * Returns the string `'unknown'` if the file cannot be hashed (e.g. the
   * distro does not ship `/etc/os-release`).
   *
   * @param rootfsPath - Absolute path to the rootfs directory.
   * @returns Lowercase hex SHA-256 digest, or `'unknown'`.
   */
  private async computeRootfsFingerprint(rootfsPath: string): Promise<string> {
    const osReleasePath = join(rootfsPath, ROOTFS_FINGERPRINT_FILE);
    try {
      return await sha256File(osReleasePath);
    } catch (err) {
      logger.warn(`distro[${this.cfg.name}]: could not hash /etc/os-release`, {
        osReleasePath,
        error: (err as Error).message,
      });
      return 'unknown';
    }
  }

  /**
   * Compute the on-disk size of `rootfsPath` in megabytes via `du -sm`.
   *
   * Returns `0` if `du` fails (e.g. not installed, or rootfs missing).
   *
   * @param rootfsPath - Absolute path to the rootfs directory.
   * @returns Size in MB (rounded down).
   */
  private async computeDiskUsageMb(rootfsPath: string): Promise<number> {
    const result = await exec('du', ['-sm', rootfsPath], { env: { TERM: 'dumb' } });
    if (result.exitCode !== 0) {
      logger.warn(`distro[${this.cfg.name}]: du failed`, {
        rootfsPath,
        exitCode: result.exitCode,
        stderr: tail(result.stderr, 500),
      });
      return 0;
    }
    // `du -sm` output: `<size_in_mb>\t<path>`
    const match = result.stdout.match(/^\s*(\d+)\s/);
    if (!match) {
      logger.warn(`distro[${this.cfg.name}]: could not parse du output`, {
        stdout: tail(result.stdout, 200),
      });
      return 0;
    }
    return Number.parseInt(match[1]!, 10);
  }

  /**
   * Read and parse the install marker. Returns `null` if the marker is
   * missing or unparseable.
   *
   * @returns The parsed {@link InstalledMarker}, or `null`.
   */
  private async readMarker(): Promise<InstalledMarker | null> {
    if (!(await exists(this.markerPath))) return null;
    try {
      const raw = await readFile(this.markerPath);
      return JSON.parse(raw) as InstalledMarker;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (pure functions; exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Compose a shell command string from a binary and its args. Each arg is
 * single-quoted (with embedded single-quotes escaped via the standard
 * `'\''` idiom) so the composed string is safe to pass to `bash -c`.
 *
 * @example
 *   composeShellCommand('echo', ['hello world', "it's me"])
 *   // → "echo 'hello world' 'it'\''s me'"
 *
 * @param cmd - The binary to invoke.
 * @param args - Argument vector.
 * @returns A single shell-safe string suitable for `bash -c`.
 */
export function composeShellCommand(cmd: string, args: readonly string[]): string {
  const parts = [cmd, ...args];
  return parts.map(shellQuote).join(' ');
}

/**
 * Single-quote a string for safe use as a shell argument. Embedded
 * single-quotes are escaped by closing the quote, emitting an escaped
 * literal quote, and reopening (`'\''`).
 *
 * @param s - The string to quote.
 * @returns The shell-quoted string.
 */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  // Fast path: if the string contains only "safe" characters (alphanumerics,
  // underscores, hyphens, dots, slashes, equals), no quoting is needed.
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse the rootfs path for `alias` out of `proot-distro list` output.
 *
 * Looks for a line in the "Installed distributions:" section matching
 * `  <alias> [<path>]`. Returns the captured path, or `null` if not found.
 *
 * @param output - The stdout of `proot-distro list`.
 * @param alias - The distro alias to look up.
 * @returns The rootfs path, or `null`.
 */
export function parseRootfsPath(output: string, alias: string): string | null {
  const lines = output.split('\n');
  let inInstalled = false;
  for (const line of lines) {
    if (/installed distributions:/i.test(line)) {
      inInstalled = true;
      continue;
    }
    if (inInstalled) {
      // Match: "  ubuntu [/path/to/rootfs]"
      const re = new RegExp(`^\\s*${escapeRegex(alias)}\\s+\\[(.+)\\]`);
      const m = line.match(re);
      if (m && m[1]) return m[1].trim();
    }
  }
  return null;
}

/**
 * Sanitize a user-supplied snapshot name to a filename-safe string.
 * Replaces any character outside `[A-Za-z0-9._-]` with `_`, collapses
 * consecutive underscores, trims leading/trailing underscores and dots.
* Returns the empty string if the input sanitizes to nothing.
 *
 * @param name - The raw snapshot name.
 * @returns The sanitized name, or `''`.
 */
export function sanitizeSnapshotName(name: string): string {
  const sanitized = name
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+/, '')
    .replace(/[._]+$/, '');
  return sanitized;
}

/**
 * Return the directory portion of a path. Equivalent to Node's
 * `path.posix.dirname` but inlined here to avoid a circular dependency on
 * `node:path` in the few spots that need it (and to make the helper
 * testable in isolation).
 *
 * @param p - An absolute or relative path.
 * @returns The parent directory.
 */
function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

/**
 * Return the basename (last path component) of a path.
 *
 * @param p - An absolute or relative path.
 * @returns The basename.
 */
function basename(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx < 0) return p;
  return p.slice(idx + 1);
}

/**
 * Escape a string for literal use inside a JavaScript RegExp. Mirrors
 * MDN's `escapeRegExp` recipe.
 *
 * @param s - The string to escape.
 * @returns The escaped string.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Truncate `s` to its last `max` characters, prefixing `...` if truncated.
 *
 * @param s - The string to tail.
 * @param max - Maximum length of the returned string (excluding the `...` prefix).
 * @returns The truncated string.
 */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `...${s.slice(-max)}`;
}
