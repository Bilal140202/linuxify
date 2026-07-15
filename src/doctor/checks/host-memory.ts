/**
 * Doctor check: `host.memory`.
 *
 * @module linuxify/doctor/checks/host-memory
 *
 * Verifies that the host has at least 1 GB of available RAM. proot is memory-
 * hungry (each proot session forks the parent process), and low-memory
 * conditions cause OOM kills that are hard to diagnose.
 *
 * Reads `/proc/meminfo` (Linux/Android) and looks at `MemAvailable`. On
 * platforms where `/proc/meminfo` is unavailable (macOS, Windows), the check
 * falls back to `os.totalmem() - os.freemem()` and warns that the value is
 * approximate.
 *
 * @packageDocumentation
 */

import os from 'node:os';

import { readFile } from '../../utils/fs.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum free memory, in MiB. Below this, warn. */
const WARN_FREE_MB = 1024;

/** Below this, fail. */
const FAIL_FREE_MB = 512;

/**
 * Parse `MemAvailable` from `/proc/meminfo`. Returns the value in MiB, or
 * `undefined` if the file cannot be read or the field is missing.
 *
 * @returns Available memory in MiB, or `undefined`.
 */
async function readMemAvailableMb(): Promise<number | undefined> {
  try {
    const text = await readFile('/proc/meminfo');
    const m = /MemAvailable:\s*(\d+)\s*kB/i.exec(text);
    if (!m) return undefined;
    const kb = Number.parseInt(m[1] ?? '', 10);
    if (Number.isNaN(kb)) return undefined;
    return Math.floor(kb / 1024);
  } catch {
    return undefined;
  }
}

/**
 * The `host.memory` doctor check. Registered in `checks/index.ts`.
 */
export const hostMemoryCheck: DoctorCheck = {
  id: 'host.memory',
  name: 'Memory',
  category: 'host',
  profile: ['standard', 'deep', 'ci'],
  explain: {
    what: 'Verifies that your device has at least 1 GB of free RAM.',
    why: 'proot adds overhead to every process. Running Node.js + a CLI inside proot on a low-RAM device can cause OOM kills. 1 GB is the minimum for basic operation; 2+ GB is recommended for larger CLIs.',
    consequence: 'CLIs may crash with SIGKILL (out of memory). Bootstrap stage 3 (apt install) is particularly memory-intensive and may fail.',
    fix: 'Close other apps before running Linuxify. On devices with <4 GB RAM, avoid running multiple CLIs simultaneously.',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'host.memory',
      name: 'Memory',
      category: 'host',
    };

    let availableMb = await readMemAvailableMb();
    let approx = false;
    if (availableMb === undefined) {
      // Fallback: os.freemem() (less accurate; counts only the truly-free
      // pages, not reclaimable cache).
      availableMb = Math.floor(os.freemem() / (1024 * 1024));
      approx = true;
    }

    if (availableMb < FAIL_FREE_MB) {
      return {
        ...base,
        status: 'fail',
        message: `Only ${availableMb} MiB RAM available. Linuxify requires at least ${FAIL_FREE_MB} MiB.`,
        detail: { availableMb, approx, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
        fixCommand: 'Close other apps; proot is memory-hungry.',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (availableMb < WARN_FREE_MB) {
      return {
        ...base,
        status: 'warn',
        message: `Low memory: ${availableMb} MiB available (recommend ${WARN_FREE_MB} MiB).${approx ? ' (approximate)' : ''}`,
        detail: { availableMb, approx, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
        fixCommand: 'Close other apps; proot is memory-hungry.',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `${availableMb} MiB RAM available.${approx ? ' (approximate)' : ''}`,
      detail: { availableMb, approx, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
      durationMs: Date.now() - start,
    };
  },
};
