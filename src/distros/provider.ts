/**
 * DistroProvider interface and registry.
 *
 * @module linuxify/distros/provider
 *
 * The `DistroProvider` interface is the contract every distro backend must
 * implement. It is the only seam through which the rest of Linuxify touches a
 * concrete distribution — bootstrap, launcher, doctor, patcher, and the
 * package installer all depend on this interface, never on `proot-distro`
 * directly. See `docs/20-adrs/adr-006-distro-provider-abstraction.md` for the
 * rationale (the abstraction is paid for now, even though v1 ships multiple
 * built-in providers, because the surface area that depends on "which distro
 * is installed" spans five subsystems).
 *
 * The interface is intentionally minimal: every method is async (every method
 * crosses the proot boundary, which is a process spawn), stateless (no held
 * file descriptors or background processes between calls), and side-effectful
 * only through its return value (no hidden global state). All persistent
 * state lives on disk under `~/.linuxify/distros/<name>/` and in
 * `~/.linuxify/state.json`.
 *
 * The registry is process-global and append-only within a single CLI
 * invocation: built-in providers are registered by `src/distros/index.ts` at
 * import time, and plugins may register additional providers via
 * {@link registerDistro} at load time. The registry never unregisters — a
 * process is short-lived, so staleness is not a concern.
 */

import { DistroError } from '../utils/errors.js';
import type { State } from '../state/index.js';

// ---------------------------------------------------------------------------
// Interface + options types
// ---------------------------------------------------------------------------

/**
 * The contract every distro backend must implement.
 *
 * Each method is async because every method crosses the proot boundary (a
 * process spawn). The provider is *stateless* in the sense that it holds no
 * open file descriptors or background processes between calls; all persistent
 * state lives on disk at `~/.linuxify/distros/<name>/` and in
 * `~/.linuxify/state.json`.
 *
 * Concrete implementations:
 * - {@link UbuntuProvider} (alias `ubuntu`)
 * - {@link DebianProvider} (alias `debian`)
 * - {@link ArchProvider} (alias `archlinux`)
 * - {@link AlpineProvider} (alias `alpine`)
 *
 * Custom providers may be registered at runtime via {@link registerDistro};
 * see `docs/05-bootstrap/distro-management.md` §7.
 */
export interface DistroProvider {
  /** Distro identifier, e.g. `ubuntu`, `debian`, `arch`, `alpine`, or a custom name. */
  readonly name: string;
  /** Human-readable name shown in `linuxify distros list`, e.g. `Ubuntu 24.04 LTS`. */
  readonly displayName: string;
  /** Default version installed when the caller omits `InstallOpts.version`. */
  readonly defaultVersion: string;
  /** CPU architectures this provider supports (Linuxify-canonical names). */
  readonly supportedArches: readonly string[];
  /** Minimum free storage (MB) required to install this distro. */
  readonly minStorageMb: number;

  /**
   * Return `true` if this distro is installed (i.e. the `installed` marker
   * file exists at `~/.linuxify/distros/<name>/installed`).
   */
  isInstalled(): Promise<boolean>;

  /**
   * Install the distro. Runs `proot-distro install <alias>` (which downloads
   * and extracts the rootfs), then writes the `installed` marker with the
   * install timestamp, version, arch, rootfs path, and a SHA-256 fingerprint
   * of the rootfs.
   *
   * @param opts - Install options (version, arch, mirror, progress callback).
   * @throws {DistroError} with code `E_DISTRO_INSTALL_FAILED` if proot-distro exits non-zero.
   */
  install(opts: InstallOpts): Promise<void>;

  /**
   * Uninstall the distro. Runs `proot-distro remove <alias>` and removes the
   * `installed` marker. Does not touch snapshots under
   * `~/.linuxify/snapshots/<name>/`.
   *
   * @throws {DistroError} with code `E_DISTRO_UNINSTALL_FAILED` if proot-distro exits non-zero.
   */
  uninstall(): Promise<void>;

  /**
   * Ensure the distro is "running". For proot-based providers this is a
   * no-op — proot has no persistent daemon; every `exec`/`shell` call enters
   * and exits proot independently. Kept in the interface for future
   * chroot/systemd-based providers where `start` brings up init.
   */
  start(): Promise<void>;

  /**
   * Stop any lingering proot processes bound to this distro. Best-effort:
   * proot processes are short-lived (one per `exec`/`shell` invocation), but
   * a hung `linuxify shell` left in another terminal can be killed here.
   */
  stop(): Promise<void>;

