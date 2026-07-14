/**
 * PackageManager — orchestrates package install / uninstall / listing.
 *
 * @module linuxify/packages/manager
 *
 * The {@link PackageManager} is the composition root for `linuxify add` and
 * `linuxify remove`. It pulls in:
 *  - the {@link StateStore} (to record installed packages),
 *  - a {@link DistroProvider} (to exec install commands inside the proot),
 *  - a {@link RuntimeProvider} (to ensure the required runtime is installed).
 *
 * The patcher and launcher subsystems (built by later agents) are not wired
 * in yet — the manager emits `prePatch`/`postPatch` and `preLauncher`/
 * `postLauncher` events so those modules can attach without the manager
 * depending on them. This keeps the dependency DAG acyclic: packages →
 * state, utils; packages does NOT import patcher/launcher.
 *
 * ## Install flow
 *
 *  1. **Preflight** — reject if already installed (unless `force`), reject
 *     if the package is `deprecated` (unless `force`), reject if free disk
 *     space is below the hard-stop threshold.
 *  2. **Runtime auto-install** — if the required runtime version is not
 *     installed, call `runtimeProvider.install(runtimeMinVersion)`.
 *  3. **Install steps** — normalize the `install` block (array or
 *     `{ steps, env, cwd }`) into a flat step list, then run each step via
 *     `distroProvider.exec(['bash', '-c', step.command], { env, cwd })`.
 *     Honor `expect`, `retry`, and `on_fail`.
 *  4. **Patches** — emit `prePatch`/`postPatch` events (the patcher module
 *     attaches a listener to do the actual work). The list of applied
 *     patch IDs is recorded in state.
 *  5. **Launcher** — emit `preLauncher`/`postLauncher` events (the launcher
 *     module attaches a listener to create the shim).
 *  6. **State registration** — atomically add a {@link PackageInstall} entry
 *     to `state.installed_packages` via `stateStore.update()`.
 *
 * ## Uninstall flow
 *
 *  1. Look up the package in state; throw `E_PACKAGE_NOT_INSTALLED` if
 *     absent.
 *  2. If the caller provides the original `PackageDefinition` (via
 *     {@link UninstallOpts.pkg}), run the `uninstall` steps via
 *     `distroProvider.exec`. If `pkg` is not provided, skip step execution
 *     (the registry/cache lookup to retrieve the YAML is the registry
 *     module's job, not the manager's).
 *  3. Emit `preLauncherRemove`/`postLauncherRemove` events (the launcher
 *     module removes the shim).
 *  4. Atomically remove the entry from `state.installed_packages`.
 *
 * ## Events
 *
 * The manager extends `Node's EventEmitter` and emits the following events:
 *  - `preInstall` `(pkg)` — before preflight.
 *  - `progress` `(msg: string)` — during install (also forwarded to
 *    `opts.onProgress`).
 *  - `prePatch` `(pkg, patchIds)` — before patches.
 *  - `postPatch` `(pkg, appliedPatchIds)` — after patches.
 *  - `preLauncher` `(pkg, launcherPath)` — before launcher creation.
 *  - `postLauncher` `(pkg, launcherPath)` — after launcher creation.
 *  - `postInstall` `(pkg, result)` — after state registration.
 *  - `preUninstall` `(name)` — before lookup.
 *  - `preLauncherRemove` `(name, launcherPath)` — before launcher removal.
 *  - `postLauncherRemove` `(name, launcherPath)` — after launcher removal.
 *  - `postUninstall` `(name, result)` — after state removal.
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'node:events';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import semver from 'semver';

import { EXIT_CODES, STORAGE_WARNING_MB } from '../utils/constants.js';
import { PackageError } from '../utils/errors.js';
import { getLinuxifyHome } from '../utils/process.js';
import { sleep } from '../utils/process.js';
import { logger } from '../utils/log.js';
import type { PackageInstall, StateStore } from '../state/index.js';

import type { InstallStepObject, PackageDefinition } from './schema.js';

// ============================================================================
// Provider slice interfaces
// ============================================================================

/**
 * Options accepted by {@link DistroProvider.exec}. This is the subset of the
 * full `ExecOptions` (defined in `src/distros/` by agent B5) that the
 * package manager consumes. The full interface is structurally compatible —
 * any object satisfying the full interface also satisfies this slice.
 *
 * Once B5 lands `src/distros/provider.ts`, downstream code should import the
 * full `DistroProvider`/`ExecOptions` types from there and this local
 * declaration can be removed (or kept as a structural supertype).
 */
