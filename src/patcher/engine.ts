/**
 * Patcher engine — applies text transformations to CLI tool source files.
 *
 * @module linuxify/patcher/engine
 *
 * The engine is the core of `linuxify add`'s patch step. It takes a
 * {@link PatchDefinition} (parsed from the package YAML) and a
 * {@link PatchContext} (install path + distro + state store), and
 * produces a {@link PatchResult}. The engine is the only component that
 * touches disk for writes — the per-type handlers return transformed
 * content in memory, and the engine handles backup, atomic write,
 * verify, and state recording.
 *
 * ## Pipeline (per patch)
 *
 *   1. Resolve the target file path (relative to `ctx.packageInstallPath`).
 *      Reject path-traversal escapes with `E_PATCH_PATH_OUTSIDE_ROOT`.
 *   2. Idempotency: look up the patch in `state.applied_patches`. If
 *      already applied and `force` is not set, return a "skipped" result.
 *   3. Read the file. If missing, throw `E_PATCH_FILE_NOT_FOUND`.
 *   4. Compute the original SHA-256 (for state record + conflict check).
 *   5. Backup the original to `~/.linuxify/patches/<pkg>/backups/<patch_id>.orig`.
 *   6. Dispatch to the patch-type handler. If the handler returns
 *      `success: false`, throw `E_PATCH_NO_MATCH` (the file may have
 *      been reformatted upstream; the patch's `find` pattern is stale).
 *   7. Write the patched content atomically (temp file + rename).
 *   8. Run the verify command (unless `skipVerify`). On failure, restore
 *      the backup and return a "failed" result (or throw
 *      `E_PATCH_VERIFY_FAILED` if the caller prefers exceptions).
 *   9. Compute the patched SHA-256.
 *  10. Record a `PatchApplication` entry in `state.applied_patches` and
 *      a per-patch JSON record at `~/.linuxify/patches/<pkg>/<NNN>.json`.
 *  11. Return a "success" {@link PatchResult}.
 *
 * ## Batch semantics
 *
 * `applyPatches(patches, ctx, opts?)` applies patches in declaration
 * order. If any patch fails (returns `success: false`), the engine rolls
 * back all patches applied earlier in the same batch (in reverse order),
 * so the install is left in a clean state — no half-applied patches.
 *
 * ## Safety
 *
 *  - **Path traversal**: the `file` field is resolved against
 *    `ctx.packageInstallPath` and the resolved path is checked to be
 *    *inside* the install root. Escapes (`../../../etc/passwd`) are
 *    rejected with `E_PATCH_PATH_OUTSIDE_ROOT`.
 *  - **Atomic writes**: patched content is written via
 *    `utils/fs.writeFile` (temp file + rename). A SIGKILL at any point
 *    leaves either the original or the patched file, never a half-write.
 *  - **Verify before commit**: the verify command runs *after* the
 *    patched content is on disk but *before* the patch is recorded in
 *    state. On failure, the backup is restored and the state is never
 *    touched, so a failed patch leaves no trace.
 *  - **Forbidden verify patterns**: the verify command is linted
 *    (`verify.ts`) before it is run; dangerous patterns (`rm -rf /`,
 *    `curl | sh`, `mkfs`, …) are refused with `E_PATCH_FORBIDDEN_VERIFY`.
 *
 * See `docs/08-patcher/patcher-engine.md` §4 (pipeline), §6 (verify),
 * §7 (rollback), §9 (conflict detection), §14 (safety) for the prose.
 *
 * @packageDocumentation
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { PatcherError } from '../utils/errors.js';
import { logger } from '../utils/log.js';
import {
  ensureDir,
  exists,
  readFile,
  writeFile,
  writeJson,
  copyFile,
  rmrf,
} from '../utils/fs.js';
import { sha256 } from '../utils/crypto.js';
import { getLinuxifyHome } from '../utils/process.js';
import { LINUXIFY_VERSION } from '../utils/constants.js';
import type { StateStore, PatchApplication } from '../state/index.js';
import type { PatchDefinition } from '../packages/index.js';

import type {
  ApplyPatchesOptions,
  PatchContext,
  PatchHandlerResult,
  PatchResult,
  PatchTypeHandler,
} from './types.js';
import { verifyPatch } from './verify.js';
import { getPatchTypeHandler } from './types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the absolute path to the backups directory for a package.
 *
 * @param packageName - The package name (e.g. `cline`).
 * @returns `~/.linuxify/patches/<pkg>/backups/`.
 */
