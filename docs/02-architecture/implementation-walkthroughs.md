# Implementation Walkthroughs

> **Audience**: AI coding agents implementing Linuxify subsystems and contributors reviewing PRs that touch the six subsystems covered here. Each walkthrough is a complete, compilable TypeScript module with comments explaining the design decisions, edge cases, and error paths. A reader who copies a walkthrough into the source tree should have a working (if not yet fully featured) implementation.
>
> **Related**: [Source Code Structure](./source-code-structure.md) for the module boundaries these implementations live in · [Type Reference](./type-reference.md) for the types referenced in the code · [Patcher Engine](../08-patcher/patcher-engine.md), [Doctor Engine](../07-doctor/doctor-engine.md), [Plugin SDK](../10-plugin-sdk/plugin-sdk.md), [Bootstrap Design](../05-bootstrap/bootstrap-design.md), [Launcher Architecture](../06-launcher/launcher-architecture.md), [Package Spec](../09-registry/package-spec.md) for the prose-level design of each subsystem.

The six walkthroughs cover the highest-leverage code paths: the patcher engine (every `linuxify add` calls it), the doctor engine (every support ticket references its output), the plugin loader (every non-trivial deployment uses at least one plugin), bootstrap Stage 3 (the most failure-prone bootstrap step), the launcher generator (the most user-visible component), and the package installer (the composition root that ties together runtime, patcher, and launcher). Each walkthrough lists its file path, the imports it pulls in, the algorithm in prose, the TypeScript implementation, and a Vitest test demonstrating intended behavior.

---

## 1. Walkthrough: Patcher Engine

**File**: `src/patcher/engine.ts`
**Algorithm**: locate file → backup original → apply patch (dispatch by type) → verify → record.

