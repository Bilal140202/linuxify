/**
 * Doctor check: `network.npm`.
 *
 * @module linuxify/doctor/checks/network-npm
 *
 * Verifies that `https://registry.npmjs.org` is reachable via HTTP HEAD.
 * Linuxify installs Node-based packages via `npm install -g`, which
 * requires registry access. A failure here means `linuxify add <node-pkg>`
 * will fail.
 *
 * Uses `isReachable` from `utils/net.ts`. Network checks are skipped under
 * `--offline`.
 *
 * On failure, suggests `linuxify config set npm.registry <url>` to switch
 * to a mirror.
 *
 * @packageDocumentation
 */

import { isReachable } from '../../utils/net.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** URL to probe. */
const URL = 'https://registry.npmjs.org';

/** Probe timeout (ms). */
const TIMEOUT_MS = 5000;

/**
 * The `network.npm` doctor check. Registered in `checks/index.ts`.
 */
export const networkNpmCheck: DoctorCheck = {
  id: 'network.npm',
  name: 'npm registry reachable',
  category: 'network',
  profile: ['deep', 'ci'],

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'network.npm',
      name: 'npm registry reachable',
      category: 'network',
    };

    if (process.env.LINUXIFY_OFFLINE === '1') {
      return {
        ...base,
        status: 'skip',
        message: 'npm registry check skipped (--offline).',
        durationMs: Date.now() - start,
      };
    }

    let reachable: boolean;
    try {
      reachable = await isReachable(URL, { timeoutMs: TIMEOUT_MS });
    } catch {
      reachable = false;
    }

    if (!reachable) {
      return {
        ...base,
        status: 'warn',
        message: `Could not reach ${URL} (timeout ${TIMEOUT_MS} ms).`,
        detail: { url: URL, timeoutMs: TIMEOUT_MS },
        fixCommand: 'linuxify config set npm.registry <url>',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `${URL} reachable.`,
      detail: { url: URL },
      durationMs: Date.now() - start,
    };
  },
};
