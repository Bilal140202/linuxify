/**
 * Unit tests for `src/launcher/generator.ts` (the `LauncherGenerator` class).
 *
 * These tests exercise the generator against the real `src/utils/` modules
 * (fs, errors, process, constants) — only the logger is mocked, because
 * pino's lazy initializer does not play well with vitest's stdio capture
 * (see `tests/unit/state/store.test.ts` for the same pattern). Each test
 * gets a fresh tmpdir via `mkdtemp` and constructs a `LauncherGenerator`
 * pointed at it, so no test ever touches the real `$PREFIX/bin/`.
 *
 * Coverage:
 *   - `generate()` writes the file with the correct content (standard,
 *     direct, custom variants).
 *   - The written file is executable (mode `0o755`).
 *   - `generate()` rejects path-traversal launcher names.
 *   - `generate()` rejects missing required fields.
 *   - `generate()` rejects direct variant without binaryPath.
 *   - `regenerate()` looks up the package in state and writes a standard
 *     launcher.
 *   - `regenerate()` throws when the package is not in state.
 *   - `regenerateAll()` regenerates all launchers from state and continues
 *     past individual failures.
 *   - `remove()` deletes the file.
 *   - `remove()` is idempotent (no-op on missing file).
 *   - `exists()` returns the correct boolean.
 *   - `list()` finds all Linuxify launchers and skips non-Linuxify files.
 *   - `list()` parses packageName and variant from the file header.
 *   - `getLauncherGenerator()` returns a singleton bound to `process.env.PREFIX`.
 */

import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock only the logger — pino's lazy initializer crashes under vitest's stdio
// capture. The real fs/errors/process/constants modules are used as-is.
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

import { LauncherGenerator } from '../../../src/launcher/generator.js';
import {
  getLauncherGenerator,
  _resetLauncherGeneratorForTests,
} from '../../../src/launcher/index.js';
import { LauncherError } from '../../../src/utils/errors.js';
import { LINUXIFY_HEADER_SIGNATURE } from '../../../src/launcher/templates.js';
import { defaultState, type State, type PackageInstall } from '../../../src/state/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Returns the low 9 bits of the file mode (the permission bits). */
async function fileMode(path: string): Promise<number> {
  const s = await stat(path);
  return s.mode & 0o777;
}

