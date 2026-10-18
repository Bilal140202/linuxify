/**
 * Docker engine — main orchestrator for the `linuxify docker` CLI.
 *
 * @module linuxify/docker/engine
 *
 * One-command UX:
 *
 *   $ linuxify docker run nginx
 *   → detect runtime (Podroid preferred)
 *   → pre-check arm64 manifest
 *   → allocate host port 8000 (state.docker port range)
 *   → docker pull nginx
 *   → docker run -d --name nginx --restart unless-stopped -p 8000:80 nginx
 *   → podroid-forward add 80 8000 tcp  (only on Podroid path)
 *   → print "URL: http://127.0.0.1:8000"
 *
 * The engine is the single place that knows how to wire Podroid vs
 * proot-distro Docker behind the same `docker run` UX. The CLI layer
 * just builds RunOptions from its flags and hands them here.
 *
 * State management:
 *  - Reads `state.docker` for the port-allocation table and the
 *    list of running containers.
 *  - Writes back via `stateStore.update()` on every run/stop/rm so
 *    that `linuxify docker ps` reflects reality without re-pinging
 *    the runtime.
 */

import { join } from 'node:path';

import type { StateStore, DockerState, DockerContainer } from '../state/index.js';
import { getActiveDistro } from '../utils/distros.js';
import { LinuxifyError } from '../utils/errors.js';
import { ensureDir } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { exec, getLinuxifyHome } from '../utils/process.js';


import {
  type RunOptions,
  type RunResult,
  type RuntimeInfo,
  type DockerRuntime,
  type VolumeMount,
  type EnvVar,
  type PortMapping,
  type RestartPolicy,
  imageToSlug,
  DEFAULT_RESTART_POLICY,
} from './config.js';
import { detectRuntime, getDockerArch } from './detect.js';
import { PodroidClient } from './podroid-cli.js';
import { allocatePort, reservePort } from './port-allocator.js';
import { ProotDockerClient } from './proot-cli.js';

const DOCKER_SUBDIR = 'docker';
const DOCKER_DATA_SUBDIR = 'data';

/**
 * Union of operations the docker engine can perform. Each maps to a CLI
 * subcommand under `linuxify docker <op>`.
 */
export type DockerOperation = 'init' | 'run' | 'ps' | 'stop' | 'rm' | 'logs' | 'forward' | 'clean' | 'doctor';

/**
 * Docker engine. Construct one per CLI invocation; the engine is stateless
 * beyond the `stateStore` and the runtime clients it builds.
 */
export class DockerEngine {
  private readonly stateStore: StateStore;
  private readonly homeDir: string;
  private readonly dataDir: string;

  constructor(stateStore: StateStore) {
    this.stateStore = stateStore;
    this.homeDir = join(getLinuxifyHome(), DOCKER_SUBDIR);
    this.dataDir = join(this.homeDir, DOCKER_DATA_SUBDIR);
  }

  /**
   * Initialize the docker subsystem. Detects the runtime and persists
   * `state.docker.initialized = true` + `state.docker.default_runtime`.
   * Safe to call repeatedly — a no-op if already initialized.
   *
   * @param runtime - Optional runtime to force (overrides auto-detection).
   */
  async init(runtime?: DockerRuntime): Promise<{ success: boolean; runtime: RuntimeInfo; message: string }> {
    await ensureDir(this.homeDir);
    await ensureDir(this.dataDir);

    const state = await this.stateStore.load();
    const distro = await getActiveDistro(state.active_distro);

    const runtimeInfo = await detectRuntime(distro, runtime ?? state.docker.default_runtime);

    const dockerState: DockerState = {
      ...state.docker,
      initialized: true,
      // Preserve the original `initialized_at` on re-init (the docstring
      // promises init is idempotent — repeated calls should not re-stamp
      // the timestamp, since downstream tools use it to detect "first
      // install" for migration / telemetry purposes).
      initialized_at: state.docker.initialized_at ?? new Date().toISOString(),
    };
    if (runtimeInfo.available) {
      dockerState.default_runtime = runtimeInfo.kind;
    }
    await this.stateStore.update((s) => {
      s.docker = dockerState;
    });

    if (!runtimeInfo.available) {
      return {
        success: false,
        runtime: runtimeInfo,
        message: runtimeInfo.unavailableReason
          ?? `No docker runtime available. Install Podroid (recommended) or run 'linuxify docker init --runtime docker' to install Docker inside the active proot-distro.`,
      };
    }
    return {
      success: true,
      runtime: runtimeInfo,
      message: `Docker initialized. Default runtime: ${runtimeInfo.kind} (${runtimeInfo.version ?? 'unknown version'}).`,
    };
  }

