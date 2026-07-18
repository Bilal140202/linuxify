/**
 * Unit tests for `src/registry/git-registry.ts`.
 *
 * Two test layers:
 *
 * 1. **update() with mocked simple-git**: verifies the clone-vs-fetch-and-
 *    reset branching, the 30s timeout wrapper, the `.last-update` timestamp
 *    write, and the `E_REGISTRY_UPDATE_FAILED` error wrapping. `simple-git`
 *    is mocked via `vi.mock` so no real git operations run.
 *
 * 2. **Filesystem reads against a fixture registry**: `getPackage`,
 *    `listPackages`, `getInfo`, `getLastUpdate`, `search`, and
 *    `getRegistryPath` are exercised against the on-disk fixture at
 *    `tests/fixtures/registry/` (registry.toml + 3 package YAMLs). These
 *    tests do NOT mock simple-git — they simply never call `update()`.
 *
 * The fixture directory is copied into a unique temp dir per test (via
 * `fsPromises.cp`) so tests can write the `.last-update` file without
 * polluting the committed fixture.
 */

import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock simple-git
// ---------------------------------------------------------------------------

/**
 * Hoisted mock object so the mock factory and the test body share the same
 * spy instances. `vi.hoisted` runs before all imports, ensuring the mock
 * is installed before `simple-git` is imported by the SUT.
 */
const { mockGit } = vi.hoisted(() => {
  const mockGit = {
    clone: vi.fn(),
    fetch: vi.fn(),
    reset: vi.fn(),
  };
  return { mockGit };
});

vi.mock('simple-git', () => ({
  default: vi.fn(() => mockGit),
  simpleGit: vi.fn(() => mockGit),
  ResetMode: { HARD: 'hard', MIXED: 'mixed', SOFT: 'soft', MERGE: 'merge', KEEP: 'keep' },
}));

// Mock the logger — pino's lazy initializer opens a log file in
// ~/.linuxify/logs/ which is flaky in CI and noisy in test output.
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

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { GitRegistryClient } from '../../../src/registry/git-registry.js';
import { RegistryError } from '../../../src/utils/errors.js';
import { exists } from '../../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_REGISTRY_DIR = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'registry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset the simple-git mock spies between tests. */
function resetMockGit(): void {
  mockGit.clone.mockReset();
  mockGit.fetch.mockReset();
  mockGit.reset.mockReset();
  // Default: all git ops succeed.
  mockGit.clone.mockResolvedValue('');
  mockGit.fetch.mockResolvedValue({} as never);
  mockGit.reset.mockResolvedValue('');
}

/**
 * Copy the fixture registry into a fresh temp directory and return its
 * path. The caller is responsible for cleaning up (or the test's
 * `afterEach` will rm it).
 */
