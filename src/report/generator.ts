/**
 * Report generator — collects environment state into a structured report.
 *
 * @module linuxify/report/generator
 */

import type { Config } from '../config/index.js';
import { logger } from '../utils/log.js';
import {
  getArch,
  getAndroidVersion,
  getPlatform,
  isTermux,
  isAndroid,
  exec,
  getLinuxifyHome,
} from '../utils/process.js';
import { exists, readFile, stat } from '../utils/fs.js';
import { resolve } from 'node:path';
import { LINUXIFY_VERSION, EXIT_CODES } from '../utils/constants.js';
import type { State } from '../state/index.js';
import type { StateStore } from '../state/index.js';
import type { DoctorEngine } from '../doctor/engine.js';
import type { PackageDefinition } from '../packages/schema.js';

/**
 * Output format for {@link formatReport}.
 *
 * - `text` — human-readable, ANSI color if TTY (default)
 * - `json` — stable schema `linuxify.report.v1`
 * - `markdown` — fenced ``` block for GitHub issue bodies
 * - `fingerprint` — compact one-liner (see {@link fingerprintFromReport})
 */
export type ReportFormat = 'text' | 'json' | 'markdown' | 'fingerprint';

/**
 * A complete Linuxify environment report. Mirrors the `linuxify.report.v1`
 * JSON schema; never contains PII.
 */
export interface Report {
  schema: 'linuxify.report.v1';
  generatedAt: string;
  linuxifyVersion: string;

  host: {
    platform: string;
    arch: string;
    androidVersion: string | null;
    termuxVersion: string | null;
    isTermux: boolean;
    kernel: string | null;
    storageFreeMb: number | null;
    memoryFreeMb: number | null;
  };

  install: {
    linuxifyHome: string;
    bootstrapComplete: boolean;
    bootstrapStagesDone: number[];
    bootstrapStagesFailed: number[];
    activeDistro: string | null;
    installedDistros: string[];
    configSchemaVersion: number;
  };

  runtimes: Array<{
    name: string;
    version: string;
    distro: string;
    isDefault: boolean;
  }>;

  packages: Array<{
    name: string;
    version: string;
    distro: string;
    runtime: string;
    patchesApplied: string[];
    status: 'installed' | 'broken' | 'unknown';
  }>;

  doctor: {
    profile: string;
    ok: number;
    warn: number;
    fail: number;
    missing: number;
    skip: number;
    total: number;
    durationMs: number;
    failingChecks: Array<{ id: string; name: string; message: string }>;
  };

  compatibility: Array<{
    package: string;
    status: 'supported' | 'partial' | 'broken' | 'untested';
    notes: string[];
  }>;

  warnings: string[];
}

/**
 * Generate a full report by gathering state from every subsystem.
 *
 * @param opts - Injected dependencies (config, state, doctor engine).
 * @returns A structured {@link Report}. Never throws — collection errors are
 *   captured in `report.warnings`.
 */
