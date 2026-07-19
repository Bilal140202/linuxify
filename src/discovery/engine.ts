/**
 * Discovery engine — scans the system for existing Linuxify-relevant state.
 *
 * @module linuxify/discovery/engine
 */

import { logger } from '../utils/log.js';
import { exec, isTermux, isAndroid, getArch, getAndroidVersion, getTermuxPrefix } from '../utils/process.js';
import { exists } from '../utils/fs.js';
import { join } from 'node:path';

/**
 * Host-level environment (Termux + Android + proot).
 */
export interface HostEnvironment {
  isTermux: boolean;
  isAndroid: boolean;
  androidVersion: string | null;
  arch: string;
  termuxPrefix: string;
  prootInstalled: boolean;
  prootDistroInstalled: boolean;
  prootDistroVersion: string | null;
  prootDistroWorking: boolean;
}

/**
 * A proot-distro container discovered on the system.
 */
export interface DiscoveredDistro {
  name: string;
  /** Path to the rootfs on disk. */
  rootfsPath: string;
  /** Whether the distro can be entered (proot-distro login succeeds). */
  bootable: boolean;
  /** Runtimes discovered inside this distro. */
  runtimes: DiscoveredRuntime[];
  /** Whether this distro is already managed by Linuxify (has ~/.linuxify/ inside). */
  managedByLinuxify: boolean;
  /** Approximate rootfs size in MB (0 if unknown). */
  sizeMb: number;
}

/**
 * A runtime (Node, Python, Git) discovered inside a distro.
 */
export interface DiscoveredRuntime {
  name: string;
  version: string | null;
  path: string | null;
}

/**
 * A package discovered inside a distro (e.g., cline installed via npm).
 */
export interface DiscoveredPackage {
  name: string;
  version: string | null;
  runtime: string;
}

/**
 * Complete discovery result — everything Linuxify found on the system.
 */
export interface DiscoveryResult {
  host: HostEnvironment;
  distros: DiscoveredDistro[];
  linuxifyInitialized: boolean;
  linuxifyHomeExists: boolean;
  discoveredAt: string;
  warnings: string[];
}

/**
 * Run full environment discovery.
 *
 * This is read-only — it never modifies state. It scans:
 *   1. Host (Termux, Android, proot, proot-distro)
 *   2. proot-distro containers (ubuntu, debian, arch, alpine)
 *   3. Inside each container: Node, Python, Git versions
 *   4. Linuxify home (~/.linuxify/) existence
 *
 * @returns A {@link DiscoveryResult} with everything found. Never throws —
 *   errors are captured in `result.warnings`.
 */
export async function discoverEnvironment(): Promise<DiscoveryResult> {
  const warnings: string[] = [];
  const discoveredAt = new Date().toISOString();

  // ── Host ────────────────────────────────────────────────────────────
  logger.info('discovery: scanning host');
  const host = await scanHost(warnings);

  // ── Distros ─────────────────────────────────────────────────────────
  const distros: DiscoveredDistro[] = [];
  if (host.prootDistroWorking) {
    logger.info('discovery: scanning proot-distro containers');
    const distroNames = await listProotDistroContainers(warnings);
    for (const name of distroNames) {
      logger.info({ distro: name }, 'discovery: scanning distro');
      const distro = await scanDistro(name, warnings);
      distros.push(distro);
    }
  } else {
    logger.info('discovery: proot-distro not working — skipping distro scan');
  }

  // ── Linuxify home ───────────────────────────────────────────────────
  const linuxifyHome = `${process.env.HOME ?? '/tmp'}/.linuxify`;
  const linuxifyHomeExists = await exists(linuxifyHome);
  const stateJsonExists = await exists(join(linuxifyHome, 'state.json'));
  const linuxifyInitialized = linuxifyHomeExists && stateJsonExists;

  return {
    host,
    distros,
    linuxifyInitialized,
    linuxifyHomeExists,
    discoveredAt,
    warnings,
  };
}

/**
 * Scan host-level environment.
 */
async function scanHost(warnings: string[]): Promise<HostEnvironment> {
  const isT = isTermux();
  const isA = isAndroid();
  const arch = getArch();
  const androidVersion = isA ? await getAndroidVersion() : null;
  const termuxPrefix = getTermuxPrefix();

  // Check if proot and proot-distro are on PATH
  const prootCheck = await checkBinaryOnPath('proot');
  const prootDistroCheck = await checkBinaryOnPath('proot-distro');

  // Check if proot-distro actually works (proot-distro list exits 0)
  let prootDistroWorking = false;
  let prootDistroVersion: string | null = null;
  if (prootDistroCheck.found) {
    try {
      const listResult = await exec('proot-distro', ['list'], { timeoutMs: 10000 });
      prootDistroWorking = listResult.exitCode === 0;
      if (prootDistroWorking) {
        // Try to get version from dpkg
        try {
          const dpkgResult = await exec('dpkg', ['-s', 'proot-distro'], { timeoutMs: 5000 });
          if (dpkgResult.exitCode === 0) {
            const m = /Version:\s*([0-9.]+)/.exec(dpkgResult.stdout);
            prootDistroVersion = m?.[1] ?? null;
          }
        } catch {
          // Non-fatal
        }
      }
    } catch (err) {
      warnings.push(`proot-distro list failed: ${(err as Error).message}`);
    }
  }

  return {
    isTermux: isT,
    isAndroid: isA,
    androidVersion,
    arch,
    termuxPrefix,
    prootInstalled: prootCheck.found,
    prootDistroInstalled: prootDistroCheck.found,
    prootDistroVersion,
    prootDistroWorking,
  };
}