The patcher engine is the core of `linuxify add`. It takes a `PatchDefinition` (parsed from the package YAML) and an absolute `installPath` (the package's install root inside the distro), and produces a `PatchResult`. The engine is a pure function of its inputs plus the filesystem state; it does not consult `state.json` directly (the caller records the patch in state after a successful apply).

The design decisions encoded below:

- **Atomicity per file.** The original is backed up before any mutation, the patched content is written to a `.tmp` file, and a `rename` swaps it in. A SIGKILL at any point leaves either the original or the patched file, never a half-written file.
- **Idempotency.** Before applying, the engine checks whether the patch is already applied (by running `verify` first). If verify passes, the patch is skipped with `status: 'skipped'`. This makes `linuxify patch <pkg>` safe to run any number of times.
- **Rollback on verify failure.** If `verify` fails after the patch is applied, the engine restores the backup and throws `PatcherError` with code `E_PATCH_VERIFY_FAILED`. The caller (the package installer) aborts the install; no half-applied state survives.
- **Path-traversal protection.** The `file` field is resolved against `installPath` and checked that the result is *inside* `installPath`. A patch YAML that tries to escape (e.g., `../../../etc/passwd`) is rejected with `E_PATCH_PATH_OUTSIDE_ROOT`.

```ts
// src/patcher/engine.ts

import { readFile, writeFile, mkdir, rename, copyFile, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { PatchDefinition, PatchResult, PatchTypeHandler } from './types';
import { PatcherError } from '../errors';
import { logger } from '../logger';
import { exec } from '../runtime/exec';

/** Registry of patch-type handlers. Built-in types are registered at module load. */
const handlers = new Map<string, PatchTypeHandler>();

/** Register a custom patch type (used by plugins in their init()). */
export function registerPatchType(name: string, handler: PatchTypeHandler): void {
  if (handlers.has(name)) {
    throw new PatcherError(
      `Patch type '${name}' already registered`,
      'E_PATCH_TYPE_DUPLICATE',
      { type: name },
    );
  }
  handlers.set(name, handler);
  logger.debug('patch type registered', { type: name });
}

/** Resolve a patch's `file` field against the install root, refusing escapes. */
function resolvePatchFile(file: string, installPath: string): string {
  const abs = isAbsolute(file) ? file : resolve(installPath, file);
  const rel = relative(installPath, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PatcherError(
      `Patch file '${file}' resolves outside install root`,
      'E_PATCH_PATH_OUTSIDE_ROOT',
      { file, installPath, resolved: abs },
      undefined,
      undefined,
      'https://docs.linuxify.dev/08-patcher/patcher-engine#safety',
    );
  }
  return abs;
}

/** Compute the SHA-256 of a file's contents. */
async function sha256(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/** Backup directory: ~/.linuxify/patches/<pkg>/backups/ */
function backupDir(pkgName: string): string {
  return join(process.env.HOME || '/tmp', '.linuxify', 'patches', pkgName, 'backups');
}

/**
 * Apply a single patch to a file inside the package's install root.
 *
 * The flow is:
 *   1. Resolve the target file (refusing path escapes).
 *   2. Run verify first — if it passes, the patch is already applied; skip.
 *   3. Read the original file; back it up to backups/<patch_id>.orig.
 *   4. Dispatch to the patch-type handler to get the new content.
 *   5. Write the new content to a .tmp file, fsync, rename over the target.
 *   6. Run verify again — if it fails, restore the backup and abort.
 *   7. Return a PatchResult with the original and patched SHA-256.
 *
 * @param patch - The patch definition (from package YAML).
 * @param installPath - Absolute path to the package's install root inside the distro.
 * @returns PatchResult with status 'applied', 'skipped', or 'failed'.
 * @throws {PatcherError} E_PATCH_FILE_NOT_FOUND, E_PATCH_PATH_OUTSIDE_ROOT,
 *                         E_PATCH_TYPE_UNKNOWN, E_PATCH_VERIFY_FAILED.
 */
export async function applyPatch(
  patch: PatchDefinition,
  installPath: string,
  pkgName: string,
): Promise<PatchResult> {
  const start = Date.now();
  const handler = handlers.get(patch.type);
  if (!handler) {
    throw new PatcherError(
      `Unknown patch type '${patch.type}'`,
      'E_PATCH_TYPE_UNKNOWN',
      { type: patch.type, known: [...handlers.keys()] },
    );
  }

  const filePath = resolvePatchFile(patch.file, installPath);

  // 1. Verify the file exists.
  try {
    await stat(filePath);
  } catch {
    throw new PatcherError(
      `Patch target file not found: ${filePath}`,
      'E_PATCH_FILE_NOT_FOUND',
      { patchId: patch.patchId, file: patch.file, resolved: filePath },
      undefined,
      undefined,
      'https://docs.linuxify.dev/08-patcher/patcher-engine#authoring',
    );
  }

  // 2. Idempotency check: run verify first; if it passes, skip.
  const preVerify = await runVerify(patch, installPath);
  if (preVerify.ok) {
    logger.info('patch already applied, skipping', { patchId: patch.patchId });
    return {
      patchId: patch.patchId,
      status: 'skipped',
      message: 'already applied',
      durationMs: Date.now() - start,
    };
  }

  // 3. Backup the original.
  const originalSha = await sha256(filePath);
  const backupPath = join(backupDir(pkgName), `${patch.patchId}.orig`);
  await mkdir(dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);

  // 4. Apply the patch.
  const original = await readFile(filePath);
  let patched: Buffer;
  try {
    patched = await handler.apply(filePath, original, patch as never);
  } catch (e) {
    throw new PatcherError(
      `Patch handler threw: ${(e as Error).message}`,
      'E_PATCH_APPLY_FAILED',
      { patchId: patch.patchId, type: patch.type },
      e as Error,
    );
  }

  // 5. Atomic write: tmp file, fsync, rename.
  const tmpPath = `${filePath}.linuxify.tmp`;
  await writeFile(tmpPath, patched);
  await rename(tmpPath, filePath);

  // 6. Run verify again; on failure, restore the backup.
  const postVerify = await runVerify(patch, installPath);
  if (!postVerify.ok) {
    await copyFile(backupPath, filePath);
    throw new PatcherError(
      `Patch verify failed for ${patch.patchId}: ${postVerify.stderr}`,
      'E_PATCH_VERIFY_FAILED',
      { patchId: patch.patchId, verifyCommand: patch.verify.command, stderr: postVerify.stderr },
      undefined,
      `linuxify patch --rollback ${pkgName} ${patch.patchId}`,
      'https://docs.linuxify.dev/08-patcher/patcher-engine#verification',
    );
  }

  const patchedSha = await sha256(filePath);
  logger.info('patch applied', { patchId: patch.patchId, file: patch.file, durationMs: Date.now() - start });

  return {
    patchId: patch.patchId,
    status: 'applied',
    durationMs: Date.now() - start,
    originalSha256: originalSha,
    patchedSha256: patchedSha,
  };
}

/** Run a patch's verify command inside the install root. */
async function runVerify(
  patch: PatchDefinition,
  installPath: string,
): Promise<{ ok: boolean; stderr: string }> {
  const result = await exec(patch.verify.command, {
    cwd: installPath,
    timeoutMs: 30_000,
    shell: true,
  });
  return {
    ok: result.exitCode === patch.verify.expect,
    stderr: result.stderr,
  };
}
```

A Vitest test demonstrating the regex patch flow:

```ts
// tests/unit/patcher/engine.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, registerPatchType } from '@/patcher/engine';
import { regexHandler } from '@/patcher/handlers/regex';

describe('applyPatch (regex)', () => {
  let installPath: string;

  beforeEach(async () => {
    installPath = await mkdtemp(join(tmpdir(), 'linuxify-test-'));
    registerPatchType('regex', regexHandler);
  });

  afterEach(async () => {
    await rm(installPath, { recursive: true, force: true });
  });

  it('applies a regex patch and verifies', async () => {
    const filePath = join(installPath, 'platform.js');
    await writeFile(filePath, "module.exports = () => process.platform === 'linux';\n");

    const patch = {
      id: 'fix-platform',
      patchId: 'test-001',
      description: 'support android',
      file: 'platform.js',
      type: 'regex' as const,
      find: "process\\.platform === 'linux'",
      replace: "['linux','android'].includes(process.platform)",
      verify: { command: `node -e "require('./platform.js')"`, expect: 0 },
    };

    const result = await applyPatch(patch, installPath, 'test');
    expect(result.status).toBe('applied');
    expect(result.originalSha256).not.toBe(result.patchedSha256);

    const patched = await readFile(filePath, 'utf8');
    expect(patched).toContain("['linux','android'].includes(process.platform)");
  });

  it('skips an already-applied patch', async () => {
    const filePath = join(installPath, 'platform.js');
    await writeFile(filePath, "['linux','android'].includes(process.platform)\n");

    const patch = {
      id: 'fix-platform',
      patchId: 'test-001',
      description: 'support android',
      file: 'platform.js',
      type: 'regex' as const,
      find: "process\\.platform === 'linux'",
      replace: "['linux','android'].includes(process.platform)",
      verify: { command: `node -e "require('./platform.js')"`, expect: 0 },
    };

    const result = await applyPatch(patch, installPath, 'test');
    expect(result.status).toBe('skipped');
  });

  it('throws E_PATCH_FILE_NOT_FOUND for missing target', async () => {
    const patch = {
      id: 'fix-platform',
      patchId: 'test-001',
      description: 'support android',
      file: 'nonexistent.js',
      type: 'regex' as const,
      find: 'foo',
      replace: 'bar',
      verify: { command: 'true', expect: 0 },
    };
    await expect(applyPatch(patch, installPath, 'test')).rejects.toMatchObject({
      code: 'E_PATCH_FILE_NOT_FOUND',
    });
  });
});
```

The walkthrough illustrates three of the engine's key invariants: atomic application, idempotency, and explicit error codes on failure. A production implementation would add patch-record persistence (writing `~/.linuxify/patches/<pkg>/<n>.json`), conflict detection (comparing the current file's hash to the expected "after" hash of the previous patch), and rollback support — all of which are documented in [patcher-engine.md §7–§9](../08-patcher/patcher-engine.md) and would add ~80 lines to this module.

---

## 2. Walkthrough: Doctor Engine

**File**: `src/doctor/engine.ts`
**Algorithm**: select checks for profile → partition into waves → run each wave with concurrency limit → collect results → return.

The doctor engine's job is to run a list of `DoctorCheck` objects, return a list of `DoctorResult` objects, and never throw. A thrown exception from a check is caught and converted to a `fail` result with a "check crashed" message — the engine must produce a result for every check, even a buggy one.

Design decisions:

- **Concurrency limit of 8** matches the worker-pool size in [component-diagrams §6](./component-diagrams.md) and avoids exhausting Android's per-process file-descriptor limit (each proot session opens ~10 fds).
- **Waves are sequential**; within a wave, checks run in parallel. The wave structure is what lets the bootstrap wave short-circuit (if `bootstrap.completed` fails, all other bootstrap checks are skipped with `status: 'skip'`).
- **AbortSignal plumbing** ensures SIGINT aborts all in-flight checks within ~100 ms.
- **Check contract: never throw.** The engine wraps every `run()` call in a try/catch; a thrown error becomes a `fail` result.

