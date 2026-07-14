/**
 * RuntimeProvider interface and registry.
 *
 * @module linuxify/runtimes/provider
 *
 * Defines the pluggable runtime abstraction (Node, Python, Rust, Go, …) and a
 * module-level registry for runtime lookup by name. The interface is the
 * runtime-side companion to `DistroProvider`; the two are deliberately
 * symmetric in shape (see ADR-007).
 *
 * ## Per-distro scoping
 *
 * Every method takes a `distro: string` argument so that a single provider
 * instance can manage runtimes across multiple distros. Per
 * `docs/06-launcher/runtime-management.md` §5, runtimes are **not shared
 * across distros** — a Node install in Ubuntu is distinct from one in Debian.
 * The same Node version installed in both occupies ~160 MB total (80 MB per
 * distro); this is the trade-off for the ABI-correctness guarantee.
 *
 * ## Decoupling from proot
 *
 * Providers do not call `proot-distro` directly. Instead they call the
 * injected {@link DistroExecFn}, which the runtime index wires up to a real
 * proot invocation in production (via {@link createDefaultDistroExec}) and to
 * a stub in tests. This keeps the provider code unit-testable without a real
 * Android/Termux host and avoids a hard dependency on the parallel-built
 * `distros/` subsystem (which would create a circular import).
 *
 * ## State integration
 *
 * The provider mutates `state.json`'s `installed_runtimes` array via the
 * helpers {@link upsertRuntimeInstall}, {@link removeRuntimeInstall}, and
 * {@link markDefaultRuntime}. Callers wrap a read-modify-write cycle in
 * `StateStore.update()` so concurrent CLI invocations are serialized.
 *
 * @packageDocumentation
 */

import type { State } from '../state/schema.js';
import { RuntimeError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import { exec as execProcess } from '../utils/process.js';


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link RuntimeProvider.exec}.
 *
 * Mirrors the subset of `utils/process.ts`'s `ExecOptions` that is meaningful
 * inside a proot session. `cwd` is best-effort: proot-distro may ignore it
 * depending on the login flags used by the injected {@link DistroExecFn}.
 */
export interface ExecOpts {
  /** Working directory for the child process inside the proot session. */
  readonly cwd?: string;
  /** Environment variables to set in the proot session. */
  readonly env?: Record<string, string>;
  /** Timeout in milliseconds; the proot login is killed if it exceeds this. */
  readonly timeoutMs?: number;
}

/**
 * Result of a {@link RuntimeProvider.exec} invocation. Intentionally narrow
 * (just stdout, stderr, exitCode) so callers don't depend on execa internals.
 */
export interface ExecResult {
  /** Captured stdout (string, no trailing-newline normalization). */
  readonly stdout: string;
  /** Captured stderr (string). */
  readonly stderr: string;
  /** Process exit code; `0` means success. */
  readonly exitCode: number;
}

/**
 * Options accepted by {@link RuntimeProvider.install}. The progress callback
 * lets the CLI surface human-readable status messages without coupling the
 * provider to a specific UI.
 */
export interface InstallOpts {
  /**
   * Progress callback, invoked with human-readable status messages such as
   * `"adding NodeSource apt repository"` or `"installing nodejs (lts)"`.
   * Called zero or more times during install.
   */
  readonly onProgress?: (msg: string) => void;
}

/**
 * Record of an installed runtime version, scoped to a distro. Mirrors the
 * `RuntimeInstall` shape persisted in `state.json`'s `installed_runtimes`
 * array (see `src/state/schema.ts`), exposed under a runtime-subsystem name.
 */
export interface InstalledRuntime {
  /** Runtime name (e.g. `node`, `python`). */
  readonly name: string;
  /** Resolved version string (e.g. `22.11.0`, `3.12.3`). */
  readonly version: string;
  /** Distro name (e.g. `ubuntu`). */
  readonly distro: string;
  /** Absolute path (inside the distro rootfs) to the runtime binary. */
  readonly path: string;
  /** ISO timestamp at which the runtime was installed. */
  readonly installedAt: string;
  /** Whether this version is the default for its runtime name in this distro. */
  readonly isDefault: boolean;
}

