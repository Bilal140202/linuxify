/**
 * Unit tests for `src/packages/schema.ts` (the Zod `PackageSchema`).
 *
 * These tests exercise the schema in isolation — no filesystem, no YAML
 * parser, no mocks. The goal is to verify that:
 *  1. A fully-populated, well-formed package document parses successfully.
 *  2. Each documented rejection case (missing required field, bad regex,
 *     bad enum, unknown key, wrong `setuid` literal) is caught.
 *  3. Defaults are applied correctly (tags=[], patches=[], env={}, etc.).
 *  4. Both install forms (simple array and structured object) are accepted.
 */

import { describe, it, expect } from 'vitest';

import {
  PackageSchema,
  InstallStepSchema,
  InstallBlockSchema,
  PatchDefinitionSchema,
  DoctorCheckSchema,
  PermissionsSchema,
  CompatSchema,
  EnvValueSchema,
  type PackageDefinition,
} from '../../../src/packages/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of a valid, fully-populated PackageDefinition input
 * object. Tests mutate the copy before re-parsing to exercise rejection
 * cases. Uses `JSON.parse(JSON.stringify(...))` for a deep clone (the fixture
 * has no functions, dates, or undefined values, so this is safe).
 */
function validPackageInput(): unknown {
  return {
    name: 'cline',
    version: '1.2.0',
    description: 'AI coding agent that runs in your terminal',
    homepage: 'https://github.com/cline/cline',
    license: 'MIT',
    maintainer: 'ravi@linuxify.dev',
    tags: ['ai-coding', 'terminal'],
    category: 'ai',
    runtime: 'node',
    runtime_min_version: '20',
    package: 'cline',
    launcher: 'cline',
    package_manager: 'npm',
    install: ['npm install -g cline@1.2.0'],
    uninstall: ['npm uninstall -g cline'],
    patches: [
      {
        id: 'cline-001',
        patch_id: 'cline-001',
        description: 'Treat android as linux for platform check',
        file: 'node_modules/cline/dist/platform.js',
        type: 'regex',
        find: "process\\.platform === 'linux'",
        replace: "['linux','android'].includes(process.platform)",
        verify: 'grep -q android node_modules/cline/dist/platform.js',
        rollback: true,
      },
    ],
    env: {
      CLINE_PLATFORM: 'linux',
      NODE_OPTIONS: {
        value: '--max-old-space-size=2048',
        scope: 'run',
        override: 'merge',
      },
    },
    compat: {
      min_linuxify: '0.1.0',
      tested_distros: ['ubuntu', 'debian'],
      tested_runtimes: ['node'],
      known_issues: [],
      not_supported: [],
    },
    doctor: [
      {
        id: 'cline-node-version',
        name: 'Node version',
        command: 'node --version',
        expect: 0,
        fix_command: 'linuxify runtimes install node 22 --default',
        severity: 'ok',
      },
    ],
    permissions: {
      network: true,
      filesystem: { binds: ['/sdcard:/workspace'] },
      services: { start: [] },
      setuid: false,
    },
    notes: 'If cline crashes, try linuxify patch cline.',
    deprecated: false,
    replaces: [],
    conflicts: [],
  };
}

// ---------------------------------------------------------------------------
// Top-level schema — acceptance
// ---------------------------------------------------------------------------

