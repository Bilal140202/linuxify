/**
 * Unit tests for `src/patcher/engine.ts` (the `PatcherEngine` class).
 *
 * Exercises the full patch pipeline against the real `src/utils/` and
 * `src/state/` modules — only the logger is mocked (pino's lazy
 * initializer crashes under vitest's stdio capture; same pattern as the
 * state and launcher tests). Each test gets a fresh tmpdir via
 * `mkdtemp` and points `LINUXIFY_HOME` at it so backups and per-patch
 * JSON records land inside the tmpdir.
 *
 * Coverage:
 *   - `applyPatch` (single):
 *     - applies a regex patch and records in state
 *     - skips an already-applied patch (idempotency)
 *     - re-applies with `force: true`
 *     - skips verify with `skipVerify: true`
 *     - throws `E_PATCH_FILE_NOT_FOUND` for missing target
 *     - throws `E_PATCH_NO_MATCH` when find doesn't match
 *     - returns `success: false` (and rolls back) on verify failure
 *     - throws `E_PATCH_PATH_OUTSIDE_ROOT` for path traversal
 *     - throws `E_PATCH_TYPE_UNSUPPORTED` for ast-js (stub)
 *     - writes a backup file (byte-for-byte copy of original)
 *     - writes a per-patch JSON record at `~/.linuxify/patches/<pkg>/<NNN>.json`
 *   - `applyPatches` (batch):
 *     - applies all patches in order
 *     - rolls back previously-applied on failure
 *   - `rollbackPatch`:
 *     - restores the original file from backup
 *     - removes the patch from state
 *     - returns false when patch is not in state
 *     - throws `E_PATCH_BACKUP_MISSING` when backup is gone
 *     - throws `E_PATCH_CONFLICT` when file was modified externally
 *   - `rollbackAll`:
 *     - rolls back all patches for a package in reverse order
 *   - `listApplied` / `isApplied`:
 *     - read from state correctly
 */

