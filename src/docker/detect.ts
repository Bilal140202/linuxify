/**
 * Docker runtime detection — discovers what container backend is available.
 *
 * @module linuxify/docker/detect
 *
 * Resolution priority (highest first):
 *  1. Podroid — a rootless standalone APK that boots an Alpine VM via
 *     QEMU/AVF. The canonical no-root Android Docker backend per the
 *     howtogeek research. Detected by checking for the
 *     `~/.podroid/` directory or the `podroid-forward` CLI on PATH.
 *  2. proot-distro + Docker — fall back to installing Docker inside the
 *     active proot-distro (typically Ubuntu). Works without Podroid but
 *     is slower (no KVM) and proot's syscall translation sometimes
 *     breaks dockerd in subtle ways.
 *  3. proot-distro + Podman — fall back further to podman (often more
 *     proot-friendly than docker because it doesn't need a long-running
 *     daemon). Detected by checking for `podman` inside the proot.
 *
 * The detector never throws — a failure to find any runtime is reported
 * as `available: false` with a human-readable reason, and the engine
 * surfaces that to the user with an actionable hint.
 */

import { join } from 'node:path';

import { exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { exec, getLinuxifyHome, isTermux, getArch } from '../utils/process.js';

import type { RuntimeInfo, DockerRuntime } from './config.js';

/**
 * Detect what docker runtime is available. Returns the best available
 * runtime; if none is available, returns an `available: false` RuntimeInfo
 * with `unavailableReason` set.
 *
 * @param distro - Active proot-distro name (e.g. 'ubuntu'). Used for the
 *   docker/podman fallback paths.
 * @param preferred - Optional runtime to prefer (from `--runtime` flag or
 *   `state.docker.default_runtime`). If supplied, only that runtime is
 *   probed; the other detectors are skipped.
 */
export async function detectRuntime(
  distro: string | null | undefined,
  preferred?: DockerRuntime | null,
): Promise<RuntimeInfo> {
  // Honor an explicit preference first.
  if (preferred === 'podroid') {
    return await detectPodroid();
  }
  if (preferred === 'docker') {
    return await detectProotDistro(distro, 'docker');
  }
  if (preferred === 'podman') {
    return await detectProotDistro(distro, 'podman');
  }

  // Auto-detect: Podroid first, then docker in proot, then podman in proot.
  logger.debug('docker: probing Podroid runtime');
  const podroid = await detectPodroid();
  if (podroid.available) return podroid;

  if (distro) {
    logger.debug({ distro }, 'docker: probing docker in proot');
    const docker = await detectProotDistro(distro, 'docker');
    if (docker.available) return docker;

    logger.debug({ distro }, 'docker: probing podman in proot');
    const podman = await detectProotDistro(distro, 'podman');
    if (podman.available) return podman;
  }

  // Nothing worked. Return the Podroid result (which has the most
  // actionable `unavailableReason` for the user).
  return podroid;
}

/**
 * Detect Podroid by checking for the `~/.podroid/` directory (created by
 * the APK on first launch) and the `podroid-forward` binary on PATH.
 *
 * If the `LINUXIFY_PODROID_HOST` env var is set, we treat it as the
 * Podroid guest's reachable IP and skip the directory probe — this lets
 * users on a network-attached Podroid (e.g. running on a second phone)
 * point linuxify at it explicitly.
 */
export async function detectPodroid(): Promise<RuntimeInfo> {
  const base: Pick<RuntimeInfo, 'kind'> = { kind: 'podroid' };
  const envHost = process.env.LINUXIFY_PODROID_HOST;

  // Explicit env override path.
  if (envHost) {
    // Verify the SSH endpoint responds.
    const sshOk = await probeSsh(envHost, 9922);
    if (sshOk) {
      return {
        ...base,
        available: true,
        version: null,
        endpoint: `${envHost}:9922`,
        binaryPath: null,
      };
    }
    return {
      ...base,
      available: false,
      version: null,
      endpoint: `${envHost}:9922`,
      binaryPath: null,
      unavailableReason: `LINUXIFY_PODROID_HOST=${envHost} is set but SSH on port 9922 is not reachable. Make sure Podroid is running and SSH is enabled in Settings.`,
    };
  }

  // Local Android path: look for ~/.podroid/.
  const podroidDir = join(getLinuxifyHome(), '..', '.podroid');
  const dirExists = await exists(podroidDir);

  // Also accept the Termux-prefixed path ($PREFIX/.podroid).
  const termuxPodroidDir = isTermux() ? '/data/data/com.termux/files/home/.podroid' : null;
  const termuxDirExists = termuxPodroidDir ? await exists(termuxPodroidDir) : false;

  // Probe podroid-forward on PATH.
  const forwardResult = await exec('which', ['podroid-forward'], { timeoutMs: 3000 });
  const forwardOnPath = forwardResult.exitCode === 0;

  if (dirExists || termuxDirExists || forwardOnPath) {
    // Probe the local SSH endpoint (Podroid exposes it on 127.0.0.1:9922).
    const sshOk = await probeSsh('127.0.0.1', 9922);
    return {
      ...base,
      available: sshOk,
      version: null,
      endpoint: sshOk ? '127.0.0.1:9922' : '127.0.0.1:9922 (ssh not up yet)',
      binaryPath: forwardOnPath ? forwardResult.stdout.trim() : null,
      unavailableReason: sshOk
        ? undefined
        : 'Podroid appears to be installed but SSH on 127.0.0.1:9922 is not reachable. Make sure the Podroid VM is running and SSH is enabled in its Settings.',
    };
  }

  return {
    ...base,
    available: false,
    version: null,
    endpoint: '',
    binaryPath: null,
    unavailableReason: 'Podroid not detected. Install Podroid from https://github.com/ExTV/Podroid (rootless APK) or run inside the proot-distro with `linuxify docker init --runtime docker`.',
  };
}

/**
 * Detect docker or podman inside the active proot-distro. The detection
 * shells into the proot and runs `which <binary>` and `<binary> --version`
 * to confirm both presence and that the daemon is responsive (for docker
 * we additionally probe `docker info`).
 *
 * @param distro - proot-distro name (e.g. 'ubuntu')
 * @param binary - 'docker' or 'podman'
 */
export async function detectProotDistro(
  distro: string | null | undefined,
  binary: 'docker' | 'podman',
): Promise<RuntimeInfo> {
  const base: Pick<RuntimeInfo, 'kind'> = { kind: binary };
  if (!distro) {
    return {
      ...base,
      available: false,
      version: null,
      endpoint: '',
      binaryPath: null,
      unavailableReason: `No active proot-distro; cannot probe ${binary}. Run: linuxify init`,
    };
  }

  // Probe binary presence.
  const whichResult = await exec(
    'proot-distro',
    ['login', distro, '--user', 'linuxify', '--', 'which', binary],
    { timeoutMs: 8000, env: { TERM: 'dumb' } },
  );
  if (whichResult.exitCode !== 0) {
    return {
      ...base,
      available: false,
      version: null,
      endpoint: '',
      binaryPath: null,
      unavailableReason: `${binary} is not installed in the '${distro}' proot-distro. Run: linuxify docker init --runtime ${binary}`,
    };
  }

  // Probe version + daemon.
  const versionResult = await exec(
    'proot-distro',
    ['login', distro, '--user', 'linuxify', '--', binary, '--version'],
    { timeoutMs: 8000, env: { TERM: 'dumb' } },
  );
  const version = versionResult.exitCode === 0
    ? versionResult.stdout.split('\n')[0]?.trim() ?? null
    : null;

  // For docker, additionally probe the daemon.
  if (binary === 'docker') {
    const infoResult = await exec(
      'proot-distro',
      ['login', distro, '--user', 'linuxify', '--', 'docker', 'info', '--format', '{{.ServerVersion}}'],
      { timeoutMs: 10_000, env: { TERM: 'dumb' } },
    );
    if (infoResult.exitCode !== 0) {
      return {
        ...base,
        available: false,
        version,
        endpoint: distro,
        binaryPath: whichResult.stdout.trim(),
        unavailableReason: `docker binary is installed in '${distro}' but the daemon is not responding. Try: linuxify docker init --runtime docker (it will start dockerd).`,
      };
    }
  }

  // podman is daemonless; the version probe is sufficient.
  return {
    ...base,
    available: true,
    version,
    endpoint: distro,
    binaryPath: whichResult.stdout.trim(),
  };
}

/**
 * Probe whether an SSH port is open. Doesn't authenticate — just checks
 * that something is listening on the TCP port. Used by `detectPodroid()`
 * to verify Podroid's SSH endpoint is up before declaring Podroid
 * available.
 *
 * Implemented with a raw TCP connect so we don't have to shell out to
 * `nc` / `ssh-keyscan` (which may not be available on Android).
 */
async function probeSsh(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    import('node:net').then((net) => {
      const sock = new net.Socket();
      sock.setTimeout(3000);
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(false);
      });
      sock.once('timeout', () => {
        try { sock.destroy(); } catch { /* ignore */ }
        resolve(false);
      });
      sock.connect(port, host);
    }).catch(() => resolve(false));
  });
}

/**
 * Quick one-shot helper that returns just the runtime kind, for callers
 * (like the docker doctor check) that don't need the full RuntimeInfo.
 */
export async function detectRuntimeKind(
  distro: string | null | undefined,
  preferred?: DockerRuntime | null,
): Promise<DockerRuntime | null> {
  const info = await detectRuntime(distro, preferred);
  return info.available ? info.kind : null;
}

/**
 * Get the host arch in a form docker cares about (`amd64`, `arm64`,
 * `arm/v7`, `unknown`). Used by the engine to pre-check whether an image
 * has a manifest for the host's architecture before pulling.
 */
export function getDockerArch(): 'amd64' | 'arm64' | 'arm/v7' | 'unknown' {
  const arch = getArch();
  switch (arch) {
    case 'aarch64': return 'arm64';
    case 'armv7l': return 'arm/v7';
    case 'x86_64': return 'amd64';
    default: return 'unknown';
  }
}
