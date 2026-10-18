/**
 * Unit tests for `src/hosting/services.ts` — the `ServiceManager` class.
 *
 * Covers:
 *   - `install('postgres'|'mariadb'|'redis')` runs the documented apt-get
 *     sequence.
 *   - SECURITY REGRESSION (B-H14): no command sent to exec contains the
 *     string `--skip-grant-tables`. This guards against the auth-bypass
 *     bug being reintroduced.
 *   - `start` / `stop` for each service builds the right command.
 *   - `isInstalled` runs `which <binary>` for postgres→psql,
 *     mariadb→mysql, redis→redis-cli.
 *   - `getStatus` returns the correct port for each service and the
 *     'not-installed' status when `isInstalled` returns false.
 *   - `getAllStatus` only returns services that `isInstalled` returns true.
 *   - `uninstall` runs `apt-get remove -y <pkg>; apt-get autoremove -y`.
 *
 * Both `exec` and `logger` are mocked — no real subprocesses are spawned.
 */

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

import { ServiceManager } from '../../../src/hosting/services.js';
import type { ServiceType } from '../../../src/hosting/services.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISTRO = 'ubuntu';

function ok(stdout = '', stderr = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode: 0, stdout, stderr, failed: false, timedOut: false, command: '' };
}
function fail(code = 1, stderr = 'err', stdout = ''): { exitCode: number; stdout: string; stderr: string; failed: boolean; timedOut: boolean; command: string } {
  return { exitCode: code, stdout, stderr, failed: true, timedOut: false, command: '' };
}

interface Invocation {
  cmd: string;
  args: string[];
  opts: unknown;
}

/** All exec invocations captured by the mock. */
function calls(): Invocation[] {
  return mocks.exec.mock.calls.map((c: unknown[]) => ({
    cmd: c[0] as string,
    args: c[1] as string[],
    opts: c[2],
  }));
}

/** The Nth (1-indexed) exec invocation's bash -c script string. */
function bashScriptOf(call: Invocation): string {
  // Service commands always run via `bash -c <script>`, so the script is
  // the last positional arg in the args vector.
  return call.args[call.args.length - 1];
}

// ---------------------------------------------------------------------------