/** Returns true if a file exists at `path`. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Builds a PackageInstall entry suitable for state.installed_packages. */
function makePackageEntry(opts: {
  name: string;
  distro?: string;
  launcherPath?: string;
}): PackageInstall {
  return {
    name: opts.name,
    version: '1.0.0',
    distro: opts.distro ?? 'ubuntu',
    runtime: 'node',
    runtime_version: '22.11.0',
    install_date: '2025-01-01T00:00:00.000Z',
    launcher_path: opts.launcherPath ?? `/data/data/com.termux/files/usr/bin/${opts.name}`,
    patches_applied: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LauncherGenerator', () => {
  let tmpPrefix: string;
  let binDir: string;
  let gen: LauncherGenerator;

  beforeEach(async () => {
    tmpPrefix = await mkdtemp(join(tmpdir(), 'linuxify-launcher-'));
    binDir = join(tmpPrefix, 'bin');
    gen = new LauncherGenerator({ prefix: tmpPrefix });
  });

  afterEach(async () => {
    await rm(tmpPrefix, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('stores the prefix as a public readonly field', () => {
      expect(gen.prefix).toBe(tmpPrefix);
    });

    it('derives binDir from prefix', () => {
      expect(gen.binDir).toBe(binDir);
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_PREFIX) when prefix is empty', () => {
      expect(() => new LauncherGenerator({ prefix: '' })).toThrow(LauncherError);
      expect(() => new LauncherGenerator({ prefix: '' })).toThrow(/prefix/);
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_PREFIX) when prefix is whitespace', () => {
      expect(() => new LauncherGenerator({ prefix: '   ' })).toThrow(LauncherError);
    });
  });

  // -------------------------------------------------------------------------
  // generate() — standard variant
  // -------------------------------------------------------------------------

  describe('generate() — standard variant', () => {
    it('writes a launcher file at <prefix>/bin/<launcherName>', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      const launcherPath = join(binDir, 'cline');
      expect(await fileExists(launcherPath)).toBe(true);
    });

    it('writes the file with mode 0755 (executable, world-readable)', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      expect(await fileMode(join(binDir, 'cline'))).toBe(0o755);
    });

    it('writes the correct content (shebang, header, env vars, exec line)', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      const content = await readFile(join(binDir, 'cline'), 'utf8');
      expect(content).toContain('#!/data/data/com.termux/files/usr/bin/sh');
      expect(content).toContain('# Auto-generated by Linuxify. Do not edit.');
      expect(content).toContain('# Package: cline');
      expect(content).toContain('# Distro: ubuntu');
      expect(content).toContain('# Variant: standard');
      expect(content).toContain('LINUXIFY_PKG="cline"');
      expect(content).toContain('LINUXIFY_DISTRO="ubuntu"');
      expect(content).toContain('exec linuxify run "$LINUXIFY_PKG" -- "$@"');
    });

    it('returns a LauncherResult with the correct path and metadata', async () => {
      const result = await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      expect(result.path).toBe(join(binDir, 'cline'));
      expect(result.packageName).toBe('cline');
      expect(result.launcherName).toBe('cline');
      expect(result.variant).toBe('standard');
    });

    it('creates the bin/ directory if it does not exist', async () => {
      expect(await fileExists(binDir)).toBe(false);
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      expect(await fileExists(binDir)).toBe(true);
      expect(await fileExists(join(binDir, 'cline'))).toBe(true);
    });

    it('overwrites an existing launcher atomically (no .tmp file left behind)', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      // Overwrite with a different distro.
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'debian',
        variant: 'standard',
      });
      const content = await readFile(join(binDir, 'cline'), 'utf8');
      expect(content).toContain('# Distro: debian');
      expect(content).not.toContain('# Distro: ubuntu');

      // No .tmp files left behind.
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(binDir);
      const tmpFiles = files.filter((f) => f.includes('.tmp.'));
      expect(tmpFiles).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // generate() — direct variant
  // -------------------------------------------------------------------------

  describe('generate() — direct variant', () => {
    it('writes a direct launcher that execs proot-distro login directly', async () => {
      await gen.generate({
        packageName: 'eslint',
        launcherName: 'eslint',
        distro: 'debian',
        variant: 'direct',
        binaryPath: '/home/linuxify/.local/bin/eslint',
      });
      const content = await readFile(join(binDir, 'eslint'), 'utf8');
      expect(content).toContain('#!/data/data/com.termux/files/usr/bin/sh');
      expect(content).toContain('# Variant: direct');
      expect(content).toContain(
        'exec proot-distro login debian --user linuxify -- /home/linuxify/.local/bin/eslint "$@"',
      );
      // Direct variant does NOT set LINUXIFY_* env vars.
      expect(content).not.toContain('LINUXIFY_PKG=');
    });

    it('throws LauncherError(E_LAUNCHER_DIRECT_BINARY_PATH_MISSING) when binaryPath is missing', async () => {
      await expect(
        gen.generate({
          packageName: 'eslint',
          launcherName: 'eslint',
          distro: 'debian',
          variant: 'direct',
        }),
      ).rejects.toThrow(LauncherError);
      await expect(
        gen.generate({
          packageName: 'eslint',
          launcherName: 'eslint',
          distro: 'debian',
          variant: 'direct',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_DIRECT_BINARY_PATH_MISSING' });
    });
  });

  // -------------------------------------------------------------------------
  // generate() — custom variant
  // -------------------------------------------------------------------------

  describe('generate() — custom variant', () => {
    it('writes a custom launcher with the user script preserved', async () => {
      await gen.generate({
        packageName: 'mytool',
        launcherName: 'mytool',
        distro: 'alpine',
        variant: 'custom',
        customScript: '#!/bin/bash\necho pre\nexec linuxify run mytool -- "$@"',
      });
      const content = await readFile(join(binDir, 'mytool'), 'utf8');
      expect(content.split('\n')[0]).toBe('#!/bin/bash');
      expect(content).toContain('# Variant: custom');
      expect(content).toContain('echo pre');
      expect(content).toContain('exec linuxify run mytool -- "$@"');
    });

    it('throws LauncherError(E_LAUNCHER_CUSTOM_SCRIPT_MISSING) when customScript is missing', async () => {
      await expect(
        gen.generate({
          packageName: 'mytool',
          launcherName: 'mytool',
          distro: 'alpine',
          variant: 'custom',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_CUSTOM_SCRIPT_MISSING' });
    });
  });

  // -------------------------------------------------------------------------
  // generate() — validation
  // -------------------------------------------------------------------------

  describe('generate() — validation', () => {
    it('throws LauncherError(E_LAUNCHER_INVALID_SPEC) when packageName is empty', async () => {
      await expect(
        gen.generate({
          packageName: '',
          launcherName: 'cline',
          distro: 'ubuntu',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_SPEC' });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_SPEC) when distro is empty', async () => {
      await expect(
        gen.generate({
          packageName: 'cline',
          launcherName: 'cline',
          distro: '',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_SPEC' });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) when launcherName contains "/"', async () => {
      await expect(
        gen.generate({
          packageName: 'cline',
          launcherName: '../etc/passwd',
          distro: 'ubuntu',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME' });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) when launcherName is "."', async () => {
      await expect(
        gen.generate({
          packageName: 'cline',
          launcherName: '.',
          distro: 'ubuntu',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME' });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) when launcherName is ".."', async () => {
      await expect(
        gen.generate({
          packageName: 'cline',
          launcherName: '..',
          distro: 'ubuntu',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME' });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) when launcherName contains backslash', async () => {
      await expect(
        gen.generate({
          packageName: 'cline',
          launcherName: 'foo\\bar',
          distro: 'ubuntu',
          variant: 'standard',
        }),
      ).rejects.toMatchObject({ code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME' });
    });

    it('does not write any file when validation fails', async () => {
      try {
        await gen.generate({
          packageName: '',
          launcherName: 'cline',
          distro: 'ubuntu',
          variant: 'standard',
        });
      } catch {
        // expected
      }
      expect(await fileExists(binDir)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // regenerate()
  // -------------------------------------------------------------------------

  describe('regenerate()', () => {
    it('looks up the package in state and writes a standard launcher', async () => {
      const state: State = defaultState();
      state.installed_packages.push(makePackageEntry({ name: 'cline', distro: 'ubuntu' }));

      const result = await gen.regenerate('cline', state);

      expect(result.packageName).toBe('cline');
      expect(result.launcherName).toBe('cline');
      expect(result.variant).toBe('standard');
      expect(result.path).toBe(join(binDir, 'cline'));

      const content = await readFile(join(binDir, 'cline'), 'utf8');
      expect(content).toContain('# Package: cline');
      expect(content).toContain('# Distro: ubuntu');
      expect(content).toContain('exec linuxify run "$LINUXIFY_PKG" -- "$@"');
    });

    it('derives launcherName from the basename of launcher_path', async () => {
      const state: State = defaultState();
      state.installed_packages.push(
        makePackageEntry({
          name: 'cline',
          distro: 'ubuntu',
          launcherPath: '/some/weird/path/my-cline',
        }),
      );

      const result = await gen.regenerate('cline', state);
      expect(result.launcherName).toBe('my-cline');
      expect(result.path).toBe(join(binDir, 'my-cline'));
    });

    it('writes the file with mode 0755', async () => {
      const state: State = defaultState();
      state.installed_packages.push(makePackageEntry({ name: 'cline' }));

      await gen.regenerate('cline', state);
      expect(await fileMode(join(binDir, 'cline'))).toBe(0o755);
    });

    it('overwrites an existing launcher with the new distro from state', async () => {
      // First, write a launcher for ubuntu.
      const state1: State = defaultState();
      state1.installed_packages.push(makePackageEntry({ name: 'cline', distro: 'ubuntu' }));
      await gen.regenerate('cline', state1);
      expect(await readFile(join(binDir, 'cline'), 'utf8')).toContain('# Distro: ubuntu');

      // Now switch the distro in state and regenerate.
      const state2: State = defaultState();
      state2.installed_packages.push(makePackageEntry({ name: 'cline', distro: 'debian' }));
      await gen.regenerate('cline', state2);
      const content = await readFile(join(binDir, 'cline'), 'utf8');
      expect(content).toContain('# Distro: debian');
      expect(content).not.toContain('# Distro: ubuntu');
    });

    it('throws LauncherError(E_LAUNCHER_PACKAGE_NOT_IN_STATE) when the package is not installed', async () => {
      const state: State = defaultState();
      await expect(gen.regenerate('nonexistent', state)).rejects.toMatchObject({
        code: 'E_LAUNCHER_PACKAGE_NOT_IN_STATE',
      });
    });

    it('includes a fixCommand in the not-in-state error', async () => {
      const state: State = defaultState();
      try {
        await gen.regenerate('nonexistent', state);
      } catch (e) {
        expect((e as LauncherError).fixCommand).toBe('linuxify add nonexistent');
      }
    });
  });

  // -------------------------------------------------------------------------
  // regenerateAll()
  // -------------------------------------------------------------------------

  describe('regenerateAll()', () => {
    it('regenerates launchers for every package in state', async () => {
      const state: State = defaultState();
      state.installed_packages.push(
        makePackageEntry({ name: 'cline', distro: 'ubuntu' }),
        makePackageEntry({ name: 'codex', distro: 'ubuntu' }),
        makePackageEntry({ name: 'aider', distro: 'debian' }),
      );

      const results = await gen.regenerateAll(state);

      expect(results).toHaveLength(3);
      expect(results.map((r) => r.packageName).sort()).toEqual(['aider', 'cline', 'codex']);
      expect(await fileExists(join(binDir, 'cline'))).toBe(true);
      expect(await fileExists(join(binDir, 'codex'))).toBe(true);
      expect(await fileExists(join(binDir, 'aider'))).toBe(true);

      // aider is in debian; the others in ubuntu.
      const aiderContent = await readFile(join(binDir, 'aider'), 'utf8');
      expect(aiderContent).toContain('# Distro: debian');
      const clineContent = await readFile(join(binDir, 'cline'), 'utf8');
      expect(clineContent).toContain('# Distro: ubuntu');
    });

    it('returns an empty array when state.installed_packages is empty', async () => {
      const state: State = defaultState();
      const results = await gen.regenerateAll(state);
      expect(results).toEqual([]);
    });

    it('continues past a malformed entry and returns the successful ones', async () => {
      const state: State = defaultState();
      state.installed_packages.push(
        makePackageEntry({ name: 'good1', distro: 'ubuntu' }),
        // Malformed: empty launcher_path — basename('') is '', which fails
        // validation inside regenerate().
        {
          ...makePackageEntry({ name: 'bad', distro: 'ubuntu' }),
          launcher_path: '',
        },
        makePackageEntry({ name: 'good2', distro: 'ubuntu' }),
      );

      const results = await gen.regenerateAll(state);

      // The two good packages should have been regenerated; the bad one
      // should have been skipped.
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.packageName).sort()).toEqual(['good1', 'good2']);
      expect(await fileExists(join(binDir, 'good1'))).toBe(true);
      expect(await fileExists(join(binDir, 'good2'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // remove()
  // -------------------------------------------------------------------------

  describe('remove()', () => {
    it('deletes an existing launcher file', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      expect(await fileExists(join(binDir, 'cline'))).toBe(true);

      await gen.remove('cline');

      expect(await fileExists(join(binDir, 'cline'))).toBe(false);
    });

    it('is idempotent — no-op when the file does not exist', async () => {
      expect(await fileExists(join(binDir, 'ghost'))).toBe(false);
      await expect(gen.remove('ghost')).resolves.toBeUndefined();
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) for path-traversal names', async () => {
      await expect(gen.remove('../etc/passwd')).rejects.toMatchObject({
        code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME',
      });
    });

    it('throws LauncherError(E_LAUNCHER_INVALID_LAUNCHER_NAME) for empty name', async () => {
      await expect(gen.remove('')).rejects.toMatchObject({
        code: 'E_LAUNCHER_INVALID_LAUNCHER_NAME',
      });
    });
  });

  // -------------------------------------------------------------------------
  // exists()
  // -------------------------------------------------------------------------

  describe('exists()', () => {
    it('returns true when the launcher exists', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      expect(await gen.exists('cline')).toBe(true);
    });

    it('returns false when the launcher does not exist', async () => {
      expect(await gen.exists('cline')).toBe(false);
    });

    it('returns false when the bin/ directory does not exist', async () => {
      // Fresh tmpPrefix, bin/ not yet created.
      expect(await fileExists(binDir)).toBe(false);
      expect(await gen.exists('anything')).toBe(false);
    });

    it('returns true for a non-Linuxify file too (exists is path-only, not content-aware)', async () => {
      // exists() just checks the path; it does not validate that the file is
      // a Linuxify launcher. Use list() for content-aware enumeration.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'foreign'), 'not a linuxify file\n', { mode: 0o755 });
      expect(await gen.exists('foreign')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    it('returns an empty array when bin/ does not exist', async () => {
      expect(await fileExists(binDir)).toBe(false);
      expect(await gen.list()).toEqual([]);
    });

    it('returns an empty array when bin/ is empty', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      expect(await gen.list()).toEqual([]);
    });

    it('finds a single Linuxify launcher', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });

      const list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.packageName).toBe('cline');
      expect(list[0]!.launcherName).toBe('cline');
      expect(list[0]!.variant).toBe('standard');
      expect(list[0]!.path).toBe(join(binDir, 'cline'));
    });

    it('finds multiple Linuxify launchers of mixed variants', async () => {
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      await gen.generate({
        packageName: 'eslint',
        launcherName: 'eslint',
        distro: 'debian',
        variant: 'direct',
        binaryPath: '/usr/bin/eslint',
      });
      await gen.generate({
        packageName: 'mytool',
        launcherName: 'mytool',
        distro: 'alpine',
        variant: 'custom',
        customScript: '#!/bin/bash\nexec linuxify run mytool -- "$@"',
      });

      const list = await gen.list();
      expect(list).toHaveLength(3);

      const byName = new Map(list.map((r) => [r.launcherName, r]));
      expect(byName.get('cline')!.variant).toBe('standard');
      expect(byName.get('eslint')!.variant).toBe('direct');
      expect(byName.get('mytool')!.variant).toBe('custom');

      expect(byName.get('cline')!.packageName).toBe('cline');
      expect(byName.get('eslint')!.packageName).toBe('eslint');
      expect(byName.get('mytool')!.packageName).toBe('mytool');
    });

    it('skips non-Linuxify files in bin/', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });

      // A Linuxify launcher.
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });

      // A non-Linuxify file (no header signature).
      await writeFile(join(binDir, 'foreign'), '#!/bin/sh\necho hello\n', { mode: 0o755 });

      // Another non-Linuxify file.
      await writeFile(join(binDir, 'random-binary'), '\x00\x01\x02binary\x00', { mode: 0o755 });

      const list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.launcherName).toBe('cline');
    });

    it('does not crash on binary files in bin/', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      // Write a 4 KB binary file with no Linuxify signature.
      const buf = Buffer.alloc(4096, 0xff);
      await writeFile(join(binDir, 'big-binary'), buf, { mode: 0o755 });

      const list = await gen.list();
      expect(list).toEqual([]);
    });

    it('parses packageName from the header even when filename differs', async () => {
      // Generate a launcher whose filename differs from the package name.
      await gen.generate({
        packageName: 'real-package',
        launcherName: 'alias-name',
        distro: 'ubuntu',
        variant: 'standard',
      });

      const list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.launcherName).toBe('alias-name');
      expect(list[0]!.packageName).toBe('real-package');
    });

    it('defaults variant to "standard" when the header is malformed', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      // Write a file with the Linuxify signature but no Variant line.
      await writeFile(
        join(binDir, 'weird'),
        [
          '#!/data/data/com.termux/files/usr/bin/sh',
          '# Auto-generated by Linuxify. Do not edit.',
          '# Package: weird',
          // No '# Variant: ...' line.
          'exec true',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.variant).toBe('standard'); // default
      expect(list[0]!.packageName).toBe('weird');
    });

    it('defaults packageName to the filename when the header is missing the Package line', async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });
      await writeFile(
        join(binDir, 'orphan'),
        [
          '#!/data/data/com.termux/files/usr/bin/sh',
          '# Auto-generated by Linuxify. Do not edit.',
          '# Variant: standard',
          // No '# Package: ...' line.
          'exec true',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      const list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.packageName).toBe('orphan'); // falls back to filename
    });

    it('skips directories and symlinks in bin/', async () => {
      const { mkdir, symlink } = await import('node:fs/promises');
      await mkdir(binDir, { recursive: true });

      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });

      // A directory in bin/ — should be skipped.
      await mkdir(join(binDir, 'subdir'), { recursive: true });
      // A file inside the subdir with the Linuxify signature — must NOT be
      // found (list() is non-recursive).
      await writeFile(
        join(binDir, 'subdir', 'nested'),
        ['#!/bin/sh', '# Auto-generated by Linuxify.', ''].join('\n'),
        { mode: 0o755 },
      );

      // A symlink to cline — should be skipped (we check isFile()).
      await symlink(join(binDir, 'cline'), join(binDir, 'cline-link'));

      const list = await gen.list();
      // Only the regular file 'cline' should be found.
      expect(list).toHaveLength(1);
      expect(list[0]!.launcherName).toBe('cline');
    });

    it('detects files whose header appears within the first 1 KiB', async () => {
      // The generator reads only the first 1 KiB of each file. A Linuxify
      // launcher's signature is always on line 2, so this is plenty. Verify
      // by writing a launcher with a normal header.
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      const list = await gen.list();
      expect(list.some((r) => r.launcherName === 'cline')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: generate + list + remove
  // -------------------------------------------------------------------------

  describe('integration: generate → list → remove', () => {
    it('generate, list, remove, list-again lifecycle', async () => {
      // Initial state: no launchers.
      expect(await gen.list()).toEqual([]);

      // Generate three launchers.
      await gen.generate({
        packageName: 'cline',
        launcherName: 'cline',
        distro: 'ubuntu',
        variant: 'standard',
      });
      await gen.generate({
        packageName: 'codex',
        launcherName: 'codex',
        distro: 'ubuntu',
        variant: 'standard',
      });
      await gen.generate({
        packageName: 'aider',
        launcherName: 'aider',
        distro: 'debian',
        variant: 'direct',
        binaryPath: '/usr/bin/aider',
      });

      // list() should find all three.
      let list = await gen.list();
      expect(list).toHaveLength(3);

      // Remove one.
      await gen.remove('codex');
      list = await gen.list();
      expect(list).toHaveLength(2);
      expect(list.map((r) => r.launcherName).sort()).toEqual(['aider', 'cline']);

      // Remove another.
      await gen.remove('cline');
      list = await gen.list();
      expect(list).toHaveLength(1);
      expect(list[0]!.launcherName).toBe('aider');

      // Remove the last.
      await gen.remove('aider');
      list = await gen.list();
      expect(list).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// getLauncherGenerator() singleton
// ---------------------------------------------------------------------------

describe('getLauncherGenerator()', () => {
  let originalPrefix: string | undefined;

  beforeEach(() => {
    originalPrefix = process.env.PREFIX;
    _resetLauncherGeneratorForTests();
  });

  afterEach(() => {
    if (originalPrefix === undefined) {
      delete process.env.PREFIX;
    } else {
      process.env.PREFIX = originalPrefix;
    }
    _resetLauncherGeneratorForTests();
  });

  it('returns a LauncherGenerator bound to process.env.PREFIX', () => {
    const tmp = '/tmp/linuxify-singleton-test-1';
    process.env.PREFIX = tmp;
    const gen = getLauncherGenerator();
    expect(gen).toBeInstanceOf(LauncherGenerator);
    expect(gen.prefix).toBe(tmp);
  });

  it('falls back to the hardcoded Termux prefix when PREFIX is unset', () => {
    delete process.env.PREFIX;
    const gen = getLauncherGenerator();
    expect(gen.prefix).toBe('/data/data/com.termux/files/usr');
  });

  it('returns the same instance on subsequent calls (singleton)', () => {
    process.env.PREFIX = '/tmp/linuxify-singleton-test-2';
    const a = getLauncherGenerator();
    const b = getLauncherGenerator();
    expect(a).toBe(b);
  });

  it('_resetLauncherGeneratorForTests() forces the next call to re-create', () => {
    process.env.PREFIX = '/tmp/linuxify-singleton-test-3a';
    const a = getLauncherGenerator();
    _resetLauncherGeneratorForTests();
    process.env.PREFIX = '/tmp/linuxify-singleton-test-3b';
    const b = getLauncherGenerator();
    expect(a).not.toBe(b);
    expect(b.prefix).toBe('/tmp/linuxify-singleton-test-3b');
  });
});
