/**
 * Shared distro detection — the single source of truth for installed containers.
 *
 * @module linuxify/utils/distros
 *
 * Every subsystem (bootstrap, doctor, discovery, repair, CLI commands) MUST
 * use these helpers instead of implementing their own proot-distro parsing.
 *
 * This prevents the bug where Stage 2 and Stage 7 use `proot-distro list
 * --quiet` but doctor reads stale state.json — they now all query the same
 * ground truth.
 */

import { exec } from './process.js';
import { logger } from './log.js';

/**
 * Get the list of installed proot-distro containers by running
 * `proot-distro list --quiet`.
 *
 * This is the SINGLE SOURCE OF TRUTH for "is Ubuntu installed?" — every
 * subsystem (bootstrap, doctor, discovery, repair) should call this instead
 * of parsing proot-distro output themselves or reading stale state.json.
 *
 * @returns Array of container names (e.g., ['ubuntu', 'debian']). Empty if
 *   none installed or proot-distro not available.
 */
export async function getInstalledContainers(): Promise<string[]> {
  try {
    const r = await exec('proot-distro', ['list', '--quiet'], { timeoutMs: 10000 });
    if (r.exitCode !== 0) {
      // --quiet not supported (old proot-distro) or proot-distro broken.
      // Fall back to the filesystem check.
      return await getInstalledContainersFromFilesystem();
    }
    const containers = r.stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    logger.debug({ containers }, 'getInstalledContainers: found via proot-distro list --quiet');
    return containers;
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'getInstalledContainers: proot-distro list --quiet failed, trying filesystem');
    return await getInstalledContainersFromFilesystem();
  }
}

/**
 * Check if a specific container is installed.
 *
 * @param name - Container name (e.g., 'ubuntu').
 * @returns true if the container is installed.
 */
export async function isContainerInstalled(name: string): Promise<boolean> {
  const containers = await getInstalledContainers();
  return containers.includes(name);
}

/**
 * Get the active distro — the one Linuxify should use for `linuxify run`,
 * `linuxify shell`, etc.
 *
 * Resolution order:
 * 1. If state.json has an active_distro AND it's actually installed → use it.
 * 2. If state.json has no active_distro but Ubuntu is installed → 'ubuntu'.
 * 3. If no distros are installed → null.
 *
 * This fixes the bug where doctor said "no active distro" even though
 * Ubuntu was installed — it now checks reality, not just state.json.
 *
 * @param stateActiveDistro - The active_distro from state.json (may be empty).
 * @returns The active distro name, or null if none installed.
 */
export async function getActiveDistro(stateActiveDistro: string | null | undefined): Promise<string | null> {
  const installed = await getInstalledContainers();

  // 1. If state.json points to an installed distro, use it.
  if (stateActiveDistro && installed.includes(stateActiveDistro)) {
    return stateActiveDistro;
  }

  // 2. If Ubuntu is installed, use it as the default.
  if (installed.includes('ubuntu')) {
    return 'ubuntu';
  }

  // 3. If any distro is installed, use the first one.
  if (installed.length > 0) {
    return installed[0]!;
  }

  // 4. No distros installed.
  return null;
}

/**
 * Filesystem fallback: check the proot-distro installed-rootfs directory
 * directly. This is the ground truth — directories there ARE containers.
 */
async function getInstalledContainersFromFilesystem(): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const { getTermuxPrefix } = await import('./process.js');
    const { join } = await import('node:path');
    const rootfsDir = join(getTermuxPrefix(), 'var', 'lib', 'proot-distro', 'installed-rootfs');
    const entries = await readdir(rootfsDir);
    logger.debug({ entries }, 'getInstalledContainers: found via filesystem');
    return entries;
  } catch {
    return [];
  }
}
