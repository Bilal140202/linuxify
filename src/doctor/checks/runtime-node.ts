/**
 * Doctor check: `runtime.node`.
 *
 * @module linuxify/doctor/checks/runtime-node
 *
 * Verifies that Node.js is installed and reports a version ≥ 20 LTS.
 * Runs `node --version` on the host PATH (not inside proot) because the
 * launcher shim execs `linuxify run` on the host, which then enters proot
 * — so the host Node is what matters for the CLI itself.
 *
 * On failure, suggests `linuxify runtimes install node 22`.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum Node major version (20 LTS). */
const MIN_NODE_MAJOR = 20;

/**
 * Parse a `node --version` string (e.g. `v22.11.0`) into its major version
 * number. Returns `undefined` if the string cannot be parsed.
 *
 * @param version - The raw `node --version` output.
 * @returns The major version, or `undefined`.
 */
function parseNodeMajor(version: string): number | undefined {
  const m = /^v?(\d+)\./.exec(version.trim());
  if (!m) return undefined;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * The `runtime.node` doctor check. Registered in `checks/index.ts`.
 */
export const runtimeNodeCheck: DoctorCheck = {
  id: 'runtime.node',
  name: 'Node.js',
  category: 'runtime',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'runtime.node',
      name: 'Node.js',
      category: 'runtime',
    };

    let rawVersion: string;
    try {
      const r = await exec('node', ['--version'], { timeoutMs: 4000 });
      if (r.exitCode !== 0) {
        return {
          ...base,
          status: 'fail',
          message: `node --version exited ${r.exitCode}.`,
          detail: { exitCode: r.exitCode, stderr: r.stderr.slice(0, 500) },
          fixCommand: 'linuxify runtimes install node 22',
          fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
          durationMs: Date.now() - start,
        };
      }
      rawVersion = r.stdout.trim();
    } catch (e) {
      return {
        ...base,
        status: 'fail',
        message: `node binary not found: ${(e as Error).message}`,
        detail: { error: (e as Error).message },
        fixCommand: 'linuxify runtimes install node 22',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const major = parseNodeMajor(rawVersion);
    if (major === undefined) {
      return {
        ...base,
        status: 'warn',
        message: `Could not parse Node version from '${rawVersion}'.`,
        detail: { raw: rawVersion },
        fixCommand: 'linuxify runtimes install node 22',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    if (major < MIN_NODE_MAJOR) {
      return {
        ...base,
        status: 'fail',
        message: `Node ${rawVersion} (expected ≥ v${MIN_NODE_MAJOR}).`,
        detail: { raw: rawVersion, major, minMajor: MIN_NODE_MAJOR },
        fixCommand: 'linuxify runtimes install node 22',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Node ${rawVersion}.`,
      detail: { raw: rawVersion, major },
      durationMs: Date.now() - start,
    };
  },
};
