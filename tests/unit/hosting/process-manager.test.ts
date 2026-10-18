/**
 * Unit tests for `src/hosting/process-manager.ts` — the `ProcessManager` class.
 *
 * Covers:
 *   - Each method (`start`, `stop`, `restart`, `remove`, `status`, `logs`,
 *     `isInstalled`, `install`) builds the expected `proot-distro login
 *     <distro> --user linuxify --` invocation.
 *   - `start` interpolates the startCommand and includes `--name` and
 *     `--no-treekill`.
 *   - `status` parses `pm2 jlist` JSON output; returns `[]` on parse error
 *     or non-zero exit.
 *   - `logs` uses `--lines N --nostream`.
 *   - `install` runs `npm install -g pm2`.
 *   - `isInstalled` runs `which pm2`.
 *   - All non-zero exits return non-zero; success returns 0.
 *
 * Both `exec` and `logger` are mocked — no real subprocesses are spawned.
 */

// vi.hoisted lets us share state between the mock factory and the tests.
const mocks = vi.hoisted(() => {
  return {
    exec: vi.fn(),
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
  getLinuxifyHome: () => '/tmp/linuxify-test-home',
}));

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

import { ProcessManager } from '../../../src/hosting/process-manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISTRO = 'ubuntu';

function ok(stdout = '', stderr = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode: 0, stdout, stderr, failed: false, timedOut: false, command: '' };
}
function fail(exitCode = 1, stderr = 'err', stdout = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode, stdout, stderr, failed: true, timedOut: false, command: '' };
}

/** Return the cmd + args of the i-th exec call. exec(cmd, args, opts). */
function callInvocations(): Array<{ cmd: string; args: string[] }> {
  return mocks.exec.mock.calls.map((c: unknown[]) => ({
    cmd: c[0] as string,
    args: c[1] as string[],
  }));
}

// ---------------------------------------------------------------------------