function backupsDir(packageName: string): string {
  return path.join(getLinuxifyHome(), 'patches', packageName, 'backups');
}

/**
 * Compute the absolute path to a patch's `.orig` backup file.
 *
 * @param packageName - The package name.
 * @param patchId - The patch's stable `<pkg>-<NNN>` id.
 * @returns `~/.linuxify/patches/<pkg>/backups/<patch_id>.orig`.
 */
function backupPath(packageName: string, patchId: string): string {
  // Sanitize the patchId for use as a filename. The convention is
  // `<pkg>-<NNN>` (e.g. `cline-001`), which is already filename-safe,
  // but defensive sanitization costs nothing and protects against a
  // future plugin that registers a patch with an unusual id.
  const safe = patchId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(backupsDir(packageName), `${safe}.orig`);
}

/**
 * Compute the directory holding per-patch JSON records for a package.
 *
 * @param packageName - The package name.
 * @returns `~/.linuxify/patches/<pkg>/`.
 */
function patchesDir(packageName: string): string {
  return path.join(getLinuxifyHome(), 'patches', packageName);
}

/**
 * Compute the path to a per-patch JSON record.
 *
 * The filename is `<NNN>.json` where `<NNN>` is a zero-padded 3-digit
 * sequence number (001, 002, …) scoped to the package. The sequence is
 * assigned at record-write time based on the current count of records
 * in the package's patches directory (so re-applying a patch after a
 * rollback gets a fresh number rather than reusing the rolled-back one).
 *
 * @param packageName - The package name.
 * @param seq - The 1-based sequence number.
 * @returns `~/.linuxify/patches/<pkg>/<NNN>.json`.
 */
function recordPath(packageName: string, seq: number): string {
  const padded = String(seq).padStart(3, '0');
  return path.join(patchesDir(packageName), `${padded}.json`);
}

/**
 * Resolve a patch's `file` field against the install root, refusing
 * path-traversal escapes.
 *
 * @param file - The patch's `file` field (relative or absolute).
 * @param installPath - The package install root (absolute).
 * @returns The resolved absolute path, guaranteed to be inside
 *   `installPath`.
 * @throws {PatcherError} with code `E_PATCH_PATH_OUTSIDE_ROOT` if the
 *   resolved path escapes the install root.
 */
function resolvePatchFile(file: string, installPath: string): string {
  const abs = path.resolve(installPath, file);
  const rel = path.relative(installPath, abs);
  // `path.relative` returns a string starting with `..` if `abs` is
  // outside `installPath`, or an absolute path on Windows if the two
  // are on different drives. Either case is an escape.
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PatcherError(
      `Patch file '${file}' resolves outside install root '${installPath}'`,
      {
        code: 'E_PATCH_PATH_OUTSIDE_ROOT',
        details: { file, installPath, resolved: abs, relative: rel },
        docsUrl:
          'https://docs.linuxify.dev/08-patcher/patcher-engine#safety',
      },
    );
  }
  return abs;
}

/**
 * Per-patch JSON record shape. Written to
 * `~/.linuxify/patches/<pkg>/<NNN>.json` (see patcher-engine.md §4).
 * Contains the verbatim patch definition plus the original/patched
 * hashes, timestamps, and the Linuxify version — everything needed to
 * audit or rollback the patch without consulting the original YAML.
 */