export async function generateReport(opts: {
  config: Config;
  stateStore: StateStore;
  doctorEngine?: DoctorEngine;
  packageDefinitions?: Map<string, PackageDefinition>;
}): Promise<Report> {
  const { config, stateStore } = opts;
  const warnings: string[] = [];

  // ── Host ────────────────────────────────────────────────────────────
  const host = await collectHost(warnings);

  // ── Install state ───────────────────────────────────────────────────
  let state: State;
  try {
    state = await stateStore.load();
  } catch (err) {
    warnings.push(`Failed to load state: ${(err as Error).message}`);
    state = emptyState();
  }

  const install = await collectInstall(state, warnings);

  // ── Runtimes ────────────────────────────────────────────────────────
  const runtimes = state.installed_runtimes.map((r) => ({
    name: r.name,
    version: r.version,
    distro: r.distro,
    isDefault: r.is_default,
  }));

  // ── Packages ────────────────────────────────────────────────────────
  const packages = state.installed_packages.map((p) => ({
    name: p.name,
    version: p.version,
    distro: p.distro,
    runtime: p.runtime,
    patchesApplied: p.patches_applied,
    status: 'installed' as const,
  }));

  // ── Doctor ──────────────────────────────────────────────────────────
  let doctorSummary: Report['doctor'] = {
    profile: 'standard',
    ok: 0,
    warn: 0,
    fail: 0,
    missing: 0,
    skip: 0,
    total: 0,
    durationMs: 0,
    failingChecks: [],
  };
  if (opts.doctorEngine) {
    try {
      const report = await opts.doctorEngine.run(
        { profile: 'standard', quiet: true },
        { config, state },
      );
      doctorSummary = {
        profile: report.profile,
        ok: report.summary.ok,
        warn: report.summary.warn,
        fail: report.summary.fail,
        missing: report.summary.missing,
        skip: report.summary.skip,
        total: report.summary.total,
        durationMs: report.durationMs,
        failingChecks: report.results
          .filter((r) => r.status === 'fail' || r.status === 'missing')
          .map((r) => ({ id: r.id, name: r.name, message: r.message })),
      };
    } catch (err) {
      warnings.push(`Doctor run failed: ${(err as Error).message}`);
    }
  }

  // ── Compatibility ───────────────────────────────────────────────────
  const compatibility: Report['compatibility'] = [];
  for (const pkg of packages) {
    const def = opts.packageDefinitions?.get(pkg.name);
    if (!def) {
      compatibility.push({
        package: pkg.name,
        status: 'untested',
        notes: ['No package definition in registry'],
      });
      continue;
    }
    const notes: string[] = [];
    let status: 'supported' | 'partial' | 'broken' | 'untested' = 'supported';

    // Check distro compat
    if (!def.compat.tested_distros.includes(pkg.distro)) {
      notes.push(`Distro '${pkg.distro}' not in tested list`);
      status = 'partial';
    }
    if (def.compat.not_supported.includes(pkg.distro)) {
      notes.push(`Distro '${pkg.distro}' explicitly not supported`);
      status = 'broken';
    }
    // Check known issues
    for (const issue of def.compat.known_issues ?? []) {
      if (typeof issue === 'object' && issue !== null && 'severity' in issue) {
        const ki = issue as { id?: string; severity?: string; description?: string };
        if (ki.severity === 'high') {
          notes.push(`Known issue: ${ki.description ?? ki.id ?? 'unnamed'}`);
          if (status !== 'broken') status = 'partial';
        }
      }
    }
    compatibility.push({ package: pkg.name, status, notes });
  }

  return {
    schema: 'linuxify.report.v1',
    generatedAt: new Date().toISOString(),
    linuxifyVersion: LINUXIFY_VERSION,
    host,
    install,
    runtimes,
    packages,
    doctor: doctorSummary,
    compatibility,
    warnings,
  };
}

/**
 * Render a report in the requested format.
 *
 * - `text` — colored if TTY, plain otherwise
 * - `json` — 2-space indented JSON
 * - `markdown` — wrapped in a ```linuxify-report fenced block
 * - `fingerprint` — compact one-liner
 */
export function formatReport(report: Report, format: ReportFormat): string {
  switch (format) {
    case 'json':
      return JSON.stringify(report, null, 2);
    case 'markdown':
      return '```linuxify-report\n' + formatText(report, false) + '\n```';
    case 'fingerprint':
      // Compact one-liner — defer to fingerprint module
      return compactFingerprint(report);
    case 'text':
    default:
      return formatText(report, process.stdout.isTTY ?? false);
  }
}

// ─── internals ────────────────────────────────────────────────────────

async function collectHost(warnings: string[]): Promise<Report['host']> {
  const platform = getPlatform();
  const arch = getArch();
  const androidVersion = isAndroid() ? await getAndroidVersion() : null;
  const termux = isTermux();

  let termuxVersion: string | null = null;
  if (termux) {
    // Try TERMUX_VERSION env var first (set by Termux since 0.118).
    termuxVersion = process.env.TERMUX_VERSION ?? null;
    // Fall back to dpkg -s com.termux (same method doctor uses).
    if (!termuxVersion) {
      try {
        const { stdout } = await exec('dpkg', ['-s', 'com.termux'], { timeoutMs: 3000 });
        const m = /Version:\s*([0-9.]+)/.exec(stdout);
        termuxVersion = m?.[1] ?? null;
      } catch {
        warnings.push('Could not determine Termux version');
      }
    }
  }

  let kernel: string | null = null;
  try {
    const { stdout } = await exec('uname', ['-r'], { timeoutMs: 2000 });
    kernel = stdout.trim();
  } catch {
    // Non-POSIX host (Windows without WSL) — skip
  }

  const storageFreeMb = await getStorageFreeMb(warnings);
  const memoryFreeMb = getMemoryFreeMb();

  return {
    platform,
    arch,
    androidVersion,
    termuxVersion,
    isTermux: termux,
    kernel,
    storageFreeMb,
    memoryFreeMb,
  };
}