// ---------------------------------------------------------------------------
// DistroExec injection
// ---------------------------------------------------------------------------

/**
 * Signature of the "execute inside distro" function injected into every
 * runtime provider. Production wiring (in `runtimes/index.ts`) builds this
 * from `proot-distro login` via {@link createDefaultDistroExec}; tests stub
 * it with a recorder that returns canned responses.
 *
 * The function is expected to:
 *   - Run `cmd` with `args` as a non-interactive command inside the named
 *     distro's proot session.
 *   - Not throw on non-zero exit; instead return an {@link ExecResult} with
 *     the captured `exitCode`.
 *   - Honor `opts.timeoutMs` by killing the proot session if exceeded.
 *
 * @param distro - Distro name (e.g. `ubuntu`).
 * @param cmd - Binary to invoke, as resolved inside the proot rootfs. May be
 *   a bare name (resolved via PATH inside the proot) or an absolute path.
 * @param args - Argument vector; each element is passed through unescaped.
 * @param opts - Optional {@link ExecOpts}.
 * @returns An {@link ExecResult} with stdout, stderr, and exitCode populated.
 */
export type DistroExecFn = (
  distro: string,
  cmd: string,
  args: readonly string[],
  opts?: ExecOpts,
) => Promise<ExecResult>;

// ---------------------------------------------------------------------------
// RuntimeProvider interface
// ---------------------------------------------------------------------------

/**
 * A pluggable runtime backend (Node, Python, Rust, Go, …).
 *
 * Implementations live in `src/runtimes/<name>.ts` and register themselves
 * with the module-level registry (see {@link registerRuntime}). The CLI
 * looks providers up by name via {@link getRuntime}.
 *
 * Every method takes a `distro` argument; a single provider instance can
 * manage runtimes across multiple distros. State (`state.json`'s
 * `installed_runtimes`) is keyed by `(name, distro, version)`.
 *
 * Concurrency: providers are stateless beyond the injected `distroExec` and
 * `stateStore`; the same instance may be called concurrently from different
 * async contexts. State mutations go through `StateStore.update()` which
 * acquires the state lock.
 */
export interface RuntimeProvider {
  /** Runtime identifier (e.g. `node`, `python`, `rust`, `go`). */
  readonly name: string;
  /** Human-readable label (e.g. `Node.js`). */
  readonly displayName: string;
  /** Default version spec (e.g. `lts`, `stable`, `3.12`). */
  readonly defaultVersion: string;
  /** Version specs this provider can install (e.g. `['lts', '20', '22']`). */
  readonly supportedVersions: readonly string[];

  /**
   * Whether the given version is currently installed in the distro.
   *
   * "Installed" means the binary exists and reports a compatible version
   * when invoked with `--version`. The check is performed by running the
   * binary inside the proot session via {@link DistroExecFn}, not by
   * consulting `state.json` (which can drift if the user runs `apt remove`
   * directly).
   *
   * @param version - Version spec (e.g. `22`, `22.11.0`, `lts`).
   * @param distro - Distro name.
   * @returns `true` if a matching install is present.
   */
  isInstalled(version: string, distro: string): Promise<boolean>;

  /**
   * Install the given version into the distro.
   *
   * Idempotent: if the version is already installed, this is a no-op (logged
   * at `debug`). On success, updates `state.json`'s `installed_runtimes`
   * array; if this is the first install of this runtime name in this distro,
   * marks it as the default.
   *
   * @param version - Version spec to install.
   * @param distro - Distro name.
   * @param opts - Optional {@link InstallOpts} (progress callback).
   * @throws {RuntimeError} with code `E_RUNTIME_INSTALL_FAILED` on apt /
   *   rustup / download failure. The error's `details` carries the failing
   *   command, exit code, and captured stdout/stderr.
   */
  install(version: string, distro: string, opts?: InstallOpts): Promise<void>;