interface PatchRecord {
  /** The patch's stable `<pkg>-<NNN>` id (e.g. `cline-001`). */
  readonly patch_id: string;
  /** The user-facing id (e.g. `fix-platform-check`). */
  readonly id: string;
  /** One-sentence description from the YAML. */
  readonly description: string;
  /** Package name. */
  readonly package: string;
  /** File path (relative to install root, as in the YAML). */
  readonly file: string;
  /** Patch type (`regex`/`sed`/`shell`/`ast-js`/…). */
  readonly type: string;
  /** The `find` string from the YAML. */
  readonly find: string;
  /** The `replace` string from the YAML. */
  readonly replace: string;
  /** The `verify` command from the YAML. */
  readonly verify: string;
  /** SHA-256 of the original file content. */
  readonly original_sha256: string;
  /** SHA-256 of the patched file content. */
  readonly patched_sha256: string;
  /** ISO timestamp when the patch was applied. */
  readonly applied_at: string;
  /** Linuxify CLI version that applied the patch. */
  readonly linuxify_version: string;
  /** Path to the `.orig` backup file. */
  readonly rollback_path: string;
  /** Whether the verify command exited 0. */
  readonly verified: boolean;
}

/**
 * Patcher error codes that {@link PatcherEngine.applyPatches} treats as
 * "recoverable" — the patch failed, but the batch can continue to roll
 * back previously-applied patches and return a failure result instead
 * of throwing.
 *
 * Unrecoverable errors (path escape, forbidden verify, type unsupported,
 * type unknown) cause `applyPatches` to roll back and re-throw, because
 * they indicate a structural problem with the YAML that will affect
 * every subsequent patch too.
 */
const RECOVERABLE_PATCH_ERRORS = new Set([
  'E_PATCH_NO_MATCH',
  'E_PATCH_FILE_NOT_FOUND',
]);

// ---------------------------------------------------------------------------
// PatcherEngine
// ---------------------------------------------------------------------------

/**
 * Applies text transformations to CLI tool source files.
 *
 * One `PatcherEngine` instance is typically created per CLI invocation
 * and shared across install/patch/rollback commands via the command
 * context. The engine is stateless aside from the {@link StateStore}
 * reference it holds — all per-patch state lives in `state.json` and
 * the `~/.linuxify/patches/<pkg>/` directory tree.
 *
 * ## Error model
 *
 * `applyPatch` returns a {@link PatchResult} with `success: false` on
 * recoverable failures (verify failed, no match, file not found). It
 * throws {@link PatcherError} on unrecoverable failures (path escape,
 * forbidden verify pattern, type unsupported, state corruption). The
 * distinction lets `applyPatches` decide whether to roll back the batch
 * (recoverable) or abort entirely (unrecoverable).
 */
export class PatcherEngine {
  /** Shared state store; the engine reads/writes `state.applied_patches`. */
  private readonly stateStore: StateStore;

  /**
   * @param opts - Constructor options.
   * @param opts.stateStore - The shared {@link StateStore}. The engine
   *   uses `stateStore.update()` to atomically mutate `state.applied_patches`.
   */
  constructor(opts: { stateStore: StateStore }) {
    if (!opts?.stateStore) {
      throw new PatcherError('PatcherEngine requires a stateStore', {
        code: 'E_PATCH_GENERIC',
      });
    }
    this.stateStore = opts.stateStore;
  }

  /**
   * Apply a single patch to a file inside the package's install root.
   *
   * See the module docstring for the full pipeline. This method does
   * NOT take `force` or `skipVerify` — those are batch-level options
   * on {@link applyPatches}. To apply a single patch with `force`,
   * call `applyPatches([patch], ctx, { force: true })`.
   *
   * @param patch - The patch definition (from package YAML).
   * @param ctx - The patch context (install path, distro, state store).
   * @returns A {@link PatchResult}. `success: true` means the file is
   *   now in the patched state (or was already patched and skipped);
   *   `success: false` means the patch failed and the file was rolled
   *   back to its original state.
   * @throws {PatcherError} for unrecoverable failures (path escape,
   *   forbidden verify, type unsupported, type unknown, state errors).
   */
  async applyPatch(patch: PatchDefinition, ctx: PatchContext): Promise<PatchResult> {
    return this._applyOne(patch, ctx, { force: false, skipVerify: false });
  }

