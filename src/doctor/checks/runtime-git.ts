/**
 * Doctor check: `runtime.git`.
 *
 * @module linuxify/doctor/checks/runtime-git
 *
 * Verifies that Git ≥ 2.40 is installed. Runs `git --version` on the host
 * PATH. Many Linuxify packages rely on `git clone` for installation, so a
 * missing or too-old Git breaks the install path.
 *
 * On failure, suggests `linuxify runtimes install git`.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum Git major.minor (2.40). */
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 40;

/**
 * Parse a `git --version` string (e.g. `git version 2.49.0`) into a
 * `{major, minor}` pair. Returns `undefined` if the string cannot be parsed.
 *
 * @param version - The raw `git --version` output.
 * @returns The major and minor version, or `undefined`.
 */
function parseGitVersion(version: string): { major: number; minor: number } | undefined {
  const m = /git version\s+(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return undefined;
  const major = Number.parseInt(m[1] ?? '', 10);
  const minor = Number.parseInt(m[2] ?? '', 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return undefined;
  return { major, minor };
}

/**
 * The `runtime.git` doctor check. Registered in `checks/index.ts`.
 */
export const runtimeGitCheck: DoctorCheck = {
  id: 'runtime.git',
  name: 'Git',
  category: 'runtime',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that Git is installed inside the active distro.',
    why: "Git is needed by many CLIs for repository operations (Aider reads git history, Cline can commit changes). It's installed during bootstrap stage 3 as part of the base packages.",
    consequence: "CLIs that interact with git repositories won't work properly. Aider won't be able to track file changes.",
    fix: 'linuxify init',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'runtime.git',
      name: 'Git',
      category: 'runtime',
    };

    let rawVersion: string;
    try {
      const r = await exec('git', ['--version'], { timeoutMs: 4000 });
      if (r.exitCode !== 0) {
        return {
          ...base,
          status: 'warn',
          message: `git --version exited ${r.exitCode}.`,
          detail: { exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) },
          fixCommand: 'linuxify runtimes install git',
          fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
          durationMs: Date.now() - start,
        };
      }
      rawVersion = r.stdout.trim();
    } catch (e) {
      return {
        ...base,
        status: 'warn',
        message: `git binary not found: ${(e as Error).message}`,
        detail: { error: (e as Error).message },
        fixCommand: 'linuxify runtimes install git',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const parsed = parseGitVersion(rawVersion);
    if (!parsed) {
      return {
        ...base,
        status: 'warn',
        message: `Could not parse Git version from '${rawVersion}'.`,
        detail: { raw: rawVersion },
        fixCommand: 'linuxify runtimes install git',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const { major, minor } = parsed;
    const tooOld =
      major < MIN_GIT_MAJOR ||
      (major === MIN_GIT_MAJOR && minor < MIN_GIT_MINOR);

    if (tooOld) {
      return {
        ...base,
        status: 'warn',
        message: `Git ${rawVersion} (expected ≥ ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}).`,
        detail: { raw: rawVersion, major, minor, minMajor: MIN_GIT_MAJOR, minMinor: MIN_GIT_MINOR },
        fixCommand: 'linuxify runtimes install git',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Git ${rawVersion}.`,
      detail: { raw: rawVersion, major, minor },
      durationMs: Date.now() - start,
    };
  },
};