  /**
   * Execute a command inside the distro as the configured user (default
   * `linuxify`). The command is composed as `bash -c "<cmd> <args...>"` and
   * passed to `proot-distro login <alias> --user <user> -- bash -c "<cmd>"`.
   *
   * @param cmd - Binary to invoke (e.g. `apt-get`, `node`, `git`).
   * @param args - Argument vector; each element is joined into the bash `-c` string.
   * @param opts - Execution options (user, cwd, env, timeout).
   * @returns An {@link ExecResult} with stdout, stderr, and exitCode.
   * @throws {DistroError} with code `E_DISTRO_EXEC_FAILED` if proot-distro fails to spawn.
   */
  exec(cmd: string, args: string[], opts?: ExecOpts): Promise<ExecResult>;

  /**
   * Open an interactive shell inside the distro as the configured user.
   * Inherits stdio so the user's terminal is connected directly to the proot
   * login shell. Resolves only when the user exits the shell.
   *
   * @param opts - Shell options (user, cwd).
   * @throws {DistroError} with code `E_DISTRO_SHELL_FAILED` if proot-distro fails to spawn.
   */
  shell(opts?: ShellOpts): Promise<void>;

  /**
   * Return live information about the installed distro: version, arch,
   * install timestamp, rootfs path, rootfs SHA-256 fingerprint, and current
   * disk usage.
   *
   * @throws {DistroError} with code `E_DISTRO_NOT_INSTALLED` if the distro is not installed.
   */
  info(): Promise<DistroInfo>;

  /**
   * Run the distro's package-manager upgrade (e.g. `apt-get update &&
   * apt-get upgrade -y` for Ubuntu/Debian, `pacman -Syu` for Arch,
   * `apk update && apk upgrade` for Alpine).
   *
   * @throws {DistroError} with code `E_DISTRO_UPDATE_FAILED` if the upgrade exits non-zero.
   */
  update(): Promise<void>;

  /**
   * Take a tar+zstd snapshot of the rootfs at
   * `~/.linuxify/snapshots/<name>/<sanitized-name>.tar.zst`. The snapshot
   * captures the entire rootfs (filesystem, symlinks, ownership) at a point
   * in time and is restorable via {@link restore}.
   *
   * @param name - Snapshot name; sanitized to a filename-safe string.
   * @returns The absolute path of the created snapshot tarball.
   * @throws {DistroError} with code `E_DISTRO_SNAPSHOT_FAILED` if the snapshot fails.
   */
  snapshot(name: string): Promise<string>;

  /**
   * Restore a previously-taken snapshot. Replaces the current rootfs with
   * the snapshot's contents (extracts the tarball back to the rootfs
   * location). Any packages installed since the snapshot will be lost.
   *
   * @param snapshotPath - Absolute path to a `.tar.zst` snapshot tarball.
   * @throws {DistroError} with code `E_DISTRO_RESTORE_FAILED` if extraction fails.
   */
  restore(snapshotPath: string): Promise<void>;
}

/**
 * Options accepted by {@link DistroProvider.install}.
 */
export interface InstallOpts {
  /** Version to install; defaults to the provider's `defaultVersion`. */
  readonly version?: string;
  /** CPU arch; defaults to the host arch (first entry of `supportedArches` that matches). */
  readonly arch?: string;
  /** Mirror override; passed to proot-distro via `DISTRO_MIRROR_<ALIAS>` env var. */
  readonly mirror?: string;
  /** Progress callback; invoked with human-readable status messages. */
  readonly onProgress?: (msg: string) => void;
}

/**
 * Options accepted by {@link DistroProvider.exec}.
 */
export interface ExecOpts {
  /** User to run as inside the proot; defaults to `linuxify`. */
  readonly user?: string;
  /** Working directory inside the proot; passed via `--cwd`. */
  readonly cwd?: string;
  /** Environment variables to set inside the proot (`--env KEY=VALUE` per entry). */
  readonly env?: Record<string, string>;
  /** Hard timeout in milliseconds; the proot is killed if it exceeds this. */
  readonly timeoutMs?: number;
}

/**
 * Options accepted by {@link DistroProvider.shell}.
 */
export interface ShellOpts {
  /** User to log in as; defaults to `linuxify`. */
  readonly user?: string;
  /** Working directory at shell start; passed via `--cwd`. */
  readonly cwd?: string;
}