  /**
   * Apply multiple patches in declaration order. If any patch fails
   * (returns `success: false`), all previously-applied patches in this
   * batch are rolled back in reverse order, leaving the install in a
   * clean state.
   *
   * @param patches - The patch definitions to apply, in order.
   * @param ctx - The patch context.
   * @param opts - Batch options (`force`, `skipVerify`, `onProgress`).
   * @returns An array of {@link PatchResult}, one per patch. If the
   *   batch was rolled back, the failed patch's result has
   *   `success: false`; the rolled-back patches have their original
   *   results (with `applied: true`) but the files on disk have been
   *   restored to their pre-batch state.
   */
  async applyPatches(
    patches: readonly PatchDefinition[],
    ctx: PatchContext,
    opts: ApplyPatchesOptions = {},
  ): Promise<PatchResult[]> {
    const results: PatchResult[] = [];
    const appliedInBatch: PatchDefinition[] = [];

    for (const patch of patches) {
      opts.onProgress?.(`applying ${patch.patch_id}`);
      let result: PatchResult;
      try {
        result = await this._applyOne(patch, ctx, {
          force: opts.force ?? false,
          skipVerify: opts.skipVerify ?? false,
        });
      } catch (err) {
        // Recoverable errors (no-match, file-not-found): convert to a
        // failure PatchResult, roll back the batch, and stop.
        if (err instanceof PatcherError && RECOVERABLE_PATCH_ERRORS.has(err.code)) {
          result = {
            patchId: patch.patch_id,
            success: false,
            file: path.resolve(ctx.packageInstallPath, patch.file),
            applied: false,
            verified: false,
            error: err.message,
            durationMs: 0,
          };
          results.push(result);
          logger.warn(
            { patchId: patch.patch_id, code: err.code, error: err.message },
            'patch failed — rolling back batch',
          );
          await this._rollbackBatch(appliedInBatch, ctx);
          // Mark previously-applied patches in the results array as
          // rolled back (applied=false). The caller sees that the
          // patches were attempted but ultimately undone.
          for (let i = 0; i < appliedInBatch.length && i < results.length - 1; i++) {
            const r = results[i]!;
            results[i] = { ...r, applied: false };
          }
          break;
        }
        // Unrecoverable error (path escape, forbidden verify, type
        // unsupported, …). Roll back the batch and re-throw so the
        // caller sees the structural failure.
        await this._rollbackBatch(appliedInBatch, ctx);
        throw err;
      }
      results.push(result);
      if (result.applied) {
        appliedInBatch.push(patch);
      }
      if (!result.success) {
        // Recoverable failure returned from _applyOne (e.g. verify
        // failed). Roll back the batch and stop.
        logger.warn(
          { patchId: patch.patch_id, error: result.error },
          'patch failed — rolling back batch',
        );
        await this._rollbackBatch(appliedInBatch, ctx);
        for (let i = 0; i < appliedInBatch.length && i < results.length - 1; i++) {
          const r = results[i]!;
          results[i] = { ...r, applied: false };
        }
        break;
      }
    }

    return results;
  }

