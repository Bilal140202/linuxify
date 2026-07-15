/**
 * Doctor check: `host.storage`.
 *
 * @module linuxify/doctor/checks/host-storage
 *
 * Verifies that the home filesystem has at least 2 GB free. Below 5 GB is a
 * warning; below 2 GB is a failure (rootfs downloads alone exceed 1 GB).
 *
 * Reads `df -k ~` and parses the "Available" column (in 1-KiB blocks). On
 * platforms where `df` is unavailable (Windows), the check is skipped.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Soft minimum free space, in MiB. Below this, warn. */
const WARN_FREE_MB = 5 * 1024;

/** Hard minimum free space, in MiB. Below this, fail. */
const FAIL_FREE_MB = 2 * 1024;

/**
 * Parse the "Available" column (1-KiB blocks) from `df -k <path>` output.
 * Returns the value in MiB, or `undefined` if the output cannot be parsed.
 *
 * Handles both BSD `df` (no header on `/` line in some Termux builds) and
 * GNU `df` (header always present). Picks the last numeric column that
 * precedes the capacity percentage.
 *
 * @param stdout - Raw `df -k` output.
 * @returns Free space in MiB, or `undefined`.
 */
function parseDfAvailableMb(stdout: string): number | undefined {
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  // Find the line containing the target path or the last data line.
  // df output: Filesystem  1K-blocks  Used  Available  Use%  Mounted on
  // We want the "Available" column (4th on GNU, varies on BSD).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(/\s+/);
    // Skip header lines (those containing "Available" or "1K-blocks").
    if (parts.some((p) => p === 'Available' || p === '1K-blocks' || p === 'Filesystem')) continue;
    // Find the index of the "Use%" column (ends with %); the column before
    // it is "Available".
    const useIdx = parts.findIndex((p) => p.endsWith('%'));
    if (useIdx > 0) {
      const avail = Number.parseInt(parts[useIdx - 1] ?? '', 10);
      if (!Number.isNaN(avail)) return Math.floor(avail / 1024);
    }
    // Fallback: assume Available is the second-to-last numeric column.
    const nums = parts.map((p) => Number.parseInt(p, 10)).filter((n) => !Number.isNaN(n));
    if (nums.length >= 3) return Math.floor(nums[nums.length - 2] / 1024);
  }
  return undefined;
}

/**
 * The `host.storage` doctor check. Registered in `checks/index.ts`.
 */
export const hostStorageCheck: DoctorCheck = {
  id: 'host.storage',
  name: 'Storage',
  category: 'host',
  profile: ['minimal', 'standard', 'deep', 'pre-flight', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that your device has at least 2 GB of free storage space.',
    why: 'Linuxify needs space for the Ubuntu rootfs (~300 MB), Node.js (~200 MB), Python (~150 MB), and each installed CLI (~50-500 MB). A full bootstrap uses ~1.5 GB; each package adds more.',
    consequence: "Installs will fail mid-way with 'No space left on device'. A partial install can leave the environment in a broken state that `linuxify repair` may not fully fix.",
    fix: 'Free up space: run `linuxify gc` to clean caches, remove unused distros, or uninstall apps you no longer need.',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'host.storage',
      name: 'Storage',
      category: 'host',
    };

    let availableMb: number | undefined;
    try {
      const target = process.env.HOME ?? '~';
      const r = await exec('df', ['-k', target], { timeoutMs: 4000 });
      if (r.exitCode === 0) {
        availableMb = parseDfAvailableMb(r.stdout);
      }
    } catch {
      /* fall through to warn */
    }

    if (availableMb === undefined) {
      return {
        ...base,
        status: 'warn',
        message: 'Could not determine free disk space.',
        detail: { warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
        fixCommand: 'df -k ~',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (availableMb < FAIL_FREE_MB) {
      return {
        ...base,
        status: 'fail',
        message: `Only ${availableMb} MiB free. Linuxify requires at least ${FAIL_FREE_MB} MiB.`,
        detail: { availableMb, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
        fixCommand: 'linuxify gc',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (availableMb < WARN_FREE_MB) {
      return {
        ...base,
        status: 'warn',
        message: `Low disk space: ${availableMb} MiB free (recommend ${WARN_FREE_MB} MiB).`,
        detail: { availableMb, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
        fixCommand: 'linuxify gc',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `${availableMb} MiB free.`,
      detail: { availableMb, warnMb: WARN_FREE_MB, failMb: FAIL_FREE_MB },
      durationMs: Date.now() - start,
    };
  },
};
