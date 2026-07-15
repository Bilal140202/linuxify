/**
 * Doctor check: `path.proot`.
 *
 * @module linuxify/doctor/checks/path-proot
 *
 * Verifies that `proot` and `proot-distro` binaries are available on the
 * host PATH. proot-distro is the entry point the distro providers shell out
 * to for install/login/snapshot; without it, no distro operation works.
 *
 * Uses `which` (POSIX) to locate each binary. On platforms without `which`
 * (Windows), falls back to `command -v` via `sh -c`.
 *
 * On failure, suggests `pkg install proot-distro`.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/**
 * Resolve the absolute path of a binary via `which` (POSIX) or
 * `command -v` (fallback). Returns `null` if the binary is not found.
 *
 * @param name - Binary name to look up.
 * @returns Absolute path, or `null`.
 */
async function whichBin(name: string): Promise<string | null> {
  try {
    const r = await exec('which', [name], { timeoutMs: 2000 });
    if (r.exitCode === 0) return r.stdout.trim() || null;
  } catch {
    /* fall through to fallback */
  }
  try {
    const r = await exec('sh', ['-c', `command -v ${name}`], { timeoutMs: 2000 });
    if (r.exitCode === 0) return r.stdout.trim() || null;
  } catch {
    /* give up */
  }
  return null;
}

/**
 * The `path.proot` doctor check. Registered in `checks/index.ts`.
 */
export const pathProotCheck: DoctorCheck = {
  id: 'path.proot',
  name: 'PATH: proot',
  category: 'path',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that `proot` and `proot-distro` are installed and on your PATH.',
    why: 'proot is the syscall-translating tool that lets Linuxify run a real Ubuntu filesystem inside Termux without root. proot-distro is a helper that manages distro installations (install, login, remove). Both are Termux packages installed during bootstrap stage 1.',
    consequence: 'Without proot, Linuxify cannot enter the Ubuntu environment at all. Every `linuxify run`, `linuxify shell`, and `linuxify add` will fail because there is no way to enter the distro.',
    fix: 'pkg install proot proot-distro',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'path.proot',
      name: 'PATH: proot',
      category: 'path',
    };

    const prootPath = await whichBin('proot');
    const prootDistroPath = await whichBin('proot-distro');

    if (!prootPath && !prootDistroPath) {
      return {
        ...base,
        status: 'fail',
        message: 'Neither proot nor proot-distro found on PATH.',
        detail: { proot: null, prootDistro: null },
        fixCommand: 'pkg install proot-distro',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    if (!prootPath) {
      return {
        ...base,
        status: 'fail',
        message: 'proot binary missing (proot-distro found).',
        detail: { proot: null, prootDistro: prootDistroPath },
        fixCommand: 'pkg install proot',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    if (!prootDistroPath) {
      return {
        ...base,
        status: 'fail',
        message: 'proot-distro binary missing (proot found).',
        detail: { proot: prootPath, prootDistro: null },
        fixCommand: 'pkg install proot-distro',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: 'proot and proot-distro on PATH.',
      detail: { proot: prootPath, prootDistro: prootDistroPath },
      durationMs: Date.now() - start,
    };
  },
};
