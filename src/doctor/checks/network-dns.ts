/**
 * Doctor check: `network.dns`.
 *
 * @module linuxify/doctor/checks/network-dns
 *
 * Verifies that DNS resolution works by looking up `example.com` via
 * `node -e 'require("dns").lookup(...)'`. Uses Node's built-in `dns`
 * module (not `getent` or `nslookup`) so the check works on every platform
 * without external binaries.
 *
 * Network checks are skipped under `--offline` (signalled by the
 * `LINUXIFY_OFFLINE` env var, set by the CLI when `--offline` is passed).
 *
 * On failure, suggests checking `/etc/resolv.conf` inside the proot.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** DNS lookup timeout (ms). */
const DNS_TIMEOUT_MS = 3000;

/** Hostname to resolve for the test. */
const TEST_HOST = 'example.com';

/**
 * The `network.dns` doctor check. Registered in `checks/index.ts`.
 */
export const networkDnsCheck: DoctorCheck = {
  id: 'network.dns',
  name: 'DNS',
  category: 'network',
  profile: ['deep', 'ci'],
  explain: {
    what: 'Verifies that DNS resolution works (can resolve hostnames like github.com).',
    why: "Bootstrap downloads the Ubuntu rootfs from Ubuntu's CDN, and package installs pull from npm/PyPI. All of these require working DNS. Corporate networks and some mobile carriers intercept or break DNS.",
    consequence: "Downloads will fail with 'Could not resolve host'. Bootstrap stage 2 (rootfs download) and every `linuxify add` will fail.",
    fix: 'Check your network connection. If on a corporate network, ask IT about DNS restrictions. Try a different network (mobile data vs Wi-Fi).',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'network.dns',
      name: 'DNS',
      category: 'network',
    };

    if (process.env.LINUXIFY_OFFLINE === '1') {
      return {
        ...base,
        status: 'skip',
        message: 'DNS check skipped (--offline).',
        durationMs: Date.now() - start,
      };
    }

    const script = `require('dns').lookup(${JSON.stringify(TEST_HOST)}, (err, addr) => { process.stdout.write(err ? 'ERR:' + err.message : 'OK:' + addr); process.exit(err ? 1 : 0); })`;

    let result;
    try {
      result = await exec('node', ['-e', script], { timeoutMs: DNS_TIMEOUT_MS });
    } catch (e) {
      return {
        ...base,
        status: 'warn',
        message: `DNS lookup failed to spawn: ${(e as Error).message}`,
        detail: { error: (e as Error).message, host: TEST_HOST },
        fixCommand: 'Check /etc/resolv.conf inside proot.',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (result.timedOut) {
      return {
        ...base,
        status: 'warn',
        message: `DNS lookup timed out after ${DNS_TIMEOUT_MS} ms.`,
        detail: { host: TEST_HOST, timeoutMs: DNS_TIMEOUT_MS },
        fixCommand: 'Check /etc/resolv.conf inside proot.',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (result.exitCode !== 0 || !result.stdout.startsWith('OK:')) {
      return {
        ...base,
        status: 'warn',
        message: `DNS resolution failed: ${result.stdout.trim() || result.stderr.trim()}`,
        detail: { host: TEST_HOST, exitCode: result.exitCode, stdout: result.stdout },
        fixCommand: 'Check /etc/resolv.conf inside proot.',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    const address = result.stdout.slice(3).trim();
    return {
      ...base,
      status: 'ok',
      message: `DNS resolves ${TEST_HOST} → ${address}.`,
      detail: { host: TEST_HOST, address },
      durationMs: Date.now() - start,
    };
  },
};