export interface DistroExecOptions {
  /** Working directory inside the proot distro. */
  readonly cwd?: string;
  /** Environment variables merged with the distro's default env. */
  readonly env?: Record<string, string>;
  /** Timeout in milliseconds; the command is killed if it exceeds this. */
  readonly timeoutMs?: number;
  /** User to run as inside the distro (default: `linuxify`). */
  readonly user?: string;
}

/**
 * Result of {@link DistroProvider.exec}. Mirrors the subset of the full
 * `ExecResult` (from `src/distros/`) that the manager reads. The distro
 * provider's `ExecResult` does not include `durationMs`; the manager
 * computes its own wall-clock duration via `Date.now()`.
 */
export interface DistroExecResult {
  /** The command's exit code. `0` means success. */
  readonly exitCode: number;
  /** Captured stdout. */
  readonly stdout: string;
  /** Captured stderr. */
  readonly stderr: string;
}

/**
 * Minimal slice of the `DistroProvider` interface that the package manager
 * consumes. The full interface (defined by agent B5 in `src/distros/provider.ts`)
 * adds lifecycle methods (`install`, `uninstall`, `start`, `stop`, `shell`,
 * `info`, `update`, `snapshot`, `restore`) and metadata fields
 * (`displayName`, `defaultVersion`, `supportedArches`, `minStorageMb`); the
 * manager only needs `name` and `exec`. TypeScript's structural typing means
 * any object satisfying B5's full `DistroProvider` interface also satisfies
 * this slice — the `exec` signature is aligned: `exec(cmd: string, args:
 * string[], opts?)`.
 */
export interface DistroProvider {
  /** Distro identifier, e.g. `ubuntu`, `debian`. */
  readonly name: string;
  /**
   * Execute a command inside the distro (via proot). The `cmd` is the binary
   * to invoke (e.g. `bash`); `args` is the argument vector. The distro
   * provider composes these into a `proot-distro login` invocation.
   */
  exec(cmd: string, args: readonly string[], opts?: DistroExecOptions): Promise<DistroExecResult>;
}

/**
 * Options accepted by {@link RuntimeProvider.install}. B6's full
 * `InstallOpts` also includes an `onProgress` callback; the manager does not
 * forward progress from the runtime provider (it emits its own `progress`
 * events), so this slice omits it. Any object satisfying B6's `InstallOpts`
 * also satisfies this slice.
 */
export interface RuntimeInstallOptions {
  /** Cooperative cancellation signal (forwarded but not yet wired). */
  readonly signal?: AbortSignal;
}

/** An installed runtime version entry (minimal slice of B6's `InstalledRuntime`). */
export interface RuntimeVersion {
  /** The version string (e.g. `22.11.0`). */
  readonly version: string;
}

/**
 * Minimal slice of the `RuntimeProvider` interface that the package manager
 * consumes. The full interface (defined by agent B6 in
 * `src/runtimes/provider.ts`) adds `displayName`, `supportedVersions`,
 * `isInstalled`, `uninstall`, `getDefault`, `setDefault`, `exec`, and
 * `pathFor`; the manager only needs `name`, `defaultVersion`, `install`,
 * and `list`. The `install` and `list` signatures are aligned with B6's:
 * both take a `distro` argument so a single provider instance can manage
 * runtimes across multiple distros. TypeScript's structural typing means any
 * object satisfying B6's full `RuntimeProvider` interface also satisfies
 * this slice.
 */
export interface RuntimeProvider {
  /** Runtime identifier: `node`, `python`, `rust`, `go`, `bun`, `deno`. */
  readonly name: string;
  /** Default version, resolved at construction time. */
  readonly defaultVersion: string;
  /** Install a specific version of the runtime into the named distro. */
  install(version: string, distro: string, opts?: RuntimeInstallOptions): Promise<void>;
  /** List installed versions of this runtime in the named distro. */
  list(distro: string): Promise<RuntimeVersion[]>;
}

