/**
 * Doctor check: `docker.runtime-available`.
 *
 * @module linuxify/doctor/checks/docker-runtime-available
 *
 * Verifies that the docker subsystem can find a usable runtime (Podroid,
 * proot-distro Docker, or proot-distro Podman). This is the foundational
 * docker check — if it fails, every `linuxify docker` subcommand will
 * refuse to run.
 *
 * Resolution (mirrors `src/docker/detect.ts`):
 *  1. Honor `state.docker.default_runtime` if set.
 *  2. Otherwise auto-detect: Podroid first, then docker in proot, then
 *     podman in proot.
 *  3. If nothing is available, return `fail` with an actionable
 *     `fixCommand` pointing the user at `linuxify docker init`.
 *
 * @packageDocumentation
 */

import { detectRuntime } from '../../docker/index.js';
import { getActiveDistro } from '../../utils/distros.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `docker.runtime-available` doctor check. Registered in `checks/index.ts`.
 */
export const dockerRuntimeAvailableCheck: DoctorCheck = {
  id: 'docker.runtime-available',
  name: 'Docker runtime available',
  category: 'services',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that the docker subsystem can find a usable runtime — Podroid (preferred), docker inside the proot, or podman inside the proot.',
    why: 'The `linuxify docker` subcommands shell out to a docker runtime. Without one, every docker operation refuses to run. Podroid is the canonical no-root backend on Android (a real Alpine VM via QEMU/AVF); the proot-distro fallbacks work but are slower.',
    consequence: '`linuxify docker run <image>` will refuse to start with "Docker runtime unavailable." — you cannot run any containers.',
    fix: 'linuxify docker init',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'docker.runtime-available',
      name: 'Docker runtime available',
      category: 'services',
    };

    // Skip entirely if the docker subsystem has never been initialized
    // AND the user has no containers — running this check on a fresh
    // install would always fail and be noise.
    if (!ctx.state.docker.initialized && ctx.state.docker.containers.length === 0) {
      return {
        ...base,
        status: 'skip',
        message: 'Docker subsystem not initialized. Run: linuxify docker init',
        detail: {
          initialized: false,
          containerCount: 0,
        },
        durationMs: Date.now() - start,
      };
    }

    const distro = await getActiveDistro(ctx.state.active_distro);
    const info = await detectRuntime(distro, ctx.state.docker.default_runtime);

    if (info.available) {
      return {
        ...base,
        status: 'ok',
        message: `Docker runtime: ${info.kind} (${info.version ?? 'unknown version'})`,
        detail: {
          kind: info.kind,
          version: info.version,
          endpoint: info.endpoint,
          binaryPath: info.binaryPath,
        },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'fail',
      message: info.unavailableReason
        ?? `No docker runtime available. Run: linuxify docker init`,
      detail: {
        kind: info.kind,
        endpoint: info.endpoint,
        unavailableReason: info.unavailableReason,
      },
      fixCommand: 'linuxify docker init',
      fixDocs: 'https://docs.linuxify.dev/24-docker/overview',
      durationMs: Date.now() - start,
    };
  },
};