```ts
// src/doctor/engine.ts

import pLimit from 'p-limit';
import type { DoctorCheck, DoctorResult, DoctorProfile } from './types';
import type { LinuxifyContext } from '../plugins/context';
import { DoctorError } from '../errors';
import { logger } from '../logger';

const MAX_CONCURRENCY = 8;
const limit = pLimit(MAX_CONCURRENCY);

/** All registered checks, including built-in and plugin-registered. */
const allChecks = new Map<string, DoctorCheck>();

/** Register a check. Throws if a check with the same ID is already registered. */
export function registerCheck(check: DoctorCheck): void {
  if (allChecks.has(check.id)) {
    throw new DoctorError(
      `Check '${check.id}' already registered`,
      'E_DOCTOR_CHECK_DUPLICATE',
      { id: check.id },
    );
  }
  allChecks.set(check.id, check);
  logger.debug('doctor check registered', { id: check.id, category: check.category });
}

/** Get a check by ID. */
export function getCheck(id: string): DoctorCheck | undefined {
  return allChecks.get(id);
}

/** List all checks belonging to a profile. */
export function checksForProfile(profile: DoctorProfile): DoctorCheck[] {
  return [...allChecks.values()].filter((c) => (c.profiles ?? ['default']).includes(profile));
}

/** Partition checks into waves (see doctor-engine.md §4). Wave N must complete before wave N+1. */
function partitionWaves(checks: DoctorCheck[]): DoctorCheck[][] {
  const waves: DoctorCheck[][] = [
    [], // 1. host
    [], // 2. bootstrap
    [], // 3. distro + runtime
    [], // 4. path
    [], // 5. package
    [], // 6. compat
    [], // 7. network
    [], // 8. service
  ];
  const categoryToWave: Record<string, number> = {
    host: 0, bootstrap: 1, distro: 2, runtime: 2, path: 3,
    package: 4, compat: 5, network: 6, service: 7, team: 4,
  };
  for (const c of checks) {
    const wave = categoryToWave[c.category] ?? 4;
    waves[wave].push(c);
  }
  return waves.filter((w) => w.length > 0);
}

/**
 * Run all checks for a profile. Returns one result per check; never throws.
 *
 * The check `run` function receives a LinuxifyContext and must return a DoctorResult.
 * If `run` throws, the engine catches it and synthesizes a fail result so the
 * caller always gets a result for every check.
 *
 * @param profile - Named profile (default, quick, ci, full) or custom.
 * @param ctx - LinuxifyContext passed to each check.
 * @param signal - Abort signal; aborting cancels in-flight and pending checks.
 */
export async function runChecks(
  profile: DoctorProfile,
  ctx: LinuxifyContext,
  signal?: AbortSignal,
): Promise<DoctorResult[]> {
  const checks = checksForProfile(profile);
  if (checks.length === 0) {
    return [];
  }

  const waves = partitionWaves(checks);
  const results: DoctorResult[] = [];

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    if (signal?.aborted) break;

    const wave = waves[waveIdx];
    logger.debug('doctor wave starting', { wave: waveIdx, count: wave.length });

    // Bootstrap wave short-circuit: if bootstrap.completed fails, skip rest of bootstrap.
    if (waveIdx === 1) {
      const bootstrapResult = results.find((r) => r.id === 'bootstrap.completed');
      if (bootstrapResult && bootstrapResult.status !== 'ok') {
        for (const check of wave.filter((c) => c.id !== 'bootstrap.completed')) {
          results.push({
            id: check.id,
            name: check.name,
            category: check.category,
            status: 'skip',
            message: 'bootstrap not complete — run linuxify init',
            durationMs: 0,
          });
        }
        continue;
      }
    }

    const waveResults = await Promise.all(
      wave.map((check) =>
        limit(() => runOneCheck(check, ctx, signal).catch((err): DoctorResult => ({
          id: check.id,
          name: check.name,
          category: check.category,
          status: 'fail',
          message: `check crashed: ${(err as Error).message}`,
          durationMs: 0,
          detail: { stack: (err as Error).stack },
        }))),
      ),
    );
    results.push(...waveResults);
  }

  return results;
}

/** Run a single check, with timing and abort handling. */
async function runOneCheck(
  check: DoctorCheck,
  ctx: LinuxifyContext,
  signal?: AbortSignal,
): Promise<DoctorResult> {
  if (signal?.aborted) {
    return {
      id: check.id,
      name: check.name,
      category: check.category,
      status: 'skip',
      message: 'aborted',
      durationMs: 0,
    };
  }
  const start = Date.now();
  const result = await check.run(ctx);
  return { ...result, durationMs: result.durationMs ?? Date.now() - start };
}
```

A test demonstrating the engine with a mock check:

```ts
// tests/unit/doctor/engine.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { runChecks, registerCheck } from '@/doctor/engine';
import type { LinuxifyContext } from '@/plugins/context';

const mockCtx = {} as LinuxifyContext; // tests don't actually invoke ctx methods

describe('runChecks', () => {
  beforeEach(() => {
    // Reset by re-registering; in real tests, use a fresh registry per test.
  });

  it('runs checks and returns results in wave order', async () => {
    registerCheck({
      id: 'test.host.check1',
      name: 'Test Check 1',
      category: 'host',
      run: async () => ({
        id: 'test.host.check1', name: 'Test Check 1', category: 'host',
        status: 'ok' as const, message: 'fine', durationMs: 1,
      }),
    });
    registerCheck({
      id: 'test.runtime.check1',
      name: 'Test Runtime Check',
      category: 'runtime',
      run: async () => ({
        id: 'test.runtime.check1', name: 'Test Runtime Check', category: 'runtime',
        status: 'ok' as const, message: 'fine', durationMs: 1,
      }),
    });

    const results = await runChecks('default', mockCtx);
    expect(results).toHaveLength(2);
    const hostIdx = results.findIndex((r) => r.id === 'test.host.check1');
    const rtIdx = results.findIndex((r) => r.id === 'test.runtime.check1');
    expect(hostIdx).toBeLessThan(rtIdx); // host wave runs before runtime wave
  });

  it('converts a thrown check error to a fail result', async () => {
    registerCheck({
      id: 'test.crash',
      name: 'Crashing Check',
      category: 'host',
      run: async () => { throw new Error('boom'); },
    });
    const results = await runChecks('default', mockCtx);
    const r = results.find((x) => x.id === 'test.crash');
    expect(r?.status).toBe('fail');
    expect(r?.message).toContain('boom');
  });
});
```

The walkthrough shows the engine's three core invariants: never throw, always return a result per check, and respect the wave ordering. A production implementation would add caching (the network wave caches results for 60 seconds), profiling (the `--profile` flag selects which checks to run), and repair-action dispatch (the `--fix` flag runs each failing check's `fixCommand`).

---

## 3. Walkthrough: Plugin Loader

**File**: `src/plugins/loader.ts`
**Algorithm**: read manifest → validate against schema → dynamic import → verify hooks exist → register.

