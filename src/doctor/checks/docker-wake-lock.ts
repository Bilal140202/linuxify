/**
 * Doctor check: `docker.wake-lock`.
 *
 * @module linuxify/doctor/checks/docker-wake-lock
 *
 * Verifies that a wake lock is enabled when there are long-running
 * containers. Android's background-process optimization is the #1
 * operational killer of long-running containers (per the howtogeek
 * research — the author lost Calibre-web this way). A wake lock keeps
 * the device's CPU awake so the container runtime isn't killed.
 *
 * The check returns `warn` (not `fail`) when there are containers AND
 * `state.docker.wake_lock_enabled === false`. It returns `ok` when
 * either there are no containers (nothing to keep alive) or the wake
 * lock is enabled.
 *
 * @packageDocumentation
 */

import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `docker.wake-lock` doctor check. Registered in `checks/index.ts`.
 */
export const dockerWakeLockCheck: DoctorCheck = {
  id: 'docker.wake-lock',
  name: 'Docker wake lock',
  category: 'services',
  profile: ['deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that a wake lock is enabled when there are long-running docker containers.',
    why: 'Android aggressively kills background processes to save battery. Docker containers — especially long-running ones like FreshRSS, Calibre-web, or Omni-tools — get killed when the phone enters "optimization mode". A wake lock keeps the CPU awake so the container runtime survives.',
    consequence: 'Containers will be silently killed by Android\'s background-process optimization. The container\'s state in linuxify will say "running" but the actual process is gone — `linuxify docker ps` will reconcile the status, but the container restarts from scratch on next start (losing in-memory state).',
    fix: 'linuxify docker config --wake-lock on',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'docker.wake-lock',
      name: 'Docker wake lock',
      category: 'services',
    };

    const ds = ctx.state.docker;

    // Nothing to keep alive.
    if (ds.containers.length === 0) {
      return {
        ...base,
        status: 'ok',
        message: 'No containers; wake lock not needed.',
        detail: { containerCount: 0, wakeLockEnabled: ds.wake_lock_enabled },
        durationMs: Date.now() - start,
      };
    }

    if (ds.wake_lock_enabled) {
      return {
        ...base,
        status: 'ok',
        message: `Wake lock enabled (${ds.containers.length} container(s) protected).`,
        detail: { containerCount: ds.containers.length, wakeLockEnabled: true },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'warn',
      message: `${ds.containers.length} container(s) running but wake lock is DISABLED. Android may kill them.`,
      detail: {
        containerCount: ds.containers.length,
        wakeLockEnabled: false,
        note: 'Enable with: linuxify docker config --wake-lock on',
      },
      fixCommand: 'linuxify docker config --wake-lock on',
      fixDocs: 'https://docs.linuxify.dev/24-docker/wake-lock',
      durationMs: Date.now() - start,
    };
  },
};
