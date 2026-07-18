/**
 * Doctor check: `runtime.python`.
 *
 * @module linuxify/doctor/checks/runtime-python
 *
 * Verifies that Python ≥ 3.12 is installed. Runs `python3 --version` on the
 * host PATH.
 *
 * On failure, suggests `linuxify runtimes install python 3.12`.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum Python minor version (3.12). */
const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 12;

/**
 * Parse a `python3 --version` string (e.g. `Python 3.12.3`) into a
 * `{major, minor}` pair. Returns `undefined` if the string cannot be parsed.
 *
 * @param version - The raw `python3 --version` output.
 * @returns The major and minor version, or `undefined`.
 */
function parsePythonVersion(version: string): { major: number; minor: number } | undefined {
  const m = /Python\s+(\d+)\.(\d+)\./.exec(version.trim());
  if (!m) return undefined;
  const major = Number.parseInt(m[1] ?? '', 10);
  const minor = Number.parseInt(m[2] ?? '', 10);
  if (Number.isNaN(major) || Number.isNaN(minor)) return undefined;
  return { major, minor };
}

/**
 * The `runtime.python` doctor check. Registered in `checks/index.ts`.
 */
export const runtimePythonCheck: DoctorCheck = {
  id: 'runtime.python',
  name: 'Python',
  category: 'runtime',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that Python 3.10+ is installed inside the active distro.',
    why: 'Some CLIs (Aider, Claude Code) are Python applications. They need Python to run. Linuxify installs Python 3.12 during bootstrap stage 4.',
    consequence: "Python-based CLIs won't start. `linuxify add aider` will fail because `pip install aider-chat` requires Python.",
    fix: 'linuxify runtimes install python 3.12',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'runtime.python',
      name: 'Python',
      category: 'runtime',
    };

    let rawVersion: string;
    try {
      const r = await exec('python3', ['--version'], { timeoutMs: 4000 });
      if (r.exitCode !== 0) {
        // Some installs put python at `python` not `python3`; try once more.
        const r2 = await exec('python', ['--version'], { timeoutMs: 4000 });
        if (r2.exitCode !== 0) {
          return {
            ...base,
            status: 'warn',
            message: `python3 --version exited ${r.exitCode}.`,
            detail: { exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) },
            fixCommand: 'linuxify runtimes install python 3.12',
            fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
            durationMs: Date.now() - start,
          };
        }
        rawVersion = r2.stdout.trim();
      } else {
        rawVersion = r.stdout.trim();
      }
    } catch (e) {
      return {
        ...base,
        status: 'warn',
        message: `python3 binary not found: ${(e as Error).message}`,
        detail: { error: (e as Error).message },
        fixCommand: 'linuxify runtimes install python 3.12',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const parsed = parsePythonVersion(rawVersion);
    if (!parsed) {
      return {
        ...base,
        status: 'warn',
        message: `Could not parse Python version from '${rawVersion}'.`,
        detail: { raw: rawVersion },
        fixCommand: 'linuxify runtimes install python 3.12',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const { major, minor } = parsed;
    const tooOld =
      major < MIN_PYTHON_MAJOR ||
      (major === MIN_PYTHON_MAJOR && minor < MIN_PYTHON_MINOR);

    if (tooOld) {
      return {
        ...base,
        status: 'warn',
        message: `Python ${rawVersion} (expected ≥ ${MIN_PYTHON_MAJOR}.${MIN_PYTHON_MINOR}).`,
        detail: { raw: rawVersion, major, minor, minMajor: MIN_PYTHON_MAJOR, minMinor: MIN_PYTHON_MINOR },
        fixCommand: 'linuxify runtimes install python 3.12',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Python ${rawVersion}.`,
      detail: { raw: rawVersion, major, minor },
      durationMs: Date.now() - start,
    };
  },
};
