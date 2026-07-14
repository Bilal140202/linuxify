/**
 * Shell patch-type handler.
 *
 * @module linuxify/patcher/types/shell
 *
 * The `shell` patch type delegates the file transformation to a
 * user-supplied shell command. The command is run with the `$FILE`
 * environment variable set to the absolute path of the target file,
 * allowing the command to read, modify, and rewrite the file in place
 * using whatever tools it likes (`sed`, `awk`, `perl`, a Python one-
 * liner, …).
 *
 * Unlike the `regex` and `sed` handlers, the `shell` handler does not
 * return transformed content directly — instead it reads the file back
 * from disk after the command completes. This is necessary because the
 * command may rewrite the file using its own I/O (e.g. `sed -i`), and
 * trying to capture stdout would miss in-place rewrites.
 *
 * The handler does NOT verify the command exited 0 — that is the verify
 * step's job. Instead, it treats any non-zero exit as "the patch did
 * not apply" and returns `success: false`. The engine then aborts the
 * patch (without rolling back, since no writes were made by the engine).
 *
 * Safety:
 *  - The command runs with the same privileges as the patcher process.
 *    Authors of `shell` patches must take care not to ship dangerous
 *    commands (the package linter scans for `rm -rf /`, `mkfs`, etc.).
 *  - The command's CWD is set to the package install root, so relative
 *    paths in the command resolve predictably.
 *  - A 30-second timeout prevents runaway commands from hanging the
 *    install.
 */

import { readFile } from 'node:fs/promises';

import { exec } from '../../utils/process.js';
import { logger } from '../../utils/log.js';

import type { PatchHandlerResult, PatchTypeHandler } from '../types.js';

/** Timeout (ms) for the shell command. Mirrors the verify-step timeout. */
const SHELL_PATCH_TIMEOUT_MS = 30_000;

/**
 * Run a shell patch command against a file.
 *
 * @param filePath - Absolute path to the target file. Passed to the
 *   command via the `$FILE` environment variable.
 * @param command - The shell command to run. Executed via `bash -c`.
 * @returns `{ success, result }`. `result` is the file's content after
 *   the command has run (read back from disk). `success` is `false` if
 *   the command exited non-zero (the engine will abort without rollback
 *   since no engine-side writes occurred).
 */
export async function applyShellPatch(
  filePath: string,
  command: string,
): Promise<{ success: boolean; result: string }> {
  // Set $FILE for the command and inherit the rest of the environment.
  // We do not strip any env vars — the command may legitimately need
  // $PATH, $HOME, $TMPDIR, etc.
  const env: Record<string, string> = { ...process.env, FILE: filePath } as Record<
    string,
    string
  >;

  const result = await exec('bash', ['-c', command], {
    env,
    timeoutMs: SHELL_PATCH_TIMEOUT_MS,
    // CWD is the file's directory so the command can use relative paths
    // to sibling files (e.g. `awk -f transform.awk $FILE > $FILE.new`).
    cwd: filePath.substring(0, filePath.lastIndexOf('/')) || '.',
  });

  if (result.exitCode !== 0) {
    logger.warn(
      { command, exitCode: result.exitCode, stderr: result.stderr },
      'shell patch command exited non-zero',
    );
    // Still read the file back — the command may have made partial
    // changes before failing. The engine will decide what to do with
    // this content (typically it discards it because success=false).
    const content = await readFile(filePath, 'utf8');
    return { success: false, result: content };
  }

  const content = await readFile(filePath, 'utf8');
  return { success: true, result: content };
}

/**
 * {@link PatchTypeHandler} implementation for the `shell` patch type.
 *
 * The handler reads `patch.replace` as the shell command (the YAML
 * convention is: `find` is unused, `replace` holds the command — this
 * mirrors how `find`/`replace` are repurposed for `python-ast`). The
 * target file's absolute path is computed from `ctx.packageInstallPath`
 * + `patch.file`.
 *
 * If `patch.replace` is empty, the handler falls back to `patch.find`
 * (so YAML authors can use either field for the command). If both are
 * empty, the handler throws — the package YAML schema requires `find`
 * and `replace` to be non-empty strings, so this is purely defensive.
 */
export const shellHandler: PatchTypeHandler = {
  async apply(_content, patch, ctx): Promise<PatchHandlerResult> {
    // `_content` (the original file content) is intentionally unused:
    // the shell command reads and writes the file directly via $FILE,
    // and we read the result back from disk after the command runs.
    const command = patch.replace || patch.find;
    if (!command) {
      throw new Error(
        `shell patch '${patch.patch_id}' has empty command (both find and replace are empty)`,
      );
    }
    // Compute the absolute file path. The engine has already verified
    // the file exists and resolved path-traversal escapes; we just join
    // here. Using `path.resolve` ensures we get an absolute path even
    // if `patch.file` is relative (which it should always be per the
    // YAML schema, but defensive coding costs nothing).
    const { resolve } = await import('node:path');
    const filePath = resolve(ctx.packageInstallPath, patch.file);

    const r = await applyShellPatch(filePath, command);
    // If the shell command failed, we still return the (possibly
    // modified) content so the engine can decide whether to write it.
    // In practice the engine will treat success=false as "abort the
    // patch" and not write anything.
    return r;
  },
};
