/**
 * Patcher type definitions.
 *
 * @module linuxify/patcher/types
 *
 * The patcher subsystem applies text transformations to CLI tool source
 * files to fix platform/arch/path issues encountered when running Linux-
 * oriented developer CLIs inside a Linuxify-managed proot on Android (see
 * `docs/08-patcher/patcher-engine.md`). This module defines the type
 * surface consumed by the engine, the per-type handlers, and the verify
 * step.
 *
 * The runtime {@link PatchDefinition} (declared in a package's YAML and
 * parsed by the packages subsystem) is *reused* — we do not redefine it
 * here, so the YAML schema and the patcher's runtime representation cannot
 * drift apart.
 *
 * Design notes:
 *  - `PatchType` is the literal union from `packages/schema.ts`'s
 *    `PatchTypeSchema`. Keeping them in sync means a YAML declaring
 *    `type: regex` is type-checked end-to-end.
 *  - `PatchApplication` mirrors the shape in `state/schema.ts`'s
 *    `PatchApplicationSchema` exactly so that recording a patch in
 *    `state.json` requires no field renaming.
 *  - `PatchContext` carries everything a handler needs (install path,
 *    distro name, state store) without reaching into the engine's private
 *    state — handlers stay pure functions of `(content, patch, ctx)`.
 *
 * @packageDocumentation
 */

import type { StateStore } from '../state/index.js';
import type { PatchDefinition, PatchType } from '../packages/index.js';

// Re-export the patch type union and patch definition so callers can import
// everything they need from this module without reaching into packages.
export type { PatchDefinition, PatchType };

/**
 * Result of running a patch's `verify` command. Mirrors the data the
 * engine needs to decide whether to commit the patch or roll it back.
 */
export interface VerifyResult {
  /** Whether the verify command exited 0. */
  readonly ok: boolean;
  /** The verify command's exit code (0 on success). */
  readonly exitCode: number;
  /** Captured stderr, surfaced in failure diagnostics. */
  readonly stderr: string;
  /** Captured stdout, surfaced in `--json` failure output. */
  readonly stdout: string;
}

/**
 * A persisted record of a successfully-applied patch, mirrored into
 * `state.json`'s `applied_patches` array. The full per-patch record (with
 * the verbatim YAML definition, find/replace, and Linuxify version) also
 * lives at `~/.linuxify/patches/<pkg>/<NNN>.json` (see `engine.ts`).
 *
 * Field names are `snake_case` to match the on-disk JSON shape enforced by
 * `state/schema.ts`'s `PatchApplicationSchema` (`.strict()`).
 */
export interface PatchApplication {
  /** Stable `<pkg>-<NNN>` identifier (e.g. `cline-001`). */
  readonly patch_id: string;
  /** Package name the patch was applied to. */
  readonly package: string;
  /** ISO timestamp when the patch was applied. */
  readonly applied_at: string;
  /** Absolute path to the file the patch was applied to. */
  readonly applied_to_file: string;
  /** SHA-256 of the original (pre-patch) file content. */
  readonly original_hash: string;
  /** SHA-256 of the patched file content. */
  readonly patched_hash: string;
  /** Path to the `.orig` backup file used for rollback. */
  readonly rollback_path: string;
  /** Whether the verify command exited 0 after the patch was applied. */
  readonly verified: boolean;
}

/**
 * Outcome of a single `applyPatch` call. The engine always returns a
 * `PatchResult` (never throws on verify failure — it returns a result
 * with `success: false`); callers inspect `success` to decide whether to
 * abort a batch.
 *
 * The `applied` flag distinguishes "patch was committed to disk and
 * recorded in state" from "patch was skipped (already applied) or rolled
 * back (verify failed)". `verified` is only `true` when both the verify
 * step ran and passed.
 */
export interface PatchResult {
  /** The patch's stable `<pkg>-<NNN>` id. */
  readonly patchId: string;
  /** `true` if the file is now in the patched state and recorded. */
  readonly success: boolean;
  /** Absolute path of the file the patch targeted. */
  readonly file: string;
  /** `true` if the patch was committed to disk and recorded in state. */
  readonly applied: boolean;
  /** `true` if the verify step ran and passed. `false` if skipped or failed. */
  readonly verified: boolean;
  /** Error message (only present when `success` is `false`). */
  readonly error?: string;
  /** Wall-clock duration of the apply call in milliseconds. */
  readonly durationMs: number;
}

