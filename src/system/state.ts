/**
 * SystemState assessment engine — the "is Linuxify ready?" state machine.
 *
 * @module linuxify/system/state
 *
 * This is the single function that every `linuxify` invocation calls to
 * decide what to do. It replaces the old pattern of "user must know which
 * command to run" with "Linuxify figures out what's needed and does it."
 */

import { exists } from '../utils/fs.js';
import { join } from 'node:path';
import { getLinuxifyHome } from '../utils/process.js';
import { getInstalledContainers, getActiveDistro } from '../utils/distros.js';
import { exec } from '../utils/process.js';
import { logger } from '../utils/log.js';

/**
 * The overall state of the Linuxify system.
 */
export type SystemState = 'not-initialized' | 'repairable' | 'ready' | 'broken';

/**
 * A full system state assessment. Contains the state plus details about
 * what's broken (if anything) and what repairs are needed.
 */
export interface SystemStateAssessment {
  state: SystemState;
  /** What's broken, if anything. Each issue has a suggested auto-repair. */
  issues: SystemIssue[];
  /** The active distro (if any is installed). */
  activeDistro: string | null;
  /** Whether the linuxify user exists inside the distro. */
  linuxifyUserExists: boolean;
  /** Whether ~/.linuxify/state.json exists. */
  stateFileExists: boolean;
  /** Whether bootstrap has ever completed (all 9 markers). */
  bootstrapComplete: boolean;
  /** Assessment took this many milliseconds. */
  durationMs: number;
}

/**
 * A single issue found during assessment, with an optional auto-repair.
 */
export interface SystemIssue {
  /** Stable issue ID. */
  id: string;
  /** Human-readable description. */
  description: string;
  /** Whether this can be auto-repaired safely. */
  autoRepairable: boolean;
  /** The repair action to take (if autoRepairable). */
  repairAction?: 'bootstrap' | 'create-user' | 'install-distro' | 'repair-state';
}

/**
 * Assess the full system state. This is the SINGLE function that determines
 * whether Linuxify is ready to launch, needs repair, or needs bootstrap.
 *
 * Called by the default `linuxify` command (no args) and by `linuxify init`.
 *
 * Never throws — errors are captured as issues.
 */
export async function assessSystemState(): Promise<SystemStateAssessment> {
  const start = Date.now();
  const issues: SystemIssue[] = [];

  const linuxifyHome = getLinuxifyHome();
  const stateFileExists = await exists(join(linuxifyHome, 'state.json'));

  // Check bootstrap markers.
  const bootstrapDir = join(linuxifyHome, '.bootstrap');
  let bootstrapComplete = true;
  for (let i = 0; i <= 8; i++) {
    if (!(await exists(join(bootstrapDir, `stage-${i}.done`)))) {
      bootstrapComplete = false;
      break;
    }
  }

  // Check installed containers.
  const containers = await getInstalledContainers();
  const activeDistro = await getActiveDistro(null);

  // Check linuxify user exists (only if a distro is installed).
  let linuxifyUserExists = false;
  if (activeDistro) {
    try {
      const r = await exec('proot-distro', ['login', activeDistro, '--', 'id', 'linuxify'], { timeoutMs: 15000 });
      linuxifyUserExists = r.exitCode === 0;
    } catch {
      linuxifyUserExists = false;
    }
  }

  // ── Determine state ────────────────────────────────────────────────

  // Not initialized: no state file AND no bootstrap markers.
  if (!stateFileExists && !bootstrapComplete && containers.length === 0) {
    return {
      state: 'not-initialized',
      issues: [],
      activeDistro: null,
      linuxifyUserExists: false,
      stateFileExists: false,
      bootstrapComplete: false,
      durationMs: Date.now() - start,
    };
  }

  // Check for repairable issues.
  if (!bootstrapComplete) {
    issues.push({
      id: 'bootstrap-incomplete',
      description: 'Bootstrap was started but never finished.',
      autoRepairable: true,
      repairAction: 'bootstrap',
    });
  }

  if (containers.length === 0) {
    issues.push({
      id: 'no-distro',
      description: 'No Linux distribution is installed.',
      autoRepairable: true,
      repairAction: 'install-distro',
    });
  } else if (activeDistro && !linuxifyUserExists) {
    issues.push({
      id: 'missing-user',
      description: `The 'linuxify' user is missing inside ${activeDistro}.`,
      autoRepairable: true,
      repairAction: 'create-user',
    });
  }

  if (!stateFileExists && bootstrapComplete) {
    issues.push({
      id: 'missing-state',
      description: 'state.json is missing but bootstrap completed.',
      autoRepairable: true,
      repairAction: 'repair-state',
    });
  }

  // Determine final state.
  let state: SystemState;
  if (issues.length === 0) {
    state = 'ready';
  } else if (issues.every((i) => i.autoRepairable)) {
    state = 'repairable';
  } else {
    state = 'broken';
  }

  logger.info({ state, issueCount: issues.length, activeDistro, linuxifyUserExists }, 'system state assessed');

  return {
    state,
    issues,
    activeDistro,
    linuxifyUserExists,
    stateFileExists,
    bootstrapComplete,
    durationMs: Date.now() - start,
  };
}
