/**
 * Unit tests for `src/packages/parser.ts`.
 *
 * Exercises the three-stage pipeline (YAML parse → Zod validation → lint)
 * against the fixture files in `tests/fixtures/packages/`. The logger is
 * mocked (consistent with other test files) to avoid pino multistream
 * initialization during tests.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi } from 'vitest';

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

import { parsePackageYaml, loadPackageFromFile, lintPackage } from '../../../src/packages/parser.js';
import { PackageError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Fixture paths
// ---------------------------------------------------------------------------

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'packages');

/** Read a fixture file as UTF-8 text. */
async function readFixture(name: string): Promise<string> {
  return readFile(join(FIXTURES_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// parsePackageYaml
// ---------------------------------------------------------------------------

describe('parsePackageYaml', () => {
  describe('accepts valid YAML', () => {
    it('parses cline.yml (simple form)', async () => {
      const yaml = await readFixture('cline.yml');
      const pkg = parsePackageYaml(yaml);
      expect(pkg.name).toBe('cline');
      expect(pkg.version).toBe('1.2.0');
      expect(pkg.runtime).toBe('node');
      expect(pkg.package_manager).toBe('npm');
      expect(Array.isArray(pkg.install)).toBe(true);
    });

    it('parses codex.yml (structured form with patches)', async () => {
      const yaml = await readFixture('codex.yml');
      const pkg = parsePackageYaml(yaml);
      expect(pkg.name).toBe('codex');
      expect(pkg.version).toBe('0.20.1');
      expect(pkg.patches).toHaveLength(2);
      expect(pkg.patches[0]!.patch_id).toBe('codex-001');
      expect(pkg.doctor).toHaveLength(2);
      // Structured install form: object with steps, env, cwd.
      expect(Array.isArray(pkg.install)).toBe(false);
      const install = pkg.install as { steps: unknown[]; env?: Record<string, string>; cwd?: string };
      expect(install.steps).toHaveLength(1);
      expect(install.env).toEqual({ npm_config_target_platform: 'linux' });
      expect(install.cwd).toBe('/tmp');
    });

    it('applies defaults for omitted optional fields', async () => {
      const yaml = await readFixture('cline.yml');
      const pkg = parsePackageYaml(yaml);
      expect(pkg.patches).toEqual([]); // cline.yml has no patches
      expect(pkg.doctor).toEqual([]); // cline.yml has no doctor checks
      expect(pkg.deprecated).toBe(false);
      expect(pkg.replaces).toEqual([]);
      expect(pkg.conflicts).toEqual([]);
    });
  });

  describe('rejects invalid YAML', () => {
    it('throws PackageError(E_PACKAGE_PARSE_FAILED) on YAML syntax error', () => {
      const badYaml = 'name: cline\n  bad: indentation\n: colon';
      expect(() => parsePackageYaml(badYaml)).toThrow(PackageError);
      expect(() => parsePackageYaml(badYaml)).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_PARSE_FAILED' }),
      );
    });

    it('throws PackageError(E_PACKAGE_PARSE_FAILED) on empty input', () => {
      expect(() => parsePackageYaml('')).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_PARSE_FAILED' }),
      );
    });

    it('throws PackageError(E_PACKAGE_PARSE_FAILED) on null (empty YAML document)', () => {
      expect(() => parsePackageYaml('---\n')).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_PARSE_FAILED' }),
      );
    });

    it('throws PackageError(E_PACKAGE_PARSE_FAILED) on a YAML scalar (not a mapping)', () => {
      expect(() => parsePackageYaml('just a string')).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_PARSE_FAILED' }),
      );
    });

    it('throws PackageError(E_PACKAGE_PARSE_FAILED) on a YAML array', () => {
      expect(() => parsePackageYaml('- item1\n- item2')).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_PARSE_FAILED' }),
      );
    });
  });

  describe('rejects schema-invalid YAML', () => {
    it('throws PackageError(E_PACKAGE_SCHEMA_INVALID) for bad name', async () => {
      const yaml = await readFixture('invalid-bad-name.yml');
      expect(() => parsePackageYaml(yaml)).toThrow(PackageError);
      expect(() => parsePackageYaml(yaml)).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_SCHEMA_INVALID' }),
      );
    });

    it('throws PackageError(E_PACKAGE_SCHEMA_INVALID) for missing runtime', async () => {
      const yaml = await readFixture('invalid-missing-runtime.yml');
      expect(() => parsePackageYaml(yaml)).toThrow(
        expect.objectContaining({ code: 'E_PACKAGE_SCHEMA_INVALID' }),
      );
    });

    it('includes Zod issues in the error details', async () => {
      const yaml = await readFixture('invalid-bad-name.yml');
      try {
        parsePackageYaml(yaml);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PackageError);
        const details = (error as PackageError).details as { issues: unknown[] };
        expect(Array.isArray(details.issues)).toBe(true);
        expect(details.issues.length).toBeGreaterThan(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// loadPackageFromFile
// ---------------------------------------------------------------------------

describe('loadPackageFromFile', () => {
  it('loads and parses cline.yml', async () => {
    const pkg = await loadPackageFromFile(join(FIXTURES_DIR, 'cline.yml'));
    expect(pkg.name).toBe('cline');
    expect(pkg.version).toBe('1.2.0');
  });

  it('loads and parses codex.yml', async () => {
    const pkg = await loadPackageFromFile(join(FIXTURES_DIR, 'codex.yml'));
    expect(pkg.name).toBe('codex');
    expect(pkg.patches).toHaveLength(2);
  });

  it('does not throw when name matches filename', async () => {
    // cline.yml → name: cline → match. Should not throw.
    const pkg = await loadPackageFromFile(join(FIXTURES_DIR, 'cline.yml'));
    expect(pkg.name).toBe('cline');
  });

  it('throws PackageError(E_PACKAGE_SCHEMA_INVALID) for invalid-bad-name.yml', async () => {
    await expect(loadPackageFromFile(join(FIXTURES_DIR, 'invalid-bad-name.yml'))).rejects.toThrow(
      expect.objectContaining({ code: 'E_PACKAGE_SCHEMA_INVALID' }),
    );
  });

  it('throws PackageError(E_PACKAGE_SCHEMA_INVALID) for invalid-missing-runtime.yml', async () => {
    await expect(
      loadPackageFromFile(join(FIXTURES_DIR, 'invalid-missing-runtime.yml')),
    ).rejects.toThrow(expect.objectContaining({ code: 'E_PACKAGE_SCHEMA_INVALID' }));
  });

  it('parses dangerous-install.yml (passes schema; linter flags it separately)', async () => {
    const pkg = await loadPackageFromFile(join(FIXTURES_DIR, 'dangerous-install.yml'));
    expect(pkg.name).toBe('dangerous');
    expect(Array.isArray(pkg.install)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lintPackage
// ---------------------------------------------------------------------------

describe('lintPackage', () => {
  it('returns passed=true for a clean package (cline.yml)', async () => {
    const yaml = await readFixture('cline.yml');
    const pkg = parsePackageYaml(yaml);
    const result = lintPackage(pkg);
    expect(result.passed).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('returns passed=true for codex.yml (with patches)', async () => {
    const yaml = await readFixture('codex.yml');
    const pkg = parsePackageYaml(yaml);
    const result = lintPackage(pkg);
    expect(result.passed).toBe(true);
  });

  it('returns passed=false for dangerous-install.yml', async () => {
    const yaml = await readFixture('dangerous-install.yml');
    const pkg = parsePackageYaml(yaml);
    const result = lintPackage(pkg);
    expect(result.passed).toBe(false);
    const errorCodes = result.issues.filter((i) => i.severity === 'error').map((i) => i.code);
    expect(errorCodes).toContain('E_LINT_RM_RF_ROOT');
  });

  it('includes warnings in the issues array', async () => {
    const yaml = await readFixture('dangerous-install.yml');
    const pkg = parsePackageYaml(yaml);
    const result = lintPackage(pkg);
    const warnings = result.issues.filter((i) => i.severity === 'warning');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('issues array contains errors before warnings', async () => {
    const yaml = await readFixture('dangerous-install.yml');
    const pkg = parsePackageYaml(yaml);
    const result = lintPackage(pkg);
    const firstWarningIdx = result.issues.findIndex((i) => i.severity === 'warning');
    const lastErrorIdx = result.issues.map((i) => i.severity).lastIndexOf('error');
    expect(lastErrorIdx).toBeLessThan(firstWarningIdx);
  });
});