/**
 * Check if a binary is on PATH using `command -v`.
 */
async function checkBinaryOnPath(name: string): Promise<{ found: boolean; path: string | null }> {
  try {
    const r = await exec('sh', ['-c', `command -v ${name}`], { timeoutMs: 2000 });
    if (r.exitCode === 0 && r.stdout.trim()) {
      return { found: true, path: r.stdout.trim() };
    }
  } catch {
    // give up
  }
  return { found: false, path: null };
}

/**
 * List proot-distro containers by parsing `proot-distro list` output AND
 * checking the filesystem directly.
 *
 * We use both methods because:
 * 1. `proot-distro list` is the official way but its output format may vary
 * 2. The filesystem check (`$PREFIX/var/lib/proot-distro/installed-rootfs/`)
 *    is the ground truth — directories there ARE installed containers
 */
async function listProotDistroContainers(warnings: string[]): Promise<string[]> {
  const distros = new Set<string>();

  // Method 1: Parse `proot-distro list` output.
  try {
    const r = await exec('proot-distro', ['list'], { timeoutMs: 10000 });
    if (r.exitCode === 0) {
      const parsed = parseDistroList(r.stdout);
      for (const d of parsed) distros.add(d);
      if (parsed.length === 0) {
        logger.debug({ stdout: r.stdout.slice(0, 200) }, 'discovery: proot-distro list returned no parsed distros');
      }
    } else {
      warnings.push('proot-distro list failed — falling back to filesystem check');
    }
  } catch (err) {
    warnings.push(`proot-distro list threw: ${(err as Error).message}`);
  }

  // Method 2: Check the filesystem directly.
  try {
    const { readdir } = await import('node:fs/promises');
    const rootfsDir = join(getTermuxPrefix(), 'var', 'lib', 'proot-distro', 'installed-rootfs');
    logger.debug({ rootfsDir }, 'discovery: checking rootfs directory');
    const entries = await readdir(rootfsDir);
    for (const name of entries) {
      // Each subdirectory is an installed container
      distros.add(name);
    }
    if (entries.length > 0) {
      logger.info({ found: entries }, 'discovery: found containers via filesystem');
    }
  } catch {
    // Directory may not exist if no containers are installed — fine.
  }

  return Array.from(distros);
}

/**
 * Parse `proot-distro list` output to extract container names.
 *
 * Output looks like:
 * ```
 * Installed containers:
 *
 *   ubuntu
 *   debian
 *
 * Log in with: proot-distro login <name>
 * ```
 */
function parseDistroList(stdout: string): string[] {
  const lines = stdout.split('\n');
  const distros: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.toLowerCase().startsWith('installed containers')) {
      inSection = true;
      continue;
    }
    if (trimmed.toLowerCase().startsWith('log in with')) {
      inSection = false;
      continue;
    }
    if (inSection && !trimmed.includes(':')) {
      distros.push(trimmed);
    }
  }
  return distros;
}

/**
 * Scan a single proot-distro container for runtimes and Linuxify state.
 */
async function scanDistro(name: string, warnings: string[]): Promise<DiscoveredDistro> {
  const rootfsPath = `${process.env.PREFIX ?? '/data/data/com.termux/files/usr'}/var/lib/proot-distro/installed-rootfs/${name}`;

  // Check if the distro is bootable (proot-distro login -- true exits 0)
  let bootable = false;
  try {
    const r = await exec('proot-distro', ['login', name, '--', 'true'], { timeoutMs: 15000 });
    bootable = r.exitCode === 0;
  } catch (err) {
    warnings.push(`distro '${name}' not bootable: ${(err as Error).message}`);
  }

  // Scan runtimes inside the distro
  const runtimes: DiscoveredRuntime[] = [];
  if (bootable) {
    runtimes.push(await checkRuntimeInDistro(name, 'node', ['--version']));
    runtimes.push(await checkRuntimeInDistro(name, 'python3', ['--version']));
    runtimes.push(await checkRuntimeInDistro(name, 'git', ['--version']));
  }

  // Check if Linuxify manages this distro (look for ~/.linuxify/ inside)
  let managedByLinuxify = false;
  if (bootable) {
    try {
      const r = await exec(
        'proot-distro',
        ['login', name, '--', 'test', '-d', '/home/linuxify/.linuxify'],
        { timeoutMs: 10000 },
      );
      managedByLinuxify = r.exitCode === 0;
    } catch {
      // Non-fatal
    }
  }

  // Get rootfs size (approximate)
  let sizeMb = 0;
  try {
    const r = await exec('du', ['-sm', rootfsPath], { timeoutMs: 10000 });
    const m = /^(\d+)/.exec(r.stdout);
    if (m) sizeMb = parseInt(m[1], 10);
  } catch {
    // Non-fatal
  }

  return {
    name,
    rootfsPath,
    bootable,
    runtimes,
    managedByLinuxify,
    sizeMb,
  };
}

/**
 * Check if a runtime (node, python3, git) is installed inside a distro.
 */
async function checkRuntimeInDistro(
  distro: string,
  name: string,
  versionArgs: string[],
): Promise<DiscoveredRuntime> {
  try {
    const r = await exec(
      'proot-distro',
      ['login', distro, '--', 'sh', '-c', `command -v ${name} && ${name} ${versionArgs.join(' ')}`],
      { timeoutMs: 15000 },
    );
    if (r.exitCode === 0) {
      const lines = r.stdout.trim().split('\n');
      const path = lines[0]?.trim() ?? null;
      const version = lines.slice(1).join(' ').trim() || null;
      return { name, version, path };
    }
  } catch {
    // Runtime not installed
  }
  return { name, version: null, path: null };
}
