/**
 * Doctor check: `docker.arm64-support`.
 *
 * @module linuxify/doctor/checks/docker-arm64-support
 *
 * Verifies that the host architecture is supported by the most common
 * multi-arch docker images. On Android, the relevant arches are:
 *  - `arm64` (aarch64 — the modern standard for Android phones since ~2017)
 *  - `arm/v7` (armv7l — older 32-bit phones, still common on cheap devices)
 *  - `amd64` (x86_64 — emulators / Chromebooks)
 *
 * The check maps `process.arch` to the docker convention and warns if
 * the host arch is `unknown` (which means the docker subsystem's
 * `getDockerArch()` will refuse to pre-check manifests, so the engine
 * will fall through to "pull and pray" — slow and error-prone).
 *
 * Also surfaces a `warn` (not `fail`) on armv7l, since some images
 * only publish `arm64` manifests and will fail to pull on armv7.
 *
 * @packageDocumentation
 */

import { getArch } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `docker.arm64-support` doctor check. Registered in `checks/index.ts`.
 */
export const dockerArm64SupportCheck: DoctorCheck = {
  id: 'docker.arm64-support',
  name: 'Docker host architecture',
  category: 'services',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that the host architecture is one docker recognizes (arm64, arm/v7, or amd64). On Android phones, arm64 is the modern standard.',
    why: 'The docker engine pre-checks the image manifest before pulling to avoid a 20-minute pull that fails at the end. The pre-check requires knowing the host arch. If the arch is unknown, the engine skips the pre-check and falls through to "pull and pray".',
    consequence: '`linuxify docker run <amd64-only image>` will start a pull that fails at the end with "no manifest for arm64" — wasted bandwidth and time.',
    fix: 'Check that your device supports arm64. If you are on an emulator, set the system image to arm64 (not x86).',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'docker.arm64-support',
      name: 'Docker host architecture',
      category: 'services',
    };

    // Skip if the docker subsystem hasn't been initialized.
    if (!ctx.state.docker.initialized) {
      return {
        ...base,
        status: 'skip',
        message: 'Docker subsystem not initialized.',
        durationMs: Date.now() - start,
      };
    }

    const arch = getArch();
    const dockerArchMap: Record<string, string> = {
      aarch64: 'arm64',
      armv7l: 'arm/v7',
      x86_64: 'amd64',
    };
    const dockerArch = dockerArchMap[arch] ?? 'unknown';

    if (dockerArch === 'unknown') {
      return {
        ...base,
        status: 'fail',
        message: `Host arch '${arch}' is not recognized by docker. Pulls will skip the manifest pre-check.`,
        detail: { hostArch: arch, dockerArch },
        fixCommand: 'linuxify docker init --runtime podroid',
        fixDocs: 'https://docs.linuxify.dev/24-docker/arch-support',
        durationMs: Date.now() - start,
      };
    }

    if (dockerArch === 'arm/v7') {
      return {
        ...base,
        status: 'warn',
        message: `Host arch armv7l maps to docker's 'arm/v7'. Some multi-arch images only publish 'arm64' manifests; pulls may fail.`,
        detail: { hostArch: arch, dockerArch, note: 'arm/v7 is increasingly deprecated in the docker ecosystem; consider upgrading to an arm64 device.' },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Host arch '${arch}' → docker '${dockerArch}'.`,
      detail: { hostArch: arch, dockerArch },
      durationMs: Date.now() - start,
    };
  },
};