describe('ProcessManager', () => {
  let pm: ProcessManager;

  beforeEach(() => {
    mocks.exec.mockReset();
    pm = new ProcessManager(DISTRO);
  });

  describe('start', () => {
    it('invokes proot-distro login ubuntu --user linuxify -- bash -c', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.start('myapp', 'node server.js', '/srv/app');
      const calls = callInvocations();
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c.cmd).toBe('proot-distro');
      expect(c.args.slice(0, 5)).toEqual(['login', DISTRO, '--user', 'linuxify', '--']);
      expect(c.args[5]).toBe('bash');
      expect(c.args[6]).toBe('-c');
      expect(c.args[7]).toContain('pm2 start "node server.js"');
    });

    it('interpolates the startCommand into a bash -c string', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.start('webapp', 'npm start', '/srv/web');
      const lastArg = callInvocations()[0]!.args[7];
      expect(lastArg).toContain('pm2 start "npm start"');
    });

    it('passes --name <name> and --no-treekill', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.start('unique-name', 'node app.js', '/srv/app');
      const lastArg = callInvocations()[0]!.args[7];
      expect(lastArg).toContain('--name unique-name');
      expect(lastArg).toContain('--no-treekill');
    });

    it('cds into cwd before pm2 start', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.start('a', 'node b.js', '/srv/app');
      const lastArg = callInvocations()[0]!.args[7];
      expect(lastArg).toContain('cd /srv/app');
    });

    it('returns 0 on success', async () => {
      mocks.exec.mockResolvedValue(ok());
      const code = await pm.start('a', 'node b.js', '/srv/app');
      expect(code).toBe(0);
    });

    it('returns the non-zero exit code on failure', async () => {
      mocks.exec.mockResolvedValue(fail(2, 'boom'));
      const code = await pm.start('a', 'node b.js', '/srv/app');
      expect(code).toBe(2);
    });
  });

  describe('stop', () => {
    it('invokes pm2 stop <name>', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.stop('myapp');
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'pm2', 'stop', 'myapp']);
    });

    it('returns 0 on success', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await pm.stop('myapp')).toBe(0);
    });

    it('returns the non-zero exit code on failure', async () => {
      mocks.exec.mockResolvedValue(fail(3, 'no such app'));
      expect(await pm.stop('myapp')).toBe(3);
    });
  });

  describe('restart', () => {
    it('invokes pm2 restart <name>', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.restart('myapp');
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'pm2', 'restart', 'myapp']);
    });

    it('returns 0 on success', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await pm.restart('myapp')).toBe(0);
    });

    it('returns non-zero exit code on failure', async () => {
      mocks.exec.mockResolvedValue(fail(4));
      expect(await pm.restart('myapp')).toBe(4);
    });
  });

  describe('remove', () => {
    it('invokes pm2 delete <name>', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.remove('myapp');
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'pm2', 'delete', 'myapp']);
    });

    it('returns 0 on success', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await pm.remove('myapp')).toBe(0);
    });

    it('returns non-zero exit code on failure', async () => {
      mocks.exec.mockResolvedValue(fail(5));
      expect(await pm.remove('myapp')).toBe(5);
    });
  });

  describe('status', () => {
    it('invokes pm2 jlist', async () => {
      mocks.exec.mockResolvedValue(ok('[]'));
      await pm.status();
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'pm2', 'jlist']);
    });

    it('parses JSON stdout and returns the parsed array', async () => {
      const payload = [{ name: 'app1', pid: 100 }, { name: 'app2', pid: 200 }];
      mocks.exec.mockResolvedValue(ok(JSON.stringify(payload)));
      const result = await pm.status();
      expect(result).toEqual(payload);
    });

    it('returns [] when jlist exits non-zero', async () => {
      mocks.exec.mockResolvedValue(fail(1, 'no daemon'));
      const result = await pm.status();
      expect(result).toEqual([]);
    });

    it('returns [] when stdout is unparseable garbage', async () => {
      mocks.exec.mockResolvedValue(ok('this is not json {{{'));
      const result = await pm.status();
      expect(result).toEqual([]);
    });

    it('returns a parsed object payload (when pm2 jlist returns one)', async () => {
      // pm2 jlist always returns an array in practice, but the parser must
      // be willing to return whatever JSON.parse produced — including an
      // object — so callers can introspect.
      mocks.exec.mockResolvedValue(ok(JSON.stringify({ ok: true })));
      const result = await pm.status();
      expect(result).toEqual({ ok: true });
    });
  });

  describe('logs', () => {
    it('invokes pm2 logs <name> --lines <N> --nostream', async () => {
      mocks.exec.mockResolvedValue(ok('line1\nline2\n'));
      await pm.logs('myapp', 25);
      const c = callInvocations()[0]!;
      expect(c.args).toEqual([
        'login', DISTRO, '--user', 'linuxify', '--',
        'pm2', 'logs', 'myapp', '--lines', '25', '--nostream',
      ]);
    });

    it('defaults to 50 lines when no lines arg is given', async () => {
      mocks.exec.mockResolvedValue(ok('log line\n'));
      await pm.logs('myapp');
      const c = callInvocations()[0]!;
      // The lines arg sits at index 9 of the args vector.
      expect(c.args[9]).toBe('50');
      expect(c.args[10]).toBe('--nostream');
    });

    it('returns the stdout of pm2 logs', async () => {
      mocks.exec.mockResolvedValue(ok('captured log line\n'));
      const out = await pm.logs('myapp', 10);
      expect(out).toBe('captured log line\n');
    });

    it('returns stdout even on non-zero exit (no error-throw)', async () => {
      mocks.exec.mockResolvedValue({ exitCode: 1, stdout: 'partial\n', stderr: 'err', failed: true, timedOut: false, command: '' });
      const out = await pm.logs('myapp', 10);
      expect(out).toBe('partial\n');
    });
  });

  describe('isInstalled', () => {
    it('invokes which pm2', async () => {
      mocks.exec.mockResolvedValue(ok('/usr/bin/pm2\n'));
      await pm.isInstalled();
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'which', 'pm2']);
    });

    it('returns true on exit 0', async () => {
      mocks.exec.mockResolvedValue(ok('/usr/local/bin/pm2'));
      expect(await pm.isInstalled()).toBe(true);
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(1, 'pm2 not found'));
      expect(await pm.isInstalled()).toBe(false);
    });
  });

  describe('install', () => {
    it('invokes npm install -g pm2', async () => {
      mocks.exec.mockResolvedValue(ok('added 1 package'));
      await pm.install();
      const c = callInvocations()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'npm', 'install', '-g', 'pm2']);
    });

    it('returns true on exit 0', async () => {
      mocks.exec.mockResolvedValue(ok('added 1 package'));
      expect(await pm.install()).toBe(true);
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(1, 'EACCES'));
      expect(await pm.install()).toBe(false);
    });
  });

  describe('all methods pass TERM=dumb env', () => {
    it('start passes TERM=dumb', async () => {
      mocks.exec.mockResolvedValue(ok());
      await pm.start('a', 'node b.js', '/x');
      const optsArg = mocks.exec.mock.calls[0]![2] as { env?: Record<string, string> };
      expect(optsArg?.env).toEqual({ TERM: 'dumb' });
    });

    it('status passes TERM=dumb', async () => {
      mocks.exec.mockResolvedValue(ok('[]'));
      await pm.status();
      const optsArg = mocks.exec.mock.calls[0]![2] as { env?: Record<string, string> };
      expect(optsArg?.env).toEqual({ TERM: 'dumb' });
    });
  });
});