describe('ServiceManager', () => {
  let sm: ServiceManager;

  beforeEach(() => {
    mocks.exec.mockReset();
    sm = new ServiceManager(DISTRO);
  });

  // -------------------------------------------------------------------------
  // install
  // -------------------------------------------------------------------------

  describe('install', () => {
    it('postgres runs the apt-get + service start + psql ALTER sequence', async () => {
      mocks.exec.mockResolvedValue(ok());   // every step exits 0
      mocks.exec.mockResolvedValueOnce(ok()); // isInstalled probe at the end → exit 0 → true
      const installed = await sm.install('postgres');
      expect(installed).toBe(true);

      const scripts = calls().map(bashScriptOf);
      // Should contain apt-get install -y postgresql postgresql-contrib
      expect(scripts.some((s) => s.includes('apt-get install -y postgresql postgresql-contrib'))).toBe(true);
      // Should start the postgres service.
      expect(scripts.some((s) => s.includes('service postgresql start'))).toBe(true);
      // Should ALTER USER postgres PASSWORD.
      expect(scripts.some((s) => s.includes('ALTER USER postgres'))).toBe(true);
    });

    it('postgres wraps each command in `apt-get update` + DEBIAN_FRONTEND=noninteractive', async () => {
      mocks.exec
        .mockResolvedValueOnce(ok()) // step 1
        .mockResolvedValueOnce(ok()) // step 2
        .mockResolvedValueOnce(ok()) // step 3
        .mockResolvedValueOnce(ok()); // isInstalled probe at end → true
      await sm.install('postgres');
      // The first 3 calls are the install steps (run as root via `--`),
      // which always wrap the command in DEBIAN_FRONTEND + apt-get update.
      const installCalls = calls().slice(0, 3);
      for (const inv of installCalls) {
        expect(inv.cmd).toBe('proot-distro');
        expect(inv.args.slice(0, 2)).toEqual(['login', DISTRO]);
        expect(inv.args).toContain('bash');
        expect(inv.args).toContain('-c');
        const script = bashScriptOf(inv);
        expect(script).toContain('DEBIAN_FRONTEND=noninteractive');
        expect(script).toContain('apt-get update -qq');
      }
    });

    it('mariadb runs mysql_install_db + mysqld_safe --skip-networking (NOT --skip-grant-tables)', async () => {
      mocks.exec.mockResolvedValue(ok());
      mocks.exec.mockResolvedValueOnce(ok()); // isInstalled probe at end
      await sm.install('mariadb');

      const scripts = calls().map(bashScriptOf);
      expect(scripts.some((s) => s.includes('apt-get install -y mariadb-server'))).toBe(true);
      expect(scripts.some((s) => s.includes('mysql_install_db'))).toBe(true);
      // The post-fix path uses --skip-networking (safe) not
      // --skip-grant-tables (auth bypass).
      expect(scripts.some((s) => s.includes('mysqld_safe --skip-networking'))).toBe(true);
      expect(scripts.some((s) => s.includes('mariadb -u root'))).toBe(true);
    });

    it('redis runs redis-server --daemonize yes --bind 127.0.0.1', async () => {
      mocks.exec.mockResolvedValue(ok());
      mocks.exec.mockResolvedValueOnce(ok());
      await sm.install('redis');

      const scripts = calls().map(bashScriptOf);
      expect(scripts.some((s) => s.includes('apt-get install -y redis-server'))).toBe(true);
      expect(scripts.some((s) => s.includes('redis-server --daemonize yes --bind 127.0.0.1'))).toBe(true);
    });

    it('returns false when isInstalled reports not installed at the end', async () => {
      // mariadb install runs 5 commands (apt-get, mysql_install_db, mysqld_safe,
      // sleep, mariadb -u root), then isInstalled makes one more call.
      mocks.exec
        .mockResolvedValueOnce(ok()) // apt-get install
        .mockResolvedValueOnce(ok()) // mysql_install_db
        .mockResolvedValueOnce(ok()) // mysqld_safe --skip-networking
        .mockResolvedValueOnce(ok()) // sleep 2
        .mockResolvedValueOnce(ok()) // mariadb -u root ...
        .mockResolvedValueOnce(fail(1)); // isInstalled probe at end → false
      const installed = await sm.install('mariadb');
      expect(installed).toBe(false);
    });

    it('does not short-circuit on a single step failure (still runs the rest)', async () => {
      // Step 1 fails, step 2 onward still runs.
      mocks.exec
        .mockResolvedValueOnce(fail(1)) // step 1 fails
        .mockResolvedValueOnce(ok())    // step 2
        .mockResolvedValueOnce(ok())    // step 3
        .mockResolvedValueOnce(ok())    // step 4 (sleep)
        .mockResolvedValueOnce(ok())    // step 5 (mariadb -u root ...)
        .mockResolvedValueOnce(ok());   // isInstalled probe
      await sm.install('mariadb');
      // 5 install commands + 1 isInstalled probe = 6 calls.
      expect(calls()).toHaveLength(6);
    });

    // SECURITY REGRESSION TEST (B-H14)
    it('SECURITY: NO command sent to exec contains the string `--skip-grant-tables`', async () => {
      mocks.exec.mockResolvedValue(ok());
      mocks.exec.mockResolvedValueOnce(ok());
      await sm.install('mariadb');
      for (const inv of calls()) {
        const everything = JSON.stringify({ cmd: inv.cmd, args: inv.args, opts: inv.opts });
        expect(everything).not.toContain('--skip-grant-tables');
      }
    });
  });

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  describe('start', () => {
    it('postgres starts via `service postgresql start`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.start('postgres')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('service postgresql start');
    });

    it('mariadb starts via `service mariadb start || mysqld_safe &`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.start('mariadb')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('service mariadb start');
      expect(script).toContain('mysqld_safe &');
    });

    it('redis starts via `redis-server --daemonize yes --bind 127.0.0.1`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.start('redis')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('redis-server --daemonize yes --bind 127.0.0.1');
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(2));
      expect(await sm.start('postgres')).toBe(false);
    });
  });

  describe('stop', () => {
    it('postgres stops via `service postgresql stop`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.stop('postgres')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('service postgresql stop');
    });

    it('mariadb stops via `service mariadb stop || mysqladmin shutdown`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.stop('mariadb')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('service mariadb stop');
      expect(script).toContain('mysqladmin shutdown');
    });

    it('redis stops via `redis-cli shutdown`', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.stop('redis')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('redis-cli shutdown');
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(2));
      expect(await sm.stop('redis')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isInstalled
  // -------------------------------------------------------------------------

  describe('isInstalled', () => {
    it('postgres probes `which psql`', async () => {
      mocks.exec.mockResolvedValue(ok('/usr/bin/psql'));
      expect(await sm.isInstalled('postgres')).toBe(true);
      const c = calls()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'which', 'psql']);
    });

    it('mariadb probes `which mysql`', async () => {
      mocks.exec.mockResolvedValue(ok('/usr/bin/mysql'));
      expect(await sm.isInstalled('mariadb')).toBe(true);
      const c = calls()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'which', 'mysql']);
    });

    it('redis probes `which redis-cli`', async () => {
      mocks.exec.mockResolvedValue(ok('/usr/bin/redis-cli'));
      expect(await sm.isInstalled('redis')).toBe(true);
      const c = calls()[0]!;
      expect(c.args).toEqual(['login', DISTRO, '--user', 'linuxify', '--', 'which', 'redis-cli']);
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(1, 'psql not found'));
      expect(await sm.isInstalled('postgres')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getStatus
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns status "not-installed" when isInstalled returns false', async () => {
      mocks.exec.mockResolvedValue(fail(1));
      const info = await sm.getStatus('postgres');
      expect(info.status).toBe('not-installed');
      expect(info.name).toBe('postgres');
      expect(info.version).toBeNull();
    });

    it('returns port 5432 for postgres', async () => {
      mocks.exec.mockResolvedValueOnce(ok('/usr/bin/psql')); // isInstalled → true
      mocks.exec.mockResolvedValueOnce(ok()); // pg_isready → exit 0 → running
      const info = await sm.getStatus('postgres');
      expect(info.port).toBe(5432);
      expect(info.status).toBe('running');
    });

    it('returns port 3306 for mariadb', async () => {
      mocks.exec.mockResolvedValueOnce(ok('/usr/bin/mysql'));
      mocks.exec.mockResolvedValueOnce(ok()); // mysqladmin ping → 0
      const info = await sm.getStatus('mariadb');
      expect(info.port).toBe(3306);
    });

    it('returns port 6379 for redis', async () => {
      mocks.exec.mockResolvedValueOnce(ok('/usr/bin/redis-cli'));
      mocks.exec.mockResolvedValueOnce(ok()); // redis-cli ping → 0
      const info = await sm.getStatus('redis');
      expect(info.port).toBe(6379);
    });

    it('returns status "running" when the readiness probe exits 0', async () => {
      mocks.exec.mockResolvedValueOnce(ok('/usr/bin/redis-cli'));
      mocks.exec.mockResolvedValueOnce(ok());
      const info = await sm.getStatus('redis');
      expect(info.status).toBe('running');
    });

    it('returns status "stopped" when installed but the readiness probe exits non-zero', async () => {
      mocks.exec.mockResolvedValueOnce(ok('/usr/bin/redis-cli')); // installed
      mocks.exec.mockResolvedValueOnce(fail(1)); // redis-cli ping fails
      const info = await sm.getStatus('redis');
      expect(info.status).toBe('stopped');
      expect(info.port).toBe(6379);
    });
  });

  // -------------------------------------------------------------------------
  // getAllStatus
  // -------------------------------------------------------------------------

  describe('getAllStatus', () => {
    it('only returns services that isInstalled returns true for', async () => {
      // postgres installed, mariadb NOT installed, redis installed.
      // isInstalled is called in order: postgres → mariadb → redis.
      mocks.exec.mockResolvedValueOnce(ok()); // isInstalled(postgres) → true
      mocks.exec.mockResolvedValueOnce(ok()); // getStatus(postgres) isInstalled probe → true
      mocks.exec.mockResolvedValueOnce(ok()); // getStatus(postgres) pg_isready → 0
      mocks.exec.mockResolvedValueOnce(fail(1)); // isInstalled(mariadb) → false
      mocks.exec.mockResolvedValueOnce(ok()); // isInstalled(redis) → true
      mocks.exec.mockResolvedValueOnce(ok()); // getStatus(redis) isInstalled → true
      mocks.exec.mockResolvedValueOnce(ok()); // getStatus(redis) redis-cli ping → 0

      const all = await sm.getAllStatus();
      expect(all.map((s) => s.name)).toEqual(['postgres', 'redis']);
      expect(all.find((s) => s.name === 'mariadb')).toBeUndefined();
    });

    it('returns an empty array when nothing is installed', async () => {
      mocks.exec.mockResolvedValue(fail(1)); // every isInstalled returns false
      const all = await sm.getAllStatus();
      expect(all).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // uninstall
  // -------------------------------------------------------------------------

  describe('uninstall', () => {
    it('postgres runs apt-get remove -y postgresql postgresql-contrib; apt-get autoremove -y', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.uninstall('postgres')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('apt-get remove -y postgresql postgresql-contrib');
      expect(script).toContain('apt-get autoremove -y');
    });

    it('mariadb runs apt-get remove -y mariadb-server', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.uninstall('mariadb')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('apt-get remove -y mariadb-server');
      expect(script).toContain('apt-get autoremove -y');
    });

    it('redis runs apt-get remove -y redis-server', async () => {
      mocks.exec.mockResolvedValue(ok());
      expect(await sm.uninstall('redis')).toBe(true);
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('apt-get remove -y redis-server');
    });

    it('sets DEBIAN_FRONTEND=noninteractive in the uninstall script', async () => {
      mocks.exec.mockResolvedValue(ok());
      await sm.uninstall('redis');
      const script = bashScriptOf(calls()[0]!);
      expect(script).toContain('DEBIAN_FRONTEND=noninteractive');
    });

    it('returns false on non-zero exit', async () => {
      mocks.exec.mockResolvedValue(fail(2));
      expect(await sm.uninstall('redis')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // SECURITY REGRESSION — global invariant across all methods
  // -------------------------------------------------------------------------

  describe('B-H14 security regression — no method emits --skip-grant-tables', () => {
    const services: ServiceType[] = ['postgres', 'mariadb', 'redis'];
    for (const svc of services) {
      it(`${svc} install emits no --skip-grant-tables in any invocation`, async () => {
        mocks.exec.mockResolvedValue(ok());
        mocks.exec.mockResolvedValueOnce(ok());
        await sm.install(svc);
        for (const inv of calls()) {
          const blob = JSON.stringify({ cmd: inv.cmd, args: inv.args, opts: inv.opts });
          expect(blob).not.toContain('--skip-grant-tables');
        }
      });
    }

    it('start/stop/install/uninstall/getStatus/isInstalled across all three services emit no --skip-grant-tables', async () => {
      mocks.exec.mockResolvedValue(ok());
      // Drive every method on every service.
      for (const svc of services) {
        await sm.install(svc);
        await sm.start(svc);
        await sm.stop(svc);
        await sm.uninstall(svc);
        await sm.isInstalled(svc);
        await sm.getStatus(svc);
      }
      for (const inv of calls()) {
        const blob = JSON.stringify({ cmd: inv.cmd, args: inv.args, opts: inv.opts });
        expect(blob).not.toContain('--skip-grant-tables');
      }
    });
  });
});