  /**
   * Run a container. Implements the one-command UX described in the
   * module docstring.
   */
  async run(opts: RunOptions): Promise<RunResult> {
    const state = await this.stateStore.load();
    if (!state.docker.initialized) {
      // Auto-init on first run so the user truly only needs one command.
      logger.info('docker: not initialized; auto-initializing on first run');
      const initResult = await this.init(opts.runtime);
      if (!initResult.success) {
        return {
          success: false,
          name: opts.name ?? imageToSlug(opts.image),
          containerId: '',
          hostPort: 0,
          guestPort: 0,
          runtime: initResult.runtime.kind,
          url: '',
          publicUrl: null,
          message: initResult.message,
        };
      }
    }

    // Re-load state after auto-init.
    const freshState = await this.stateStore.load();
    const distro = await getActiveDistro(freshState.active_distro);
    const runtimeInfo = await detectRuntime(
      distro,
      opts.runtime ?? freshState.docker.default_runtime,
    );
    if (!runtimeInfo.available) {
      return {
        success: false,
        name: opts.name ?? imageToSlug(opts.image),
        containerId: '',
        hostPort: 0,
        guestPort: opts.ports?.[0]?.guestPort ?? 0,
        runtime: runtimeInfo.kind,
        url: '',
        publicUrl: null,
        message: runtimeInfo.unavailableReason ?? 'Docker runtime unavailable.',
      };
    }

    const dockerState = freshState.docker;
    const arch = getDockerArch();
    const name = opts.name ?? this.deduplicateName(imageToSlug(opts.image), dockerState);

    // Resolve ports.
    const requestedPorts: PortMapping[] = opts.ports && opts.ports.length > 0
      ? opts.ports
      : [{ guestPort: 80 }]; // default: expose image's port 80
    const ports: Array<{ host: number; guest: number; protocol?: 'tcp' | 'udp' }> = [];
    for (const p of requestedPorts) {
      let hostPort: number;
      if (p.hostPort) {
        // User supplied explicit host port; verify it's free.
        await reservePort(dockerState, p.hostPort, opts.image);
        hostPort = p.hostPort;
      } else {
        // Auto-allocate.
        const alloc = await allocatePort(dockerState, opts.image, p.guestPort);
        hostPort = alloc.hostPort;
      }
      ports.push({ host: hostPort, guest: p.guestPort });
    }

    // Persist the new container entry to state before running so a
    // mid-run crash leaves a record (the engine's `rm` can clean up
    // stale entries on next invocation).
    const restart: RestartPolicy = opts.restart ?? DEFAULT_RESTART_POLICY;
    const volumes: VolumeMount[] = opts.volumes ?? [];
    const env: EnvVar[] = opts.env ?? [];
    const primaryHostPort = ports[0]!.host;
    const primaryGuestPort = ports[0]!.guest;

    // Pull the image (pre-checks arch).
    const client = await this.getClient(runtimeInfo, distro);
    if (opts.pull || !(await this.isImageCached(runtimeInfo, distro, opts.image, client))) {
      logger.info({ image: opts.image, arch }, 'docker: pulling image');
      const pullR = await client.pullImage(opts.image, arch);
      if (!pullR.ok) {
        return {
          success: false,
          name,
          containerId: '',
          hostPort: primaryHostPort,
          guestPort: primaryGuestPort,
          runtime: runtimeInfo.kind,
          url: '',
          publicUrl: null,
          message: pullR.message,
        };
      }
    }

    // Run the container.
    const runR = await client.runContainer({
      image: opts.image,
      name,
      ports: ports.map((p) => ({ host: p.host, guest: p.guest })),
      env,
      volumes,
      restart,
      extraArgs: opts.extraArgs,
    });
    if (!runR.ok) {
      return {
        success: false,
        name,
        containerId: '',
        hostPort: primaryHostPort,
        guestPort: primaryGuestPort,
        runtime: runtimeInfo.kind,
        url: '',
        publicUrl: null,
        message: runR.message,
      };
    }

    // For Podroid, set up port forwarding so the container is reachable
    // from the Android host and the LAN.
    let forwardRuleId = '';
    let publicUrl: string | null = null;
    if (runtimeInfo.kind === 'podroid' && client instanceof PodroidClient) {
      // Forward each port mapping.
      for (const p of ports) {
        const fwd = await client.addForward(p.guest, p.host, 'tcp');
        if (!fwd.ok) {
          logger.warn({ ...p, msg: fwd.message }, 'docker: podroid-forward failed (continuing)');
        } else if (p === ports[0]) {
          forwardRuleId = fwd.ruleId;
        }
      }
      // Compute the public URL from the runtime endpoint.
      const hostMatch = /([0-9.]+):\d+/.exec(runtimeInfo.endpoint);
      if (hostMatch) {
        publicUrl = `http://${hostMatch[1]}:${primaryHostPort}`;
      }
    }

    // Record in state.
    const containerRecord: DockerContainer = {
      name,
      image: opts.image,
      container_id: runR.containerId,
      runtime: runtimeInfo.kind,
      host_port: primaryHostPort,
      guest_port: primaryGuestPort,
      forward_rule_id: forwardRuleId,
      started_at: new Date().toISOString(),
      restart_policy: restart,
      status: 'running',
      volumes: volumes.map((v) => ({
        host_path: v.hostPath,
        container_path: v.containerPath,
        mode: v.mode,
      })),
      env: env.map((e) => ({ key: e.key, value: e.value })),
    };
    const updatedDockerState: DockerState = {
      ...dockerState,
      containers: [...dockerState.containers.filter((c) => c.name !== name), containerRecord],
    };
    await this.stateStore.update((s) => {
      s.docker = updatedDockerState;
    });

    const url = `http://127.0.0.1:${primaryHostPort}`;
    return {
      success: true,
      name,
      containerId: runR.containerId,
      hostPort: primaryHostPort,
      guestPort: primaryGuestPort,
      runtime: runtimeInfo.kind,
      url,
      publicUrl,
      message: `Started '${name}' from ${opts.image} → ${url}${publicUrl ? ` (public: ${publicUrl})` : ''}`,
    };
  }