  /**
   * Roll back a single patch by its ID. Restores the original file from
   * the `.orig` backup and removes the patch from state.
   *
   * @param patchId - The patch's stable `<pkg>-<NNN>` id.
   * @param packageName - The package name.
   * @param ctx - The patch context (used for the install path; the
   *   backup path is computed from `getLinuxifyHome()`).
   * @returns `true` if the patch was rolled back; `false` if the patch
   *   was not found in state (nothing to roll back).
   * @throws {PatcherError} with code `E_PATCH_BACKUP_MISSING` if the
   *   backup file is missing.
   * @throws {PatcherError} with code `E_PATCH_CONFLICT` if the current
   *   file's hash does not match the `patched_hash` recorded in state
   *   (the file was modified externally; refusing to roll back).
   */
  async rollbackPatch(
    patchId: string,
    packageName: string,
    ctx: PatchContext,
  ): Promise<boolean> {
    const state = await this.stateStore.load();
    const entry = state.applied_patches.find(
      (p) => p.patch_id === patchId && p.package === packageName,
    );
    if (!entry) {
      logger.debug(
        { patchId, packageName },
        'rollback: patch not in state — nothing to do',
      );
      return false;
    }

    // Sanity check: the recorded target file should be inside the
    // package install root from ctx. If it isn't (e.g. state was
    // corrupted or the package was moved), we still attempt the
    // rollback but log a warning so the user can investigate.
    const relToInstall = path.relative(ctx.packageInstallPath, entry.applied_to_file);
    if (relToInstall.startsWith('..') || path.isAbsolute(relToInstall)) {
      logger.warn(
        {
          patchId,
          file: entry.applied_to_file,
          installRoot: ctx.packageInstallPath,
        },
        'rollback target file is outside current install root — proceeding anyway',
      );
    }

    const backup = entry.rollback_path;
    if (!(await exists(backup))) {
      throw new PatcherError(
        `Backup file missing for patch '${patchId}' (expected at ${backup}); ` +
          `cannot roll back — reinstall the package to restore original files`,
        {
          code: 'E_PATCH_BACKUP_MISSING',
          details: { patchId, packageName, expectedBackup: backup },
          docsUrl: 'https://docs.linuxify.dev/08-patcher/patcher-engine#rollback',
        },
      );
    }

    // Conflict check: if the current file's hash differs from the
    // `patched_hash` recorded in state, the file was modified externally
    // (e.g. by `npm update -g` overwriting the patched file). Restoring
    // the backup would clobber those external changes, so we refuse.
    const targetExists = await exists(entry.applied_to_file);
    if (targetExists) {
      const currentContent = await readFile(entry.applied_to_file);
      const currentHash = sha256(currentContent);
      if (currentHash !== entry.patched_hash) {
        throw new PatcherError(
          `Cannot roll back patch '${patchId}': target file ` +
            `'${entry.applied_to_file}' was modified externally ` +
            `(current sha256 ${currentHash.slice(0, 8)}… ≠ ` +
            `recorded patched_hash ${entry.patched_hash.slice(0, 8)}…). ` +
            `Reinstall the package if you want to start fresh.`,
          {
            code: 'E_PATCH_CONFLICT',
            details: {
              patchId,
              packageName,
              file: entry.applied_to_file,
              currentHash,
              expectedHash: entry.patched_hash,
            },
          },
        );
      }
    }

    // Restore the backup. `copyFile` overwrites the target atomically
    // on most filesystems (it uses `fs.copyFile` which on Linux is a
    // single syscall). For stronger atomicity guarantees we could write
    // to a temp file + rename, but `copyFile` is good enough for v0.1.
    await ensureDir(path.dirname(entry.applied_to_file));
    await copyFile(backup, entry.applied_to_file);

    // Remove the patch from state.
    await this.stateStore.update((s) => {
      s.applied_patches = s.applied_patches.filter(
        (p) => !(p.patch_id === patchId && p.package === packageName),
      );
    });

    // Best-effort: delete the per-patch JSON record. We don't track
    // which `<NNN>.json` file corresponds to this patch in state, so
    // we scan the package's patches directory and delete any record
    // whose `patch_id` matches. This is O(n) in the number of records
    // but n is typically <10.
    await this._deleteRecordFiles(packageName, patchId);

    logger.info(
      { patchId, packageName, file: entry.applied_to_file },
      'patch rolled back',
    );
    return true;
  }

