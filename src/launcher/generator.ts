/**
 * Launcher generator — writes shell-script shims to `$PREFIX/bin/`.
 *
 * @module linuxify/launcher/generator
 *
 * The generator is the most user-visible component of Linuxify: every time
 * a user types `cline` (or any other Linuxify-managed CLI) in a Termux
 * shell, the kernel resolves `cline` via `$PATH`, finds the shim at
 * `$PREFIX/bin/cline`, and execs it. The shim execs into `linuxify run`,
 * which enters the proot and runs the real binary. If the launcher is
 * broken, every Linuxify-managed tool is broken (see
 * `docs/06-launcher/launcher-architecture.md` §1).
 *
 * The generator is intentionally trivial — most of the launcher's behavior
 * lives in `linuxify run` (which is the CLI agent's responsibility), not in
 * the shim. The generator's only job is to render the right template, write
 * it atomically with the right permissions, and provide a few helpers for
 * repair, removal, and enumeration.
 *
 * ## Atomic write
 *
 * Each launcher is written to `<path>.<pid>.<rand>.tmp`, then `rename`d
 * over the target. A SIGKILL during the write therefore leaves either the
 * previous launcher or no launcher at all — never a half-written file that
 * would shadow the real binary with a broken shim. After the rename, an
 * explicit `chmod 0755` is applied as belt-and-suspenders against umask
 * surprises on exotic filesystems.
 *
 * ## Regeneration
 *
 * `regenerate(packageName, state)` looks up the package in `state.json`'s
 * `installed_packages` array and re-renders its launcher. It is called by:
 *
 *   - `linuxify use <distro>` (active distro change might update
 *     `LINUXIFY_DISTRO`).
 *   - `linuxify upgrade <pkg>` (runtime version might have changed).
 *   - `linuxify self-update` (template format might have changed).
 *
 * `regenerateAll(state)` iterates every installed package and regenerates
 * its launcher. Best-effort: failures are logged and the iteration
 * continues, so one broken package doesn't block the others.
 *
 * @packageDocumentation
 */