  /**
   * Uninstall the given version from the distro.
   *
   * Removes the runtime binary and any associated packages (e.g. `apt
   * remove nodejs`), then removes the entry from `state.json`. If the
   * uninstalled version was the default, the default is cleared (the caller
   * may want to prompt the user to pick a new default).
   *
   * @param version - Version spec to uninstall.
   * @param distro - Distro name.
   * @throws {RuntimeError} with code `E_RUNTIME_NOT_INSTALLED` if the
   *   version is not installed.
   * @throws {RuntimeError} with code `E_RUNTIME_UNINSTALL_FAILED` on apt /
   *   rustup failure.
   */
  uninstall(version: string, distro: string): Promise<void>;

  /**
   * List installed versions of this runtime in the distro.
   *
   * Queries the distro (via `distroExec`) for the actual installed state —
   * not `state.json` — so the result reflects out-of-band `apt remove`
   * operations. Cross-references with `state.json` for `installed_at`
   * timestamps; entries discovered in the distro but missing from state are
   * returned with `installed_at: ''` and `isDefault: false`.
   *
   * @param distro - Distro name.
   * @returns Array of {@link InstalledRuntime}, possibly empty.
   */
  list(distro: string): Promise<InstalledRuntime[]>;

  /**
   * Get the current default version, or `null` if none is set.
   *
   * Reads from `state.json`; does not invoke `distroExec`. Returns `null`
   * when no entry with `is_default: true` exists for this runtime name in
   * this distro.
   *
   * @param distro - Distro name.
   * @returns The default version string, or `null`.
   */
  getDefault(distro: string): Promise<string | null>;

  /**
   * Mark the given version as the default in the distro.
   *
   * Atomically updates `state.json`: clears `is_default` on all other
   * entries of the same runtime name in the same distro, then sets
   * `is_default: true` on the matching entry.
   *
   * @param version - Version spec to mark as default. Must already be
   *   installed (recorded in `state.json`); to install first, call
   *   {@link install}.
   * @param distro - Distro name.
   * @throws {RuntimeError} with code `E_RUNTIME_NOT_INSTALLED` if the
   *   version is not present in `state.json`.
   */
  setDefault(version: string, distro: string): Promise<void>;

  /**
   * Execute a command using a specific runtime version inside the distro.
   *
   * Resolves `cmd` to the runtime's bin directory (via {@link pathFor}) and
   * invokes it via {@link DistroExecFn}. Used by `linuxify runtimes exec
   * <name> <version> -- <cmd>` and by doctor health checks.
   *
   * Does **not** throw on non-zero exit; callers inspect `exitCode`.
   *
   * @param version - Version spec (used to locate the runtime bin dir).
   * @param distro - Distro name.
   * @param cmd - Binary name to invoke (e.g. `node`, `npm`, `python3`).
   * @param args - Argument vector.
   * @param opts - Optional {@link ExecOpts}.
   * @returns An {@link ExecResult} with stdout, stderr, and exitCode.
   */
  exec(
    version: string,
    distro: string,
    cmd: string,
    args: readonly string[],
    opts?: ExecOpts,
  ): Promise<ExecResult>;