  /**
   * List all linuxify-managed containers (from state, with a refresh
   * from the runtime to update statuses).
   */
  async ps(): Promise<DockerContainer[]> {
    const state = await this.stateStore.load();
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);
    if (!runtimeInfo.available) {
      // No runtime — return the state as-is, marking containers as 'unknown'.
      return state.docker.containers.map((c) => ({ ...c, status: 'unknown' as const }));
    }
    const client = await this.getClient(runtimeInfo, distro);
    const liveContainers = await client.listContainers();
    const liveByName = new Map(liveContainers.map((c) => [c.name, c]));

    // Update each state container with its live status.
    const updated = state.docker.containers.map((c) => {
      const live = liveByName.get(c.name);
      if (!live) return { ...c, status: 'stopped' as const };
      // Reconcile status from docker's "Up X seconds" / "Exited (0)...".
      const status: DockerContainer['status'] = live.status.toLowerCase().startsWith('up')
        ? 'running'
        : live.status.toLowerCase().startsWith('exited')
          ? 'stopped'
          : 'unknown';
      return { ...c, status, container_id: live.id || c.container_id };
    });

    // Persist the refresh.
    if (JSON.stringify(updated) !== JSON.stringify(state.docker.containers)) {
      const newDockerState: DockerState = { ...state.docker, containers: updated };
      await this.stateStore.update((s) => {
        s.docker = newDockerState;
      });
    }
    return updated;
  }

  /**
   * Stop a container (without removing it). Use `start` to bring it
   * back up.
   */
  async stop(name: string): Promise<{ success: boolean; message: string }> {
    const state = await this.stateStore.load();
    const container = state.docker.containers.find((c) => c.name === name);
    if (!container) {
      return { success: false, message: `Container '${name}' not found in linuxify state. Run: linuxify docker ps` };
    }
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);
    if (!runtimeInfo.available) {
      return { success: false, message: runtimeInfo.unavailableReason ?? 'Runtime unavailable.' };
    }
    const client = await this.getClient(runtimeInfo, distro);
    const ok = await client.stop(name);
    if (!ok) {
      return { success: false, message: `Failed to stop '${name}' (runtime: ${runtimeInfo.kind}).` };
    }
    // Update state.
    const updated = state.docker.containers.map((c) =>
      c.name === name ? { ...c, status: 'stopped' as const } : c,
    );
    const stoppedState: DockerState = { ...state.docker, containers: updated };
    await this.stateStore.update((s) => {
      s.docker = stoppedState;
    });
    return { success: true, message: `Stopped '${name}'.` };
  }

  /**
   * Remove a container entirely (stop + delete + remove from state +
   * remove Podroid forward if any).
   */
  async rm(name: string): Promise<{ success: boolean; message: string }> {
    const state = await this.stateStore.load();
    const container = state.docker.containers.find((c) => c.name === name);
    if (!container) {
      return { success: false, message: `Container '${name}' not found. Run: linuxify docker ps` };
    }
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);
    if (runtimeInfo.available) {
      const client = await this.getClient(runtimeInfo, distro);
      await client.stopAndRemove(name);
      // Remove Podroid forward rule if any.
      if (runtimeInfo.kind === 'podroid' && client instanceof PodroidClient) {
        await client.removeForward(container.guest_port, container.host_port);
      }
    }
    // Remove from state.
    const updated = state.docker.containers.filter((c) => c.name !== name);
    const removedState: DockerState = { ...state.docker, containers: updated };
    await this.stateStore.update((s) => {
      s.docker = removedState;
    });
    return { success: true, message: `Removed '${name}' and cleaned up.` };
  }

  /**
   * Fetch the last N lines of a container's logs.
   */
  async logs(name: string, lines: number = 50): Promise<{ success: boolean; logs: string; message: string }> {
    const state = await this.stateStore.load();
    const container = state.docker.containers.find((c) => c.name === name);
    if (!container) {
      return { success: false, logs: '', message: `Container '${name}' not found.` };
    }
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);
    if (!runtimeInfo.available) {
      return { success: false, logs: '', message: runtimeInfo.unavailableReason ?? 'Runtime unavailable.' };
    }
    const client = await this.getClient(runtimeInfo, distro);
    const logs = await client.logs(name, lines);
    return { success: true, logs, message: `Logs for '${name}':` };
  }

  /**
   * Manually add a port-forward rule (Podroid only). Useful when the
   * user runs docker directly inside the VM and wants linuxify to
   * expose it.
   */
  async forward(guestPort: number, hostPort: number, protocol: 'tcp' | 'udp' = 'tcp'): Promise<{ success: boolean; message: string }> {
    const state = await this.stateStore.load();
    if (!state.docker.initialized) {
      return { success: false, message: 'Docker not initialized. Run: linuxify docker init' };
    }
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);
    if (runtimeInfo.kind !== 'podroid') {
      return {
        success: false,
        message: `Forwarding is only needed on Podroid. Current runtime: ${runtimeInfo.kind} (containers are already reachable on the LAN).`,
      };
    }
    if (runtimeInfo.kind === 'podroid') {
      const client = (await this.getClient(runtimeInfo, distro)) as PodroidClient;
      const r = await client.addForward(guestPort, hostPort, protocol);
      return { success: r.ok, message: r.message };
    }
    return { success: false, message: 'Unreachable.' };
  }

  /**
   * Clean up: stop every linuxify-managed container, remove every
   * Podroid forward rule, and clear the state.containers list. Does NOT
   * delete pulled images (use `linuxify docker image rm` for that).
   */
  async clean(): Promise<{ success: boolean; stopped: number; forwardsRemoved: number; message: string }> {
    const state = await this.stateStore.load();
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);

    let stopped = 0;
    let forwardsRemoved = 0;

    if (runtimeInfo.available) {
      const client = await this.getClient(runtimeInfo, distro);
      for (const c of state.docker.containers) {
        if (await client.stopAndRemove(c.name)) stopped++;
      }
      if (runtimeInfo.kind === 'podroid' && client instanceof PodroidClient) {
        forwardsRemoved = await client.cleanForwards();
      }
    }

    // Clear state.
    const clearedState: DockerState = { ...state.docker, containers: [] };
    await this.stateStore.update((s) => {
      s.docker = clearedState;
    });

    return {
      success: true,
      stopped,
      forwardsRemoved,
      message: `Stopped ${stopped} container(s), removed ${forwardsRemoved} forward rule(s).`,
    };
  }

  /**
   * Run a docker-specific health check. Returns the runtime info and
   * a list of issues.
   */
  async doctor(): Promise<{
    initialized: boolean;
    runtime: RuntimeInfo;
    containerCount: number;
    issues: string[];
  }> {
    const issues: string[] = [];
    const state = await this.stateStore.load();
    const distro = await getActiveDistro(state.active_distro);
    const runtimeInfo = await detectRuntime(distro, state.docker.default_runtime);

    if (!state.docker.initialized) {
      issues.push('Docker subsystem not initialized. Run: linuxify docker init');
    }
    if (!runtimeInfo.available) {
      issues.push(runtimeInfo.unavailableReason ?? 'No docker runtime available.');
    }
    if (state.docker.containers.length > 0) {
      // Stale-state check: any containers in state that aren't in the runtime?
      if (runtimeInfo.available) {
        const client = await this.getClient(runtimeInfo, distro);
        const live = new Set((await client.listContainers()).map((c) => c.name));
        for (const c of state.docker.containers) {
          if (!live.has(c.name)) {
            issues.push(`Container '${c.name}' is in state but not in runtime — run: linuxify docker rm ${c.name}`);
          }
        }
      }
    }
    if (!state.docker.wake_lock_enabled && state.docker.containers.length > 0) {
      issues.push('Wake lock is disabled; Android may kill long-running containers. Run: linuxify docker config --wake-lock on');
    }

    return {
      initialized: state.docker.initialized,
      runtime: runtimeInfo,
      containerCount: state.docker.containers.length,
      issues,
    };
  }

  // ─── Private helpers ──────────────────────────────────────────

  /**
   * Get the runtime-specific client. The dispatch is on
   * `runtimeInfo.kind`. For Podroid, returns a PodroidClient pointed
   * at the runtime's SSH endpoint. For docker/podman in proot, returns
   * a ProotDockerClient.
   */
  private async getClient(info: RuntimeInfo, distro: string | null): Promise<PodroidClient | ProotDockerClient> {
    if (info.kind === 'podroid') {
      const hostMatch = /([0-9.]+):\d+/.exec(info.endpoint);
      const host = hostMatch ? hostMatch[1]! : '127.0.0.1';
      const portMatch = /:([0-9]+)$/.exec(info.endpoint);
      const port = portMatch ? Number(portMatch[1]) : 9922;
      return new PodroidClient({ host, port });
    }
    if (!distro) {
      throw new LinuxifyError(
        'E_DOCKER_NO_DISTRO',
        'No active proot-distro; cannot talk to docker/podman. Run: linuxify init',
      );
    }
    return new ProotDockerClient({ distro, binary: info.kind === 'podman' ? 'podman' : 'docker' });
  }

  /**
   * Probe whether an image is already cached locally. Avoids a
   * 5-minute pull on every run.
   */
  private async isImageCached(
    info: RuntimeInfo,
    distro: string | null,
    image: string,
    client: PodroidClient | ProotDockerClient,
  ): Promise<boolean> {
    // `docker images -q <image>` returns the image ID if cached,
    // empty string if not.
    if (info.kind === 'podroid') {
      const r = await (client as PodroidClient).runInVm(
        `docker images -q ${shellQuote(image)} 2>/dev/null`,
        10_000,
      );
      return r.stdout.trim().length > 0;
    }
    if (!distro) return false;
    const r = await exec(
      'proot-distro',
      ['login', distro, '--user', 'linuxify', '--', 'bash', '-c',
       `${client instanceof ProotDockerClient ? (client as unknown as { binary: string }).binary : 'docker'} images -q ${shellQuote(image)} 2>/dev/null`],
      { timeoutMs: 10_000, env: { TERM: 'dumb' } },
    );
    return r.stdout.trim().length > 0;
  }

  /**
   * Generate a unique container name from a slug. If the slug is
   * already taken by an existing container, append `-2`, `-3`, etc.
   */
  private deduplicateName(slug: string, dockerState: DockerState): string {
    if (!dockerState.containers.some((c) => c.name === slug)) return slug;
    for (let i = 2; i < 1000; i++) {
      const candidate = `${slug}-${i}`;
      if (!dockerState.containers.some((c) => c.name === candidate)) return candidate;
    }
    return `${slug}-${Date.now()}`;
  }
}

/**
 * Shell-quote a string for safe interpolation into a single shell command.
 * Wraps in single quotes and escapes embedded single quotes.
 *
 * Exported so the CLI's option-parsing code can use the same quoter
 * when building `--extra-args` strings for the engine.
 */
export function shellQuote(s: string): string {
  if (s.includes('\0')) {
    throw new Error(`E_DOCKER_SHELL_INJECTION: argument contains a NUL byte: ${JSON.stringify(s)}`);
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}