import { promises as fsp, type Dirent } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import { LauncherError } from '../utils/errors.js';
import { ensureDir, exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import type { State } from '../state/index.js';

import {
  customTemplate,
  directTemplate,
  standardTemplate,
  LINUXIFY_HEADER_SIGNATURE,
} from './templates.js';
import type { LauncherResult, LauncherSpec, LauncherVariant } from './types.js';

/**
 * Filesystem mode for launcher files. `0755` = `rwxr-xr-x` (executable by
 * owner, readable/executable by group and other). World-readability is
 * required because `$PREFIX/bin/` is on every Termux user's `$PATH` and
 * the launcher must be invocable regardless of the calling shell's euid.
 */
const LAUNCHER_FILE_MODE = 0o755;

/**
 * Maximum number of bytes to read from a candidate file when scanning for
 * the Linuxify header signature. The signature always appears in the first
 * 512 bytes (it's the second line of every template), so reading the first
 * 1 KiB is more than enough. Capping the read avoids loading large
 * non-launcher binaries into memory during `list()`.
 */
const HEADER_SCAN_BYTES = 1024;

/**
 * Generate, regenerate, remove, and enumerate launcher shims.
 *
 * One `LauncherGenerator` instance is bound to a single `$PREFIX` (the
 * Termux prefix, `/data/data/com.termux/files/usr` by default). All
 * operations target `$PREFIX/bin/`. Use {@link getLauncherGenerator} (from
 * the barrel) for the default-bound instance; tests construct their own
 * with a tmpdir prefix.
 */
export class LauncherGenerator {
  /**
   * Absolute path to the Termux `$PREFIX` directory. The launcher files
   * live at `<prefix>/bin/<launcherName>`.
   */
  readonly prefix: string;

  /**
   * @param opts - Constructor options.
   * @param opts.prefix - Absolute path to `$PREFIX` (Termux prefix). The
   *   generator writes launchers to `<prefix>/bin/`.
   */
  constructor(opts: { prefix: string }) {
    if (!opts || !opts.prefix || opts.prefix.trim() === '') {
      throw new LauncherError('LauncherGenerator requires a non-empty opts.prefix', {
        code: 'INVALID_PREFIX',
      });
    }
    this.prefix = opts.prefix;
  }

  /**
   * Absolute path to the launcher bin directory (`<prefix>/bin/`).
   * Exposed for tests and `linuxify doctor` diagnostics.
   */
  get binDir(): string {
    return join(this.prefix, 'bin');
  }

  /**
   * Generate (or overwrite) a launcher file.
   *
   * Flow:
   *   1. Validate the spec (non-empty packageName/launcherName/distro;
   *      launcherName has no path separators and isn't `.` / `..`).
   *   2. Dispatch to the right template based on `spec.variant`:
   *      - `standard` → {@link standardTemplate}
   *      - `direct`   → {@link directTemplate} (requires `spec.binaryPath`)
   *      - `custom`   → {@link customTemplate} (requires `spec.customScript`)
   *   3. Ensure `<prefix>/bin/` exists.
   *   4. Atomically write the rendered script (temp file + rename) with
   *      mode `0o755`.
   *   5. Return a {@link LauncherResult} describing the file.
   *
   * @param spec - The launcher specification.
   * @returns A {@link LauncherResult} with the absolute path of the
   *   written file.
   * @throws {LauncherError} with code `E_LAUNCHER_INVALID_SPEC` if the spec
   *   is missing required fields.
   * @throws {LauncherError} with code `E_LAUNCHER_INVALID_LAUNCHER_NAME`
   *   if `launcherName` contains a path separator or is `.`/`..`.
   * @throws {LauncherError} with code `E_LAUNCHER_DIRECT_BINARY_PATH_MISSING`
   *   if `variant === 'direct'` and `spec.binaryPath` is empty.
   * @throws {LauncherError} with code `E_LAUNCHER_CUSTOM_SCRIPT_MISSING`
   *   if `variant === 'custom'` and `spec.customScript` is empty.
   * @throws {LauncherError} with code `E_LAUNCHER_WRITE_FAILED` if the
   *   atomic write fails (the original error is preserved on `cause`).
   */
  async generate(spec: LauncherSpec): Promise<LauncherResult> {
    this.validateSpec(spec);

    const content = this.renderTemplate(spec);
    const launcherPath = join(this.binDir, spec.launcherName);

    await this.writeExecutable(launcherPath, content);

    logger.info('launcher generated', {
      packageName: spec.packageName,
      launcherName: spec.launcherName,
      variant: spec.variant,
      distro: spec.distro,
      path: launcherPath,
    });

    return {
      path: launcherPath,
      packageName: spec.packageName,
      launcherName: spec.launcherName,
      variant: spec.variant,
    };
  }

  /**
   * Regenerate a single package's launcher from state.
   *
   * Looks up `packageName` in `state.installed_packages` and re-renders its
   * launcher as the `standard` variant (the default). The `launcherName`
   * is derived from the basename of the state entry's `launcher_path`
   * field; the `distro` is taken from the state entry.
   *
   * Note: this method always renders the `standard` variant because the
   * state schema (B3's `PackageInstallSchema`) does not currently carry a
   * `variant` or `binaryPath` field. Packages that use the `direct` or
   * `custom` variant must be regenerated via {@link generate} with the
   * appropriate spec.
   *
   * @param packageName - The package name to look up in state.
   * @param state - The current `state.json` contents.
   * @returns A {@link LauncherResult} for the regenerated launcher.
   * @throws {LauncherError} with code `E_LAUNCHER_PACKAGE_NOT_IN_STATE`
   *   if `packageName` is not in `state.installed_packages`.
   */
  async regenerate(packageName: string, state: State): Promise<LauncherResult> {
    const entry = state.installed_packages.find((p) => p.name === packageName);
    if (!entry) {
      throw new LauncherError(
        `cannot regenerate launcher: package '${packageName}' is not in state.installed_packages`,
        {
          code: 'PACKAGE_NOT_IN_STATE',
          details: { packageName },
          fixCommand: `linuxify add ${packageName}`,
        },
      );
    }

    const launcherName = basename(entry.launcher_path);
    if (!launcherName || launcherName === '.' || launcherName === '..') {
      throw new LauncherError(
        `cannot regenerate launcher for '${packageName}': state entry has invalid launcher_path '${entry.launcher_path}'`,
        {
          code: 'INVALID_LAUNCHER_PATH',
          details: { packageName, launcherPath: entry.launcher_path },
        },
      );
    }

    const spec: LauncherSpec = {
      packageName: entry.name,
      launcherName,
      distro: entry.distro,
      variant: 'standard',
    };

    logger.debug('regenerating launcher from state', {
      packageName,
      launcherName,
      distro: entry.distro,
    });
    return this.generate(spec);
  }

  /**
   * Regenerate launchers for every package in `state.installed_packages`.
   *
   * Best-effort: if a single package's regeneration fails (e.g. its state
   * entry is malformed), the failure is logged at `warn` and the iteration
   * continues. The returned array contains only the launchers that were
   * successfully regenerated. This is the right behavior for `linuxify
   * repair launchers` and for the automatic regeneration triggered by
   * `linuxify use` / `linuxify upgrade` / `linuxify self-update`, where
   * blocking on one bad package would be a poor UX.
   *
   * @param state - The current `state.json` contents.
   * @returns An array of {@link LauncherResult} for each successfully
   *   regenerated launcher. May be shorter than `state.installed_packages`
   *   if some packages failed.
   */
  async regenerateAll(state: State): Promise<LauncherResult[]> {
    const results: LauncherResult[] = [];
    for (const entry of state.installed_packages) {
      try {
        const result = await this.regenerate(entry.name, state);
        results.push(result);
      } catch (e) {
        logger.warn('failed to regenerate launcher; continuing', {
          packageName: entry.name,
          error: (e as Error).message,
          code: (e as { code?: string }).code,
        });
      }
    }
    logger.info('regenerateAll complete', {
      total: state.installed_packages.length,
      succeeded: results.length,
      failed: state.installed_packages.length - results.length,
    });
    return results;
  }

  /**
   * Remove a launcher file. Idempotent: if the file does not exist, this
   * is a no-op (logged at `debug`).
   *
   * @param launcherName - The launcher filename (no path). Must not contain
   *   a path separator.
   * @throws {LauncherError} with code `E_LAUNCHER_INVALID_LAUNCHER_NAME`
   *   if `launcherName` contains a path separator.
   * @throws {LauncherError} with code `E_LAUNCHER_REMOVE_FAILED` if the
   *   removal fails for any reason other than ENOENT.
   */
  async remove(launcherName: string): Promise<void> {
    this.validateLauncherName(launcherName);
    const p = join(this.binDir, launcherName);
    try {
      await fsp.unlink(p);
      logger.info('launcher removed', { launcher: launcherName, path: p });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.debug('launcher already absent; nothing to remove', {
          launcher: launcherName,
          path: p,
        });
        return;
      }
      throw new LauncherError(
        `failed to remove launcher '${launcherName}': ${(e as Error).message}`,
        {
          code: 'REMOVE_FAILED',
          details: { launcher: launcherName, path: p },
          cause: e,
        },
      );
    }
  }

  /**
   * Check whether a launcher file exists.
   *
   * @param launcherName - The launcher filename (no path).
   * @returns `true` if the file exists, `false` otherwise (including when
   *   the parent directory does not exist).
   */
  async exists(launcherName: string): Promise<boolean> {
    this.validateLauncherName(launcherName);
    const p = join(this.binDir, launcherName);
    return exists(p);
  }

  /**
   * Enumerate every Linuxify-managed launcher in `$PREFIX/bin/`.
   *
   * A file is considered Linuxify-managed if its first 1 KiB contains the
   * substring {@link LINUXIFY_HEADER_SIGNATURE} (`"Auto-generated by Linuxify"`).
   * This catches all three variants (standard, direct, custom) without
   * false-positives on user-installed binaries that happen to share a name.
   *
   * For each matching file, the launcher name, package name, and variant
   * are parsed from the comment header (`# Package: <name>` and
   * `# Variant: <variant>`). If the header is malformed, the launcher name
   * defaults to the filename and the variant defaults to `standard`.
   *
   * @returns An array of {@link LauncherResult}, one per Linuxify launcher
   *   found. The order is unspecified (it follows `readdir` order, which
   *   is filesystem-dependent).
   */
  async list(): Promise<LauncherResult[]> {
    if (!(await exists(this.binDir))) {
      return [];
    }

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(this.binDir, { withFileTypes: true });
    } catch (e) {
      throw new LauncherError(
        `failed to enumerate launchers in ${this.binDir}: ${(e as Error).message}`,
        { code: 'LIST_FAILED', details: { dir: this.binDir }, cause: e },
      );
    }

    const results: LauncherResult[] = [];
    for (const entry of entries) {
      // Skip directories, symlinks, sockets, etc. — only regular files are
      // launchers. (Direct-variant launchers in this implementation are
      // also regular shell-script files, not symlinks — see ADR-004.)
      if (!entry.isFile()) continue;

      const filePath = join(this.binDir, entry.name);
      const head = await this.readHead(filePath);
      if (head === null) continue;
      if (!head.includes(LINUXIFY_HEADER_SIGNATURE)) continue;

      const packageName = parseHeaderField(head, 'Package') ?? entry.name;
      const variantStr = parseHeaderField(head, 'Variant');
      const variant = isLauncherVariant(variantStr) ? variantStr : 'standard';

      results.push({
        path: filePath,
        packageName,
        launcherName: entry.name,
        variant,
      });
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Validate a {@link LauncherSpec} before rendering. Throws on missing
   * required fields or path-traversal attempts in `launcherName`.
   */
  private validateSpec(spec: LauncherSpec): void {
    if (!spec) {
      throw new LauncherError('launcher spec is required', { code: 'INVALID_SPEC' });
    }
    if (!spec.packageName || spec.packageName.trim() === '') {
      throw new LauncherError('launcher spec.packageName is required', {
        code: 'INVALID_SPEC',
        details: { spec },
      });
    }
    if (!spec.distro || spec.distro.trim() === '') {
      throw new LauncherError('launcher spec.distro is required', {
        code: 'INVALID_SPEC',
        details: { spec },
      });
    }
    this.validateLauncherName(spec.launcherName);
  }

  /**
   * Validate that `launcherName` is a plain filename (no path separators,
   * not `.` or `..`). This prevents path-traversal attacks where a
   * malicious package YAML might set `launcher: ../../../etc/cron.d/backdoor`.
   */
  private validateLauncherName(launcherName: string): void {
    if (!launcherName || launcherName.trim() === '') {
      throw new LauncherError('launcher name is required', {
        code: 'INVALID_LAUNCHER_NAME',
      });
    }
    if (launcherName.includes('/') || launcherName.includes('\\')) {
      throw new LauncherError(
        `invalid launcher name '${launcherName}': must not contain a path separator`,
        { code: 'INVALID_LAUNCHER_NAME', details: { launcherName } },
      );
    }
    if (launcherName === '.' || launcherName === '..') {
      throw new LauncherError(`invalid launcher name '${launcherName}': must not be '.' or '..'`, {
        code: 'INVALID_LAUNCHER_NAME',
        details: { launcherName },
      });
    }
  }

  /**
   * Dispatch to the right template based on `spec.variant`. Throws on
   * unknown variants and on missing required variant-specific fields.
   */
  private renderTemplate(spec: LauncherSpec): string {
    switch (spec.variant) {
      case 'standard':
        return standardTemplate(spec);
      case 'direct':
        return directTemplate(spec, spec.binaryPath ?? '');
      case 'custom':
        return customTemplate(spec);
      default:
        throw new LauncherError(`unknown launcher variant: ${spec.variant as string}`, {
          code: 'UNKNOWN_VARIANT',
          details: { variant: spec.variant },
        });
    }
  }

  /**
   * Atomically write `content` to `filePath` with mode `0o755`.
   *
   * Uses the temp-file-then-rename pattern: writes to
   * `<filePath>.<pid>.<rand>.tmp`, then renames over `filePath`. On any
   * failure the temp file is best-effort unlinked. After the rename, an
   * explicit `chmod 0o755` is applied because some filesystems (notably
   * FAT-based emulated storage on Android) can drop mode bits during
   * rename.
   */
  private async writeExecutable(filePath: string, content: string): Promise<void> {
    const dir = dirname(filePath);
    await ensureDir(dir);

    const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmpPath, content, { encoding: 'utf8', mode: LAUNCHER_FILE_MODE });
      await fsp.rename(tmpPath, filePath);
      // Belt-and-suspenders: rename can drop mode bits on some filesystems.
      await fsp.chmod(filePath, LAUNCHER_FILE_MODE);
    } catch (e) {
      // Best-effort cleanup of the temp file on any failure path.
      await fsp.unlink(tmpPath).catch(() => void 0);
      throw new LauncherError(
        `failed to write launcher '${basename(filePath)}': ${(e as Error).message}`,
        {
          code: 'WRITE_FAILED',
          details: { path: filePath },
          cause: e,
        },
      );
    }
  }

  /**
   * Read up to {@link HEADER_SCAN_BYTES} bytes from the beginning of
   * `filePath` as UTF-8. Returns `null` if the file cannot be read (it
   * may have been deleted between the `readdir` and the read, or it may
   * be a binary file that produces invalid UTF-8).
   *
   * Reading only the first 1 KiB avoids loading large non-launcher
   * binaries into memory during `list()`.
   */
  private async readHead(filePath: string): Promise<string | null> {
    let handle;
    try {
      handle = await fsp.open(filePath, 'r');
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(HEADER_SCAN_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEADER_SCAN_BYTES, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return null;
    } finally {
      await handle.close().catch(() => void 0);
    }
  }
}

// -------------------------------------------------------------------------
// Header parsing helpers (module-private)
// -------------------------------------------------------------------------

/**
 * Parse a `# Field: value` line from the launcher header. Returns the
 * trimmed value, or `undefined` if the field is not present. Matches the
 * first occurrence of the field (later duplicates are ignored).
 *
 * @param head - The first ~1 KiB of the launcher file.
 * @param field - The field name (e.g. `Package`, `Variant`).
 * @returns The trimmed value, or `undefined`.
 */
function parseHeaderField(head: string, field: string): string | undefined {
  // Match `# Field: value` where leading whitespace and trailing whitespace
  // are tolerated. The field name is case-sensitive (matches the template
  // output exactly).
  const re = new RegExp(`^#\\s*${field}:\\s*(.+?)\\s*$`, 'm');
  const m = head.match(re);
  return m ? m[1] : undefined;
}

/**
 * Type-guard: returns `true` if `v` is a valid {@link LauncherVariant}.
 * Used to narrow the result of {@link parseHeaderField} for the `Variant`
 * field, defaulting to `'standard'` if the value is unrecognized.
 */
function isLauncherVariant(v: string | undefined): v is LauncherVariant {
  return v === 'standard' || v === 'direct' || v === 'custom';
}