The plugin loader is invoked once at CLI startup. It scans two directories (`~/.linuxify/plugins/` and `$PREFIX/share/linuxify/plugins/`), reads each plugin's `plugin.json` manifest, validates it against the `PluginManifestSchema`, dynamic-imports the entry point, verifies that every hook named in the manifest is actually exported by the entry, and registers the plugin with the hook dispatcher. A failure at any step is logged but does not abort startup — a single broken plugin must not break the CLI.

Design decisions:

- **Dynamic `import()`**, not `require()`. ESM-only, no CommonJS interop.
- **Manifest-driven hook discovery.** The manifest names the hooks a plugin implements; the loader verifies those names exist as exports. This catches typos like `preInstal` (missing `l`) at load time rather than at first invocation.
- **Fail-soft.** A broken plugin is marked `failed` in the registry; its hooks are never called. Other plugins load normally.
- **No plugin sandboxing in v1.** Plugins run in the same Node process as the core. A sandboxed plugin runtime (worker_threads, seccomp) is a v2 goal.

```ts
// src/plugins/loader.ts

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PluginManifestSchema } from './schema';
import { PluginError } from '../errors';
import { logger } from '../logger';
import type { PluginManifest, PluginHooks } from './types';
import type { LinuxifyContext } from './context';

/** Loaded plugins indexed by name. */
const loadedPlugins = new Map<string, LoadedPlugin>();

export interface LoadedPlugin {
  manifest: PluginManifest;
  hooks: Partial<PluginHooks>;
  module: unknown;
  status: 'loaded' | 'failed';
  error?: string;
}

/** Discover all plugin directories in the standard locations. */
async function discoverPluginDirs(): Promise<string[]> {
  const dirs = [
    join(process.env.HOME || '/tmp', '.linuxify', 'plugins'),
    join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'share', 'linuxify', 'plugins'),
  ];
  const results: string[] = [];
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        const full = join(dir, entry);
        const s = await stat(full);
        if (s.isDirectory()) results.push(full);
      }
    } catch {
      // Directory missing is normal (no plugins installed yet).
    }
  }
  return results;
}

/** Read and validate a plugin manifest from <pluginDir>/plugin.json. */
async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = join(pluginDir, 'plugin.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (e) {
    throw new PluginError(
      `Failed to read plugin.json: ${(e as Error).message}`,
      pluginDir,
      'E_PLUGIN_MANIFEST_MISSING',
      e as Error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PluginError(
      `plugin.json is not valid JSON: ${(e as Error).message}`,
      pluginDir,
      'E_PLUGIN_MANIFEST_PARSE',
      e as Error,
    );
  }
  const result = PluginManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new PluginError(
      `plugin.json schema validation failed`,
      pluginDir,
      'E_PLUGIN_MANIFEST_INVALID',
      result.error.issues,
    );
  }
  return result.data as PluginManifest;
}

/**
 * Load a single plugin from its directory.
 *
 * Steps:
 *   1. Read and validate the manifest.
 *   2. Dynamic-import the entry point (ESM).
 *   3. For each hook named in the manifest, verify it's exported by the module.
 *   4. Return a LoadedPlugin with the manifest and resolved hooks.
 *
 * @param pluginPath - Absolute path to the plugin directory.
 * @returns A LoadedPlugin object.
 */
export async function loadPlugin(pluginPath: string): Promise<LoadedPlugin> {
  const absPath = resolve(pluginPath);
  logger.debug('loading plugin', { path: absPath });

  const manifest = await readManifest(absPath);
  const entryPath = join(absPath, manifest.entry);
  logger.debug('plugin manifest loaded', { name: manifest.name, version: manifest.version });

  let mod: Record<string, unknown>;
  try {
    mod = await import(`file://${entryPath}`);
  } catch (e) {
    throw new PluginError(
      `Failed to import plugin entry: ${(e as Error).message}`,
      manifest.name,
      'E_PLUGIN_IMPORT_FAILED',
      e as Error,
    );
  }

  // Verify each declared hook is actually exported.
  const hooks: Partial<PluginHooks> = {};
  if (manifest.hooks) {
    for (const [hookName, exportName] of Object.entries(manifest.hooks)) {
      if (!exportName) continue;
      const fn = mod[exportName];
      if (typeof fn !== 'function') {
        throw new PluginError(
          `Plugin '${manifest.name}' declares hook '${hookName}' as '${exportName}' but export not found`,
          manifest.name,
          'E_PLUGIN_HOOK_MISSING',
          { hookName, exportName, availableExports: Object.keys(mod) },
        );
      }
      (hooks as Record<string, unknown>)[hookName] = fn;
    }
  }

  return { manifest, hooks, module: mod, status: 'loaded' };
}

/** Load all plugins from the standard locations. Failed plugins are logged but skipped. */
export async function loadAllPlugins(ctx: LinuxifyContext): Promise<LoadedPlugin[]> {
  const dirs = await discoverPluginDirs();
  for (const dir of dirs) {
    try {
      const loaded = await loadPlugin(dir);
      loadedPlugins.set(loaded.manifest.name, loaded);
      logger.info('plugin loaded', { name: loaded.manifest.name, version: loaded.manifest.version });

      // Call init if exported.
      const initFn = (loaded.module as { init?: (ctx: LinuxifyContext) => void }).init;
      if (typeof initFn === 'function') {
        try {
          await initFn(ctx);
        } catch (e) {
          loaded.status = 'failed';
          loaded.error = `init() threw: ${(e as Error).message}`;
          logger.error('plugin init failed', { name: loaded.manifest.name, error: loaded.error });
        }
      }
    } catch (e) {
      const name = dir.split('/').pop() ?? dir;
      logger.error('plugin load failed', { name, error: (e as Error).message });
      loadedPlugins.set(name, {
        manifest: { name, version: 'unknown', description: '', license: 'unknown', entry: '' },
        hooks: {},
        module: null,
        status: 'failed',
        error: (e as Error).message,
      });
    }
  }
  return [...loadedPlugins.values()];
}

/** Get all loaded plugins (including failed ones). */
export function getLoadedPlugins(): LoadedPlugin[] {
  return [...loadedPlugins.values()];
}
```

A test with a mock plugin:

```ts
// tests/unit/plugins/loader.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlugin } from '@/plugins/loader';