async function collectInstall(
  state: State,
  _warnings: string[],
): Promise<Report['install']> {
  const linuxifyHome = getLinuxifyHome();
  const bootstrapDir = resolve(linuxifyHome, '.bootstrap');

  const stagesDone: number[] = [];
  const stagesFailed: number[] = [];
  for (let i = 0; i <= 8; i++) {
    try {
      if (await exists(resolve(bootstrapDir, `stage-${i}.done`))) {
        stagesDone.push(i);
      }
      if (await exists(resolve(bootstrapDir, `stage-${i}.failed`))) {
        stagesFailed.push(i);
      }
    } catch {
      // Permission errors etc. — just skip
    }
  }

  const installedDistros: string[] = [];
  try {
    const distrosDir = resolve(linuxifyHome, 'distros');
    const { readdir } = await import('node:fs/promises');
    for (const name of await readdir(distrosDir)) {
      if (await exists(resolve(distrosDir, name, 'installed'))) {
        installedDistros.push(name);
      }
    }
  } catch {
    // No distros dir — fresh install
  }

  return {
    linuxifyHome,
    bootstrapComplete: stagesDone.length === 9,
    bootstrapStagesDone: stagesDone,
    bootstrapStagesFailed: stagesFailed,
    activeDistro: state.active_distro || null,
    installedDistros,
    configSchemaVersion: 1,
  };
}

async function getStorageFreeMb(warnings: string[]): Promise<number | null> {
  try {
    const { stdout } = await exec('df', ['-m', getLinuxifyHome()], { timeoutMs: 2000 });
    const lines = stdout.trim().split('\n');
    const last = lines[lines.length - 1]?.trim().split(/\s+/);
    if (last && last.length >= 4) {
      return parseInt(last[3], 10) || null;
    }
  } catch (err) {
    warnings.push(`Could not probe storage: ${(err as Error).message}`);
  }
  return null;
}

function getMemoryFreeMb(): number | null {
  try {
    const free = process.memoryUsage?.();
    // process.memoryUsage is RSS, not free. Return null — real free memory
    // requires /proc/meminfo on Linux or `free` command.
    void free;
  } catch {
    // noop
  }
  return null;
}