  /**
   * Roll back all patches for a package, in reverse order of application.
   *
   * Reads the package's `applied_patches` entries from state, sorts
   * them by `applied_at` descending (most-recent first), and rolls
   * each back via {@link rollbackPatch}. Best-effort: if a single
   * rollback fails (e.g. backup missing), the failure is logged and
   * the iteration continues so one bad patch doesn't block the others.
   *
   * @param packageName - The package name.
   * @param ctx - The patch context.
   */
  async rollbackAll(packageName: string, ctx: PatchContext): Promise<void> {
    const state = await this.stateStore.load();
    const entries = state.applied_patches
      .filter((p) => p.package === packageName)
      // Reverse-chronological order: most-recently-applied first.
      .sort((a, b) => b.applied_at.localeCompare(a.applied_at));

    for (const entry of entries) {
      try {
        await this.rollbackPatch(entry.patch_id, packageName, ctx);
      } catch (err) {
        // Log and continue — one failed rollback shouldn't block the
        // others. The caller can inspect state to see which patches
        // remain.
        logger.error(
          {
            patchId: entry.patch_id,
            packageName,
            err: (err as Error).message,
          },
          'rollback failed for patch — continuing',
        );
      }
    }
  }

  /**
   * List all patches applied to a package, in chronological order.
   *
   * @param packageName - The package name.
   * @returns An array of {@link PatchApplication} entries, oldest
   *   first. Empty if no patches have been applied.
   */
  async listApplied(packageName: string): Promise<PatchApplication[]> {
    const state = await this.stateStore.load();
    return state.applied_patches
      .filter((p) => p.package === packageName)
      .sort((a, b) => a.applied_at.localeCompare(b.applied_at));
  }

  /**
   * Check whether a specific patch is currently applied.
   *
   * @param patchId - The patch's stable `<pkg>-<NNN>` id.
   * @param packageName - The package name.
   * @returns `true` if the patch is recorded in `state.applied_patches`.
   */
  async isApplied(patchId: string, packageName: string): Promise<boolean> {
    const state = await this.stateStore.load();
    return state.applied_patches.some(
      (p) => p.patch_id === patchId && p.package === packageName,
    );
  }

  // -------------------------------------------------------------------------
  // Private internals
  // -------------------------------------------------------------------------

