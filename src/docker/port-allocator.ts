/**
 * Port allocator — auto-allocates host ports from a configurable range,
 * persisted in `state.docker.next_port_hint` and `state.docker.containers[]`.
 *
 * @module linuxify/docker/port-allocator
 *
 * The allocator walks up from `next_port_hint` until it finds a free
 * port, then bumps `next_port_hint` past the allocated port so the next
 * `docker run` starts its search there (skips re-probing ports we
 * already know are in use).
 *
 * "Free" means two things:
 *   1. Not already assigned to a linuxify-managed container (checked
 *      against `state.docker.containers[].host_port`).
 *   2. Not currently bound by anything on the OS (probed via a
 *      throwaway TCP server — same trick as the hosting subsystem's
 *      `findAvailablePort`).
 *
 * On Podroid, condition 2 only proves the port is free inside the
 * Alpine VM, not on the Android host. The `podroid-forward` rule that
 * the engine sets up after a successful `docker run` is what makes the
 * port actually reachable from Android/LAN.
 *
 * The allocator supports "sticky" allocation: if the user passes
 * `--port <image-port>` (only the guest port), the allocator first
 * checks whether the same image already has an assigned host port for
 * that guest port in `state.docker.containers[]`. If yes, it returns
 * that port so the same image gets the same URL across restarts.
 */

import { createServer } from 'node:net';

import type { DockerState } from '../state/index.js';
import { logger } from '../utils/log.js';

/**
 * Result of a port allocation request.
 */
export interface PortAllocation {
  /** The host port that was allocated. */
  hostPort: number;
  /** Whether the allocation re-used an existing sticky assignment. */
  reused: boolean;
}

/**
 * Find a free host port for a new container.
 *
 * @param state - Current docker state (mutated in place; caller persists).
 * @param image - The image being run, used for sticky re-use.
 * @param guestPort - The container-side port being exposed.
 * @returns The allocated host port and whether it was a sticky re-use.
 */
export async function allocatePort(
  state: DockerState,
  image: string,
  guestPort: number,
): Promise<PortAllocation> {
  // 1. Sticky re-use: same image + same guest port → same host port.
  const existing = state.containers.find(
    (c) => c.image === image && c.guest_port === guestPort,
  );
  if (existing) {
    logger.debug(
      { image, guestPort, hostPort: existing.host_port },
      'docker: re-using sticky port assignment',
    );
    // Verify it's still free; if not, fall through to fresh allocation.
    if (await isPortFree(existing.host_port)) {
      return { hostPort: existing.host_port, reused: true };
    }
    logger.warn(
      { image, hostPort: existing.host_port },
      'docker: sticky port no longer free; reallocating',
    );
  }

  // 2. Fresh allocation: walk from next_port_hint to port_range_end.
  const start = Math.max(state.next_port_hint, state.port_range_start);
  const end = state.port_range_end;
  const usedPorts = new Set(state.containers.map((c) => c.host_port));

  for (let port = start; port <= end; port++) {
    if (usedPorts.has(port)) continue;
    if (await isPortFree(port)) {
      // Bump next_port_hint past the allocated port so the next run
      // doesn't re-probe it. Wrap around at port_range_end.
      state.next_port_hint = port + 1 > end ? state.port_range_start : port + 1;
      return { hostPort: port, reused: false };
    }
  }

  // 3. Range exhausted — fall back to an ephemeral port in 49152–65535.
  // This is the RFC 6056 ephemeral range, so the OS may also allocate
  // here; we accept the small collision risk in the rare case the user
  // has exhausted the entire 8000–8999 range (1000 containers).
  logger.warn(
    { range: `${state.port_range_start}-${state.port_range_end}` },
    'docker: configured port range exhausted; falling back to ephemeral range',
  );
  for (let i = 0; i < 100; i++) {
    const port = 49152 + Math.floor(Math.random() * 16383);
    if (usedPorts.has(port)) continue;
    if (await isPortFree(port)) {
      return { hostPort: port, reused: false };
    }
  }

  // 4. Truly nothing free — give up. The engine surfaces this to the user.
  throw new Error(
    `E_DOCKER_NO_FREE_PORT: no free host port available in range ${state.port_range_start}-${state.port_range_end} or the ephemeral fallback. Stop some containers and try again.`,
  );
}

/**
 * Probe whether a TCP port is currently free on the loopback interface.
 * Same implementation as the hosting engine's `isPortFree` — duplicated
 * here so the docker subsystem doesn't reach into the hosting engine's
 * private method.
 *
 * Never throws; errors are treated as "not free" so we move on.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.unref();
    srv.once('error', () => {
      try { srv.close(); } catch { /* ignore */ }
      resolve(false);
    });
    srv.once('listening', () => {
      try { srv.close(); } catch { /* ignore */ }
      resolve(true);
    });
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Reserve a specific host port (used when the user passes
 * `--port H:G` with an explicit host port). Verifies the port is free
 * before returning; throws on conflict.
 *
 * @param state - Current docker state (used to check existing assignments).
 * @param hostPort - The host port the user wants.
 * @param image - The image being run (for the conflict message).
 */
export async function reservePort(
  state: DockerState,
  hostPort: number,
  image: string,
): Promise<void> {
  const usedByExisting = state.containers.find((c) => c.host_port === hostPort);
  if (usedByExisting) {
    throw new Error(
      `E_DOCKER_PORT_IN_USE: host port ${hostPort} is already assigned to container '${usedByExisting.name}' (image: ${usedByExisting.image}). Stop it first or pick a different port.`,
    );
  }
  if (!(await isPortFree(hostPort))) {
    throw new Error(
      `E_DOCKER_PORT_BOUND: host port ${hostPort} is currently bound by another process (not a linuxify-managed container). Pick a different port or stop the process holding ${hostPort}. Image: ${image}.`,
    );
  }
}
