/**
 * Doctor check: `host.arch`.
 *
 * @module linuxify/doctor/checks/host-arch
 *
 * Verifies that the host CPU architecture is one Linuxify supports:
 * `aarch64` (primary), `armv7l` (best-effort), or `x86_64` (Chromebooks,
 * Android-x86). Any other arch is rejected.
 *
 * Uses `getArch()` from `utils/process.ts`, which normalizes Node's
 * `process.arch` to the Linuxify-canonical form (`arm64` → `aarch64`,
 * `arm` → `armv7l`, `x64` → `x86_64`).
 *
 * @packageDocumentation
 */

import { getArch } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Set of architectures Linuxify supports. */
const SUPPORTED_ARCHS = new Set(['aarch64', 'armv7l', 'x86_64']);

/**
 * The `host.arch` doctor check. Registered in `checks/index.ts`.
 */
export const hostArchCheck: DoctorCheck = {
  id: 'host.arch',
  name: 'Architecture',
  category: 'host',
  profile: ['minimal', 'standard', 'deep', 'pre-flight', 'post-install', 'ci'],
  explain: {
    what: "Verifies that your device's CPU architecture is supported (aarch64, armv7l, or x86_64).",
    why: 'Linuxify ships pre-built binaries for the three common Android architectures. aarch64 (64-bit ARM) is the primary target. armv7l (32-bit ARM) is best-effort. x86_64 is for Chromebooks and Android-x86.',
    consequence: 'If your architecture is unsupported, downloads will fail because there is no matching rootfs or Node binary. This is rare but happens on exotic hardware.',
    fix: "Linuxify cannot run on this architecture. File an issue with your device's CPU info so we can consider adding support.",
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'host.arch',
      name: 'Architecture',
      category: 'host',
    };

    const arch = getArch();

    if (!SUPPORTED_ARCHS.has(arch)) {
      return {
        ...base,
        status: 'fail',
        message: `Unsupported architecture '${arch}'. Linuxify supports aarch64, armv7l, and x86_64.`,
        detail: { arch, supported: [...SUPPORTED_ARCHS] },
        fixCommand: 'Use a supported device; see compat matrix.',
        fixDocs: 'https://docs.linuxify.dev/11-compat-db/compatibility-database',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Architecture: ${arch}.`,
      detail: { arch },
      durationMs: Date.now() - start,
    };
  },
};
