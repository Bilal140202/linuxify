/**
 * Unit tests for `src/plugins/manifest.ts` — Zod schema, validateManifest,
 * and lintManifest.
 *
 * These tests exercise the schema in isolation (no filesystem, no dynamic
 * imports). The goal is to verify:
 *  1. A fully-populated, well-formed manifest parses successfully.
 *  2. Each documented rejection case (missing required field, unknown hook,
 *     bad type) is caught with the right error code.
 *  3. `lintManifest` catches semantic issues (bad name, bad semver, bad
 *     semver range, undeclared hook name).
 */

import { describe, it, expect } from 'vitest';

import {
  PluginManifestSchema,
  validateManifest,
  lintManifest,
  KNOWN_HOOK_NAMES,
} from '../../../src/plugins/manifest.js';
import type { PluginManifest } from '../../../src/plugins/types.js';
import { PluginError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of a valid, fully-populated manifest. Tests mutate
 * the copy before re-parsing to exercise rejection cases.
 */
function validManifestInput(): unknown {
  return {
    name: 'linuxify-plugin-test',
    version: '1.0.0',
    linuxify: '>=0.1.0',
    description: 'test plugin',
    provides: {
      runtimes: ['java'],
      distros: ['fedora'],
      commands: ['my-cmd'],
      doctorChecks: ['java.runtime'],
      patchTypes: ['jvm-bytecode'],
    },
    hooks: {
      preInstall: './hooks/pre-install.js',
      postInstall: './hooks/post-install.js',
      prePatch: './hooks/pre-patch.js',
      postPatch: './hooks/post-patch.js',
      preRun: './hooks/pre-run.js',
      postRun: './hooks/post-run.js',
      doctor: './hooks/doctor.js',
      bootstrap: './hooks/bootstrap.js',
      command: './hooks/command.js',
    },
    configSchema: './config-schema.json',
  };
}

// ---------------------------------------------------------------------------
// Tests: PluginManifestSchema (Zod)
// ---------------------------------------------------------------------------

describe('PluginManifestSchema', () => {
  it('accepts a fully-populated valid manifest', () => {
    const result = PluginManifestSchema.safeParse(validManifestInput());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('linuxify-plugin-test');
      expect(result.data.version).toBe('1.0.0');
      expect(result.data.provides.runtimes).toEqual(['java']);
      expect(result.data.hooks.preInstall).toBe('./hooks/pre-install.js');
    }
  });

  it('accepts a manifest with extra top-level fields (passthrough)', () => {
    const input = validManifestInput();
    (input as Record<string, unknown>).author = 'test@example.com';
    (input as Record<string, unknown>).license = 'MIT';
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects a manifest missing required `name`', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.name;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a manifest missing required `version`', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.version;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a manifest missing required `linuxify`', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.linuxify;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a manifest missing required `provides`', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.provides;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects a manifest missing required `hooks`', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.hooks;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in the `provides` block (strict)', () => {
    const input = validManifestInput() as {
      provides: Record<string, unknown>;
    };
    input.provides.unknownField = ['oops'];
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects unknown hook names in the `hooks` block (strict)', () => {
    const input = validManifestInput() as {
      hooks: Record<string, unknown>;
    };
    input.hooks.unknownHook = './hooks/unknown.js';
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('accepts a manifest with empty provides arrays', () => {
    const input = validManifestInput() as {
      provides: Record<string, unknown[]>;
    };
    input.provides.runtimes = [];
    input.provides.distros = [];
    input.provides.commands = [];
    input.provides.doctorChecks = [];
    input.provides.patchTypes = [];
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts a manifest with no hooks declared', () => {
    const input = validManifestInput() as {
      hooks: Record<string, unknown>;
    };
    input.hooks = {};
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts a manifest with only some provides fields', () => {
    const input = validManifestInput() as {
      provides: Record<string, unknown>;
    };
    delete input.provides.runtimes;
    delete input.provides.distros;
    const result = PluginManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: validateManifest
// ---------------------------------------------------------------------------

describe('validateManifest', () => {
  it('returns the validated manifest on success', () => {
    const manifest = validateManifest(validManifestInput());
    expect(manifest.name).toBe('linuxify-plugin-test');
    expect(manifest.version).toBe('1.0.0');
  });

  it('throws PluginError with E_PLUGIN_MANIFEST_INVALID on schema failure', () => {
    const input = validManifestInput() as Record<string, unknown>;
    delete input.name;
    try {
      validateManifest(input);
      throw new Error('expected validateManifest to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginError);
      expect((err as PluginError).code).toBe('E_PLUGIN_MANIFEST_INVALID');
      expect((err as PluginError).details).toHaveProperty('issues');
    }
  });

  it('throws on non-object input', () => {
    expect(() => validateManifest('not-an-object')).toThrow(PluginError);
    expect(() => validateManifest(null)).toThrow(PluginError);
    expect(() => validateManifest(42)).toThrow(PluginError);
    expect(() => validateManifest([])).toThrow(PluginError);
  });
});

// ---------------------------------------------------------------------------
// Tests: lintManifest
// ---------------------------------------------------------------------------

describe('lintManifest', () => {
  it('passes with no issues on a valid manifest', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    const report = lintManifest(manifest);
    expect(report.passed).toBe(true);
    expect(report.errors).toHaveLength(0);
  });

  it('reports E_LINT_BAD_NAME for non-kebab-case names', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { name: string }).name = 'Bad_Name';
    const report = lintManifest(manifest);
    expect(report.passed).toBe(false);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_NAME')).toBe(true);
  });

  it('reports E_LINT_BAD_NAME for names starting with a digit', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { name: string }).name = '1plugin';
    const report = lintManifest(manifest);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_NAME')).toBe(true);
  });

  it('reports E_LINT_BAD_VERSION for invalid semver', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { version: string }).version = 'not-semver';
    const report = lintManifest(manifest);
    expect(report.passed).toBe(false);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_VERSION')).toBe(true);
  });

  it('accepts valid semver with pre-release tags', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { version: string }).version = '1.0.0-alpha.1';
    const report = lintManifest(manifest);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_VERSION')).toBe(false);
  });

  it('reports E_LINT_BAD_LINUXIFY_RANGE for invalid semver range', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { linuxify: string }).linuxify = 'not-a-range';
    const report = lintManifest(manifest);
    expect(report.passed).toBe(false);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_LINUXIFY_RANGE')).toBe(true);
  });

  it('accepts common semver range formats', () => {
    // Note: semver uses whitespace (not commas) to separate comparators.
    for (const range of ['>=0.1.0', '^0.1.0', '~0.1.0', '*', '>=0.1.0 <0.2.0', '1.x']) {
      const manifest = validateManifest(validManifestInput()) as PluginManifest;
      (manifest as { linuxify: string }).linuxify = range;
      const report = lintManifest(manifest);
      expect(report.errors.some((e) => e.code === 'E_LINT_BAD_LINUXIFY_RANGE')).toBe(false);
    }
  });

  it('rejects comma-separated ranges (semver requires whitespace)', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest;
    (manifest as { linuxify: string }).linuxify = '>=0.1.0,<0.2.0';
    const report = lintManifest(manifest);
    expect(report.errors.some((e) => e.code === 'E_LINT_BAD_LINUXIFY_RANGE')).toBe(true);
  });

  it('warns on absolute hook paths', () => {
    const manifest = validateManifest(validManifestInput()) as PluginManifest & {
      hooks: Record<string, string>;
    };
    manifest.hooks.preInstall = '/abs/path/hook.js';
    const report = lintManifest(manifest);
    expect(report.warnings.some((w) => w.code === 'E_LINT_ABSOLUTE_HOOK_PATH')).toBe(true);
  });

  it('includes all 9 known hook names in KNOWN_HOOK_NAMES', () => {
    expect(KNOWN_HOOK_NAMES).toHaveLength(9);
    expect(KNOWN_HOOK_NAMES).toContain('preInstall');
    expect(KNOWN_HOOK_NAMES).toContain('postInstall');
    expect(KNOWN_HOOK_NAMES).toContain('prePatch');
    expect(KNOWN_HOOK_NAMES).toContain('postPatch');
    expect(KNOWN_HOOK_NAMES).toContain('preRun');
    expect(KNOWN_HOOK_NAMES).toContain('postRun');
    expect(KNOWN_HOOK_NAMES).toContain('doctor');
    expect(KNOWN_HOOK_NAMES).toContain('bootstrap');
    expect(KNOWN_HOOK_NAMES).toContain('command');
  });
});
