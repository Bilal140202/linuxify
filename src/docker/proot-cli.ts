/**
 * proot-distro Docker/Podman CLI wrapper — runs docker/podman inside the
 * active proot-distro (typically Ubuntu).
 *
 * @module linuxify/docker/proot-cli
 *
 * This is the fallback path when Podroid isn't available. It's slower
 * than Podroid (no KVM acceleration) and proot's syscall translation
 * sometimes breaks dockerd in subtle ways, but it works without rooting
 * the device and without installing a separate APK.
 *
 * The wrapper shells into the proot via `proot-distro login <distro>
 * --user linuxify --` and runs `docker <args>` (or `podman <args>`) inside.
 * No port forwarding is needed on this path — docker's `-p` flag binds
 * directly to the proot's network namespace, which Termux makes reachable
 * on the LAN via the standard `0.0.0.0` bind.
 */

import { logger } from '../utils/log.js';
import { exec } from '../utils/process.js';

/** Default per-command timeout (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * proot-distro docker/podman client.
 *
 * All operations shell into the proot as the linuxify user and run
 * `docker <args>` (or `podman <args>`). The wrapper handles common
 * operations: pull, run, stop, start, rm, logs, ps.
 */
export class ProotDockerClient {
  private readonly distro: string;
  private readonly binary: 'docker' | 'podman';

  constructor(opts: { distro: string; binary?: 'docker' | 'podman' }) {
    this.distro = opts.distro;
    this.binary = opts.binary ?? 'docker';
  }

  /**
   * Run a command inside the proot as the linuxify user.
   */
  private async runInProot(
    command: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c', command],
      { timeoutMs, env: { TERM: 'dumb' } },
    );
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  /**
   * Pull an image. Pre-checks the manifest supports our arch.
   *
   * @param image - Image reference.
   * @param arch - Host arch (for manifest pre-check).
   */
  async pullImage(image: string, arch: string): Promise<{ ok: boolean; message: string }> {
    // Manifest pre-check — refuse to start a 20-min pull that's
    // guaranteed to fail at the end.
    const manifestR = await this.runInProot(
      `${this.binary} manifest inspect ${shellQuote(image)} 2>/dev/null | grep -q '"architecture": "${arch}"' && echo ok || echo missing`,
      15_000,
    );
    if (manifestR.stdout.trim() === 'missing') {
      return {
        ok: false,
        message: `Image '${image}' has no manifest for arch '${arch}'. Pick a multi-arch image (linux/arm64 is the most common Android arch).`,
      };
    }
    // Pull (long-running; cap at 5 min).
    const r = await this.runInProot(
      `${this.binary} pull ${shellQuote(image)} 2>&1 | tail -5`,
      300_000,
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        message: `${this.binary} pull ${image} failed: ${r.stdout || r.stderr}`.slice(0, 300),
      };
    }
    return { ok: true, message: `Pulled ${image}.` };
  }

  /**
   * Run a container in detached mode. Returns the container's short ID.
   *
   * On proot-distro, no separate `forward` step is needed — docker's
   * `-p` binds directly to the proot's network namespace, which Termux
   * surfaces on the LAN.
   */
  async runContainer(opts: {
    image: string;
    name: string;
    ports: Array<{ host: number; guest: number; protocol?: 'tcp' | 'udp' }>;
    env: Array<{ key: string; value: string }>;
    volumes: Array<{ hostPath: string; containerPath: string; mode: 'ro' | 'rw' }>;
    restart: 'no' | 'unless-stopped' | 'always' | 'on-failure';
    extraArgs?: string[];
  }): Promise<{ ok: boolean; containerId: string; message: string }> {
    const args: string[] = [
      this.binary, 'run', '-d',
      '--name', shellQuote(opts.name),
      '--restart', opts.restart,
    ];
    for (const p of opts.ports) {
      const proto = p.protocol ?? 'tcp';
      args.push('-p', `${p.host}:${p.guest}/${proto}`);
    }
    for (const e of opts.env) {
      args.push('-e', shellQuote(`${e.key}=${e.value}`));
    }
    for (const v of opts.volumes) {
      args.push('-v', shellQuote(`${v.hostPath}:${v.containerPath}:${v.mode}`));
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    args.push(shellQuote(opts.image));

    const cmd = args.join(' ');
    logger.info({ cmd }, `proot-${this.binary}: ${this.binary} run`);
    const r = await this.runInProot(`${cmd} 2>&1`, 60_000);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        containerId: '',
        message: `${this.binary} run failed: ${r.stdout || r.stderr}`.slice(0, 300),
      };
    }
    const containerId = r.stdout.trim().slice(0, 12);
    return {
      ok: true,
      containerId,
      message: `Started container '${opts.name}' (id: ${containerId}).`,
    };
  }

  /**
   * Stop and remove a container by name.
   */
  async stopAndRemove(name: string): Promise<boolean> {
    await this.runInProot(`${this.binary} stop ${shellQuote(name)} 2>&1`, 30_000);
    const r = await this.runInProot(`${this.binary} rm -f ${shellQuote(name)} 2>&1`, 30_000);
    return r.exitCode === 0;
  }

  /**
   * Stop a container by name (no remove).
   */
  async stop(name: string): Promise<boolean> {
    const r = await this.runInProot(`${this.binary} stop ${shellQuote(name)} 2>&1`, 30_000);
    return r.exitCode === 0;
  }

  /**
   * Start a stopped container by name.
   */
  async start(name: string): Promise<boolean> {
    const r = await this.runInProot(`${this.binary} start ${shellQuote(name)} 2>&1`, 30_000);
    return r.exitCode === 0;
  }

  /**
   * List all containers in JSON format.
   */
  async listContainers(): Promise<Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    ports: string;
  }>> {
    const r = await this.runInProot(
      `${this.binary} ps -a --format '{{json .}}' 2>/dev/null`,
      10_000,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as {
            ID?: string;
            Names?: string;
            Image?: string;
            Status?: string;
            Ports?: string;
          };
        } catch {
          return null;
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .map((c) => ({
        id: c.ID ?? '',
        name: c.Names ?? '',
        image: c.Image ?? '',
        status: c.Status ?? '',
        ports: c.Ports ?? '',
      }));
  }

  /**
   * Fetch the last N lines of a container's logs.
   */
  async logs(name: string, lines: number = 50): Promise<string> {
    const r = await this.runInProot(
      `${this.binary} logs --tail ${lines} ${shellQuote(name)} 2>&1`,
      15_000,
    );
    return r.stdout;
  }
}

/**
 * Shell-quote a string for safe interpolation into a single shell command.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(s: string): string {
  if (s.includes('\0')) {
    throw new Error(`E_DOCKER_SHELL_INJECTION: argument contains a NUL byte: ${JSON.stringify(s)}`);
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