// ============================================================================
// Install / uninstall options and results
// ============================================================================

/**
 * Options accepted by {@link PackageManager.install}.
 */
export interface InstallOpts {
  /** Force reinstall over an existing install (skip the already-installed check). */
  readonly force?: boolean;
  /** Skip patch application (emit `prePatch`/`postPatch` with an empty list). */
  readonly noPatch?: boolean;
  /** Progress callback; called with human-readable status messages. */
  readonly onProgress?: (msg: string) => void;
}

/**
 * Result of {@link PackageManager.install}.
 */
export interface InstallResult {
  /** Whether the install succeeded. */
  readonly success: boolean;
  /** Package name. */
  readonly package: string;
  /** Package version. */
  readonly version: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** IDs of patches applied (empty if `noPatch` or no patches). */
  readonly patchesApplied: string[];
  /** Error message; only present when `success` is `false`. */
  readonly error?: string;
}

/**
 * Options accepted by {@link PackageManager.uninstall}.
 */
export interface UninstallOpts {
  /**
   * The original package definition, used to run the `uninstall` steps. If
   * omitted, uninstall skips step execution (only state removal + launcher
   * removal events). The CLI layer retrieves the YAML from the registry
   * cache and passes it here; the manager itself does not fetch YAMLs.
   */
  readonly pkg?: PackageDefinition;
  /** Progress callback. */
  readonly onProgress?: (msg: string) => void;
}

/**
 * Result of {@link PackageManager.uninstall}.
 */