/**
 * Result of {@link DistroProvider.exec}. A narrow subset of the richer
 * `ExecResult` returned by `utils/process.exec` — only the three fields the
 * distro interface contract guarantees.
 */
export interface ExecResult {
  /** Captured stdout (execa strips the trailing newline by default). */
  readonly stdout: string;
  /** Captured stderr. */
  readonly stderr: string;
  /** Exit code; `0` means success. */
  readonly exitCode: number;
}

/**
 * Information about an installed distro, returned by {@link DistroProvider.info}.
 */
export interface DistroInfo {
  /** Distro identifier (matches {@link DistroProvider.name}). */
  readonly name: string;
  /** Installed version (e.g. `24.04`, `12`, `rolling`, `3.20`). */
  readonly version: string;
  /** CPU arch the rootfs was installed for (Linuxify-canonical name). */
  readonly arch: string;
  /** ISO timestamp the distro was installed (from the `installed` marker). */
  readonly installedAt: string;
  /** Absolute path to the rootfs directory (managed by proot-distro). */
  readonly rootfsPath: string;
  /** SHA-256 fingerprint of the rootfs (hex digest of `/etc/os-release`). */
  readonly rootfsSha256: string;
  /** Current on-disk size of the rootfs, in megabytes. */
  readonly diskUsageMb: number;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Internal registry map. Process-global; populated by `src/distros/index.ts`
 * at import time and by plugins via {@link registerDistro} at load time.
 *
 * Keys are distro names (lowercase); values are the provider instances.
 * Re-registering an existing name overwrites the prior entry — this is
 * intentional so plugins can replace a built-in provider if needed (e.g. a
 * custom Ubuntu build with a different default mirror).
 */
const REGISTRY = new Map<string, DistroProvider>();

/**
 * Register a distro provider. Re-registering an existing name overwrites the
 * prior entry (so plugins can override built-ins).
 *
 * @param provider - The provider instance to register. Its `name` is used as
 *   the registry key (case-sensitive).
 */
export function registerDistro(provider: DistroProvider): void {
  if (!provider.name) {
    throw new DistroError('Cannot register a distro with an empty name', {
      code: 'REGISTER_INVALID',
    });
  }
  REGISTRY.set(provider.name, provider);
}

/**
 * Look up a registered distro provider by name.
 *
 * @param name - Distro name (e.g. `ubuntu`).
 * @returns The registered provider.
 * @throws {DistroError} with code `E_DISTRO_NOT_FOUND` if no provider is
 *   registered under `name`.
 */
export function getDistro(name: string): DistroProvider {
  const provider = REGISTRY.get(name);
  if (!provider) {
    throw new DistroError(
      `Unknown distro '${name}'. Registered: ${REGISTRY.size === 0 ? '(none)' : Array.from(REGISTRY.keys()).join(', ')}.`,
      {
        code: 'NOT_FOUND',
        details: { requested: name, registered: Array.from(REGISTRY.keys()) },
        fixCommand: `linuxify distros install ${name}`,
      },
    );
  }
  return provider;
}

/**
 * List all registered distro providers. The order is insertion order, which
 * means built-ins appear first (in the order they were registered by
 * `src/distros/index.ts`) followed by any plugin-registered providers.
 *
 * @returns A frozen array of registered providers.
 */
export function listDistros(): DistroProvider[] {
  return Array.from(REGISTRY.values());
}

/**
 * Return the name of the active distro for a given state. Reads
 * `state.active_distro`; returns the empty string if no distro is active
 * (e.g. a fresh install that has not yet run `linuxify use <name>`).
 *
 * This function is pure: it does not consult the registry or the filesystem,
 * so a stale `active_distro` value in state does not throw here. Callers that
 * need a live provider should follow this with {@link getDistro} and handle
 * the `E_DISTRO_NOT_FOUND` if the recorded distro was uninstalled.
 *
 * @param state - The current Linuxify state.
 * @returns The active distro name, or `''` if none is set.
 */
export function getActiveDistroName(state: State): string {
  return state.active_distro ?? '';
}

/**
 * Clear the registry. Exported for tests so each test file can start with a
 * clean slate; not part of the public distros API surface.
 *
 * @internal
 */
export function _clearDistroRegistryForTests(): void {
  REGISTRY.clear();
}