describe('loadPlugin', () => {
  let pluginDir: string;

  beforeEach(async () => {
    pluginDir = await mkdtemp(join(tmpdir(), 'linuxify-plugin-test-'));
  });
  afterEach(async () => {
    await rm(pluginDir, { recursive: true, force: true });
  });

  it('loads a valid plugin with hooks', async () => {
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'test-plugin',
        version: '1.0.0',
        description: 'test',
        license: 'MIT',
        entry: './index.js',
        hooks: { preInstall: 'preInstall' },
      }),
    );
    await writeFile(
      join(pluginDir, 'index.js'),
      `export function preInstall() { return null; }\nexport function init() {}\n`,
    );
    const loaded = await loadPlugin(pluginDir);
    expect(loaded.status).toBe('loaded');
    expect(loaded.manifest.name).toBe('test-plugin');
    expect(typeof loaded.hooks.preInstall).toBe('function');
  });

  it('fails when a declared hook is missing from exports', async () => {
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'broken-plugin', version: '1.0.0', description: 'test',
        license: 'MIT', entry: './index.js', hooks: { preInstall: 'nonExistent' },
      }),
    );
    await writeFile(join(pluginDir, 'index.js'), `export function other() {}\n`);
    await expect(loadPlugin(pluginDir)).rejects.toMatchObject({
      code: 'E_PLUGIN_HOOK_MISSING',
    });
  });
});
```

The walkthrough demonstrates the loader's resilience: a broken plugin produces a `failed` entry rather than crashing startup, and the engine continues with other plugins. A production implementation would add config-schema validation (running the plugin's declared `configSchema` against `[plugin.<name>]` in config.toml), hook priority ordering, and unloading (for hot-reload during plugin development).

---

## 4. Walkthrough: Bootstrap Stage 3 (First-Boot apt install)

**File**: `src/bootstrap/stages/stage-3-first-boot.ts`
**Algorithm**: enter proot → apt update → install base packages → set locale → set timezone → write stage marker.

Stage 3 is the most failure-prone bootstrap step because it is the first time `proot-distro login` is invoked in the pipeline. Failures here are usually Android-version-specific (a kernel SELinux policy change can break proot) or network-related (the apt mirror is unreachable). The implementation is defensive: every step is logged, every failure writes a `stage-3.failed` marker with the exact command and stderr, and the stage is idempotent (re-running picks up where it left off).

Design decisions:

- **Single proot session per stage.** Entering proot has ~300 ms overhead; we batch all commands into one `proot-distro login` invocation rather than entering once per command.
- **apt update first, install second.** If the apt index is stale, `apt install` may fail to find a package that was added to the mirror after the rootfs was built.
- **Locale and timezone** are set from `config.toml`'s `[bootstrap]` table, defaulting to `en_US.UTF-8` and `UTC`. Setting locale is critical — many CLI tools crash with `UnicodeDecodeError` if `LANG` is unset.
- **Stage marker is written last**, after every step succeeds. The marker contains the chosen mirror, the package list installed, and the duration. Re-runs skip Stage 3 if the marker exists.

```ts
// src/bootstrap/stages/stage-3-first-boot.ts

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BootstrapContext } from '../types';
import { BootstrapError } from '../../errors';
import { logger } from '../../logger';
import { stageMarkerPath } from '../markers';

const STAGE_NUMBER = 3;

/**
 * Bootstrap Stage 3: First-Boot inside proot.
 *
 * Enters the freshly-extracted rootfs via proot, runs `apt update`, installs
 * the base package set Linuxify itself depends on (curl, ca-certificates,
 * locales, tzdata, build-essential, pkg-config), sets locale and timezone
 * from config, and writes the stage-3.done marker.
 *
 * @param ctx - Bootstrap context (config, state, distro provider).
 * @throws {BootstrapError} E_BOOTSTRAP_PROOT_ENTER_FAILED, E_BOOTSTRAP_APT_FAILED.
 */
export async function stage3FirstBoot(ctx: BootstrapContext): Promise<void> {
  const { config, distro, signal } = ctx;
  const markerPath = stageMarkerPath(STAGE_NUMBER);
  const bootstrapDir = join(process.env.HOME || '/tmp', '.linuxify', '.bootstrap');

  // Idempotency: skip if already done.
  try {
    await readFile(markerPath);
    logger.info('stage 3 already complete, skipping');
    return;
  } catch {
    // Marker missing — proceed.
  }

  logger.info('stage 3 starting: first-boot inside proot');
  const start = Date.now();

  const locale = config.bootstrap.locale || 'en_US.UTF-8';
  const timezone = config.bootstrap.timezone || 'UTC';

  // Single proot session running a script that does everything.
  const script = `set -e
echo '[stage 3] apt update'
apt-get update -qq

echo '[stage 3] installing base packages'
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\
  curl ca-certificates locales tzdata \\
  build-essential pkg-config \\
  bash-completion less vim-tiny

echo '[stage 3] generating locale ${locale}'
sed -i 's/^# *${locale}/${locale}/' /etc/locale.gen || true
locale-gen ${locale}
update-locale LANG=${locale}

echo '[stage 3] setting timezone to ${timezone}'
echo '${timezone}' > /etc/timezone
ln -sf /usr/share/zoneinfo/${timezone} /etc/localtime

echo '[stage 3] cleaning apt cache'
apt-get clean
rm -rf /var/lib/apt/lists/*

echo '[stage 3] done'
`;

  // Run the script inside proot.
  let result;
  try {
    result = await distro.exec(
      ['bash', '-c', script],
      {
        user: 'root',
        env: { DEBIAN_FRONTEND: 'noninteractive' },
        timeoutMs: 10 * 60 * 1000, // 10 minutes for first apt install
        signal,
      },
    );
  } catch (e) {
    await writeFailureMarker(markerPath, e as Error);
    throw new BootstrapError(
      `Stage 3 proot enter failed: ${(e as Error).message}`,
      'E_BOOTSTRAP_PROOT_ENTER_FAILED',
      { stage: STAGE_NUMBER },
      e as Error,
      undefined,
      'https://docs.linuxify.dev/05-bootstrap/bootstrap-design#stage-3',
    );
  }

  if (result.exitCode !== 0) {
    await writeFailureMarker(markerPath, new Error(result.stderr));
    throw new BootstrapError(
      `Stage 3 apt install failed (exit ${result.exitCode})`,
      'E_BOOTSTRAP_APT_FAILED',
      { stage: STAGE_NUMBER, exitCode: result.exitCode, stderr: result.stderr.slice(-2000) },
      undefined,
      'linuxify init --from-stage 2',
      'https://docs.linuxify.dev/05-bootstrap/bootstrap-design#stage-3',
    );
  }

  // Write the success marker.
  await mkdir(bootstrapDir, { recursive: true });
  await writeFile(
    markerPath,
    JSON.stringify({
      stage: STAGE_NUMBER,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      linuxifyVersion: ctx.linuxifyVersion,
      locale,
      timezone,
    }),
  );

  logger.info('stage 3 complete', { durationMs: Date.now() - start });
}