  /**
   * Internal single-patch apply with full options. Shared by
   * {@link applyPatch} (default opts) and {@link applyPatches} (per-
   * batch opts).
   */
  private async _applyOne(
    patch: PatchDefinition,
    ctx: PatchContext,
    opts: { force: boolean; skipVerify: boolean },
  ): Promise<PatchResult> {
    const start = Date.now();
    const packageName = ctx.packageInstallPath.split('/').filter(Boolean).pop() ?? '';

    // 1. Resolve + path-traversal check.
    const filePath = resolvePatchFile(patch.file, ctx.packageInstallPath);

    // 2. Idempotency: look up in state. If applied and not force, skip.
    if (!opts.force) {
      const already = await this.isApplied(patch.patch_id, packageName);
      if (already) {
        logger.debug(
          { patchId: patch.patch_id, file: patch.file },
          'patch already applied — skipping',
        );
        return {
          patchId: patch.patch_id,
          success: true,
          file: filePath,
          applied: false,
          verified: true,
          error: 'already applied',
          durationMs: Date.now() - start,
        };
      }
    }

    // 3. Read the file. Throw E_PATCH_FILE_NOT_FOUND if missing.
    if (!(await exists(filePath))) {
      throw new PatcherError(
        `Patch target file not found: ${filePath}`,
        {
          code: 'E_PATCH_FILE_NOT_FOUND',
          details: { patchId: patch.patch_id, file: patch.file, resolved: filePath },
          docsUrl:
            'https://docs.linuxify.dev/08-patcher/patcher-engine#authoring',
        },
      );
    }
    const originalContent = await readFile(filePath);

    // 4. Compute original sha256.
    const originalHash = sha256(originalContent);

    // 5. Backup the original.
    const backup = backupPath(packageName, patch.patch_id);
    await ensureDir(path.dirname(backup));
    await copyFile(filePath, backup);

    // 6. Dispatch to the patch-type handler.
    const handler = this._lookupHandler(patch);
    let patchedContent: string;
    let handlerResult: PatchHandlerResult;
    try {
      handlerResult = await handler.apply(originalContent, patch, ctx);
    } catch (err) {
      // Re-throw PatcherError as-is (E_PATCH_TYPE_UNSUPPORTED, etc.)
      // so the caller sees the precise code.
      if (err instanceof PatcherError) {
        throw err;
      }
      // Otherwise wrap as E_PATCH_APPLY_FAILED.
      throw new PatcherError(
        `Patch handler threw for '${patch.patch_id}': ${(err as Error).message}`,
        {
          code: 'E_PATCH_APPLY_FAILED',
          details: { patchId: patch.patch_id, type: patch.type },
          cause: err,
        },
      );
    }
    if (!handlerResult.success) {
      // No-match: the patch's `find` pattern didn't match. The file
      // may have been reformatted upstream. Throw so the caller can
      // decide whether to abort the batch.
      throw new PatcherError(
        `Patch '${patch.patch_id}' did not match any content in ${patch.file} ` +
          `(the file may have been reformatted or updated; update the patch's 'find' pattern)`,
        {
          code: 'E_PATCH_NO_MATCH',
          details: {
            patchId: patch.patch_id,
            file: patch.file,
            type: patch.type,
            find: patch.find,
          },
          docsUrl:
            'https://docs.linuxify.dev/08-patcher/patcher-engine#authoring',
        },
      );
    }
    patchedContent = handlerResult.result;

    // 7. Write the patched content atomically.
    await writeFile(filePath, patchedContent);

    // 8. Verify (unless skipVerify).
    let verified = true;
    if (!opts.skipVerify) {
      const verifyResult = await verifyPatch(patch, ctx);
      verified = verifyResult.ok;
      if (!verified) {
        // Roll back: restore the backup.
        await copyFile(backup, filePath);
        return {
          patchId: patch.patch_id,
          success: false,
          file: filePath,
          applied: false,
          verified: false,
          error: `verify failed (exit ${verifyResult.exitCode}): ${verifyResult.stderr.trim() || verifyResult.stdout.trim()}`,
          durationMs: Date.now() - start,
        };
      }
    }

    // 9. Compute patched sha256.
    const patchedHash = sha256(patchedContent);

    // 10. Record in state + write per-patch JSON record.
    const appliedAt = new Date().toISOString();
    const app: PatchApplication = {
      patch_id: patch.patch_id,
      package: packageName,
      applied_at: appliedAt,
      applied_to_file: filePath,
      original_hash: originalHash,
      patched_hash: patchedHash,
      rollback_path: backup,
      verified,
    };
    await this.stateStore.update((s) => {
      // Idempotency: if force=true and the patch is already in state
      // (from a prior apply), replace the existing entry rather than
      // appending a duplicate.
      const existingIdx = s.applied_patches.findIndex(
        (p) => p.patch_id === patch.patch_id && p.package === packageName,
      );
      if (existingIdx >= 0) {
        s.applied_patches[existingIdx] = app;
      } else {
        s.applied_patches.push(app);
      }
    });

    await this._writeRecord(packageName, patch, {
      originalHash,
      patchedHash,
      appliedAt,
      backupPath: backup,
      verified,
    });

    logger.info(
      { patchId: patch.patch_id, file: patch.file, durationMs: Date.now() - start },
      'patch applied',
    );

    return {
      patchId: patch.patch_id,
      success: true,
      file: filePath,
      applied: true,
      verified,
      durationMs: Date.now() - start,
    };
  }