function emptyState(): State {
  return {
    schema_version: 1,
    linuxify_version: LINUXIFY_VERSION,
    active_distro: '',
    installed_distros: [],
    installed_runtimes: [],
    installed_packages: [],
    applied_patches: [],
    bootstrap_progress: {
      current_stage: 0,
      completed_stages: [],
      failed_stage: null,
      error: null,
      started_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    },
    last_doctor_run: null,
    telemetry: { user_id: null, enabled: false, last_flush: null },
    plugins: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function formatText(r: Report, color: boolean): string {
  const lines: string[] = [];
  const green = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const yellow = (s: string) => (color ? `\x1b[33m${s}\x1b[0m` : s);
  const red = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);
  const bold = (s: string) => (color ? `\x1b[1m${s}\x1b[0m` : s);

  const check = (ok: boolean, warn = false) =>
    ok ? green('✔') : warn ? yellow('⚠') : red('✖');

  lines.push(bold(`Linuxify Report`));
  lines.push(dim(`Generated ${r.generatedAt} · v${r.linuxifyVersion}`));
  lines.push('');

  // Host
  lines.push(bold('Environment'));
  lines.push(`  ${check(!!r.host.termuxVersion)} Termux              ${r.host.termuxVersion ?? 'not detected'}`);
  lines.push(`  ${check(!!r.host.androidVersion)} Android             ${r.host.androidVersion ?? 'not detected'}`);
  lines.push(`  ${check(true)} Architecture         ${r.host.arch}`);
  lines.push(`  ${check(!!r.host.kernel)} Kernel               ${r.host.kernel ?? 'unknown'}`);
  if (r.host.storageFreeMb !== null) {
    const ok = r.host.storageFreeMb >= 2048;
    const warn = !ok && r.host.storageFreeMb >= 512;
    lines.push(`  ${check(ok, warn)} Storage              ${r.host.storageFreeMb} MiB free`);
  }
  lines.push('');

  // Install
  lines.push(bold('Linuxify'));
  lines.push(`  ${check(r.install.bootstrapComplete)} Bootstrap            ${r.install.bootstrapStagesDone.length}/9 stages${r.install.bootstrapComplete ? '' : ' (incomplete)'}`);
  if (r.install.bootstrapStagesFailed.length > 0) {
    lines.push(`  ${red('!')} Failed stages        ${r.install.bootstrapStagesFailed.join(', ')}`);
  }
  lines.push(`  ${check(!!r.install.activeDistro)} Active distro        ${r.install.activeDistro ?? 'none'}`);
  if (r.install.installedDistros.length > 0) {
    lines.push(`  ${check(true)} Installed distros    ${r.install.installedDistros.join(', ')}`);
  }
  lines.push('');

  // Runtimes
  if (r.runtimes.length > 0) {
    lines.push(bold('Runtimes'));
    for (const rt of r.runtimes) {
      const marker = rt.isDefault ? green('★') : dim('·');
      lines.push(`  ${marker} ${rt.name.padEnd(12)} ${rt.version.padEnd(12)} ${dim(`(${rt.distro})`)}`);
    }
    lines.push('');
  }

  // Packages
  if (r.packages.length > 0) {
    lines.push(bold('Packages'));
    for (const pkg of r.packages) {
      const compat = r.compatibility.find((c) => c.package === pkg.name);
      const status = compat?.status ?? 'unknown';
      const icon = status === 'supported' ? green('✓') : status === 'partial' ? yellow('⚠') : red('✖');
      lines.push(`  ${icon} ${pkg.name.padEnd(16)} ${pkg.version.padEnd(12)} ${dim(`[${pkg.runtime}@${pkg.distro}]`)}`);
      if (pkg.patchesApplied.length > 0) {
        lines.push(`    ${dim(`patches: ${pkg.patchesApplied.join(', ')}`)}`);
      }
      if (compat && compat.notes.length > 0) {
        for (const note of compat.notes) {
          lines.push(`    ${yellow('!')} ${note}`);
        }
      }
    }
    lines.push('');
  } else {
    lines.push(bold('Packages'));
    lines.push(`  ${dim('(none installed — run: linuxify add cline)')}`);
    lines.push('');
  }

  // Doctor
  if (r.doctor.total > 0) {
    lines.push(bold('Doctor'));
    lines.push(`  Profile: ${r.doctor.profile} · ${r.doctor.durationMs}ms`);
    lines.push(`  ${green(`OK: ${r.doctor.ok}`)}  ${yellow(`Warn: ${r.doctor.warn}`)}  ${red(`Fail: ${r.doctor.fail}`)}  Missing: ${r.doctor.missing}  Skip: ${r.doctor.skip}`);
    if (r.doctor.failingChecks.length > 0) {
      lines.push(`  ${red('Failing checks:')}`);
      for (const fc of r.doctor.failingChecks) {
        lines.push(`    ${red('✖')} ${fc.id} — ${fc.message}`);
      }
    }
    lines.push('');
  }

  // Compatibility summary
  const supported = r.compatibility.filter((c) => c.status === 'supported').length;
  const partial = r.compatibility.filter((c) => c.status === 'partial').length;
  const broken = r.compatibility.filter((c) => c.status === 'broken').length;
  const total = r.compatibility.length;
  if (total > 0) {
    const pct = total > 0 ? Math.round((supported / total) * 100) : 100;
    lines.push(bold('Compatibility'));
    lines.push(`  ${pct === 100 ? green(`${pct}%`) : yellow(`${pct}%`)} supported · ${partial} partial · ${broken} broken`);
    lines.push('');
  }

  // Warnings
  if (r.warnings.length > 0) {
    lines.push(bold('Collection Warnings'));
    for (const w of r.warnings) {
      lines.push(`  ${yellow('!')} ${w}`);
    }
    lines.push('');
  }

  lines.push(dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
  lines.push(dim('Copy this report when opening a GitHub issue.'));
  lines.push(dim('Tip: long-press in Termux to select and copy, or run:'));
  lines.push(dim('  linuxify report --markdown > report.md'));

  return lines.join('\n');
}

function compactFingerprint(r: Report): string {
  // Single-line fingerprint for log signatures.
  // Example: linuxify/0.1.0 android/16 termux/0.119 ubuntu/24.04 node/24.18 arch/arm64 kernel/6.17 storage/ok
  const parts: string[] = [`linuxify/${r.linuxifyVersion}`];
  if (r.host.androidVersion) parts.push(`android/${r.host.androidVersion}`);
  if (r.host.termuxVersion) parts.push(`termux/${r.host.termuxVersion}`);
  if (r.install.activeDistro) parts.push(`distro/${r.install.activeDistro}`);
  const defaultNode = r.runtimes.find((rt) => rt.name === 'node' && rt.isDefault);
  if (defaultNode) parts.push(`node/${defaultNode.version}`);
  parts.push(`arch/${r.host.arch}`);
  if (r.host.kernel) parts.push(`kernel/${r.host.kernel}`);
  parts.push(`storage/${r.host.storageFreeMb !== null && r.host.storageFreeMb >= 2048 ? 'ok' : 'low'}`);
  parts.push(`doctor/${r.doctor.fail === 0 ? 'clean' : `${r.doctor.fail}fail`}`);
  return parts.join(' ');
}

// Unused import suppression — stat is reserved for future inode checks.
void stat;
void readFile;
void logger;
void EXIT_CODES;