  /**
   * Return the absolute path (inside the distro rootfs) to the runtime's
   * binary for the given version.
   *
   * Synchronous: the path is computed from the runtime's install-root
   * convention, not by querying the distro. Used by the launcher to
   * construct the proot PATH.
   *
   * @param version - Version spec (ignored by some providers whose path
   *   does not vary by version, e.g. apt-installed Python at
   *   `/usr/bin/python3`).
   * @param distro - Distro name (ignored by most providers; included for
   *   future per-distro path customization).
   * @returns Absolute path inside the distro rootfs.
   */
  pathFor(version: string, distro: string): string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Internal registry map. Keys are lowercased runtime names so that lookups
 * are case-insensitive (`Node` and `node` resolve to the same provider).
 */
const RUNTIME_REGISTRY = new Map<string, RuntimeProvider>();

/**
 * Register a runtime provider. Re-registering an existing name replaces the
 * prior entry (useful for plugins overriding built-ins) and logs a warning.
 *
 * @param provider - The provider instance to register.
 * @throws {RuntimeError} with code `E_RUNTIME_INVALID` if `provider.name`
 *   is empty after trimming.
 */
export function registerRuntime(provider: RuntimeProvider): void {
  const name = provider.name.trim().toLowerCase();
  if (!name) {
    throw new RuntimeError('RuntimeProvider.name must be a non-empty string', {
      code: 'INVALID',
    });
  }
  if (RUNTIME_REGISTRY.has(name)) {
    logger.warn(
      { name, prev: RUNTIME_REGISTRY.get(name)?.displayName },
      're-registering runtime provider (overriding previous registration)',
    );
  }
  RUNTIME_REGISTRY.set(name, provider);
  logger.debug({ name, displayName: provider.displayName }, 'runtime provider registered');
}

/**
 * Look up a registered runtime provider by name (case-insensitive).
 *
 * @param name - Runtime name (e.g. `node`).
 * @returns The registered provider.
 * @throws {RuntimeError} with code `E_RUNTIME_NOT_FOUND` if no provider is
 *   registered under `name`. The error's `fixCommand` suggests
 *   `linuxify runtimes list` so the user can see what is registered.
 */
export function getRuntime(name: string): RuntimeProvider {
  const key = name.trim().toLowerCase();
  const provider = RUNTIME_REGISTRY.get(key);
  if (!provider) {
    throw new RuntimeError(`No runtime provider registered for name '${name}'`, {
      code: 'NOT_FOUND',
      details: { name },
      fixCommand: 'linuxify runtimes list',
    });
  }
  return provider;
}

/**
 * List all registered runtime providers, sorted alphabetically by `name`.
 *
 * @returns A new array (callers may mutate without affecting the registry).
 */
export function listRuntimes(): RuntimeProvider[] {
  return Array.from(RUNTIME_REGISTRY.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remove a registered provider. Used by tests to reset the registry between
 * cases; production code rarely needs this (use {@link registerRuntime} to
 * override an existing registration instead).
 *
 * @param name - Runtime name (case-insensitive).
 */
export function unregisterRuntime(name: string): void {
  RUNTIME_REGISTRY.delete(name.trim().toLowerCase());
}

/**
 * Remove all registered providers. Used by tests to start each case with a
 * clean registry.
 */
export function clearRuntimes(): void {
  RUNTIME_REGISTRY.clear();
}

// ---------------------------------------------------------------------------
// Default DistroExecFn (production wiring)
// ---------------------------------------------------------------------------

/**
 * Build a default {@link DistroExecFn} that invokes `proot-distro login`
 * to run a command inside a distro. This is the production wiring; tests
 * inject their own stub via the provider constructor.
 *
 * The constructed function runs:
 *   `proot-distro login <distro> -- <cmd> <args...>`
 *
 * Env vars from `opts.env` are merged with the host's env (execa's default
 * `extendEnv: true`), so they are inherited by the proot session. The
 * `cwd` option is forwarded to execa, which sets the working directory of
 * the `proot-distro` process (not the proot session — that would require
 * `--rootfd` or `--cwd` flags on proot itself, not yet wired up here).
 *
 * @returns A {@link DistroExecFn} backed by `proot-distro`.
 */
export function createDefaultDistroExec(): DistroExecFn {
  return async (distro, cmd, args, opts) => {
    const fullArgs = ['login', distro, '--', cmd, ...args];
    const result = await execProcess('proot-distro', fullArgs, {
      cwd: opts?.cwd,
      env: opts?.env,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Convert a snake_case `RuntimeInstall` record from `state.json`'s
 * `installed_runtimes` array into the camelCase {@link InstalledRuntime}
 * shape exposed by this module. The two types differ only in field naming;
 * the conversion is a plain property rename.
 *
 * @param r - The state.json record.
 * @returns An {@link InstalledRuntime} with the same data.
 */
function fromStateRecord(r: State['installed_runtimes'][number]): InstalledRuntime {
  return {
    name: r.name,
    version: r.version,
    distro: r.distro,
    path: r.path,
    installedAt: r.installed_at,
    isDefault: r.is_default,
  };
}

/**
 * Convert a camelCase {@link InstalledRuntime} into the snake_case
 * `RuntimeInstall` record persisted in `state.json`.
 *
 * @param r - The {@link InstalledRuntime}.
 * @returns A state.json-compatible record.
 */
function toStateRecord(r: InstalledRuntime): State['installed_runtimes'][number] {
  return {
    name: r.name,
    version: r.version,
    distro: r.distro,
    path: r.path,
    installed_at: r.installedAt,
    is_default: r.isDefault,
  };
}

/**
 * Find all `installed_runtimes` entries matching `name` and `distro`.
 *
 * @param state - The loaded State object (not mutated).
 * @param name - Runtime name.
 * @param distro - Distro name.
 * @returns A new array of matching entries (possibly empty).
 */
export function findInstalledRuntimes(
  state: State,
  name: string,
  distro: string,
): InstalledRuntime[] {
  return state.installed_runtimes
    .filter((r) => r.name === name && r.distro === distro)
    .map(fromStateRecord);
}

/**
 * Insert or replace an `installed_runtimes` entry, keyed by
 * `(name, distro, version)`. If an entry with the same key already exists,
 * it is replaced in place; otherwise the new entry is appended.
 *
 * Mutates `state.installed_runtimes` in place. Callers should wrap the
 * read-modify-write cycle in `StateStore.update()` to acquire the state lock.
 *
 * @param state - The State object to mutate.
 * @param install - The entry to upsert.
 */
export function upsertRuntimeInstall(state: State, install: InstalledRuntime): void {
  const record = toStateRecord(install);
  const idx = state.installed_runtimes.findIndex(
    (r) => r.name === install.name && r.distro === install.distro && r.version === install.version,
  );
  if (idx >= 0) {
    state.installed_runtimes[idx] = record;
  } else {
    state.installed_runtimes.push(record);
  }
}

/**
 * Remove the `installed_runtimes` entry keyed by `(name, distro, version)`.
 *
 * Mutates `state.installed_runtimes` in place.
 *
 * @param state - The State object to mutate.
 * @param name - Runtime name.
 * @param distro - Distro name.
 * @param version - Version spec.
 * @returns `true` if an entry was removed, `false` if no matching entry
 *   existed.
 */
export function removeRuntimeInstall(
  state: State,
  name: string,
  distro: string,
  version: string,
): boolean {
  const before = state.installed_runtimes.length;
  state.installed_runtimes = state.installed_runtimes.filter(
    (r) => !(r.name === name && r.distro === distro && r.version === version),
  );
  return state.installed_runtimes.length < before;
}

/**
 * Mark the `(name, distro, version)` entry as the default. Clears
 * `is_default` on all other entries of the same runtime name in the same
 * distro, then sets `is_default: true` on the matching entry.
 *
 * Mutates `state.installed_runtimes` in place.
 *
 * @param state - The State object to mutate.
 * @param name - Runtime name.
 * @param distro - Distro name.
 * @param version - Version spec to mark as default. Must already be present
 *   in `installed_runtimes`.
 * @returns `true` if the entry was found and marked, `false` if no matching
 *   entry exists (in which case no mutation occurs).
 */
export function markDefaultRuntime(
  state: State,
  name: string,
  distro: string,
  version: string,
): boolean {
  let found = false;
  for (const r of state.installed_runtimes) {
    if (r.name === name && r.distro === distro) {
      if (r.version === version) {
        r.is_default = true;
        found = true;
      } else {
        r.is_default = false;
      }
    }
  }
  return found;
}

/**
 * Read the default version for `(name, distro)` from `state.json`.
 *
 * @param state - The loaded State object (not mutated).
 * @param name - Runtime name.
 * @param distro - Distro name.
 * @returns The default version string, or `null` if no entry has
 *   `is_default: true`.
 */
export function getDefaultRuntimeVersion(
  state: State,
  name: string,
  distro: string,
): string | null {
  for (const r of state.installed_runtimes) {
    if (r.name === name && r.distro === distro && r.is_default) {
      return r.version;
    }
  }
  return null;
}