  /**
   * Look up the handler for a patch's type. Throws
   * `E_PATCH_TYPE_UNKNOWN` if no handler is registered (the type
   * string is not in the registry and no plugin has registered it).
   */
  private _lookupHandler(patch: PatchDefinition): PatchTypeHandler {
    const handler = getPatchTypeHandler(patch.type);
    if (!handler) {
      throw new PatcherError(
        `Unknown patch type '${patch.type}' for patch '${patch.patch_id}'`,
        {
          code: 'E_PATCH_TYPE_UNKNOWN',
          details: { type: patch.type, patchId: patch.patch_id },
        },
      );
    }
    return handler;
  }

  /**
   * Write the per-patch JSON record at
   * `~/.linuxify/patches/<pkg>/<NNN>.json`. The sequence number is
   * derived from the count of existing records in the package's
   * patches directory (so re-applying a patch after a rollback gets a
   * fresh number rather than reusing the rolled-back one).
   */
  private async _writeRecord(
    packageName: string,
    patch: PatchDefinition,
    meta: {
      originalHash: string;
      patchedHash: string;
      appliedAt: string;
      backupPath: string;
      verified: boolean;
    },
  ): Promise<void> {
    const dir = patchesDir(packageName);
    await ensureDir(dir);
    // Scan for existing <NNN>.json files to determine the next sequence
    // number. We use the count of existing files + 1; gaps from deleted
    // records are not filled (so a sequence like 001, 002, 004 is
    // possible after a rollback of 003). This is fine — the sequence
    // is for human readability, not for ordering (ordering comes from
    // `applied_at` in state).
    let nextSeq = 1;
    try {
      const entries = await fsp.readdir(dir);
      const nums = entries
        .filter((e) => /^\d{3}\.json$/.test(e))
        .map((e) => parseInt(e.slice(0, 3), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length > 0) {
        nextSeq = Math.max(...nums) + 1;
      }
    } catch {
      // Directory doesn't exist or isn't readable — start at 1.
      nextSeq = 1;
    }

    const record: PatchRecord = {
      patch_id: patch.patch_id,
      id: patch.id,
      description: patch.description,
      package: packageName,
      file: patch.file,
      type: patch.type,
      find: patch.find,
      replace: patch.replace,
      verify: patch.verify,
      original_sha256: meta.originalHash,
      patched_sha256: meta.patchedHash,
      applied_at: meta.appliedAt,
      linuxify_version: LINUXIFY_VERSION,
      rollback_path: meta.backupPath,
      verified: meta.verified,
    };
    await writeJson(recordPath(packageName, nextSeq), record);
  }

  /**
   * Delete any per-patch JSON records whose `patch_id` matches the
   * given id. Used during rollback to clean up the `~/.linuxify/patches/
   * <pkg>/` directory. Best-effort: errors are logged but not thrown.
   */
  private async _deleteRecordFiles(packageName: string, patchId: string): Promise<void> {
    const dir = patchesDir(packageName);
    if (!(await exists(dir))) return;
    let entries: string[];
    try {
      entries = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!/^\d{3}\.json$/.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      try {
        const content = await readFile(fullPath);
        const parsed = JSON.parse(content) as { patch_id?: string };
        if (parsed.patch_id === patchId) {
          await rmrf(fullPath);
        }
      } catch {
        // Malformed record file — skip it. Don't delete what we can't
        // parse; the user might be able to recover it manually.
      }
    }
  }

  /**
   * Roll back a batch of patches (used by `applyPatches` when one
   * patch fails). Iterates in reverse order and calls `rollbackPatch`
   * for each. Best-effort: individual failures are logged.
   */
  private async _rollbackBatch(
    applied: readonly PatchDefinition[],
    ctx: PatchContext,
  ): Promise<void> {
    // Reverse order: most-recently-applied first.
    for (let i = applied.length - 1; i >= 0; i--) {
      const patch = applied[i]!;
      const packageName =
        ctx.packageInstallPath.split('/').filter(Boolean).pop() ?? '';
      try {
        await this.rollbackPatch(patch.patch_id, packageName, ctx);
      } catch (err) {
        logger.error(
          {
            patchId: patch.patch_id,
            err: (err as Error).message,
          },
          'batch rollback failed for patch',
        );
      }
    }
  }
}
