/**
 * Doctor check: `network.github`.
 *
 * @module linuxify/doctor/checks/network-github
 *
 * Verifies that `https://github.com` is reachable via HTTP HEAD. Linuxify
 * uses GitHub for the package registry, for plugin sources, and for the
 * CLI's own self-update checks. A failure here means the user cannot
 * install or update packages.
 *
 * Uses `isReachable` from `utils/net.ts` (which respects timeouts and
 * never throws). Network checks are skipped under `--offline`.
 *
 * On failure, suggests checking connectivity (VPN, firewall, etc.).
 *
 * @packageDocumentation
 */

import { isReachable } from '../../utils/net.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** URL to probe. */
const URL = 'https://github.com';

/** Probe timeout (ms). */
const TIMEOUT_MS = 5000;

/**
 * The `network.github` doctor check. Registered in `checks/index.ts`.
 */
export const networkGithubCheck: DoctorCheck = {
  id: 'network.github',
  name: 'GitHub reachable',
  category: 'network',
  profile: ['deep', 'ci'],
  explain: {
    what: 'Verifies that github.com is reachable (the Linuxify registry and source code live there).',
    why: "The Linuxify registry is a git repository on GitHub. `linuxify update` pulls from it, and `linuxify search` queries it. If GitHub is blocked, you can't discover or install packages.",
    consequence: "`linuxify search` and `linuxify add` will fail because the registry can't be updated. Existing packages still work (they're already installed).",
    fix: 'Check if GitHub is blocked on your network. Use a VPN if necessary. For air-gapped environments, see `linuxify bundle` for offline installation.',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'network.github',
      name: 'GitHub reachable',
      category: 'network',
    };

    if (process.env.LINUXIFY_OFFLINE === '1') {
      return {
        ...base,
        status: 'skip',
        message: 'GitHub reachability check skipped (--offline).',
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
        fixCommand: 'Check connectivity; consider VPN.',
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
