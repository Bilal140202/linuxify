import { describe, it, expect } from 'vitest';

import { EXIT_CODES } from '../../../src/utils/constants.js';
import {
  LinuxifyError,
  BootstrapError,
  DistroError,
  RuntimeError,
  PackageError,
  PatcherError,
  DoctorError,
  LauncherError,
  PluginError,
  RegistryError,
  ConfigError,
  StateError,
  TelemetryError,
  SecurityError,
  NetworkError,
  StorageError,
  wrapError,
  isLinuxifyError,
} from '../../../src/utils/errors.js';

describe('utils/errors', () => {
  describe('LinuxifyError (base)', () => {
    it('constructs from an options object', () => {
      const err = new LinuxifyError({
        code: 'E_TEST_FOO',
        message: 'foo failed',
        exitCode: 4,
        details: { x: 1 },
        fixCommand: 'linuxify repair',
        docsUrl: 'https://docs.linuxify.dev/test',
      });
      expect(err.code).toBe('E_TEST_FOO');
      expect(err.message).toBe('foo failed');
      expect(err.exitCode).toBe(4);
      expect(err.details).toEqual({ x: 1 });
      expect(err.fixCommand).toBe('linuxify repair');
      expect(err.docsUrl).toBe('https://docs.linuxify.dev/test');
      expect(err.name).toBe('LinuxifyError');
    });

    it('defaults exitCode to GENERIC_ERROR when omitted', () => {
      const err = new LinuxifyError({ code: 'E_TEST', message: 'x' });
      expect(err.exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
      expect(err.exitCode).toBe(1);
    });

    it('normalizes a bare code suffix to E_ prefix', () => {
      const err = new LinuxifyError({ code: 'FOO_BAR', message: 'x' });
      expect(err.code).toBe('E_FOO_BAR');
    });

    it('accepts the legacy positional constructor form', () => {
      const err = new LinuxifyError(
        'something broke',
        'E_LEGACY',
        { k: 'v' },
        new Error('root cause'),
        'linuxify fix',
        'https://docs.linuxify.dev/legacy',
      );
      expect(err.message).toBe('something broke');
      expect(err.code).toBe('E_LEGACY');
      expect(err.details).toEqual({ k: 'v' });
      expect((err.cause as Error).message).toBe('root cause');
      expect(err.fixCommand).toBe('linuxify fix');
      expect(err.docsUrl).toBe('https://docs.linuxify.dev/legacy');
    });

    it('toString includes name, code, and message', () => {
      const err = new LinuxifyError({ code: 'E_TEST', message: 'boom' });
      const s = err.toString();
      expect(s).toContain('LinuxifyError [E_TEST]: boom');
    });

    it('toString includes fixCommand and docsUrl when present', () => {
      const err = new LinuxifyError({
        code: 'E_TEST',
        message: 'boom',
        fixCommand: 'linuxify repair',
        docsUrl: 'https://docs.linuxify.dev/x',
      });
      const s = err.toString();
      expect(s).toContain('Try: linuxify repair');
      expect(s).toContain('Docs: https://docs.linuxify.dev/x');
    });

    it('toString includes cause when present', () => {
      const err = new LinuxifyError({
        code: 'E_TEST',
        message: 'wrapped',
        cause: new Error('root'),
      });
      const s = err.toString();
      expect(s).toContain('Cause: Error: root');
    });

    it('toJSON returns a structured object', () => {
      const err = new LinuxifyError({
        code: 'E_TEST',
        message: 'x',
        details: { a: 1 },
        cause: new Error('root'),
      });
      const j = err.toJSON();
      expect(j.name).toBe('LinuxifyError');
      expect(j.code).toBe('E_TEST');
      expect(j.message).toBe('x');
      expect(j.details).toEqual({ a: 1 });
      expect(j.cause).toEqual({ name: 'Error', message: 'root' });
    });
  });

  describe('subsystem error classes — default exit codes', () => {
    const cases: Array<{
      name: string;
      cls: new (m: string) => Error;
      exit: number;
      prefix: string;
    }> = [
      {
        name: 'BootstrapError',
        cls: BootstrapError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'BOOTSTRAP',
      },
      {
        name: 'DistroError',
        cls: DistroError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'DISTRO',
      },
      {
        name: 'RuntimeError',
        cls: RuntimeError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'RUNTIME',
      },
      {
        name: 'PackageError',
        cls: PackageError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'PACKAGE',
      },
      {
        name: 'PatcherError',
        cls: PatcherError as never,
        exit: EXIT_CODES.PATCH_INVALID,
        prefix: 'PATCHER',
      },
      {
        name: 'DoctorError',
        cls: DoctorError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'DOCTOR',
      },
      {
        name: 'LauncherError',
        cls: LauncherError as never,
        exit: EXIT_CODES.LAUNCHER_MISSING,
        prefix: 'LAUNCHER',
      },
      {
        name: 'PluginError',
        cls: PluginError as never,
        exit: EXIT_CODES.STEP_FAILED,
        prefix: 'PLUGIN',
      },
      {
        name: 'RegistryError',
        cls: RegistryError as never,
        exit: EXIT_CODES.REGISTRY_ERROR,
        prefix: 'REGISTRY',
      },
      {
        name: 'ConfigError',
        cls: ConfigError as never,
        exit: EXIT_CODES.CONFIG_INVALID,
        prefix: 'CONFIG',
      },
      {
        name: 'StateError',
        cls: StateError as never,
        exit: EXIT_CODES.STATE_CORRUPT,
        prefix: 'STATE',
      },
      {
        name: 'TelemetryError',
        cls: TelemetryError as never,
        exit: EXIT_CODES.TELEMETRY_DISABLED,
        prefix: 'TELEMETRY',
      },
      {
        name: 'SecurityError',
        cls: SecurityError as never,
        exit: EXIT_CODES.SIGNATURE_INVALID,
        prefix: 'SECURITY',
      },
      {
        name: 'NetworkError',
        cls: NetworkError as never,
        exit: EXIT_CODES.NETWORK_ERROR,
        prefix: 'NETWORK',
      },
      {
        name: 'StorageError',
        cls: StorageError as never,
        exit: EXIT_CODES.STORAGE_FULL,
        prefix: 'STORAGE',
      },
    ];

    for (const c of cases) {
      it(`${c.name} defaults to exit ${c.exit} and code E_${c.prefix}_GENERIC`, () => {
        const err = new c.cls('a failure');
        expect(err.exitCode).toBe(c.exit);
        expect(err.code).toBe(`E_${c.prefix}_GENERIC`);
        expect(err.name).toBe(c.name);
        expect(err.message).toBe('a failure');
        expect(err).toBeInstanceOf(LinuxifyError);
      });
    }
  });

  describe('subsystem error classes — code prefix resolution', () => {
    it('BootstrapError prefixes a bare code suffix', () => {
      const err = new BootstrapError('fdroid required', { code: 'FDROID_REQUIRED' });
      expect(err.code).toBe('E_BOOTSTRAP_FDROID_REQUIRED');
    });

    it('BootstrapError does not double-prefix a fully-qualified code', () => {
      const err = new BootstrapError('x', { code: 'E_BOOTSTRAP_FDROID_REQUIRED' });
      expect(err.code).toBe('E_BOOTSTRAP_FDROID_REQUIRED');
    });

    it('BootstrapError adds E_ to a code that already starts with the subsystem prefix', () => {
      const err = new BootstrapError('x', { code: 'BOOTSTRAP_FOO' });
      expect(err.code).toBe('E_BOOTSTRAP_FOO');
    });

    it('accepts the legacy positional form for BootstrapError', () => {
      const err = new BootstrapError(
        'fdroid required',
        'FDROID_REQUIRED',
        { version: '0.101' },
        undefined,
        'pkg install termux',
        'https://docs.linuxify.dev/bootstrap',
      );
      expect(err.code).toBe('E_BOOTSTRAP_FDROID_REQUIRED');
      expect(err.exitCode).toBe(EXIT_CODES.STEP_FAILED);
      expect(err.details).toEqual({ version: '0.101' });
      expect(err.fixCommand).toBe('pkg install termux');
      expect(err.docsUrl).toBe('https://docs.linuxify.dev/bootstrap');
    });

    it('allows overriding the default exit code via opts', () => {
      const err = new BootstrapError('network down', {
        code: 'NETWORK',
        exitCode: EXIT_CODES.NETWORK_ERROR,
      });
      expect(err.exitCode).toBe(EXIT_CODES.NETWORK_ERROR);
      expect(err.exitCode).toBe(10);
    });
  });

  describe('instanceof checks', () => {
    it('each subclass is an instance of LinuxifyError', () => {
      expect(new BootstrapError('x')).toBeInstanceOf(LinuxifyError);
      expect(new PatcherError('x')).toBeInstanceOf(LinuxifyError);
      expect(new NetworkError('x')).toBeInstanceOf(LinuxifyError);
      expect(new StorageError('x')).toBeInstanceOf(LinuxifyError);
    });

    it('subclasses are distinguishable by instanceof', () => {
      const e = new PatcherError('x');
      expect(e).toBeInstanceOf(PatcherError);
      expect(e).not.toBeInstanceOf(NetworkError);
    });
  });

  describe('wrapError', () => {
    it('passes through an existing LinuxifyError unchanged', () => {
      const orig = new BootstrapError('original', { code: 'ORIGINAL' });
      const wrapped = wrapError(orig, 'E_OTHER');
      expect(wrapped).toBe(orig);
      expect(wrapped.code).toBe('E_BOOTSTRAP_ORIGINAL');
    });

    it('wraps a plain Error', () => {
      const orig = new Error('plain failure');
      const wrapped = wrapError(orig, 'E_WRAPPED', 'wrapped message');
      expect(wrapped).toBeInstanceOf(LinuxifyError);
      expect(wrapped.code).toBe('E_WRAPPED');
      expect(wrapped.message).toBe('wrapped message');
      expect(wrapped.cause).toBe(orig);
    });

    it('wraps a string', () => {
      const wrapped = wrapError('a string error', 'E_STR');
      expect(wrapped.code).toBe('E_STR');
      expect(wrapped.message).toBe('a string error');
    });

    it('wraps an arbitrary object', () => {
      const wrapped = wrapError({ weird: true }, 'E_OBJ');
      expect(wrapped.message).toContain('weird');
    });

    it('uses err.message when no override is given', () => {
      const wrapped = wrapError(new Error('orig msg'), 'E_X');
      expect(wrapped.message).toBe('orig msg');
    });

    it('sets default exitCode to GENERIC_ERROR', () => {
      const wrapped = wrapError(new Error('x'), 'E_X');
      expect(wrapped.exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
    });
  });

  describe('isLinuxifyError', () => {
    it('returns true for a LinuxifyError', () => {
      expect(isLinuxifyError(new LinuxifyError({ code: 'E_X', message: 'y' }))).toBe(true);
    });

    it('returns true for a subclass instance', () => {
      expect(isLinuxifyError(new BootstrapError('x'))).toBe(true);
    });

    it('returns false for a plain Error', () => {
      expect(isLinuxifyError(new Error('x'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      expect(isLinuxifyError(null)).toBe(false);
      expect(isLinuxifyError(undefined)).toBe(false);
      expect(isLinuxifyError('string')).toBe(false);
      expect(isLinuxifyError({ code: 'E_X' })).toBe(false);
    });
  });

  describe('EXIT_CODES coverage', () => {
    it('includes all v1 exit codes', () => {
      expect(EXIT_CODES.OK).toBe(0);
      expect(EXIT_CODES.GENERIC_ERROR).toBe(1);
      expect(EXIT_CODES.NOT_FOUND).toBe(2);
      expect(EXIT_CODES.ENV_NOT_READY).toBe(3);
      expect(EXIT_CODES.STEP_FAILED).toBe(4);
      expect(EXIT_CODES.ALREADY_INSTALLED).toBe(5);
      expect(EXIT_CODES.UNINSTALL_FAILED).toBe(6);
      expect(EXIT_CODES.PROOT_ENTER_FAILED).toBe(7);
      expect(EXIT_CODES.LAUNCHER_MISSING).toBe(8);
      expect(EXIT_CODES.BACKUP_CORRUPT).toBe(9);
      expect(EXIT_CODES.NETWORK_ERROR).toBe(10);
      expect(EXIT_CODES.STORAGE_FULL).toBe(20);
      expect(EXIT_CODES.VERSION_INCOMPAT).toBe(21);
      expect(EXIT_CODES.PATCH_INVALID).toBe(22);
      expect(EXIT_CODES.PATCH_ALREADY_APPLIED).toBe(23);
      expect(EXIT_CODES.CONFIG_INVALID).toBe(24);
      expect(EXIT_CODES.STATE_CORRUPT).toBe(25);
      expect(EXIT_CODES.REGISTRY_ERROR).toBe(26);
      expect(EXIT_CODES.SIGNATURE_INVALID).toBe(27);
      expect(EXIT_CODES.TELEMETRY_DISABLED).toBe(28);
      expect(EXIT_CODES.MIGRATION_FAILED).toBe(29);
      expect(EXIT_CODES.PROOT_NOT_FOUND).toBe(30);
      expect(EXIT_CODES.ROOTFS_CORRUPT).toBe(31);
    });
  });
});
