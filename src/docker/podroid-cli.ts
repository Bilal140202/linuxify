/**
 * Podroid CLI wrapper — talks to a Podroid VM over SSH.
 *
 * @module linuxify/docker/podroid-cli
 *
 * Podroid is a rootless standalone APK that boots a real Alpine Linux VM
 * via QEMU/AVF on the Android host. It exposes:
 *  - An SSH endpoint on the phone (port 9922 by default; user `root`,
 *    password `podroid`).
 *  - A `podroid-forward` CLI inside the VM (also reachable from the
 *    Android host shell if Podroid is installed as a Termux package)
 *    that maps a guest port to a host port so the container is
 *    reachable from the Android side and the LAN.
 *  - A `Downloads/` folder shared between Android and the Alpine guest.
 *
 * This module shells into the VM over SSH and runs docker commands,
 * then calls `podroid-forward add` to expose the resulting port. The
 * SSH connection uses `sshpass` (when available) for the password so
 * the user isn't prompted; when `sshpass` is not installed, the wrapper
 * falls back to env-based SSH key auth (the user can set
 * `LINUXIFY_PODROID_SSH_KEY` to point at a private key authorized on
 * the Podroid guest).
 *
 * Why SSH and not a Podroid API: Podroid doesn't expose a stable HTTP
 * API yet (as of Podroid v1.2.x). SSH is the documented remote-control
 * surface per the official README.
 */

import { logger } from '../utils/log.js';
import { exec } from '../utils/process.js';

/** Default Podroid SSH port. */
export const PODROID_SSH_PORT = 9922;
/** Default Podroid SSH user. */
export const PODROID_SSH_USER = 'root';
/** Default Podroid SSH password. */
export const PODROID_SSH_PASSWORD = 'podroid';

/** Default SSH connect timeout (ms). */
const SSH_TIMEOUT_MS = 15_000;

/**
 * Podroid client. Wraps ssh + sshpass (or a key from the env) so callers
 * can run `docker <args>` inside the Alpine VM and capture output.
 */
export class PodroidClient {
  private readonly host: string;
  private readonly port: number;
  private readonly user: string;
  private readonly password?: string;
  private readonly sshKey?: string;

  constructor(opts: {
    host: string;
    port?: number;
    user?: string;
    password?: string;
    sshKey?: string;
  }) {
    this.host = opts.host;
    this.port = opts.port ?? PODROID_SSH_PORT;
    this.user = opts.user ?? PODROID_SSH_USER;
    this.password = opts.password ?? PODROID_SSH_PASSWORD;
    this.sshKey = opts.sshKey ?? process.env.LINUXIFY_PODROID_SSH_KEY;
  }

  /**
   * Run a command inside the Podroid Alpine VM over SSH.
   *
   * @param command - Shell command to execute inside the VM.
   * @param timeoutMs - Per-call timeout (default 15s).
   * @returns The exec result (stdout/stderr/exitCode).
   */
  async runInVm(command: string, timeoutMs: number = SSH_TIMEOUT_MS): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    // Prefer sshpass if available (avoids prompting for password).
    // Fall back to a key file if LINUXIFY_PODROID_SSH_KEY is set.
    const sshArgs: string[] = [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'LogLevel=ERROR',
      '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      '-p', String(this.port),
    ];
    if (this.sshKey) {
      sshArgs.push('-i', this.sshKey);
    }
    sshArgs.push(`${this.user}@${this.host}`, command);

    // Decide which binary to invoke.
    let bin = 'ssh';
    let args = sshArgs;
    if (this.password && !this.sshKey) {
      // Use sshpass if available; verified via `which sshpass` at
      // construction time would be ideal, but a one-shot probe here is
      // fine too.
      const whichSshpass = await exec('which', ['sshpass'], { timeoutMs: 2000 });
      if (whichSshpass.exitCode === 0) {
        bin = 'sshpass';
        args = ['-p', this.password, 'ssh', ...sshArgs];
      } else {
        logger.warn(
          'podroid: sshpass not installed and no SSH key set; SSH may prompt for a password',
        );
      }
    }

