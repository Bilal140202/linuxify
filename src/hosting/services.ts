/**
 * Service manager — installs and manages databases (PostgreSQL, MariaDB, Redis).
 *
 * @module linuxify/hosting/services
 *
 * Security: All databases listen on localhost ONLY by default.
 * Never auto-expose database ports to the public internet.
 */

import { logger } from '../utils/log.js';
import { exec } from '../utils/process.js';

const SERVICE_TIMEOUT = 120_000;

export type ServiceType = 'postgres' | 'mariadb' | 'redis';
export type ServiceStatus = 'running' | 'stopped' | 'not-installed' | 'failed';

export interface ServiceInfo {
  name: ServiceType;
  status: ServiceStatus;
  port: number;
  version: string | null;
}

export class ServiceManager {
  constructor(private readonly distro: string) {}

  /**
   * Install a database service inside the proot.
   * All services bind to localhost ONLY.
   */
  async install(service: ServiceType): Promise<boolean> {
    logger.info({ service, distro: this.distro }, 'hosting: installing service');

    const commands: Record<ServiceType, string[]> = {
      postgres: [
        'apt-get install -y postgresql postgresql-contrib',
        'service postgresql start || pg_ctlcluster 16 main start 2>/dev/null || true',
        'sudo -u postgres psql -c "ALTER USER postgres PASSWORD \'linuxify\';" 2>/dev/null || true',
      ],
      mariadb: [
        // SECURITY FIX (B-H14): never use --skip-grant-tables. The previous
        // implementation fell back to `mysqld_safe --skip-grant-tables &`
        // when `service mariadb start` failed — which runs MariaDB with
        // ALL authentication disabled. Anyone with network access to the
        // proot (which on Android is every app on the device via the
        // shared loopback) could connect as root with no password. We
        // now initialize the password via the official `mariadb-init`
        // approach: install the system tables (mysql_install_db), start
        // the server normally, then grant privileges through the
        // unix_socket auth plugin that ships with MariaDB 10.6+.
        'apt-get install -y mariadb-server',
        'mysql_install_db 2>/dev/null || true',
        'service mariadb start 2>/dev/null || mysqld_safe --skip-networking &',
        'sleep 2',
        // Use the unix_socket plugin (default in MariaDB 10.6+) to set
        // the linuxify user's password. This avoids any auth-bypass.
        'mariadb -u root -e "CREATE USER IF NOT EXISTS \'linuxify\'@\'localhost\' IDENTIFIED VIA unix_socket; GRANT ALL PRIVILEGES ON *.* TO \'linuxify\'@\'localhost\';" 2>/dev/null || true',
      ],
      redis: [
        'apt-get install -y redis-server',
        'redis-server --daemonize yes --bind 127.0.0.1',
      ],
    };

    for (const cmd of commands[service]) {
      const r = await exec(
        'proot-distro',
        ['login', this.distro, '--', 'bash', '-c', `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq 2>/dev/null; ${cmd}`],
        { timeoutMs: SERVICE_TIMEOUT, env: { TERM: 'dumb' } },
      );
      if (r.exitCode !== 0) {
        logger.warn({ service, cmd: cmd.slice(0, 50), exitCode: r.exitCode }, 'hosting: service install step had issues');
      }
    }

    // Verify
    const installed = await this.isInstalled(service);
    if (installed) {
      logger.info({ service }, 'hosting: service installed successfully');
    } else {
      logger.error({ service }, 'hosting: service install may have failed');
    }
    return installed;
  }

  /**
   * Start a service.
   */
  async start(service: ServiceType): Promise<boolean> {
    const startCommands: Record<ServiceType, string> = {
      postgres: 'service postgresql start 2>/dev/null || pg_ctlcluster 16 main start 2>/dev/null || true',
      mariadb: 'service mariadb start 2>/dev/null || mysqld_safe &',
      redis: 'redis-server --daemonize yes --bind 127.0.0.1',
    };
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--', 'bash', '-c', startCommands[service]],
      { timeoutMs: 10_000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }

  /**
   * Stop a service.
   */
  async stop(service: ServiceType): Promise<boolean> {
    const stopCommands: Record<ServiceType, string> = {
      postgres: 'service postgresql stop 2>/dev/null || true',
      mariadb: 'service mariadb stop 2>/dev/null || mysqladmin shutdown 2>/dev/null || true',
      redis: 'redis-cli shutdown 2>/dev/null || true',
    };
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--', 'bash', '-c', stopCommands[service]],
      { timeoutMs: 10_000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }

  /**
   * Check if a service is installed.
   */
  async isInstalled(service: ServiceType): Promise<boolean> {
    const binaries: Record<ServiceType, string> = {
      postgres: 'psql',
      mariadb: 'mysql',
      redis: 'redis-cli',
    };
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'which', binaries[service]],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }

  /**
   * Get service status.
   */
  async getStatus(service: ServiceType): Promise<ServiceInfo> {
    const ports: Record<ServiceType, number> = {
      postgres: 5432,
      mariadb: 3306,
      redis: 6379,
    };

    const installed = await this.isInstalled(service);
    if (!installed) {
      return { name: service, status: 'not-installed', port: ports[service], version: null };
    }

    // Check if the service is responding
    const checkCommands: Record<ServiceType, string> = {
      postgres: 'pg_isready 2>/dev/null',
      mariadb: 'mysqladmin ping 2>/dev/null',
      redis: 'redis-cli ping 2>/dev/null',
    };
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c', checkCommands[service]],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );

    const running = r.exitCode === 0;
    return {
      name: service,
      status: running ? 'running' : 'stopped',
      port: ports[service],
      version: null,
    };
  }

  /**
   * Get status of all installed services.
   */
  async getAllStatus(): Promise<ServiceInfo[]> {
    const services: ServiceType[] = ['postgres', 'mariadb', 'redis'];
    const results: ServiceInfo[] = [];
    for (const s of services) {
      if (await this.isInstalled(s)) {
        results.push(await this.getStatus(s));
      }
    }
    return results;
  }

  /**
   * Uninstall a service.
   */
  async uninstall(service: ServiceType): Promise<boolean> {
    const packages: Record<ServiceType, string> = {
      postgres: 'postgresql postgresql-contrib',
      mariadb: 'mariadb-server',
      redis: 'redis-server',
    };
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--', 'bash', '-c', `export DEBIAN_FRONTEND=noninteractive; apt-get remove -y ${packages[service]}; apt-get autoremove -y`],
      { timeoutMs: SERVICE_TIMEOUT, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }
}