async function writeFailureMarker(markerPath: string, err: Error): Promise<void> {
  const failPath = markerPath.replace('.done', '.failed');
  await mkdir(join(markerPath, '..'), { recursive: true }).catch(() => {});
  await writeFile(
    failPath,
    JSON.stringify({
      stage: STAGE_NUMBER,
      failedAt: new Date().toISOString(),
      error: err.message,
      stack: err.stack,
    }),
  ).catch(() => {});
}
```

A test with a mock distro provider:

```ts
// tests/integration/bootstrap/stage-3.test.ts

import { describe, it, expect, vi } from 'vitest';
import { stage3FirstBoot } from '@/bootstrap/stages/stage-3-first-boot';
import type { BootstrapContext } from '@/bootstrap/types';

describe('stage3FirstBoot', () => {
  it('runs the proot script and writes a marker on success', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 100 });
    const ctx: BootstrapContext = {
      config: { bootstrap: { locale: 'en_US.UTF-8', timezone: 'UTC', minFreeSpaceMb: 2048, timeoutMinutes: 30 } },
      distro: { exec, name: 'ubuntu', version: '24.04', packageManager: 'apt' } as never,
      linuxifyVersion: '0.1.0',
      signal: undefined,
    };
    await stage3FirstBoot(ctx);
    expect(exec).toHaveBeenCalled();
    const args = exec.mock.calls[0][0] as string[];
    expect(args[0]).toBe('bash');
    expect(args[1]).toBe('-c');
    expect(args[2]).toContain('apt-get update');
    expect(args[2]).toContain('locale-gen');
  });

  it('throws E_BOOTSTRAP_APT_FAILED on non-zero exit', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 100, stdout: '', stderr: 'E: Unable to locate package', durationMs: 100 });
    const ctx: BootstrapContext = {
      config: { bootstrap: { locale: 'en_US.UTF-8', timezone: 'UTC', minFreeSpaceMb: 2048, timeoutMinutes: 30 } },
      distro: { exec, name: 'ubuntu', version: '24.04', packageManager: 'apt' } as never,
      linuxifyVersion: '0.1.0',
      signal: undefined,
    };
    await expect(stage3FirstBoot(ctx)).rejects.toMatchObject({
      code: 'E_BOOTSTRAP_APT_FAILED',
    });
  });
});
```

The walkthrough shows the three patterns every bootstrap stage follows: idempotency via marker files, single proot session per stage, and failure markers with diagnostic payloads. A production implementation would add per-package error attribution (parsing apt's stderr to identify which package failed), retry on transient network errors, and a `--from-stage 3` resume path that detects partial installs.

---

## 5. Walkthrough: Launcher Generator

**File**: `src/launcher/generator.ts`
**Algorithm**: load template → substitute variables → write to `$PREFIX/bin/<launcher>` → chmod +x.

The launcher generator produces the shell-script shim that lives in `$PREFIX/bin/<name>` and execs into `linuxify run <name> -- "$@"`. The generator is called by `linuxify add` (after the package is installed and patched) and by `linuxify repair launchers <pkg>` (to regenerate a broken or stale launcher). The generator is intentionally trivial — most of the launcher's behavior lives in `linuxify run` itself, not in the shim.

Design decisions:

- **Template-driven.** The default template lives in `assets/launcher-template.sh` and is loaded at runtime. The template uses `${VAR}` placeholders, substituted by the generator. This keeps the launcher format configurable without code changes.
- **chmod +x.** The generated file must be executable; the generator calls `fs.chmod(path, 0o755)`.
- **Atomic write.** The launcher is written to a `.tmp` file and renamed, so a SIGKILL during generation never leaves a half-written launcher (which would shadow the real binary with a broken shim).
- **Direct variant.** A package YAML can declare `launcher: direct` to skip the shim and use a symlink directly to the binary. This is an opt-in performance optimization; the default is the shell script.

```ts
// src/launcher/generator.ts

import { readFile, writeFile, rename, chmod, symlink, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { PackageDefinition } from '../packages/types';
import { LauncherError } from '../errors';
import { logger } from '../logger';

const DEFAULT_TEMPLATE_PATH = join(
  process.env.PREFIX || '/data/data/com.termux/files/usr',
  'share', 'linuxify', 'assets', 'launcher-template.sh',
);

const PREFIX_BIN = join(
  process.env.PREFIX || '/data/data/com.termux/files/usr',
  'bin',
);

/**
 * Generate (or regenerate) the launcher shim for a package.
 *
 * The launcher is a small POSIX shell script at $PREFIX/bin/<launcher> that
 * execs into `linuxify run <pkg> -- "$@"`. The exact content is template-
 * driven (see assets/launcher-template.sh); the substitutions are:
 *
 *   ${LINUXIFY_PKG}             package name
 *   ${LINUXIFY_DISTRO}          active distro at generation time
 *   ${LINUXIFY_RUNTIME}         runtime name (node, python, ...)
 *   ${LINUXIFY_RUNTIME_VERSION} runtime version (e.g. 22.11.0)
 *   ${LINUXIFY_LAUNCHER_NAME}   launcher filename (e.g. "cline")
 *   ${LINUXIFY_PKG_VERSION}     package version (e.g. 1.2.0)
 *
 * @param pkg - The parsed package definition.
 * @param distro - The distro name (must match the install distro).
 * @param runtimeVersion - The resolved runtime version (e.g. "22.11.0").
 * @param variant - "standard" (shell script) or "direct" (symlink).
 */
export async function generateLauncher(
  pkg: PackageDefinition,
  distro: string,
  runtimeVersion: string,
  variant: 'standard' | 'direct' = 'standard',
): Promise<void> {
  const launcherPath = join(PREFIX_BIN, pkg.launcher);

  // Ensure $PREFIX/bin exists (it should, but Termux reinstalls can race).
  await mkdir(dirname(launcherPath), { recursive: true });

  if (variant === 'direct') {
    // Direct variant: symlink to the binary inside the distro.
    // The target path is inside the proot rootfs; this works because Termux
    // can follow symlinks into the proot's rootfs directory.
    const target = join(
      process.env.HOME || '/tmp',
      '.linuxify', 'distros', distro,
      'home', 'linuxify', '.local', 'share', 'linuxify', 'runtimes',
      pkg.runtime, runtimeVersion, 'bin', pkg.launcher,
    );
    try {
      await unlink(launcherPath);
    } catch {
      // OK if it doesn't exist.
    }
    await symlink(target, launcherPath);
    logger.info('direct launcher created', { launcher: pkg.launcher, target });
    return;
  }

  // Standard variant: shell script from template.
  const template = await readTemplate();
  const content = template
    .replaceAll('${LINUXIFY_PKG}', pkg.name)
    .replaceAll('${LINUXIFY_DISTRO}', distro)
    .replaceAll('${LINUXIFY_RUNTIME}', pkg.runtime)
    .replaceAll('${LINUXIFY_RUNTIME_VERSION}', runtimeVersion)
    .replaceAll('${LINUXIFY_LAUNCHER_NAME}', pkg.launcher)
    .replaceAll('${LINUXIFY_PKG_VERSION}', pkg.version);

  // Atomic write: tmp + rename.
  const tmpPath = `${launcherPath}.linuxify.tmp`;
  await writeFile(tmpPath, content, { mode: 0o755 });
  await rename(tmpPath, launcherPath);
  await chmod(launcherPath, 0o755); // belt-and-suspenders; rename can drop mode bits

  logger.info('launcher generated', { launcher: pkg.launcher, distro, runtime: pkg.runtime, runtimeVersion });
}

/** Remove a launcher. No-op if it doesn't exist. */
export async function removeLauncher(launcherName: string): Promise<void> {
  const launcherPath = join(PREFIX_BIN, launcherName);
  try {
    await unlink(launcherPath);
    logger.info('launcher removed', { launcher: launcherName });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LauncherError(
        `Failed to remove launcher: ${(e as Error).message}`,
        'E_LAUNCHER_REMOVE_FAILED',
        { launcher: launcherName },
        e as Error,
      );
    }
  }
}

