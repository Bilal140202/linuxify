/**
 * Doctor check: `docker.port-allocation`.
 *
 * @module linuxify/doctor/checks/docker-port-allocation
 *
 * Verifies that the docker port-allocation table in `state.docker` is
 * sane:
 *  - `port_range_start` < `port_range_end`.
 *  - `next_port_hint` is inside `[port_range_start, port_range_end]`.
 *  - No two containers in `state.docker.containers[]` share a `host_port`.
 *  - Every container's `host_port` is inside the configured range.
 *
 * If the table is corrupt, suggests `linuxify repair state` (which
 * rebuilds `state.docker.containers[]` from filesystem markers — TBD).
 *
 * @packageDocumentation
 */

import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `docker.port-allocation` doctor check. Registered in `checks/index.ts`.
 */
export const dockerPortAllocationCheck: DoctorCheck = {
  id: 'docker.port-allocation',
  name: 'Docker port allocation table',
  category: 'services',
  profile: ['deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that the docker port-allocation table in state.docker is internally consistent (range bounds respected, no duplicate host ports across containers).',
    why: 'The docker engine auto-allocates host ports from a configurable range (default 8000–8999) and persists assignments in state.docker.containers[].host_port. A corrupt table — overlapping ranges, duplicate ports — would either cause silent port conflicts or stale assignments to non-running containers.',
    consequence: '`linuxify docker run` may pick a port that is already in use, or hand out the same port to two different images. The user sees an EADDRINUSE error from the runtime.',
    fix: 'linuxify repair state',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'docker.port-allocation',
      name: 'Docker port allocation table',
      category: 'services',
    };

    const ds = ctx.state.docker;

    // Skip if there are no containers AND the subsystem is not initialized
    // — port-allocation only matters once containers exist.
    if (!ds.initialized && ds.containers.length === 0) {
      return {
        ...base,
        status: 'skip',
        message: 'Docker subsystem not initialized. Run: linuxify docker init',
        durationMs: Date.now() - start,
      };
    }

    const issues: string[] = [];

    // Range sanity.
    if (ds.port_range_start >= ds.port_range_end) {
      issues.push(`port_range_start (${ds.port_range_start}) >= port_range_end (${ds.port_range_end}). Run: linuxify repair state`);
    }

    // next_port_hint inside range.
    if (ds.next_port_hint < ds.port_range_start || ds.next_port_hint > ds.port_range_end) {
      issues.push(`next_port_hint (${ds.next_port_hint}) is outside the configured range [${ds.port_range_start}, ${ds.port_range_end}]. Run: linuxify repair state`);
    }

    // Container host_ports: must be in range, must be unique.
    const seen = new Map<number, string>(); // host_port → container name
    for (const c of ds.containers) {
      if (c.host_port < ds.port_range_start || c.host_port > ds.port_range_end) {
        issues.push(`Container '${c.name}' (image: ${c.image}) host_port ${c.host_port} is outside the configured range. Run: linuxify docker rm ${c.name}`);
      }
      const prior = seen.get(c.host_port);
      if (prior) {
        issues.push(`Duplicate host_port ${c.host_port} between containers '${prior}' and '${c.name}'. Run: linuxify docker rm ${c.name}`);
      } else {
        seen.set(c.host_port, c.name);
      }
    }

    if (issues.length === 0) {
      return {
        ...base,
        status: 'ok',
        message: `Port allocation table OK (${ds.containers.length} container(s), range ${ds.port_range_start}-${ds.port_range_end}, next hint ${ds.next_port_hint}).`,
        detail: {
          containerCount: ds.containers.length,
          portRange: [ds.port_range_start, ds.port_range_end],
          nextPortHint: ds.next_port_hint,
        },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: issues.length > 1 ? 'fail' : 'warn',
      message: `${issues.length} issue(s) with port allocation table.`,
      detail: { issues },
      fixCommand: 'linuxify repair state',
      fixDocs: 'https://docs.linuxify.dev/24-docker/port-allocation',
      durationMs: Date.now() - start,
    };
  },
};
