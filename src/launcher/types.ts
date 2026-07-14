/**
 * Launcher subsystem types.
 *
 * @module linuxify/launcher/types
 *
 * A Linuxify launcher is a small POSIX shell-script shim placed at
 * `$PREFIX/bin/<name>` by `linuxify add`. When the user types `<name>` in a
 * Termux shell, the shim `exec`s into `linuxify run <name> -- "$@"`, which
 * sets up the proot environment and runs the real binary.
 *
 * Three variants are supported (see
 * `docs/06-launcher/launcher-architecture.md` §11):
 *
 *   - **standard** (default): the shell-script shim described above. Used by
 *     ~95% of packages. Adds ~50–100 ms overhead per invocation (mostly proot
 *     startup, not the script itself).
 *   - **direct**: a shell script that execs `proot-distro login` directly,
 *     bypassing `linuxify run`. Used for performance-critical trusted tools.
 *     Loses env merging, CWD binding, and preflight checks.
 *   - **custom**: a user-provided shell script. Linuxify prepends a header
 *     identifying the file as auto-generated; the rest is the user's script.
 *
 * The `LauncherSpec` is the input to the generator; `LauncherResult` is the
 * output describing the file that was written.
 *
 * @packageDocumentation
 */

/**
 * The launcher variant. See module-level docs for the semantics of each.
 */
export type LauncherVariant = 'standard' | 'direct' | 'custom';

/**
 * Specification used by {@link LauncherGenerator.generate} to produce a
 * launcher file.
 *
 * The `variant` field selects the template:
 *   - `standard` — uses {@link standardTemplate}.
 *   - `direct`   — uses {@link directTemplate}; requires `binaryPath`.
 *   - `custom`   — uses {@link customTemplate}; requires `customScript`.
 */
export interface LauncherSpec {
  /** The Linuxify package name (e.g. `cline`). */
  packageName: string;
  /** The binary name as it should appear on `$PATH` (e.g. `cline`). */
  launcherName: string;
  /** Target distro name (e.g. `ubuntu`). */
  distro: string;
  /** Launcher variant; see {@link LauncherVariant}. */
  variant: LauncherVariant;
  /**
   * User-provided script body for the `custom` variant. Required when
   * `variant === 'custom'`; ignored otherwise. May include its own shebang;
   * if missing, Linuxify prepends the standard Termux sh shebang.
   */
  customScript?: string;
  /**
   * Absolute path (inside the proot rootfs) of the binary the `direct`
   * variant should exec. Required when `variant === 'direct'`; ignored
   * otherwise. Example: `/home/linuxify/.local/bin/cline`.
   */
  binaryPath?: string;
}

/**
 * Result returned by {@link LauncherGenerator.generate} describing the
 * launcher file that was written.
 */
export interface LauncherResult {
  /** Absolute path of the written launcher (`$PREFIX/bin/<launcherName>`). */
  path: string;
  /** Package name the launcher dispatches to. */
  packageName: string;
  /** Binary name (filename without directory) of the launcher. */
  launcherName: string;
  /** Variant that was rendered. */
  variant: LauncherVariant;
}