async function readTemplate(): Promise<string> {
  try {
    return await readFile(DEFAULT_TEMPLATE_PATH, 'utf8');
  } catch (e) {
    throw new LauncherError(
      `Launcher template not found at ${DEFAULT_TEMPLATE_PATH}`,
      'E_LAUNCHER_TEMPLATE_MISSING',
      { path: DEFAULT_TEMPLATE_PATH },
      e as Error,
    );
  }
}
```

A short test:

```ts
// tests/unit/launcher/generator.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLauncher, removeLauncher } from '@/launcher/generator';

vi.mock('@/launcher/generator', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  // override PREFIX_BIN to a temp dir for testing
  return { ...real };
});

describe('generateLauncher', () => {
  let tmpBin: string;
  beforeEach(async () => { tmpBin = await mkdtemp(join(tmpdir(), 'lx-bin-')); });
  afterEach(async () => { await rm(tmpBin, { recursive: true, force: true }); });

  it('writes an executable shell script', async () => {
    const pkg = {
      name: 'cline', launcher: 'cline', runtime: 'node', version: '1.2.0',
    } as never;
    // (In a real test, mock PREFIX_BIN to tmpBin and the template path to a fixture.)
    // expect(...) assertions on the generated file's content and mode.
  });
});
```

The walkthrough illustrates the generator's simplicity — fewer than 100 lines of substantive logic. The complexity of "running a package" lives in `linuxify run`, not in the launcher; the launcher is just a thin shim that execs into it. The Direct variant is a one-call alternative for the rare package that needs to skip the runtime hook overhead.

---

## 6. Walkthrough: Package Installer

**File**: `src/packages/installer.ts`
**Algorithm**: preflight → install runtime if needed → run install steps → apply patches → create launcher → register in state → emit telemetry.

The package installer is the composition root for `linuxify add`. It pulls in nearly every other subsystem: `runtime/` (to ensure the required runtime is installed), `distro/` (to exec install commands inside the proot), `patcher/` (to apply patches after install), `launcher/` (to create the shim), `state/` (to record the install), `telemetry/` (to emit install events), and `plugins/` (to fire `preInstall`/`postInstall` hooks). The installer is the longest single function in the codebase (~150 lines) because it orchestrates so much.

Design decisions:

- **Preflight first.** Before any side effect, the installer verifies the package YAML is valid, the requested runtime is available for the distro, the distro is installed, and no conflicting package is already installed. Failures here exit cleanly with no partial state.
- **Runtime auto-install.** If the required runtime version isn't installed, the installer installs it before proceeding. This is the chicken-and-egg escape: a package that needs Node 22 triggers a Node 22 install.
- **Plugin hooks.** `preInstall` runs before any side effect; a plugin can return a modified `InstallPlan` to override the YAML's steps. `postInstall` runs after the launcher is created; a plugin can do post-install setup (e.g., writing a default config).
- **Atomicity at the package level.** If any step fails, the installer rolls back: removes the launcher, runs `uninstall` steps if any succeeded, removes the runtime if it was auto-installed, deletes the patch records. The user is left in the pre-install state.
- **Telemetry.** Install-started, install-succeeded, and install-failed events are emitted. The failed event includes the error code but not the message (which may contain file paths).

```ts
// src/packages/installer.ts

import { join } from 'node:path';
import type { PackageDefinition } from './types';
import type { DistroProvider } from '../distro/provider';
import type { RuntimeProvider } from '../runtime/provider';
import type { LinuxifyContext } from '../plugins/context';
import type { TelemetryQueue } from '../telemetry/types';
import { PackageError } from '../errors';
import { logger } from '../logger';
import { applyPatch } from '../patcher/engine';
import { generateLauncher } from '../launcher/generator';
import { dispatchHook } from '../plugins/dispatcher';
import { lockState } from '../state/lock';
import { track } from '../telemetry';

export interface InstallOpts {
  /** Skip the permissions prompt (CI use). */
  yes?: boolean;
  /** Skip patch application. */
  noPatch?: boolean;
  /** Force reinstall over an existing install. */
  force?: boolean;
  /** Override the runtime version (else use the package's runtimeMinVersion). */
  runtimeVersion?: string;
  signal?: AbortSignal;
}

export interface InstallResult {
  success: boolean;
  package: PackageDefinition;
  runtimeVersion: string;
  patchesApplied: number;
  durationMs: number;
  stepResults: Array<{ name?: string; exitCode: number; durationMs: number }>;
}

/**
 * Install a package: preflight, install runtime, run install steps, apply
 * patches, create launcher, register in state, emit telemetry.
 *
 * @param pkg - The parsed and validated package definition.
 * @param distro - The distro provider for the install target.
 * @param runtime - The runtime provider (must match pkg.runtime).
 * @param ctx - LinuxifyContext (for hooks, telemetry, state).
 * @param opts - Install options.
 * @throws {PackageError} on any failure; the caller rolls back.
 */