export interface UninstallResult {
  /** Whether the uninstall succeeded. */
  readonly success: boolean;
  /** Package name. */
  readonly package: string;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
  /** Error message; only present when `success` is `false`. */
  readonly error?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * A normalized install step. The `install` block accepts both bare strings
 * and structured objects; this type is the canonical form the manager
 * executes. Defaults are applied: `expect` → `0`, `retry` → `0`, `on_fail`
 * → `'abort'`, `name` → `step-<N>`.
 */
interface NormalizedStep {
  /** Step label (assigned `step-<N>` for bare-string steps). */
  readonly name: string;
  /** Shell command. */
  readonly command: string;
  /** Expected exit code (default `0`). */
  readonly expect: number;
  /** Retry count (default `0`). */
  readonly retry: number;
  /** On-failure behavior (default `'abort'`). */
  readonly on_fail: 'continue' | 'abort';
}

/**
 * Normalize the `install` block (array or `{ steps, env, cwd }`) into a flat
 * list of {@link NormalizedStep}s. Bare-string steps are converted to
 * `{ command: <string> }`; structured steps are kept as-is. Defaults are
 * applied for `expect` (`0`), `retry` (`0`), `on_fail` (`'abort'`), and
 * `name` (`step-<N>` for bare strings, kept for structured steps).
 *
 * @param install - The `install` field from a {@link PackageDefinition}.
 * @returns A flat array of {@link NormalizedStep}s.
 */
function normalizeSteps(install: PackageDefinition['install']): NormalizedStep[] {
  const rawSteps = Array.isArray(install) ? install : install.steps;
  return rawSteps.map((step, index): NormalizedStep => {
    if (typeof step === 'string') {
      return {
        name: `step-${index}`,
        command: step,
        expect: 0,
        retry: 0,
        on_fail: 'abort',
      };
    }
    const obj: InstallStepObject = step;
    return {
      name: obj.name,
      command: obj.command,
      expect: obj.expect ?? 0,
      retry: obj.retry ?? 0,
      on_fail: obj.on_fail ?? 'abort',
    };
  });
}

/**
 * Extract the optional `env` map from the structured-form `install` block.
 * Returns `undefined` for the simple (array) form.
 *
 * @param install - The `install` field from a {@link PackageDefinition}.
 * @returns The install-block env map, or `undefined`.
 */
function installBlockEnv(
  install: PackageDefinition['install'],
): Record<string, string> | undefined {
  return Array.isArray(install) ? undefined : install.env;
}

/**
 * Extract the optional `cwd` from the structured-form `install` block.
 * Returns `undefined` for the simple (array) form.
 *
 * @param install - The `install` field from a {@link PackageDefinition}.
 * @returns The install-block cwd, or `undefined`.
 */
function installBlockCwd(install: PackageDefinition['install']): string | undefined {
  return Array.isArray(install) ? undefined : install.cwd;
}

/**
 * Build the environment map for install-step execution. Merges:
 *  1. Standard Linuxify install env (`$LINUXIFY_PACKAGE_NAME`,
 *     `$LINUXIFY_PACKAGE_VERSION`, `$LINUXIFY_DISTRO`).
 *  2. Package-level env vars whose `scope` is `'runtime'` or `'always'`
 *     (string values default to `scope: 'always'`).
 *  3. Install-block `env` (overrides package-level).
 *
 * Run-scoped (`scope: 'run'`) vars are NOT included — they are set by the
 * launcher during `linuxify run`, not during install.
 *
 * @param pkg - The package definition.
 * @param distroName - The distro name (for `$LINUXIFY_DISTRO`).
 * @param blockEnv - The install-block env map (optional).
 * @returns The merged env map.
 */
function buildInstallEnv(
  pkg: PackageDefinition,
  distroName: string,
  blockEnv?: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {
    LINUXIFY_PACKAGE_NAME: pkg.name,
    LINUXIFY_PACKAGE_VERSION: pkg.version,
    LINUXIFY_DISTRO: distroName,
  };

  // Package-level env (scope 'runtime' or 'always').
  for (const [key, val] of Object.entries(pkg.env)) {
    if (typeof val === 'string') {
      env[key] = val; // simple form → scope defaults to 'always'
    } else {
      if (val.scope === 'runtime' || val.scope === 'always') {
        env[key] = val.value;
      }
    }
  }

  // Install-block env (overrides package-level).
  if (blockEnv) {
    for (const [key, val] of Object.entries(blockEnv)) {
      env[key] = val;
    }
  }

  return env;
}

/**
 * Check free disk space at the given path. Returns `null` if the check
 * cannot be performed (e.g. `statfs` unavailable on the platform).
 *
 * @param dirPath - The directory to check.
 * @returns Free bytes, or `null` if unknown.
 */
async function getFreeBytes(dirPath: string): Promise<number | null> {
  try {
    const stats = await statfs(dirPath);
    return stats.bsize * stats.bfree;
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime version to use for install. Prefers the runtime
 * provider's default version if it satisfies the package's min/max
 * constraints; otherwise falls back to the package's `runtime_min_version`.
 *
 * @param pkg - The package definition.
 * @param runtimeProvider - The runtime provider.
 * @returns The resolved runtime version string.
 */
function resolveRuntimeVersion(pkg: PackageDefinition, runtimeProvider: RuntimeProvider): string {
  const min = pkg.runtime_min_version;
  const defaultVer = runtimeProvider.defaultVersion;
  // If the default version satisfies min (and max if set), use it.
  const minCoerced = semver.coerce(min);
  const defaultCoerced = semver.coerce(defaultVer);
  if (minCoerced && defaultCoerced && semver.gte(defaultCoerced, minCoerced)) {
    if (pkg.runtime_max_version) {
      const maxCoerced = semver.coerce(pkg.runtime_max_version);
      if (maxCoerced && semver.lte(defaultCoerced, maxCoerced)) {
        return defaultVer;
      }
    } else {
      return defaultVer;
    }
  }
  // Fall back to the package's declared min version.
  return min;
}

// ============================================================================
// PackageManager
// ============================================================================

/**
 * Constructor options for {@link PackageManager}.
 */
export interface PackageManagerOptions {
  /** The state store (manages `~/.linuxify/state.json`). */
  readonly stateStore: StateStore;
  /** The distro provider (executes commands inside the proot distro). */
  readonly distroProvider: DistroProvider;
  /** The runtime provider (installs/ensures the required runtime). */
  readonly runtimeProvider: RuntimeProvider;
  /**
   * Minimum free disk space (in megabytes) required to proceed with an
   * install. Defaults to {@link STORAGE_WARNING_MB} (5 GB). Set to `0` to
   * skip the disk-space preflight (useful in tests). The hard-stop threshold
   * ({@link STORAGE_HARD_STOP_MB | STORAGE_HARD_STOP_MB}, 10 GB) is enforced
   * by the bootstrap subsystem, not by the package manager — a package
   * install rarely needs more than a few hundred MB.
   */
  readonly minFreeMb?: number;
}

/**
 * Orchestrates package install / uninstall / listing.
 *
 * One `PackageManager` instance is typically created per CLI invocation and
 * shared across the `linuxify add` / `linuxify remove` / `linuxify list`
 * commands. The manager is an `EventEmitter` so the patcher, launcher, and
 * telemetry modules can attach listeners without the manager importing them
 * (keeping the dependency DAG acyclic).
 *
 * @example
 * ```ts
 * import { PackageManager } from './packages/manager.js';
 * import { StateStore } from './state/index.js';
 * import { parsePackageYaml } from './packages/parser.js';
 *
 * const pm = new PackageManager({
 *   stateStore: new StateStore(statePath),
 *   distroProvider: getDistroProvider('ubuntu'),
 *   runtimeProvider: getRuntimeProvider('node'),
 * });
 *
 * pm.on('progress', (msg) => console.log(msg));
 *
 * const pkg = parsePackageYaml(yaml);
 * const result = await pm.install(pkg, { noPatch: false });
 * console.log(result.success ? 'installed' : result.error);
 * ```
 */
export class PackageManager extends EventEmitter {
  private readonly opts: PackageManagerOptions;

  /**
   * @param opts - Constructor options with state store, distro provider, and
   *   runtime provider.
   */
  constructor(opts: PackageManagerOptions) {
    super();
    this.opts = opts;
  }

  /**
   * Install a package.
   *
   * Runs the full install flow: preflight → runtime auto-install → install
   * steps → patch events → launcher events → state registration. Emits
   * `preInstall`, `progress`, `prePatch`, `postPatch`, `preLauncher`,
   * `postLauncher`, and `postInstall` events.
   *
   * @param pkg - The parsed and schema-validated package definition.
   * @param opts - Install options (`force`, `noPatch`, `onProgress`).
   * @returns An {@link InstallResult} with `success`, `durationMs`, and
   *   `patchesApplied`.
   * @throws {PackageError} with codes `E_PACKAGE_ALREADY_INSTALLED`,
   *   `E_PACKAGE_DEPRECATED`, `E_PACKAGE_DISK_FULL`,
   *   `E_PACKAGE_INSTALL_STEP_FAILED`, or `E_PACKAGE_CONFLICT`.
   */
  async install(pkg: PackageDefinition, opts: InstallOpts = {}): Promise<InstallResult> {
    const start = Date.now();
    this.emit('preInstall', pkg);
    const progress = (msg: string): void => {
      opts.onProgress?.(msg);
      this.emit('progress', msg);
    };

    try {
      // 1. Preflight.
      await this.preflight(pkg, opts, progress);

      // 2. Ensure runtime is installed.
      const runtimeVersion = resolveRuntimeVersion(pkg, this.opts.runtimeProvider);
      progress(`ensuring ${pkg.runtime} ${runtimeVersion} is installed`);
      await this.ensureRuntime(runtimeVersion, progress);

      // 3. Run install steps.
      const steps = normalizeSteps(pkg.install);
      const blockEnv = installBlockEnv(pkg.install);
      const blockCwd = installBlockCwd(pkg.install);
      const env = buildInstallEnv(pkg, this.opts.distroProvider.name, blockEnv);
      progress(`running ${steps.length} install step(s)`);
      await this.runSteps(steps, env, blockCwd, pkg.name, progress);

      // 4. Patches (emit events; patcher module attaches a listener).
      const patchesApplied: string[] = [];
      if (!opts.noPatch && pkg.patches.length > 0) {
        const patchIds = pkg.patches.map((p) => p.patch_id);
        this.emit('prePatch', pkg, patchIds);
        progress(`applying ${pkg.patches.length} patch(es)`);
        // The patcher module (later agent) listens on 'prePatch' and applies
        // patches. For now, we record all patch IDs as "applied" — the real
        // patcher will return the subset that succeeded.
        patchesApplied.push(...patchIds);
        this.emit('postPatch', pkg, patchesApplied);
      } else if (opts.noPatch) {
        progress('skipping patches (noPatch)');
      }

      // 5. Launcher (emit events; launcher module attaches a listener).
      const launcherPath = this.resolveLauncherPath(pkg);
      this.emit('preLauncher', pkg, launcherPath);
      progress(`creating launcher at ${launcherPath}`);
      // The launcher module (later agent) listens on 'preLauncher' and
      // creates the shim. For now, we just compute the path.
      this.emit('postLauncher', pkg, launcherPath);

      // 6. Register in state.
      progress('registering in state');
      await this.opts.stateStore.update((state) => {
        state.installed_packages.push({
          name: pkg.name,
          version: pkg.version,
          distro: this.opts.distroProvider.name,
          runtime: pkg.runtime,
          runtime_version: runtimeVersion,
          install_date: new Date().toISOString(),
          launcher_path: launcherPath,
          patches_applied: patchesApplied,
        });
      });

      const durationMs = Date.now() - start;
      const result: InstallResult = {
        success: true,
        package: pkg.name,
        version: pkg.version,
        durationMs,
        patchesApplied,
      };
      progress(`installed ${pkg.name}@${pkg.version} in ${durationMs}ms`);
      this.emit('postInstall', pkg, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - start;
      const result: InstallResult = {
        success: false,
        package: pkg.name,
        version: pkg.version,
        durationMs,
        patchesApplied: [],
        error: message,
      };
      this.emit('postInstall', pkg, result);
      throw error;
    }
  }

  /**
   * Uninstall a package by name.
   *
   * Looks up the package in state, runs its `uninstall` steps (if the caller
   * provided the original `PackageDefinition` via {@link UninstallOpts.pkg}),
   * emits launcher-removal events, and atomically removes the entry from
   * `state.installed_packages`.
   *
   * @param name - The package name (must match a `state.installed_packages`
   *   entry).
   * @param opts - Optional uninstall options (`pkg`, `onProgress`).
   * @returns An {@link UninstallResult} with `success` and `durationMs`.
   * @throws {PackageError} with code `E_PACKAGE_NOT_INSTALLED` if the package
   *   is not in state, or `E_PACKAGE_UNINSTALL_STEP_FAILED` if an uninstall
   *   step fails.
   */
  async uninstall(name: string, opts: UninstallOpts = {}): Promise<UninstallResult> {
    const start = Date.now();
    this.emit('preUninstall', name);
    const progress = (msg: string): void => {
      opts.onProgress?.(msg);
      this.emit('progress', msg);
    };

    try {
      const state = await this.opts.stateStore.load();
      const install = state.installed_packages.find((p) => p.name === name);
      if (!install) {
        throw new PackageError(`Package '${name}' is not installed`, {
          code: 'E_PACKAGE_NOT_INSTALLED',
          exitCode: EXIT_CODES.NOT_FOUND,
        });
      }

      // Run uninstall steps if the caller provided the package definition.
      if (opts.pkg?.uninstall && opts.pkg.uninstall.length > 0) {
        progress(`running ${opts.pkg.uninstall.length} uninstall step(s)`);
        for (let i = 0; i < opts.pkg.uninstall.length; i++) {
          const command = opts.pkg.uninstall[i]!;
          progress(`uninstall step ${i + 1}: ${command}`);
          const result = await this.opts.distroProvider.exec('bash', ['-c', command], {
            env: buildInstallEnv(opts.pkg, this.opts.distroProvider.name),
            timeoutMs: 10 * 60 * 1000,
          });
          if (result.exitCode !== 0) {
            throw new PackageError(
              `Uninstall step ${i + 1} failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`,
              {
                code: 'E_PACKAGE_UNINSTALL_STEP_FAILED',
                exitCode: EXIT_CODES.UNINSTALL_FAILED,
                details: { step: i, command, exitCode: result.exitCode, stderr: result.stderr },
              },
            );
          }
        }
      }

      // Launcher removal (emit events; launcher module attaches a listener).
      this.emit('preLauncherRemove', name, install.launcher_path);
      progress(`removing launcher at ${install.launcher_path}`);
      this.emit('postLauncherRemove', name, install.launcher_path);

      // Remove from state.
      progress('removing from state');
      await this.opts.stateStore.update((s) => {
        s.installed_packages = s.installed_packages.filter((p) => p.name !== name);
      });

      const durationMs = Date.now() - start;
      const result: UninstallResult = {
        success: true,
        package: name,
        durationMs,
      };
      progress(`uninstalled ${name} in ${durationMs}ms`);
      this.emit('postUninstall', name, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - start;
      const result: UninstallResult = {
        success: false,
        package: name,
        durationMs,
        error: message,
      };
      this.emit('postUninstall', name, result);
      throw error;
    }
  }

  /**
   * List all installed packages.
   *
   * @returns A copy of `state.installed_packages`. The returned array is a
   *   shallow copy; mutating it does not affect state.
   */
  async list(): Promise<PackageInstall[]> {
    const state = await this.opts.stateStore.load();
    return [...state.installed_packages];
  }

  /**
   * Get a specific installed package by name.
   *
   * @param name - The package name.
   * @returns The {@link PackageInstall} entry, or `null` if not installed.
   */
  async get(name: string): Promise<PackageInstall | null> {
    const state = await this.opts.stateStore.load();
    return state.installed_packages.find((p) => p.name === name) ?? null;
  }

  /**
   * Check whether a package is installed.
   *
   * @param name - The package name.
   * @returns `true` if the package is in `state.installed_packages`.
   */
  async isInstalled(name: string): Promise<boolean> {
    const state = await this.opts.stateStore.load();
    return state.installed_packages.some((p) => p.name === name);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Run preflight checks: already-installed (unless `force`), deprecated
   * (unless `force`), conflicts, and disk space.
   */
  private async preflight(
    pkg: PackageDefinition,
    opts: InstallOpts,
    progress: (msg: string) => void,
  ): Promise<void> {
    progress(`preflight for ${pkg.name}@${pkg.version}`);

    // Already installed?
    if (!opts.force) {
      const installed = await this.isInstalled(pkg.name);
      if (installed) {
        throw new PackageError(
          `Package '${pkg.name}' is already installed (use --force to reinstall)`,
          {
            code: 'E_PACKAGE_ALREADY_INSTALLED',
            exitCode: EXIT_CODES.ALREADY_INSTALLED,
          },
        );
      }
    }

    // Deprecated?
    if (pkg.deprecated && !opts.force) {
      throw new PackageError(
        `Package '${pkg.name}' is deprecated; use --force to install anyway`,
        {
          code: 'E_PACKAGE_DEPRECATED',
          details: { package: pkg.name },
        },
      );
    }

    // Conflicts?
    if (pkg.conflicts.length > 0) {
      const state = await this.opts.stateStore.load();
      const installed = new Set(state.installed_packages.map((p) => p.name));
      const conflict = pkg.conflicts.find((c) => installed.has(c));
      if (conflict) {
        throw new PackageError(
          `Package '${pkg.name}' conflicts with installed package '${conflict}'`,
          {
            code: 'E_PACKAGE_CONFLICT',
            details: { package: pkg.name, conflict },
          },
        );
      }
    }

    // Disk space.
    const linuxifyHome = getLinuxifyHome();
    const freeBytes = await getFreeBytes(dirname(this.opts.stateStore.statePath));
    if (freeBytes !== null) {
      const minMb = this.opts.minFreeMb ?? STORAGE_WARNING_MB;
      if (minMb > 0) {
        const minBytes = minMb * 1024 * 1024;
        if (freeBytes < minBytes) {
          throw new PackageError(
            `Insufficient disk space: ${Math.floor(freeBytes / 1024 / 1024)} MB free, ` +
              `${minMb} MB required (under ${linuxifyHome})`,
            {
              code: 'E_PACKAGE_DISK_FULL',
              exitCode: EXIT_CODES.STORAGE_FULL,
              details: { freeBytes, minBytes, minMb },
            },
          );
        }
      }
    }
  }

  /**
   * Ensure the required runtime version is installed. If not, call
   * `runtimeProvider.install(version, distro)`.
   */
  private async ensureRuntime(
    version: string,
    progress: (msg: string) => void,
  ): Promise<void> {
    const distroName = this.opts.distroProvider.name;
    const installed = await this.opts.runtimeProvider.list(distroName);
    const hasVersion = installed.some(
      (v) => v.version === version || semver.eq(v.version, version),
    );
    if (hasVersion) {
      progress(`runtime ${this.opts.runtimeProvider.name} ${version} already installed`);
      return;
    }
    progress(`installing runtime ${this.opts.runtimeProvider.name} ${version}`);
    logger.info(
      { runtime: this.opts.runtimeProvider.name, version, distro: distroName },
      'installing runtime (not found in state)',
    );
    await this.opts.runtimeProvider.install(version, distroName);
  }

  /**
   * Run a list of normalized install steps via the distro provider. Honors
   * `expect`, `retry` (2-second delay between attempts), and `on_fail`.
   */
  private async runSteps(
    steps: NormalizedStep[],
    env: Record<string, string>,
    cwd: string | undefined,
    packageName: string,
    progress: (msg: string) => void,
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      progress(`step ${i + 1}/${steps.length} [${step.name}]: ${step.command}`);

      const maxAttempts = step.retry + 1;
      let attempt = 0;
      let lastResult: DistroExecResult | null = null;

      while (attempt < maxAttempts) {
        lastResult = await this.opts.distroProvider.exec('bash', ['-c', step.command], {
          env,
          cwd,
          timeoutMs: 10 * 60 * 1000,
        });
        if (lastResult.exitCode === step.expect) {
          break; // success
        }
        attempt++;
        if (attempt < maxAttempts) {
          progress(
            `step ${i + 1} failed (exit ${lastResult.exitCode}); retrying (${attempt}/${step.retry})`,
          );
          await sleep(2000);
        }
      }

      if (lastResult === null) {
        // Should not happen (maxAttempts >= 1), but satisfy the type checker.
        throw new PackageError(`Install step '${step.name}' produced no result`, {
          code: 'E_PACKAGE_INSTALL_STEP_FAILED',
          details: { step: step.name, package: packageName },
        });
      }

      if (lastResult.exitCode !== step.expect) {
        if (step.on_fail === 'continue') {
          progress(
            `step ${i + 1} [${step.name}] failed (exit ${lastResult.exitCode}); continuing (on_fail: continue)`,
          );
          logger.warn(
            { package: packageName, step: step.name, exitCode: lastResult.exitCode },
            'install step failed but on_fail=continue',
          );
          continue;
        }
        throw new PackageError(
          `Install step '${step.name}' failed (exit ${lastResult.exitCode}): ${lastResult.stderr.slice(-500)}`,
          {
            code: 'E_PACKAGE_INSTALL_STEP_FAILED',
            exitCode: EXIT_CODES.STEP_FAILED,
            details: {
              step: step.name,
              command: step.command,
              exitCode: lastResult.exitCode,
              stdout: lastResult.stdout,
              stderr: lastResult.stderr,
            },
          },
        );
      }
    }
  }

  /**
   * Resolve the launcher path for a package. The launcher module (later
   * agent) creates the actual shim at this path; the manager only computes
   * the path so it can be recorded in state and emitted in events.
   *
   * The path is `<linuxifyHome>/bin/<launcher>`. On Termux this resolves to
   * `~/.linuxify/bin/<launcher>`; the launcher module symlinks it into
   * `$PREFIX/bin/` so the user's shell finds it.
   */
  private resolveLauncherPath(pkg: PackageDefinition): string {
    return join(getLinuxifyHome(), 'bin', pkg.launcher);
  }
}
