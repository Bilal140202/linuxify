/**
 * Fingerprint — a compact, stable identifier for a Linuxify environment.
 *
 * @module linuxify/report/fingerprint
 *
 * The fingerprint is a short string that uniquely identifies an environment
 * configuration WITHOUT revealing PII. It's used for:
 *
 *   1. Bug reports: "I'm on fingerprint `linuxify/0.1.0 android/16 ...`"
 *   2. Compatibility matching: "does this fingerprint match a known-good config?"
 *   3. Telemetry deduplication (opt-in): count unique configs, not unique users.
 *   4. Support routing: "this fingerprint has Alpine + Node 20 — known issue X"
 *
 * The fingerprint is NOT a hash — it's human-readable so users can eyeball
 * differences between two fingerprints. Format:
 *
 *   linuxify/<version> android/<v> termux/<v> distro/<name> node/<v> arch/<a> kernel/<v> storage/<ok|low> doctor/<clean|Nfail>
 *
 * Example:
 *   linuxify/0.1.0 android/16 termux/0.119 distro/ubuntu node/24.18 arch/arm64 kernel/6.17 storage/ok doctor/clean
 */

import type { Report } from './generator.js';

/**
 * A structured fingerprint. Each field is optional because not every field
 * is detectable on every host (e.g., `termuxVersion` is null outside Termux).
 */
export interface Fingerprint {
  linuxifyVersion: string;
  androidVersion: string | null;
  termuxVersion: string | null;
  distro: string | null;
  nodeVersion: string | null;
  arch: string;
  kernel: string | null;
  storage: 'ok' | 'low' | 'unknown';
  doctor: 'clean' | 'warn' | 'fail' | 'unknown';
}

/**
 * Extract a structured fingerprint from a full report.
 */
export function fingerprintFromReport(report: Report): Fingerprint {
  const defaultNode = report.runtimes.find((rt) => rt.name === 'node' && rt.isDefault);
  const storage: Fingerprint['storage'] =
    report.host.storageFreeMb === null
      ? 'unknown'
      : report.host.storageFreeMb >= 2048
        ? 'ok'
        : 'low';
  const doctor: Fingerprint['doctor'] =
    report.doctor.total === 0
      ? 'unknown'
      : report.doctor.fail > 0
        ? 'fail'
        : report.doctor.warn > 0
          ? 'warn'
          : 'clean';
  return {
    linuxifyVersion: report.linuxifyVersion,
    androidVersion: report.host.androidVersion,
    termuxVersion: report.host.termuxVersion,
    distro: report.install.activeDistro || null,
    nodeVersion: defaultNode?.version ?? null,
    arch: report.host.arch,
    kernel: report.host.kernel,
    storage,
    doctor,
  };
}

/**
 * Render a fingerprint as a single-line human-readable string.
 *
 * Example:
 *   linuxify/0.1.0 android/16 termux/0.119 distro/ubuntu node/24.18 arch/arm64 kernel/6.17 storage/ok doctor/clean
 */
export function formatFingerprint(fp: Fingerprint): string {
  const parts: string[] = [`linuxify/${fp.linuxifyVersion}`];
  if (fp.androidVersion) parts.push(`android/${fp.androidVersion}`);
  if (fp.termuxVersion) parts.push(`termux/${fp.termuxVersion}`);
  if (fp.distro) parts.push(`distro/${fp.distro}`);
  if (fp.nodeVersion) parts.push(`node/${fp.nodeVersion}`);
  parts.push(`arch/${fp.arch}`);
  if (fp.kernel) parts.push(`kernel/${fp.kernel}`);
  parts.push(`storage/${fp.storage}`);
  parts.push(`doctor/${fp.doctor}`);
  return parts.join(' ');
}