    const r = await exec(bin, args, { timeoutMs, env: { TERM: 'dumb' } });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  }

  /**
   * Add a port forwarding rule: `<guest-port>` on the VM → `<host-port>`
   * on Android. Idempotent — if the rule already exists, Podroid returns
   * success without creating a duplicate.
   *
   * @param guestPort - Port inside the VM.
   * @param hostPort - Port on Android.
   * @param protocol - 'tcp' or 'udp'.
   * @returns The rule identifier (empty string on failure).
   */
  async addForward(
    guestPort: number,
    hostPort: number,
    protocol: 'tcp' | 'udp' = 'tcp',
  ): Promise<{ ok: boolean; ruleId: string; message: string }> {
    const r = await this.runInVm(
      `podroid-forward add ${guestPort} ${hostPort} ${protocol} 2>&1`,
      10_000,
    );
    if (r.exitCode !== 0) {
      return {
        ok: false,
        ruleId: '',
        message: `podroid-forward add failed: ${r.stderr || r.stdout}`.slice(0, 300),
      };
    }
    // Podroid doesn't return a rule ID; we synthesize one for state tracking.
    return {
      ok: true,
      ruleId: `podroid-${guestPort}-${hostPort}-${protocol}`,
      message: `Forwarded VM port ${guestPort} → Android port ${hostPort} (${protocol}).`,
    };
  }

  /**
   * Remove a single forwarding rule by guest+host port.
   */
  async removeForward(guestPort: number, hostPort: number): Promise<boolean> {
    const r = await this.runInVm(
      `podroid-forward remove ${guestPort} ${hostPort} 2>&1`,
      10_000,
    );
    return r.exitCode === 0;
  }

  /**
   * Remove every forwarding rule added since Podroid started. The Podroid
   * README documents `podroid-forward clean` for this.
   */
  async cleanForwards(): Promise<number> {
    const r = await this.runInVm('podroid-forward clean 2>&1', 10_000);
    return r.exitCode === 0 ? 1 : 0;
  }

  /**
   * Pull a docker image inside the VM. Streams progress over stderr.
   *
   * @param image - Image reference (e.g. `nginx:latest`).
   * @param arch - Host arch (for multi-arch manifest selection).
   */
  async pullImage(image: string, arch: string): Promise<{ ok: boolean; message: string }> {
    // Pre-check: verify the manifest supports our arch before pulling.
    // `docker manifest inspect` is the canonical way to do this without
    // downloading any layers.
    const manifestR = await this.runInVm(
      `docker manifest inspect ${image} 2>/dev/null | grep -q '"architecture": "${arch}"' && echo ok || echo missing`,
      15_000,
    );
    if (manifestR.stdout.trim() === 'missing') {
      return {
        ok: false,
        message: `Image '${image}' has no manifest for arch '${arch}'. Linuxify won't start a pull that's guaranteed to fail; pick a multi-arch image.`,
      };
    }

    // Pull the image (long-running; cap at 5 min).
    const r = await this.runInVm(`docker pull ${image} 2>&1 | tail -5`, 300_000);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        message: `docker pull ${image} failed: ${r.stdout || r.stderr}`.slice(0, 300),
      };
    }
    return { ok: true, message: `Pulled ${image}.` };
  }

  /**
   * Run a container inside the VM. Returns the container's short ID.
   *
   * @param opts - Standard docker run options (image, name, ports, env, volumes, restart).
   * @returns The container ID and the actual host port bound.
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
      'docker', 'run', '-d',
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
    logger.info({ cmd }, 'podroid: docker run');
    const r = await this.runInVm(`${cmd} 2>&1`, 60_000);
    if (r.exitCode !== 0) {
      return {
        ok: false,
        containerId: '',
        message: `docker run failed: ${r.stdout || r.stderr}`.slice(0, 300),
      };
    }
    // docker run -d prints the container ID to stdout (a 64-char hex string).
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
    await this.runInVm(`docker stop ${shellQuote(name)} 2>&1`, 30_000);
    // Don't bail on stop failure — the container may already be gone.
    const r2 = await this.runInVm(`docker rm -f ${shellQuote(name)} 2>&1`, 30_000);
    return r2.exitCode === 0;
  }

  /**
   * Stop a container by name (no remove).
   */
  async stop(name: string): Promise<boolean> {
    const r = await this.runInVm(`docker stop ${shellQuote(name)} 2>&1`, 30_000);
    return r.exitCode === 0;
  }

  /**
   * Start a stopped container by name.
   */
  async start(name: string): Promise<boolean> {
    const r = await this.runInVm(`docker start ${shellQuote(name)} 2>&1`, 30_000);
    return r.exitCode === 0;
  }

  /**
   * List running containers in JSON format.
   */
  async listContainers(): Promise<Array<{
    id: string;
    name: string;
    image: string;
    status: string;
    ports: string;
  }>> {
    const r = await this.runInVm(
      `docker ps -a --format '{{json .}}' 2>/dev/null`,
      10_000,
    );
    if (r.exitCode !== 0) return [];
    return r.stdout
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          // docker ps --format '{{json .}}' outputs fields: ID, Names, Image, Status, Ports
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
    const r = await this.runInVm(
      `docker logs --tail ${lines} ${shellQuote(name)} 2>&1`,
      15_000,
    );
    return r.stdout;
  }
}

/**
 * Shell-quote a string for safe interpolation into a single shell command.
 * Wraps in single quotes and escapes any embedded single quotes.
 */
function shellQuote(s: string): string {
  // Forbid embedded nulls outright.
  if (s.includes('\0')) {
    throw new Error(`E_DOCKER_SHELL_INJECTION: argument contains a NUL byte: ${JSON.stringify(s)}`);
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