describe('PackageSchema', () => {
  describe('accepts valid input', () => {
    it('parses a fully-populated package', () => {
      const result = PackageSchema.safeParse(validPackageInput());
      expect(result.success).toBe(true);
      if (result.success) {
        const pkg: PackageDefinition = result.data;
        expect(pkg.name).toBe('cline');
        expect(pkg.version).toBe('1.2.0');
        expect(pkg.runtime).toBe('node');
        expect(pkg.patches).toHaveLength(1);
        expect(pkg.doctor).toHaveLength(1);
        expect(pkg.env.CLINE_PLATFORM).toBe('linux');
      }
    });

    it('parses a minimal package with only required fields and applies defaults', () => {
      const minimal = {
        name: 'rg',
        version: '14.1.0',
        description: 'ripgrep',
        homepage: 'https://github.com/BurntSushi/ripgrep',
        license: 'MIT',
        runtime: 'go',
        runtime_min_version: '1.21',
        package: 'ripgrep',
        launcher: 'rg',
        install: ['curl -fsSL https://example.com/rg.tar.gz | tar xz -C /tmp'],
        compat: {
          min_linuxify: '0.1.0',
          tested_distros: ['ubuntu'],
          tested_runtimes: ['go'],
          known_issues: [],
          not_supported: [],
        },
        permissions: {
          network: true,
          filesystem: { binds: [] },
          services: { start: [] },
          setuid: false,
        },
      };
      const result = PackageSchema.safeParse(minimal);
      expect(result.success).toBe(true);
      if (result.success) {
        const pkg = result.data;
        // Defaults applied:
        expect(pkg.tags).toEqual([]);
        expect(pkg.patches).toEqual([]);
        expect(pkg.env).toEqual({});
        expect(pkg.doctor).toEqual([]);
        expect(pkg.deprecated).toBe(false);
        expect(pkg.replaces).toEqual([]);
        expect(pkg.conflicts).toEqual([]);
        // Optional fields absent:
        expect(pkg.maintainer).toBeUndefined();
        expect(pkg.category).toBeUndefined();
        expect(pkg.package_manager).toBeUndefined();
        expect(pkg.uninstall).toBeUndefined();
        expect(pkg.notes).toBeUndefined();
        expect(pkg.alias_of).toBeUndefined();
      }
    });

    it('accepts all six runtime values', () => {
      for (const runtime of ['node', 'python', 'rust', 'go', 'bun', 'deno'] as const) {
        const input = { ...validPackageInput(), runtime, runtime_min_version: '1' };
        expect(PackageSchema.safeParse(input).success).toBe(true);
      }
    });

    it('accepts all five package_manager values', () => {
      for (const pm of ['npm', 'pip', 'cargo', 'go', 'binary'] as const) {
        const input = { ...validPackageInput(), package_manager: pm };
        expect(PackageSchema.safeParse(input).success).toBe(true);
      }
    });

    it('accepts setuid: false but not setuid: true', () => {
      const ok = { ...validPackageInput(), permissions: { ...validPackageInput().permissions, setuid: false } };
      expect(PackageSchema.safeParse(ok).success).toBe(true);
      const bad = { ...validPackageInput(), permissions: { ...validPackageInput().permissions, setuid: true } };
      expect(PackageSchema.safeParse(bad).success).toBe(false);
    });

    it('applies setuid default (false) when omitted', () => {
      const input = {
        ...validPackageInput(),
        permissions: {
          network: true,
          filesystem: { binds: [] },
          services: { start: [] },
          // setuid omitted
        },
      };
      const result = PackageSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.permissions.setuid).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Rejection — missing required fields
  // -------------------------------------------------------------------------

  describe('rejects missing required fields', () => {
    const requiredFields = [
      'name',
      'version',
      'description',
      'homepage',
      'license',
      'runtime',
      'runtime_min_version',
      'package',
      'launcher',
      'install',
      'compat',
      'permissions',
    ] as const;

    for (const field of requiredFields) {
      it(`rejects missing ${field}`, () => {
        const input = validPackageInput() as Record<string, unknown>;
        delete input[field];
        const result = PackageSchema.safeParse(input);
        expect(result.success).toBe(false);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Rejection — bad patterns / enums
  // -------------------------------------------------------------------------

  describe('rejects bad values', () => {
    it('rejects a name with uppercase letters', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), name: 'Cline' });
      expect(result.success).toBe(false);
    });

    it('rejects a name with spaces', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), name: 'my package' });
      expect(result.success).toBe(false);
    });

    it('rejects a name starting with a digit', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), name: '9line' });
      expect(result.success).toBe(false);
    });

    it('rejects a name that is too long (>63 chars)', () => {
      const result = PackageSchema.safeParse({
        ...validPackageInput(),
        name: 'a' + 'b'.repeat(63),
      });
      expect(result.success).toBe(false);
    });

    it('rejects a bad version (non-semver)', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), version: 'v1.2' });
      expect(result.success).toBe(false);
    });

    it('accepts a version with pre-release suffix', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), version: '1.2.0-beta.1' });
      expect(result.success).toBe(true);
    });

    it('rejects a bad homepage (not a URL)', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), homepage: 'not a url' });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid runtime enum', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), runtime: 'ruby' });
      expect(result.success).toBe(false);
    });

    it('rejects "none" as a runtime (not in the v1 enum)', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), runtime: 'none' });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid package_manager enum', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), package_manager: 'yarn' });
      expect(result.success).toBe(false);
    });

    it('rejects a launcher with uppercase letters', () => {
      const result = PackageSchema.safeParse({ ...validPackageInput(), launcher: 'Cline' });
      expect(result.success).toBe(false);
    });

    it('rejects an invalid patch type', () => {
      const input = validPackageInput() as { patches: Array<Record<string, unknown>> };
      input.patches[0]!.type = 'invalid';
      const result = PackageSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('rejects an invalid doctor severity', () => {
      const input = validPackageInput() as { doctor: Array<Record<string, unknown>> };
      input.doctor[0]!.severity = 'critical';
      const result = PackageSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Rejection — unknown keys (.strict())
  // -------------------------------------------------------------------------

  describe('rejects unknown keys (strict mode)', () => {
    it('rejects an unknown top-level key', () => {
      const input = { ...validPackageInput(), unknown_field: 'x' };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an unknown key in a patch', () => {
      const input = validPackageInput() as { patches: Array<Record<string, unknown>> };
      input.patches[0]!.unknown = 'x';
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an unknown key in a doctor check', () => {
      const input = validPackageInput() as { doctor: Array<Record<string, unknown>> };
      input.doctor[0]!.unknown = 'x';
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an unknown key in permissions', () => {
      const input = validPackageInput() as { permissions: Record<string, unknown> };
      input.permissions.unknown = 'x';
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an unknown key in compat', () => {
      const input = validPackageInput() as { compat: Record<string, unknown> };
      input.compat.unknown = 'x';
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Install block — both forms
  // -------------------------------------------------------------------------

  describe('install block', () => {
    it('accepts the simple (array of strings) form', () => {
      const input = { ...validPackageInput(), install: ['echo one', 'echo two'] };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });

    it('accepts the structured (object with steps) form', () => {
      const input = {
        ...validPackageInput(),
        install: {
          steps: [
            { name: 'step1', command: 'echo one', expect: 0, retry: 1, on_fail: 'abort' as const },
            { name: 'step2', command: 'echo two' },
          ],
          env: { FOO: 'bar' },
          cwd: '/tmp',
        },
      };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });

    it('accepts a mix of string and object steps in the same array', () => {
      const input = {
        ...validPackageInput(),
        install: ['echo bare', { name: 'named', command: 'echo named' }],
      };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });

    it('rejects a structured install without a steps field', () => {
      const input = {
        ...validPackageInput(),
        install: { env: { FOO: 'bar' } },
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an install step object missing the command field', () => {
      const input = {
        ...validPackageInput(),
        install: [{ name: 'nocmd' }],
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an install step object missing the name field (required in object form)', () => {
      const input = {
        ...validPackageInput(),
        install: [{ command: 'echo unnamed' }],
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an invalid on_fail value', () => {
      const input = {
        ...validPackageInput(),
        install: [{ name: 's', command: 'echo', on_fail: 'skip' }],
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Env block
  // -------------------------------------------------------------------------

  describe('env block', () => {
    it('accepts simple (string) env values', () => {
      const input = { ...validPackageInput(), env: { FOO: 'bar', BAZ: 'qux' } };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });

    it('accepts structured env values with all scopes and overrides', () => {
      const input = {
        ...validPackageInput(),
        env: {
          A: { value: '1', scope: 'runtime' as const, override: 'merge' as const },
          B: { value: '2', scope: 'run' as const, override: 'replace' as const },
          C: { value: '3', scope: 'always' as const, override: 'append' as const },
        },
      };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });

    it('applies defaults to structured env values (scope=always, override=merge)', () => {
      const input = {
        ...validPackageInput(),
        env: { X: { value: '1' } },
      };
      const result = PackageSchema.safeParse(input);
      expect(result.success).toBe(true);
      if (result.success) {
        const env = result.data.env as Record<string, unknown>;
        const x = env.X as { scope: string; override: string };
        expect(x.scope).toBe('always');
        expect(x.override).toBe('merge');
      }
    });

    it('rejects an invalid scope value', () => {
      const input = {
        ...validPackageInput(),
        env: { X: { value: '1', scope: 'install' } },
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });

    it('rejects an invalid override value', () => {
      const input = {
        ...validPackageInput(),
        env: { X: { value: '1', override: 'overwrite' } },
      };
      expect(PackageSchema.safeParse(input).success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Sub-schema unit checks
  // -------------------------------------------------------------------------

  describe('sub-schemas', () => {
    it('InstallStepSchema accepts a string', () => {
      expect(InstallStepSchema.safeParse('echo hello').success).toBe(true);
    });

    it('InstallStepSchema accepts a structured object', () => {
      expect(
        InstallStepSchema.safeParse({ name: 's', command: 'echo', expect: 0 }).success,
      ).toBe(true);
    });

    it('InstallBlockSchema accepts an array', () => {
      expect(InstallBlockSchema.safeParse(['echo', 'ls']).success).toBe(true);
    });

    it('InstallBlockSchema accepts an object with steps', () => {
      expect(
        InstallBlockSchema.safeParse({ steps: ['echo'], env: { X: '1' }, cwd: '/tmp' }).success,
      ).toBe(true);
    });

    it('EnvValueSchema accepts a bare string', () => {
      expect(EnvValueSchema.safeParse('hello').success).toBe(true);
    });

    it('EnvValueSchema accepts a structured object', () => {
      expect(EnvValueSchema.safeParse({ value: 'x', scope: 'run', override: 'merge' }).success).toBe(true);
    });

    it('PatchDefinitionSchema accepts a valid patch', () => {
      expect(
        PatchDefinitionSchema.safeParse({
          id: 'p1',
          patch_id: 'p1',
          description: 'd',
          file: 'f.js',
          type: 'regex',
          find: 'a',
          replace: 'b',
          verify: 'grep b f.js',
          rollback: true,
        }).success,
      ).toBe(true);
    });

    it('DoctorCheckSchema accepts all severity values', () => {
      for (const severity of ['ok', 'warn', 'fail'] as const) {
        expect(
          DoctorCheckSchema.safeParse({
            id: 'c',
            name: 'n',
            command: 'cmd',
            expect: 0,
            fix_command: 'fix',
            severity,
          }).success,
        ).toBe(true);
      }
    });

    it('PermissionsSchema rejects setuid: true', () => {
      expect(
        PermissionsSchema.safeParse({
          network: true,
          filesystem: { binds: [] },
          services: { start: [] },
          setuid: true,
        }).success,
      ).toBe(false);
    });

    it('CompatSchema requires min_linuxify, tested_distros, tested_runtimes, known_issues, not_supported', () => {
      const valid = {
        min_linuxify: '0.1.0',
        tested_distros: [],
        tested_runtimes: [],
        known_issues: [],
        not_supported: [],
      };
      expect(CompatSchema.safeParse(valid).success).toBe(true);
      for (const field of ['min_linuxify', 'tested_distros', 'tested_runtimes', 'known_issues', 'not_supported']) {
        const bad = { ...valid } as Record<string, unknown>;
        delete bad[field];
        expect(CompatSchema.safeParse(bad).success).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // alias_of
  // -------------------------------------------------------------------------

  describe('alias_of', () => {
    it('accepts an alias_of field', () => {
      const input = { ...validPackageInput(), alias_of: 'cline' };
      expect(PackageSchema.safeParse(input).success).toBe(true);
    });
  });
});