async function copyFixtureToTemp(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'linuxify-registry-test-'));
  await cp(FIXTURE_REGISTRY_DIR, tmp, { recursive: true });
  return tmp;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GitRegistryClient', () => {
  let tempDirs: string[] = [];

  beforeEach(() => {
    resetMockGit();
    tempDirs = [];
  });

  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('applies default URL, branch, and localPath when opts omitted', () => {
      const client = new GitRegistryClient();
      expect(client.getRegistryPath()).toMatch(/registry$/);
      // We can't read the private registryUrl/branch directly, but we can
      // verify them indirectly through update()'s git calls (see below).
    });

    it('honors explicit opts', () => {
      const client = new GitRegistryClient({
        registryUrl: 'https://example.com/reg.git',
        branch: 'stable',
        localPath: '/tmp/test-registry',
        trustSelfSigned: false,
      });
      expect(client.getRegistryPath()).toBe('/tmp/test-registry');
    });

    it('sets GIT_SSL_NO_VERIFY=1 when trustSelfSigned is true', () => {
      const prev = process.env.GIT_SSL_NO_VERIFY;
      delete process.env.GIT_SSL_NO_VERIFY;
      try {
         
        new GitRegistryClient({ trustSelfSigned: true });
        expect(process.env.GIT_SSL_NO_VERIFY).toBe('1');
      } finally {
        if (prev === undefined) delete process.env.GIT_SSL_NO_VERIFY;
        else process.env.GIT_SSL_NO_VERIFY = prev;
      }
    });

    it('does NOT set GIT_SSL_NO_VERIFY when trustSelfSigned is false', () => {
      const prev = process.env.GIT_SSL_NO_VERIFY;
      delete process.env.GIT_SSL_NO_VERIFY;
      try {
         
        new GitRegistryClient({ trustSelfSigned: false });
        expect(process.env.GIT_SSL_NO_VERIFY).toBeUndefined();
      } finally {
        if (prev !== undefined) process.env.GIT_SSL_NO_VERIFY = prev;
      }
    });
  });

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe('update()', () => {
    it('clones when the local path does not exist', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'linuxify-empty-'));
      tempDirs.push(tmp);
      const localPath = join(tmp, 'registry'); // does not exist yet

      const client = new GitRegistryClient({
        registryUrl: 'https://example.com/reg.git',
        branch: 'main',
        localPath,
      });
      await client.update();

      expect(mockGit.clone).toHaveBeenCalledTimes(1);
      // clone(repoPath, localPath, ['--depth', '1', '--branch', 'main'])
      const args = mockGit.clone.mock.calls[0]!;
      expect(args[0]).toBe('https://example.com/reg.git');
      expect(args[1]).toBe(localPath);
      expect(args[2]).toEqual(['--depth', '1', '--branch', 'main']);

      // fetch/reset should NOT be called on a fresh clone.
      expect(mockGit.fetch).not.toHaveBeenCalled();
      expect(mockGit.reset).not.toHaveBeenCalled();
    });

    it('fetches and hard-resets when the local path already exists', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      // tmp already has the fixture structure (registry.toml + packages/).

      const client = new GitRegistryClient({
        registryUrl: 'https://example.com/reg.git',
        branch: 'main',
        localPath: tmp,
      });
      await client.update();

      expect(mockGit.fetch).toHaveBeenCalledTimes(1);
      expect(mockGit.fetch.mock.calls[0]![0]).toBe('origin');
      expect(mockGit.fetch.mock.calls[0]![1]).toBe('main');

      expect(mockGit.reset).toHaveBeenCalledTimes(1);
      // reset(ResetMode.HARD, ['origin/main'])
      expect(mockGit.reset.mock.calls[0]![0]).toBe('hard'); // ResetMode.HARD
      expect(mockGit.reset.mock.calls[0]![1]).toEqual(['origin/main']);

      // clone should NOT be called when the path exists.
      expect(mockGit.clone).not.toHaveBeenCalled();
    });

    it('writes a .last-update timestamp on success', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);

      const client = new GitRegistryClient({ localPath: tmp });
      await client.update();

      const tsPath = join(tmp, '.last-update');
      const ts = await readFile(tsPath, 'utf8');
      expect(ts.trim().length).toBeGreaterThan(0);
      // Should be a valid ISO date.
      const parsed = new Date(ts.trim());
      expect(parsed.toString()).not.toBe('Invalid Date');
    });

    it('invalidates the in-memory cache on success', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);

      const client = new GitRegistryClient({ localPath: tmp });
      // Populate the cache via listPackages.
      const before = await client.listPackages();
      expect(before.length).toBe(3);

      await client.update();

      // After update, listPackages should re-scan (cache was invalidated).
      // We can verify this by checking that the cache miss happens — but
      // since the result is the same, we just verify no throw and the
      // count is unchanged.
      const after = await client.listPackages();
      expect(after.length).toBe(3);
    });

    it('throws RegistryError(E_REGISTRY_UPDATE_FAILED) when clone fails', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'linuxify-empty-'));
      tempDirs.push(tmp);
      const localPath = join(tmp, 'registry');

      mockGit.clone.mockRejectedValue(new Error('network unreachable'));

      const client = new GitRegistryClient({ localPath });
      await expect(client.update()).rejects.toThrow(RegistryError);
      await expect(client.update()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_UPDATE_FAILED' }),
      );
    });

    it('throws RegistryError(E_REGISTRY_UPDATE_FAILED) when fetch fails', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);

      mockGit.fetch.mockRejectedValueOnce(new Error('refusing to delete'));

      const client = new GitRegistryClient({ localPath: tmp });
      await expect(client.update()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_UPDATE_FAILED' }),
      );
    });

    it('throws RegistryError(E_REGISTRY_UPDATE_FAILED) when reset fails', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);

      mockGit.reset.mockRejectedValueOnce(new Error('merge conflict'));

      const client = new GitRegistryClient({ localPath: tmp });
      await expect(client.update()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_UPDATE_FAILED' }),
      );
    });

    it('throws RegistryError(E_REGISTRY_UPDATE_FAILED) on timeout', async () => {
      const tmp = await mkdtemp(join(tmpdir(), 'linuxify-empty-'));
      tempDirs.push(tmp);
      const localPath = join(tmp, 'registry');

      // clone never resolves → withTimeout should reject after the
      // configured timeout. We use a short 50ms timeout (via the
      // `gitTimeoutMs` constructor option) so the test doesn't wait 30s.
      mockGit.clone.mockImplementation(
        () => new Promise(() => {}) as never, // never resolves
      );

      const client = new GitRegistryClient({ localPath, gitTimeoutMs: 50 });
      await expect(client.update()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_UPDATE_FAILED' }),
      );
      // The error message should mention the timeout.
      await expect(client.update()).rejects.toThrow(/Timed out after 50ms/);
    });
  });

  // -------------------------------------------------------------------------
  // ensureInitialized / E_REGISTRY_NOT_INITIALIZED
  // -------------------------------------------------------------------------

  describe('ensureInitialized', () => {
    it('throws RegistryError(E_REGISTRY_NOT_INITIALIZED) when the local clone is absent', async () => {
      const client = new GitRegistryClient({
        localPath: '/tmp/linuxify-registry-does-not-exist-' + Date.now(),
      });
      await expect(client.listPackages()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_NOT_INITIALIZED' }),
      );
      await expect(client.getPackage('cline')).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_NOT_INITIALIZED' }),
      );
      await expect(client.search({ query: 'ai' })).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_NOT_INITIALIZED' }),
      );
      await expect(client.getInfo()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_NOT_INITIALIZED' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getPackage()
  // -------------------------------------------------------------------------

  describe('getPackage()', () => {
    it('returns a parsed PackageDefinition for an existing package', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const pkg = await client.getPackage('cline');
      expect(pkg).not.toBeNull();
      expect(pkg!.name).toBe('cline');
      expect(pkg!.version).toBe('1.2.0');
      expect(pkg!.runtime).toBe('node');
      expect(pkg!.package).toBe('cline');
    });

    it('returns a fully-validated PackageDefinition (Zod schema applied)', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const pkg = await client.getPackage('codex');
      expect(pkg).not.toBeNull();
      expect(pkg!.patches).toHaveLength(1);
      expect(pkg!.patches[0]!.patch_id).toBe('codex-001');
      expect(pkg!.doctor).toHaveLength(1);
    });

    it('returns null for a non-existent package', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const pkg = await client.getPackage('does-not-exist');
      expect(pkg).toBeNull();
    });

    it('caches the result (second call does not re-read disk)', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const first = await client.getPackage('cline');
      // Corrupt the file on disk after the first read; if the cache is
      // working, the second call should return the same parsed object
      // without re-reading the (now-corrupt) file.
      await writeFile(join(tmp, 'packages', 'cline.yml'), 'invalid: yaml: content');

      const second = await client.getPackage('cline');
      expect(second).toEqual(first);
    });
  });

  // -------------------------------------------------------------------------
  // listPackages()
  // -------------------------------------------------------------------------

  describe('listPackages()', () => {
    it('returns all packages sorted alphabetically by name', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      const names = list.map((p) => p.name);
      expect(names).toEqual(['aider', 'cline', 'codex']);
    });

    it('returns RegistryEntry objects with the expected metadata fields', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      const cline = list.find((p) => p.name === 'cline')!;
      expect(cline).toBeDefined();
      expect(cline.version).toBe('1.2.0');
      expect(cline.description).toBe('AI coding agent that runs in your terminal');
      expect(cline.runtime).toBe('node');
      expect(cline.category).toBe('ai');
      expect(cline.tags).toEqual(['ai-coding', 'terminal']);
    });

    it('includes packages across multiple runtimes', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      const runtimes = new Set(list.map((p) => p.runtime));
      expect(runtimes.has('node')).toBe(true);
      expect(runtimes.has('python')).toBe(true);
    });

    it('caches the list (second call does not re-scan disk)', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const first = await client.listPackages();
      // Delete a package file after the first scan; if the cache works,
      // the second call should still return 3 packages.
      await rm(join(tmp, 'packages', 'aider.yml'), { force: true });

      const second = await client.listPackages();
      expect(second.length).toBe(first.length);
    });

    it('skips aliases (alias_of) and excludes them from the listing', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      // Add an alias file.
      await writeFile(
        join(tmp, 'packages', 'openai-codex.yml'),
        'name: openai-codex\nalias_of: codex\ndescription: "Alias for codex"\n',
      );
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      const names = list.map((p) => p.name);
      expect(names).not.toContain('openai-codex');
      expect(names).toContain('codex');
    });

    it('skips invalid YAML files (logs warning, continues)', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      // Add an invalid YAML file.
      await writeFile(join(tmp, 'packages', 'broken.yml'), 'name: broken\n  bad: : : indentation\n');
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      const names = list.map((p) => p.name);
      expect(names).not.toContain('broken');
      expect(names).toEqual(['aider', 'cline', 'codex']);
    });

    it('skips non-YAML files in the packages directory', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, 'packages', 'README.md'), '# not a package');
      await writeFile(join(tmp, 'packages', '.hidden'), 'hidden');
      const client = new GitRegistryClient({ localPath: tmp });

      const list = await client.listPackages();
      expect(list.length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // search()
  // -------------------------------------------------------------------------

  describe('search()', () => {
    it('returns ranked results for a name query', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const results = await client.search({ query: 'cline' });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0]!.name).toBe('cline');
      expect(results[0]!.score).toBe(1.0);
    });

    it('filters by runtime', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const results = await client.search({ query: 'ai', runtime: 'python' });
      expect(results).toHaveLength(1);
      expect(results[0]!.name).toBe('aider');
    });

    it('applies the default limit of 20', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const results = await client.search({ query: '' });
      // Empty query → all packages included (zero scores kept), capped at 20.
      expect(results.length).toBe(3); // only 3 fixtures
      expect(results.length).toBeLessThanOrEqual(20);
    });

    it('caches search results for the same query+filters', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const first = await client.search({ query: 'ai' });
      // Delete all packages after the first search; if the cache works,
      // the second call returns the cached results without re-scanning.
      await rm(join(tmp, 'packages'), { recursive: true, force: true });

      const second = await client.search({ query: 'ai' });
      expect(second).toEqual(first);
    });
  });

  // -------------------------------------------------------------------------
  // getInfo()
  // -------------------------------------------------------------------------

  describe('getInfo()', () => {
    it('reads registry.toml and returns RegistryMetadata', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const info = await client.getInfo();
      expect(info.schema_version).toBe(1);
      expect(info.registry_name).toBe('linuxify');
      expect(info.maintainers).toEqual(['ravi-linuxify', 'ana-cs']);
      expect(info.package_count).toBe(3);
    });

    it('computes package_count from disk (not registry.toml)', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      // Add a 4th package.
      await writeFile(
        join(tmp, 'packages', 'goose.yml'),
        'name: goose\nversion: 0.1.0\ndescription: "Block AI agent"\nruntime: node\nruntime_min_version: "20"\npackage: goose\nlauncher: goose\ninstall:\n  - echo install\ncompat:\n  min_linuxify: "0.1.0"\n  tested_distros: []\n  tested_runtimes: []\n  known_issues: []\n  not_supported: []\npermissions:\n  network: true\n  filesystem:\n    binds: []\n  services:\n    start: []\n  setuid: false\n',
      );
      const client = new GitRegistryClient({ localPath: tmp });

      const info = await client.getInfo();
      expect(info.package_count).toBe(4);
    });

    it('throws RegistryError(E_REGISTRY_CORRUPT) when registry.toml is missing', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await rm(join(tmp, 'registry.toml'), { force: true });
      const client = new GitRegistryClient({ localPath: tmp });

      await expect(client.getInfo()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_CORRUPT' }),
      );
    });

    it('throws RegistryError(E_REGISTRY_CORRUPT) when registry.toml is invalid', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, 'registry.toml'), 'this is not = valid = toml = [[[');
      const client = new GitRegistryClient({ localPath: tmp });

      await expect(client.getInfo()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_CORRUPT' }),
      );
    });

    it('throws RegistryError(E_REGISTRY_CORRUPT) when registry.toml is missing required fields', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, 'registry.toml'), 'registry_description = "no version or name"');
      const client = new GitRegistryClient({ localPath: tmp });

      await expect(client.getInfo()).rejects.toThrow(
        expect.objectContaining({ code: 'E_REGISTRY_CORRUPT' }),
      );
    });

    it('caches the info result', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const first = await client.getInfo();
      // Corrupt registry.toml after the first read; cached result should
      // be returned on the second call.
      await rm(join(tmp, 'registry.toml'), { force: true });

      const second = await client.getInfo();
      expect(second).toEqual(first);
    });
  });

  // -------------------------------------------------------------------------
  // getRegistryPath()
  // -------------------------------------------------------------------------

  describe('getRegistryPath()', () => {
    it('returns the configured localPath', () => {
      const client = new GitRegistryClient({ localPath: '/custom/path/registry' });
      expect(client.getRegistryPath()).toBe('/custom/path/registry');
    });

    it('returns the default path when no localPath configured', () => {
      const client = new GitRegistryClient();
      const p = client.getRegistryPath();
      expect(p.endsWith('/registry')).toBe(true);
      expect(p.length).toBeGreaterThan('/registry'.length);
    });
  });

  // -------------------------------------------------------------------------
  // getLastUpdate()
  // -------------------------------------------------------------------------

  describe('getLastUpdate()', () => {
    it('returns the timestamp when .last-update exists', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, '.last-update'), '2025-01-22T10:30:00.000Z');
      const client = new GitRegistryClient({ localPath: tmp });

      const ts = await client.getLastUpdate();
      expect(ts).toBe('2025-01-22T10:30:00.000Z');
    });

    it('trims whitespace from the timestamp', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, '.last-update'), '  2025-01-22T10:30:00.000Z  \n');
      const client = new GitRegistryClient({ localPath: tmp });

      const ts = await client.getLastUpdate();
      expect(ts).toBe('2025-01-22T10:30:00.000Z');
    });

    it('returns null when .last-update does not exist', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      // Ensure no .last-update file.
      const client = new GitRegistryClient({ localPath: tmp });

      const ts = await client.getLastUpdate();
      expect(ts).toBeNull();
    });

    it('returns null when .last-update is empty', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      await writeFile(join(tmp, '.last-update'), '   \n  ');
      const client = new GitRegistryClient({ localPath: tmp });

      const ts = await client.getLastUpdate();
      expect(ts).toBeNull();
    });

    it('does NOT throw when the registry is uninitialized (returns null)', async () => {
      // getLastUpdate is safe to call before update() — it just returns null.
      const client = new GitRegistryClient({
        localPath: '/tmp/linuxify-registry-does-not-exist-' + Date.now(),
      });
      const ts = await client.getLastUpdate();
      expect(ts).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Integration: update() then read
  // -------------------------------------------------------------------------

  describe('integration: update() invalidates cache', () => {
    it('getPackage sees fresh data after update() invalidates cache', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      // Populate cache.
      const before = await client.getPackage('cline');
      expect(before!.version).toBe('1.2.0');

      // Modify the file on disk.
      await writeFile(
        join(tmp, 'packages', 'cline.yml'),
        (await readFile(join(FIXTURE_REGISTRY_DIR, 'packages', 'cline.yml'), 'utf8')).replace(
          '1.2.0',
          '1.3.0',
        ),
      );

      // Without update(), the cache still returns the old version.
      const cached = await client.getPackage('cline');
      expect(cached!.version).toBe('1.2.0');

      // After update(), the cache is invalidated and the new version is read.
      await client.update();
      const after = await client.getPackage('cline');
      expect(after!.version).toBe('1.3.0');
    });

    it('listPackages sees fresh data after update() invalidates cache', async () => {
      const tmp = await copyFixtureToTemp();
      tempDirs.push(tmp);
      const client = new GitRegistryClient({ localPath: tmp });

      const before = await client.listPackages();
      expect(before.length).toBe(3);

      // Add a new package file.
      await writeFile(
        join(tmp, 'packages', 'goose.yml'),
        'name: goose\nversion: 0.1.0\ndescription: "Block AI agent"\nruntime: node\nruntime_min_version: "20"\npackage: goose\nlauncher: goose\ninstall:\n  - echo install\ncompat:\n  min_linuxify: "0.1.0"\n  tested_distros: []\n  tested_runtimes: []\n  known_issues: []\n  not_supported: []\npermissions:\n  network: true\n  filesystem:\n    binds: []\n  services:\n    start: []\n  setuid: false\n',
      );

      // Without update(), cache returns 3.
      const cached = await client.listPackages();
      expect(cached.length).toBe(3);

      // After update(), the new package is visible.
      await client.update();
      const after = await client.listPackages();
      expect(after.length).toBe(4);
      expect(after.map((p) => p.name)).toContain('goose');
    });
  });

  // -------------------------------------------------------------------------
  // Sanity: fixture directory exists
  // -------------------------------------------------------------------------

  describe('fixture sanity', () => {
    it('the fixture registry directory exists', async () => {
      expect(await exists(FIXTURE_REGISTRY_DIR)).toBe(true);
    });

    it('the fixture registry.toml exists', async () => {
      expect(await exists(join(FIXTURE_REGISTRY_DIR, 'registry.toml'))).toBe(true);
    });

    it('the fixture packages directory has 3 YAML files', async () => {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(join(FIXTURE_REGISTRY_DIR, 'packages'));
      const ymlFiles = files.filter((f) => f.endsWith('.yml'));
      expect(ymlFiles.length).toBe(3);
    });
  });
});