/**
 * Options accepted by {@link PatcherEngine.applyPatches}. All fields are
 * optional; the defaults are `force: false`, `skipVerify: false`, no
 * progress callback.
 */
export interface ApplyPatchesOptions {
  /**
   * Re-apply a patch even if state records it as already applied. The
   * original file is re-backed-up (overwriting any prior `.orig`) before
   * the new transformation is applied. Use when the upstream file has
   * been overwritten (e.g. by `npm update -g`) and the patch needs to be
   * re-applied over the fresh content.
   */
  readonly force?: boolean;
  /**
   * Skip the verify step. Useful for dry-run / debug scenarios; never
   * set this in production because a verify-less patch can silently leave
   * a tool's source in a broken state.
   */
  readonly skipVerify?: boolean;
  /**
   * Progress callback invoked once per patch with a short human-readable
   * status string (e.g. `"applying cline-001"`, `"verifying cline-001"`).
   * Used by the CLI to render a live progress indicator.
   */
  readonly onProgress?: (msg: string) => void;
}

/**
 * Everything a patch-type handler or the verify step needs to operate,
 * bundled into a single object so handler signatures stay narrow.
 *
 * `packageInstallPath` is the absolute path to the package's install root
 * inside the distro (e.g. `~/.linuxify/runtimes/node/22/lib/node_modules/cline`).
 * The patch's `file` field is resolved against this path. Path-traversal
 * escapes (`../../../etc/passwd`) are rejected by the engine before any
 * handler sees the request.
 *
 * `distro` is the distro name the package was installed under (e.g.
 * `ubuntu`). The verify step uses this to decide whether to shell out
 * through `proot-distro login <distro>` (when the patcher itself runs on
 * the Termux host) or to exec the verify command directly (when the
 * patcher is already inside the distro).
 *
 * `stateStore` is the shared {@link StateStore}; handlers do not call it
 * directly, but the engine uses it to record `PatchApplication` entries
 * atomically.
 */
export interface PatchContext {
  /** Absolute path to the package's install root. */
  readonly packageInstallPath: string;
  /** Distro name (e.g. `ubuntu`); empty string means "current env". */
  readonly distro: string;
  /** Shared state store; engine uses it to record applied patches. */
  readonly stateStore: StateStore;
}

/**
 * Return type of a patch-type handler's `apply` method.
 *
 * `success` is `false` when the handler could not transform the content
 * (e.g. a regex `find` pattern matched zero occurrences — the file may
 * have been reformatted upstream). In that case the engine aborts the
 * patch with `E_PATCH_NO_MATCH` rather than writing the unmodified
 * content back to disk.
 *
 * `result` is the transformed content; the engine writes it atomically
 * (temp-file + rename) so a crash mid-write leaves either the original
 * or the patched file, never a half-written one (see `utils/fs.writeFile`).
 */
export interface PatchHandlerResult {
  /** `true` if the handler transformed the content; `false` if it did not. */
  readonly success: boolean;
  /** The transformed content (only meaningful when `success` is `true`). */
  readonly result: string;
}

/**
 * Interface every patch-type handler implements. The registry in
 * `types/index.ts` maps each {@link PatchType} to its handler; the engine
 * dispatches by `patch.type`.
 *
 * The handler receives the file's current content (read by the engine
 * before dispatch), the full {@link PatchDefinition} (so it can read
 * `find`, `replace`, `file`, etc.), and the {@link PatchContext} (so the
 * `shell` handler can compute the absolute file path and run a command
 * against it). The handler must not write to disk itself — that is the
 * engine's responsibility, so that atomic-write guarantees hold.
 */
export interface PatchTypeHandler {
  /**
   * Transform the file content according to the patch definition.
   *
   * @param content - The current file content (UTF-8 string).
   * @param patch - The patch definition (find, replace, file, type, ...).
   * @param ctx - The patch context (install path, distro, state store).
   * @returns A {@link PatchHandlerResult} with the transformed content.
   */
  apply(content: string, patch: PatchDefinition, ctx: PatchContext): Promise<PatchHandlerResult>;
}