import { mkdtemp, rm, writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger — pino's lazy initializer crashes under vitest's stdio
// capture (see tests/unit/state/store.test.ts for the same pattern).
vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import { PatcherEngine } from '../../../src/patcher/engine.js';
import { PatcherError } from '../../../src/utils/errors.js';
import { StateStore } from '../../../src/state/index.js';
import { sha256 } from '../../../src/utils/crypto.js';
import type { PatchDefinition, PatchContext } from '../../../src/patcher/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a {@link PatchDefinition} with sensible defaults. Tests override
 * individual fields via `overrides`.
 */
function makePatch(overrides: Partial<PatchDefinition> = {}): PatchDefinition {
  return {
    id: 'fix-platform',
    patch_id: 'test-001',
    description: 'Make tool treat android as linux',
    file: 'platform.js',
    type: 'regex',
    find: "process\\.platform === 'linux'",
    replace: "['linux','android'].includes(process.platform)",
    verify: 'node -e "require(\'./platform.js\')"',
    rollback: true,
    ...overrides,
  };
}

/**
 * Build a {@link PatchContext} pointing at the given install root and
 * state store. The `distro` is empty (verify runs directly, no proot).
 */
function makeCtx(installPath: string, stateStore: StateStore): PatchContext {
  return {
    packageInstallPath: installPath,
    distro: '',
    stateStore,
  };
}

/**
 * The canonical fixture content: a Node module with a
 * `process.platform === 'linux'` check. Mirrors the Cline example
 * from docs/08-patcher/patcher-engine.md §16.1.
 */
const ORIGINAL_PLATFORM_JS = `'use strict';
function isLinux() {
  return process.platform === 'linux';
}
module.exports = { isLinux };
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PatcherEngine', () => {
  let tmpDir: string;
  let installPath: string;
  let statePath: string;
  let stateStore: StateStore;
  let engine: PatcherEngine;
  let originalLinuxifyHome: string | undefined;

  beforeEach(async () => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    tmpDir = await mkdtemp(join(tmpdir(), 'linuxify-patcher-'));
    process.env.LINUXIFY_HOME = tmpDir;
    installPath = join(tmpDir, 'install', 'test-pkg');
    // Create the install root so tests can writeFile into it directly.
    await mkdir(installPath, { recursive: true });
    statePath = join(tmpDir, 'state.json');
    stateStore = new StateStore(statePath);
    engine = new PatcherEngine({ stateStore });
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) {
      delete process.env.LINUXIFY_HOME;
    } else {
      process.env.LINUXIFY_HOME = originalLinuxifyHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // applyPatch — success path
  // -------------------------------------------------------------------------

  describe('applyPatch (success)', () => {
    it('applies a regex patch and records in state', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const result = await engine.applyPatch(makePatch(), ctx);

      expect(result.success).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.patchId).toBe('test-001');
      expect(result.file).toBe(join(installPath, 'platform.js'));
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // The file on disk should be patched.
      const patched = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(patched).toContain("['linux','android'].includes(process.platform)");
      expect(patched).not.toContain("process.platform === 'linux'");

      // State should record the patch.
      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(1);
      expect(applied[0]!.patch_id).toBe('test-001');
      expect(applied[0]!.package).toBe('test-pkg');
      expect(applied[0]!.verified).toBe(true);
      expect(applied[0]!.applied_to_file).toBe(join(installPath, 'platform.js'));
    });

    it('computes original_hash and patched_hash correctly', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const result = await engine.applyPatch(makePatch(), ctx);
      expect(result.success).toBe(true);

      const applied = await engine.listApplied('test-pkg');
      const originalHash = sha256(ORIGINAL_PLATFORM_JS);
      const patchedContent = await readFile(join(installPath, 'platform.js'), 'utf8');
      const patchedHash = sha256(patchedContent);

      expect(applied[0]!.original_hash).toBe(originalHash);
      expect(applied[0]!.patched_hash).toBe(patchedHash);
      expect(applied[0]!.original_hash).not.toBe(applied[0]!.patched_hash);
    });

    it('writes a backup file that is a byte-for-byte copy of the original', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      const backupPath = join(tmpDir, 'patches', 'test-pkg', 'backups', 'test-001.orig');
      const backup = await readFile(backupPath, 'utf8');
      expect(backup).toBe(ORIGINAL_PLATFORM_JS);
    });

    it('writes a per-patch JSON record at ~/.linuxify/patches/<pkg>/<NNN>.json', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      const recordsDir = join(tmpDir, 'patches', 'test-pkg');
      const entries = await readdir(recordsDir);
      const jsonRecords = entries.filter((e) => /^\d{3}\.json$/.test(e));
      expect(jsonRecords).toHaveLength(1);
      expect(jsonRecords[0]).toBe('001.json');

      const record = JSON.parse(
        await readFile(join(recordsDir, '001.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(record.patch_id).toBe('test-001');
      expect(record.id).toBe('fix-platform');
      expect(record.type).toBe('regex');
      expect(record.package).toBe('test-pkg');
      expect(record.file).toBe('platform.js');
      expect(record.original_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.patched_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(record.linuxify_version).toBeTruthy();
      expect(record.rollback_path).toContain('test-001.orig');
      expect(record.verified).toBe(true);
    });

    it('invokes the onProgress callback during applyPatches', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const messages: string[] = [];
      const results = await engine.applyPatches([makePatch()], ctx, {
        onProgress: (msg) => messages.push(msg),
      });

      expect(results).toHaveLength(1);
      expect(results[0]!.success).toBe(true);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes('test-001'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // applyPatch — idempotency
  // -------------------------------------------------------------------------

  describe('applyPatch (idempotency)', () => {
    it('skips an already-applied patch (returns success, applied=false)', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      // First apply succeeds.
      const first = await engine.applyPatch(makePatch(), ctx);
      expect(first.applied).toBe(true);

      // Manually restore the original content so the second apply could
      // theoretically re-apply. The engine should still skip because
      // state records the patch as applied.
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);

      const second = await engine.applyPatch(makePatch(), ctx);
      expect(second.success).toBe(true);
      expect(second.applied).toBe(false);
      expect(second.verified).toBe(true);
      expect(second.error).toContain('already applied');

      // The file should still have the original content (we restored
      // it manually and the second apply skipped).
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);
    });

    it('re-applies with force=true via applyPatches', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      // First apply.
      await engine.applyPatch(makePatch(), ctx);

      // Restore original content (simulating `npm update -g` overwriting
      // the patched file with fresh upstream content).
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);

      // Re-apply with force.
      const results = await engine.applyPatches([makePatch()], ctx, { force: true });
      expect(results[0]!.applied).toBe(true);
      expect(results[0]!.success).toBe(true);

      // The file should now be patched again.
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toContain("['linux','android'].includes(process.platform)");
    });

    it('does not create duplicate state entries on re-apply with force', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);
      await engine.applyPatches([makePatch()], ctx, { force: true });

      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(1);
      expect(applied[0]!.patch_id).toBe('test-001');
    });
  });

  // -------------------------------------------------------------------------
  // applyPatch — verify options
  // -------------------------------------------------------------------------

  describe('applyPatch (skipVerify)', () => {
    it('skips the verify step when skipVerify=true', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      // Use a verify command that would fail (exit 1).
      const patch = makePatch({ verify: 'false' });
      const results = await engine.applyPatches([patch], ctx, { skipVerify: true });

      expect(results[0]!.success).toBe(true);
      expect(results[0]!.applied).toBe(true);
      expect(results[0]!.verified).toBe(true); // verified=true because we skipped
    });

    it('runs the verify step by default and rolls back on failure', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      // Use a verify command that always fails.
      const patch = makePatch({ verify: 'false' });
      const result = await engine.applyPatch(patch, ctx);

      expect(result.success).toBe(false);
      expect(result.applied).toBe(false);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('verify failed');

      // The file should be rolled back to the original.
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);

      // State should NOT record the patch (rolled back).
      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // applyPatch — error cases
  // -------------------------------------------------------------------------

  describe('applyPatch (errors)', () => {
    it('throws E_PATCH_FILE_NOT_FOUND when the target file does not exist', async () => {
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ file: 'nonexistent.js' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_FILE_NOT_FOUND',
      });
    });

    it('throws E_PATCH_NO_MATCH when the find pattern does not match', async () => {
      await writeFile(join(installPath, 'platform.js'), "// nothing to match\n");
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ find: 'process\\.platform === "linux"' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_NO_MATCH',
      });

      // The file should be unchanged (no match means no write).
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe("// nothing to match\n");
    });

    it('throws E_PATCH_PATH_OUTSIDE_ROOT for a path-traversal escape', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ file: '../../../etc/passwd' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_PATH_OUTSIDE_ROOT',
      });
    });

    it('throws E_PATCH_TYPE_UNSUPPORTED for ast-js (stub)', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ type: 'ast-js' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_TYPE_UNSUPPORTED',
      });
    });

    it('throws E_PATCH_TYPE_UNSUPPORTED for ast-ts (stub)', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ type: 'ast-ts' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_TYPE_UNSUPPORTED',
      });
    });

    it('throws E_PATCH_TYPE_UNSUPPORTED for python-ast (stub)', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);
      const patch = makePatch({ type: 'python-ast' });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_TYPE_UNSUPPORTED',
      });
    });

    it('throws E_PATCH_TYPE_UNKNOWN for an unrecognized type', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);
      // Cast to bypass the type system — the engine must handle unknown
      // types at runtime (e.g. a plugin type that wasn't registered).
      const patch = makePatch({ type: 'unknown-type' as never });

      await expect(engine.applyPatch(patch, ctx)).rejects.toMatchObject({
        code: 'E_PATCH_TYPE_UNKNOWN',
      });
    });
  });

  // -------------------------------------------------------------------------
  // applyPatches — batch semantics
  // -------------------------------------------------------------------------

  describe('applyPatches (batch)', () => {
    it('applies multiple patches in declaration order', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const patch1 = makePatch({
        patch_id: 'test-001',
        find: "process\\.platform === 'linux'",
        replace: "['linux','android'].includes(process.platform)",
      });
      // A second patch on the same file: rewrite the function name.
      const patch2 = makePatch({
        patch_id: 'test-002',
        id: 'rename-function',
        description: 'rename isLinux to supportsAndroid',
        find: 'isLinux',
        replace: 'supportsAndroid',
      });

      const results = await engine.applyPatches([patch1, patch2], ctx);
      expect(results).toHaveLength(2);
      expect(results[0]!.applied).toBe(true);
      expect(results[1]!.applied).toBe(true);

      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toContain('supportsAndroid');
      expect(content).toContain("['linux','android'].includes(process.platform)");
    });

    it('rolls back previously-applied patches when a later one fails', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const patch1 = makePatch({
        patch_id: 'test-001',
        find: "process\\.platform === 'linux'",
        replace: "['linux','android'].includes(process.platform)",
      });
      // patch2's find doesn't match — the engine will throw E_PATCH_NO_MATCH.
      const patch2 = makePatch({
        patch_id: 'test-002',
        find: 'nonexistent-pattern-xyz',
        replace: 'whatever',
      });

      const results = await engine.applyPatches([patch1, patch2], ctx);
      expect(results).toHaveLength(2);
      expect(results[0]!.applied).toBe(false); // rolled back
      expect(results[1]!.success).toBe(false);

      // The file should be back to the original (patch1 was rolled back).
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);

      // State should have no patches for the package (all rolled back).
      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(0);
    });

    it('rolls back the batch when verify fails on a later patch', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const patch1 = makePatch({ patch_id: 'test-001' });
      const patch2 = makePatch({
        patch_id: 'test-002',
        id: 'second',
        description: 'second patch',
        find: 'isLinux',
        replace: 'isLinuxish',
        verify: 'false', // always fails
      });

      const results = await engine.applyPatches([patch1, patch2], ctx);
      expect(results).toHaveLength(2);
      expect(results[1]!.success).toBe(false);

      // patch1 should have been rolled back.
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);

      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // rollbackPatch
  // -------------------------------------------------------------------------

  describe('rollbackPatch', () => {
    it('restores the original file and removes the patch from state', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      // Verify the file is patched.
      let content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toContain("['linux','android'].includes");

      // Rollback.
      const ok = await engine.rollbackPatch('test-001', 'test-pkg', ctx);
      expect(ok).toBe(true);

      // The file should be back to the original.
      content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);

      // State should have no patches.
      expect(await engine.listApplied('test-pkg')).toHaveLength(0);
      expect(await engine.isApplied('test-001', 'test-pkg')).toBe(false);
    });

    it('returns false when the patch is not in state', async () => {
      const ctx = makeCtx(installPath, stateStore);
      const ok = await engine.rollbackPatch('nonexistent', 'test-pkg', ctx);
      expect(ok).toBe(false);
    });

    it('throws E_PATCH_BACKUP_MISSING when the backup file is gone', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      // Delete the backup file manually.
      const backupPath = join(tmpDir, 'patches', 'test-pkg', 'backups', 'test-001.orig');
      await rm(backupPath);

      await expect(engine.rollbackPatch('test-001', 'test-pkg', ctx)).rejects.toMatchObject({
        code: 'E_PATCH_BACKUP_MISSING',
      });
    });

    it('throws E_PATCH_CONFLICT when the file was modified externally', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      // Overwrite the patched file with something else (simulating
      // `npm update -g` overwriting the patched file).
      await writeFile(join(installPath, 'platform.js'), "// totally different content\n");

      await expect(engine.rollbackPatch('test-001', 'test-pkg', ctx)).rejects.toMatchObject({
        code: 'E_PATCH_CONFLICT',
      });
    });

    it('deletes the per-patch JSON record on rollback', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      const recordsDir = join(tmpDir, 'patches', 'test-pkg');
      let entries = await readdir(recordsDir);
      expect(entries.some((e) => /^\d{3}\.json$/.test(e))).toBe(true);

      await engine.rollbackPatch('test-001', 'test-pkg', ctx);

      entries = await readdir(recordsDir);
      expect(entries.some((e) => /^\d{3}\.json$/.test(e))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // rollbackAll
  // -------------------------------------------------------------------------

  describe('rollbackAll', () => {
    it('rolls back all patches for a package in reverse order', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const patch1 = makePatch({
        patch_id: 'test-001',
        find: "process\\.platform === 'linux'",
        replace: "['linux','android'].includes(process.platform)",
      });
      const patch2 = makePatch({
        patch_id: 'test-002',
        id: 'rename',
        description: 'rename function',
        find: 'isLinux',
        replace: 'supportsAndroid',
      });

      await engine.applyPatches([patch1, patch2], ctx);
      expect(await engine.listApplied('test-pkg')).toHaveLength(2);

      await engine.rollbackAll('test-pkg', ctx);

      // All patches should be gone.
      expect(await engine.listApplied('test-pkg')).toHaveLength(0);

      // The file should be back to the original.
      const content = await readFile(join(installPath, 'platform.js'), 'utf8');
      expect(content).toBe(ORIGINAL_PLATFORM_JS);
    });

    it('is a no-op when the package has no patches', async () => {
      const ctx = makeCtx(installPath, stateStore);
      await engine.rollbackAll('test-pkg', ctx);
      expect(await engine.listApplied('test-pkg')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // listApplied / isApplied
  // -------------------------------------------------------------------------

  describe('listApplied', () => {
    it('returns patches for a package in chronological order', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      const patch1 = makePatch({ patch_id: 'test-001' });
      const patch2 = makePatch({
        patch_id: 'test-002',
        id: 'second',
        description: 'second',
        find: 'isLinux',
        replace: 'isLinuxish',
      });

      await engine.applyPatches([patch1, patch2], ctx);

      const applied = await engine.listApplied('test-pkg');
      expect(applied).toHaveLength(2);
      expect(applied[0]!.patch_id).toBe('test-001');
      expect(applied[1]!.patch_id).toBe('test-002');
      // Chronological order: applied_at should be non-decreasing.
      expect(applied[0]!.applied_at <= applied[1]!.applied_at).toBe(true);
    });

    it('returns an empty array for a package with no patches', async () => {
      const applied = await engine.listApplied('no-such-package');
      expect(applied).toEqual([]);
    });

    it('filters by package name (does not leak other packages)', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      await engine.applyPatch(makePatch(), ctx);

      // The package name is derived from the install path's last
      // segment, which is `test-pkg` here.
      const otherPackageApplied = await engine.listApplied('other-package');
      expect(otherPackageApplied).toEqual([]);
    });
  });

  describe('isApplied', () => {
    it('returns true when the patch is in state', async () => {
      await writeFile(join(installPath, 'platform.js'), ORIGINAL_PLATFORM_JS);
      const ctx = makeCtx(installPath, stateStore);

      expect(await engine.isApplied('test-001', 'test-pkg')).toBe(false);

      await engine.applyPatch(makePatch(), ctx);

      expect(await engine.isApplied('test-001', 'test-pkg')).toBe(true);
    });

    it('returns false when the patch is not in state', async () => {
      expect(await engine.isApplied('nonexistent', 'test-pkg')).toBe(false);
    });

    it('returns false when the package has no patches', async () => {
      expect(await engine.isApplied('test-001', 'no-such-package')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // sed / shell patch types (smoke tests in the engine context)
  // -------------------------------------------------------------------------

  describe('applyPatch with sed type', () => {
    it('applies a sed substitution patch', async () => {
      await writeFile(
        join(installPath, 'config.txt'),
        'path=/usr/local/bin\nuser=/home/user\n',
      );
      const ctx = makeCtx(installPath, stateStore);

      const patch = makePatch({
        file: 'config.txt',
        type: 'sed',
        find: 's|/usr/local/bin|/opt/bin|g',
        replace: '',
        verify: 'test -f config.txt',
      });

      const result = await engine.applyPatch(patch, ctx);
      expect(result.success).toBe(true);

      const content = await readFile(join(installPath, 'config.txt'), 'utf8');
      expect(content).toContain('path=/opt/bin');
    });
  });

  describe('applyPatch with shell type', () => {
    it('applies a shell patch that rewrites the file via $FILE', async () => {
      await writeFile(join(installPath, 'data.txt'), 'hello world\n');
      const ctx = makeCtx(installPath, stateStore);

      // The shell command uses `sed -i` to rewrite $FILE in place.
      const patch = makePatch({
        file: 'data.txt',
        type: 'shell',
        find: '',
        replace: "sed -i 's/world/linux/' \"$FILE\"",
        verify: 'test -f data.txt',
      });

      const result = await engine.applyPatch(patch, ctx);
      expect(result.success).toBe(true);

      const content = await readFile(join(installPath, 'data.txt'), 'utf8');
      expect(content).toBe('hello linux\n');
    });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('throws when stateStore is missing', () => {
      expect(() => new PatcherEngine({ stateStore: undefined as never })).toThrow();
    });
  });
});
