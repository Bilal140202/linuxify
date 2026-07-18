import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { LinuxifyError } from '../../../src/utils/errors.js';
import {
  readFile,
  readJson,
  writeFile,
  writeJson,
  ensureDir,
  exists,
  stat,
  chmod,
  rmrf,
  copyFile,
  resolvePath,
} from '../../../src/utils/fs.js';

describe('utils/fs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'linuxify-fs-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readFile', () => {
    it('reads a text file as utf-8', async () => {
      const p = path.join(tmpDir, 'hello.txt');
      writeFileSync(p, 'hello world');
      const content = await readFile(p);
      expect(content).toBe('hello world');
    });

    it('throws LinuxifyError on missing file', async () => {
      const p = path.join(tmpDir, 'nope.txt');
      await expect(readFile(p)).rejects.toBeInstanceOf(LinuxifyError);
      try {
        await readFile(p);
      } catch (e) {
        expect((e as LinuxifyError).code).toBe('E_FS_READ_FAILED');
      }
    });
  });

  describe('readJson', () => {
    it('parses JSON from a file', async () => {
      const p = path.join(tmpDir, 'data.json');
      writeFileSync(p, JSON.stringify({ a: 1, b: [2, 3] }));
      const data = await readJson<{ a: number; b: number[] }>(p);
      expect(data.a).toBe(1);
      expect(data.b).toEqual([2, 3]);
    });

    it('throws LinuxifyError with E_JSON_PARSE_FAILED on invalid JSON', async () => {
      const p = path.join(tmpDir, 'bad.json');
      writeFileSync(p, '{ not valid json');
      await expect(readJson(p)).rejects.toBeInstanceOf(LinuxifyError);
      try {
        await readJson(p);
      } catch (e) {
        expect((e as LinuxifyError).code).toBe('E_JSON_PARSE_FAILED');
      }
    });
  });

  describe('writeFile (atomic)', () => {
    it('writes content to a file', async () => {
      const p = path.join(tmpDir, 'out.txt');
      await writeFile(p, 'atomic content');
      expect(readFileSync(p, 'utf8')).toBe('atomic content');
    });

    it('leaves no .tmp file behind after write', async () => {
      const p = path.join(tmpDir, 'clean.txt');
      await writeFile(p, 'data');
      const files = require('node:fs').readdirSync(tmpDir) as string[];
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('overwrites existing file atomically', async () => {
      const p = path.join(tmpDir, 'overwrite.txt');
      await writeFile(p, 'first');
      await writeFile(p, 'second');
      expect(readFileSync(p, 'utf8')).toBe('second');
    });
  });

  describe('writeJson', () => {
    it('writes pretty-printed JSON', async () => {
      const p = path.join(tmpDir, 'out.json');
      await writeJson(p, { x: 1, y: 'two' });
      const text = readFileSync(p, 'utf8');
      expect(text).toContain('"x": 1');
      expect(text).toContain('"y": "two"');
      expect(text).toContain('\n'); // pretty-printed
    });

    it('rejects on non-serializable input', async () => {
      const p = path.join(tmpDir, 'bad.json');
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(writeJson(p, circular)).rejects.toBeInstanceOf(LinuxifyError);
    });
  });

  describe('ensureDir', () => {
    it('creates nested directories', async () => {
      const p = path.join(tmpDir, 'a', 'b', 'c');
      await ensureDir(p);
      const st = statSync(p);
      expect(st.isDirectory()).toBe(true);
    });

    it('is idempotent (no error if dir exists)', async () => {
      const p = path.join(tmpDir, 'idem');
      await ensureDir(p);
      await expect(ensureDir(p)).resolves.toBeUndefined();
    });

    it('creates with mode 0700', async () => {
      const p = path.join(tmpDir, 'private');
      await ensureDir(p);
      const st = statSync(p);
      // Mask with 0o777 to get the permission bits only.
      const mode = st.mode & 0o777;
      // On most POSIX systems this will be 0o700. On systems with weird umask
      // behavior we re-chmod in ensureDir, so it should match.
      expect(mode).toBe(0o700);
    });
  });

  describe('exists', () => {
    it('returns true for existing paths', async () => {
      const p = path.join(tmpDir, 'exists.txt');
      writeFileSync(p, 'x');
      expect(await exists(p)).toBe(true);
    });

    it('returns false for missing paths', async () => {
      const p = path.join(tmpDir, 'missing.txt');
      expect(await exists(p)).toBe(false);
    });

    it('returns false for inaccessible paths (never throws)', async () => {
      const p = path.join(tmpDir, 'nope');
      expect(await exists(p)).toBe(false);
    });
  });

  describe('stat', () => {
    it('returns stats for existing files', async () => {
      const p = path.join(tmpDir, 'stat.txt');
      writeFileSync(p, 'content');
      const st = await stat(p);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(7);
    });

    it('throws LinuxifyError on missing file', async () => {
      const p = path.join(tmpDir, 'nope');
      await expect(stat(p)).rejects.toBeInstanceOf(LinuxifyError);
    });
  });

  describe('chmod', () => {
    it('changes file permissions', async () => {
      const p = path.join(tmpDir, 'perm.txt');
      writeFileSync(p, 'x');
      await chmod(p, 0o644);
      const st = statSync(p);
      expect(st.mode & 0o777).toBe(0o644);
    });
  });

  describe('rmrf', () => {
    it('removes a file', async () => {
      const p = path.join(tmpDir, 'rm.txt');
      writeFileSync(p, 'x');
      await rmrf(p);
      expect(await exists(p)).toBe(false);
    });

    it('removes a directory recursively', async () => {
      const p = path.join(tmpDir, 'rmdir', 'sub');
      mkdirSync(path.join(tmpDir, 'rmdir', 'sub'), { recursive: true });
      writeFileSync(path.join(p, 'file.txt'), 'x');
      await rmrf(path.join(tmpDir, 'rmdir'));
      expect(await exists(path.join(tmpDir, 'rmdir'))).toBe(false);
    });

    it('does not throw when path is missing', async () => {
      const p = path.join(tmpDir, 'never-existed');
      await expect(rmrf(p)).resolves.toBeUndefined();
    });
  });

  describe('copyFile', () => {
    it('copies a file from src to dst', async () => {
      const src = path.join(tmpDir, 'src.txt');
      const dst = path.join(tmpDir, 'dst.txt');
      writeFileSync(src, 'copy me');
      await copyFile(src, dst);
      expect(readFileSync(dst, 'utf8')).toBe('copy me');
    });

    it('throws LinuxifyError when source is missing', async () => {
      const src = path.join(tmpDir, 'nope');
      const dst = path.join(tmpDir, 'dst.txt');
      await expect(copyFile(src, dst)).rejects.toBeInstanceOf(LinuxifyError);
    });
  });

  describe('resolvePath', () => {
    it('expands ~ to home directory', () => {
      const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
      expect(resolvePath('~/foo/bar')).toBe(path.join(home, 'foo', 'bar'));
    });

    it('expands bare ~ to home', () => {
      const home = process.env.HOME || process.env.USERPROFILE || '/tmp';
      expect(resolvePath('~')).toBe(home);
    });

    it('expands $VAR references', () => {
      process.env.LINUXIFY_TEST_VAR = '/opt/test';
      try {
        expect(resolvePath('$LINUXIFY_TEST_VAR/bin')).toBe('/opt/test/bin');
        expect(resolvePath('${LINUXIFY_TEST_VAR}/lib')).toBe('/opt/test/lib');
      } finally {
        delete process.env.LINUXIFY_TEST_VAR;
      }
    });

    it('leaves absolute paths without $ unchanged', () => {
      expect(resolvePath('/usr/bin/node')).toBe('/usr/bin/node');
    });
  });
});