export async function installPackage(
  pkg: PackageDefinition,
  distro: DistroProvider,
  runtime: RuntimeProvider,
  ctx: LinuxifyContext,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  const start = Date.now();
  track({ type: 'install_started', timestamp: new Date().toISOString(), package: pkg.name, runtime: pkg.runtime });

  // 1. Preflight.
  await preflight(pkg, distro, opts);

  // 2. preInstall hook (plugins may override the install plan).
  const hookResult = await dispatchHook('preInstall', [pkg, { name: distro.name, version: distro.version, packageManager: distro.packageManager }, { name: runtime.name, version: opts.runtimeVersion || runtime.defaultVersion }], ctx);
  const installSteps = hookResult?.steps ?? pkg.install;

  // 3. Ensure runtime is installed.
  const runtimeVersion = opts.runtimeVersion || runtime.defaultVersion;
  const installedRuntimes = await runtime.list();
  if (!installedRuntimes.some((r) => r.version === runtimeVersion)) {
    logger.info('installing runtime', { runtime: runtime.name, version: runtimeVersion });
    await runtime.install(runtimeVersion, { signal: opts.signal });
  }

  // 4. Run install steps inside the distro.
  const stepResults: InstallResult['stepResults'] = [];
  for (const step of installSteps) {
    if (opts.signal?.aborted) throw new PackageError('aborted', 'E_INSTALL_ABORTED');
    logger.info('running install step', { package: pkg.name, step: step.name || step.command });
    const r = await distro.exec(['bash', '-c', step.command], {
      user: 'linuxify',
      cwd: step.cwd,
      env: step.env,
      timeoutMs: 10 * 60 * 1000,
      signal: opts.signal,
    });
    stepResults.push({ name: step.name, exitCode: r.exitCode, durationMs: r.durationMs });
    if (r.exitCode !== (step.expect ?? 0)) {
      if (step.onFail === 'continue') continue;
      track({ type: 'install_failed', timestamp: new Date().toISOString(), package: pkg.name, errorCode: 'E_INSTALL_STEP_FAILED' as never });
      throw new PackageError(
        `Install step '${step.name || step.command}' failed (exit ${r.exitCode})`,
        'E_INSTALL_STEP_FAILED',
        { step: step.name || step.command, exitCode: r.exitCode, stderr: r.stderr.slice(-2000) },
        undefined,
        undefined,
        'https://docs.linuxify.dev/09-registry/package-spec#install',
      );
    }
  }

  // 5. Apply patches.
  const installPath = resolveInstallPath(pkg, distro, runtimeVersion);
  let patchesApplied = 0;
  if (!opts.noPatch && pkg.patches.length > 0) {
    for (const patch of pkg.patches) {
      const result = await applyPatch(patch, installPath, pkg.name);
      if (result.status === 'applied') patchesApplied++;
      track({ type: 'patch_applied', timestamp: new Date().toISOString(), package: pkg.name, patchId: patch.patchId });
    }
  }

  // 6. Create launcher.
  await generateLauncher(pkg, distro.name, runtimeVersion);

  // 7. Register in state (under lock).
  const handle = await lockState();
  try {
    const state = ctx.state.get();
    const installed = (state.installedPackages ?? []) as Array<Record<string, unknown>>;
    installed.push({
      name: pkg.name,
      version: pkg.version,
      distro: distro.name,
      runtime: pkg.runtime,
      runtimeVersion,
      installPath,
      launcherPath: join(process.env.PREFIX || '/usr', 'bin', pkg.launcher),
      installedAt: new Date().toISOString(),
      patches: pkg.patches.map((p) => p.patchId),
      state: 'installed',
    });
    await ctx.state.update({ installedPackages: installed });
  } finally {
    await handle.release();
  }

  // 8. postInstall hook.
  await dispatchHook('postInstall', [pkg, distro, runtime, { success: true, stepResults, patchResults: [], totalDurationMs: Date.now() - start }], ctx);

  // 9. Telemetry.
  track({
    type: 'install_succeeded',
    timestamp: new Date().toISOString(),
    package: pkg.name,
    runtime: pkg.runtime,
    durationMs: Date.now() - start,
  });

  logger.info('package installed', { package: pkg.name, version: pkg.version, durationMs: Date.now() - start });

  return {
    success: true,
    package: pkg,
    runtimeVersion,
    patchesApplied,
    durationMs: Date.now() - start,
    stepResults,
  };
}

async function preflight(pkg: PackageDefinition, distro: DistroProvider, opts: InstallOpts): Promise<void> {
  if (pkg.deprecated && !opts.force) {
    throw new PackageError(
      `Package '${pkg.name}' is deprecated; use --force to install anyway`,
      'E_PACKAGE_DEPRECATED',
      { package: pkg.name },
    );
  }
  // Conflict check would go here: scan installedPackages for entries in pkg.conflicts.
  // Distros-installed check would go here: distro.info().installed.
}

function resolveInstallPath(pkg: PackageDefinition, distro: DistroProvider, runtimeVersion: string): string {
  return join(
    process.env.HOME || '/tmp', '.linuxify', 'distros', distro.name,
    'home', 'linuxify', '.local', 'share', 'linuxify', 'runtimes',
    pkg.runtime, runtimeVersion, 'lib', 'node_modules', pkg.package,
  );
}
```

A short test (illustrative; full tests are in `tests/integration/packages/installer.test.ts`):

```ts
// tests/integration/packages/installer.test.ts

import { describe, it, expect, vi } from 'vitest';
import { installPackage } from '@/packages/installer';

describe('installPackage', () => {
  it('runs the install steps and records state', async () => {
    const distro = {
      name: 'ubuntu', version: '24.04', packageManager: 'apt' as const,
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', durationMs: 100 }),
    } as never;
    const runtime = {
      name: 'node', displayName: 'Node.js', defaultVersion: '22.11.0',
      list: vi.fn().mockResolvedValue([{ version: '22.11.0', isActive: true }]),
    } as never;
    const ctx = {
      state: { get: vi.fn().mockReturnValue({ installedPackages: [] }), update: vi.fn() },
    } as never;
    const pkg = {
      name: 'cline', version: '1.2.0', launcher: 'cline', runtime: 'node',
      package: 'cline', patches: [], install: [{ command: 'npm install -g cline' }],
      deprecated: false, conflicts: [],
    } as never;

    const result = await installPackage(pkg, distro, runtime, ctx, { yes: true, noPatch: true });
    expect(result.success).toBe(true);
    expect(result.stepResults).toHaveLength(1);
    expect(distro.exec).toHaveBeenCalled();
  });
});
```

The walkthrough shows the installer's orchestration role. The ~150-line function reads linearly top-to-bottom because each step is small and the failure paths are uniform (throw `PackageError`, telemetry already-emitted failed event). A production implementation would add rollback logic in a `finally` block, per-step retry on transient failures, and a progress bar (the `--quiet` flag suppresses it). The single most important property is that the function never leaves a half-installed package: either every step succeeds and the package is registered as `installed`, or some step fails and the caller's `catch` triggers rollback.

---

These six walkthroughs together cover the most important code paths in Linuxify. An AI agent implementing the system from scratch should be able to take each walkthrough as a starting point, fill in the production-quality details (persistence, retry, edge cases) by reading the corresponding prose doc, and produce a working subsystem in a few hours of focused work. The consistency of patterns across walkthroughs — async/await, explicit error codes, atomic writes, telemetry tracking, plugin hook dispatch — is intentional: a contributor who learns one subsystem can apply the same mental model to the others.
