/**
 * Doctor check: `host.termux`.
 *
 * @module linuxify/doctor/checks/host-termux
 *
 * Verifies that Termux is installed and is the F-Droid build (not the Play
 * Store build, which is unmaintained and has a broken package repository).
 *
 * Heuristics:
 * 1. `isTermux()` returns true (TERMUX_VERSION env var set, or PREFIX env
 *    var points at `com.termux`, or `process.platform === 'android'`).
 * 2. `pkg` binary exists at `$PREFIX/bin/pkg`.
 * 3. The `com.termux` meta-package version (via `dpkg -s com.termux`) is at
 *    least 0.118. The Play Store build is frozen at 0.101.
 *
 * The check never throws — errors are caught and returned as `fail` results.
 *
 * @packageDocumentation
 */

import { LINUXIFY_VERSION } from '../../utils/constants.js';
import { exists } from '../../utils/fs.js';
import { exec, getTermuxPrefix, isTermux } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum Termux version required (matches bootstrap preflight). */
const MIN_TERMUX_VERSION = '0.118';

/**
 * Compare two dotted version strings lexicographically by numeric component.
 * Returns negative if `a < b`, zero if equal, positive if `a > b`. Tolerates
 * non-numeric components by treating them as 0.
 *
 * @param a - First version string.
 * @param b - Second version string.
 * @returns Comparison result.
 */
function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/**
 * The `host.termux` doctor check. Registered in `checks/index.ts`.
 */
export const hostTermuxCheck: DoctorCheck = {
  id: 'host.termux',
  name: 'Termux',
  category: 'host',
  profile: ['minimal', 'standard', 'deep', 'pre-flight', 'post-install', 'ci'],

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'host.termux',
      name: 'Termux',
      category: 'host',
    };

    if (!isTermux()) {
      return {
        ...base,
        status: 'fail',
        message: 'Linuxify must run inside Termux.',
        detail: { isTermux: false },
        fixCommand: 'pkg install termux',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    const prefix = getTermuxPrefix();
    const pkgPath = `${prefix}/bin/pkg`;
    if (!(await exists(pkgPath))) {
      return {
        ...base,
        status: 'fail',
        message: `Termux 'pkg' not found at ${pkgPath}.`,
        detail: { prefix, pkgPath },
        fixCommand: 'pkg install termux-tools',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    let version: string | undefined;
    try {
      const r = await exec('dpkg', ['-s', 'com.termux'], { timeoutMs: 3000 });
      if (r.exitCode === 0) {
        const m = /Version:\s*([0-9.]+)/.exec(r.stdout);
        version = m?.[1];
      }
    } catch {
      /* fall through to warn */
    }

    if (!version) {
      return {
        ...base,
        status: 'warn',
        message: 'Could not determine Termux version. Ensure Termux is installed from F-Droid.',
        detail: { prefix, pkgPath },
        fixCommand: 'pkg install termux',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    if (compareVersion(version, MIN_TERMUX_VERSION) < 0) {
      return {
        ...base,
        status: 'fail',
        message: `Termux ${version} is too old (>= ${MIN_TERMUX_VERSION} required). Install Termux from F-Droid.`,
        detail: { version, minVersion: MIN_TERMUX_VERSION, prefix },
        fixCommand: 'pkg update && pkg upgrade termux',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Termux ${version} detected at ${prefix}.`,
      detail: { version, prefix, linuxifyVersion: LINUXIFY_VERSION },
      durationMs: Date.now() - start,
    };
  },
};
