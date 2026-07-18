/**
 * Bootstrap stage markers with cryptographic verification.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - SHA256 checksum of stage inputs in marker (FIX W10)
 * - Verify marker integrity on resume
 * - Tamper-evident stage completion
 */

import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import type { StageId } from './types.js';

export interface StageMarker {
  readonly stageId: StageId;
  readonly completedAt: number;
  readonly version: string;
  readonly inputHash: string;  // FIX W10: SHA256 of stage inputs
  readonly durationMs: number;
}

export interface FailedMarker {
  readonly stageId: StageId;
  readonly failedAt: number;
  readonly error: string;
  readonly attempt: number;
}

const MARKER_DIR = '.linuxify';

function markerPath(stageId: StageId, suffix: string): string {
  return join(process.env.HOME ?? '~', MARKER_DIR, `stage-${stageId}${suffix}`);
}

/**
 * Compute SHA256 hash of stage inputs for tamper detection.
 */
function computeInputHash(inputs: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/**
 * Check if a stage is complete with integrity verification.
 */
export async function isStageComplete(stageId: StageId, expectedInputs?: Record<string, unknown>): Promise<boolean> {
  const path = markerPath(stageId, '.done');
  if (!(await exists(path))) {
    return false;
  }

  // FIX W10: Verify marker integrity if inputs provided
  if (expectedInputs) {
    try {
      const raw = await readFile(path, 'utf-8');
      const marker = JSON.parse(raw) as StageMarker;
      const expectedHash = computeInputHash(expectedInputs);

      if (marker.inputHash !== expectedHash) {
        logger.warn(
          `Stage ${stageId} marker hash mismatch — inputs changed since completion. ` +
          `Re-running stage.`,
          { expected: expectedHash, actual: marker.inputHash }
        );
        return false;
      }
    } catch (err) {
      logger.warn(`Stage ${stageId} marker corrupt — re-running`, { error: (err as Error).message });
      return false;
    }
  }

  return true;
}

/**
 * Mark a stage as complete with cryptographic input hash.
 */
export async function markStageComplete(
  stageId: StageId,
  inputs: Record<string, unknown>,
  durationMs: number,
  version: string
): Promise<void> {
  const marker: StageMarker = {
    stageId,
    completedAt: Date.now(),
    version,
    inputHash: computeInputHash(inputs),
    durationMs,
  };

  const path = markerPath(stageId, '.done');
  await atomicWriteFile(path, JSON.stringify(marker, null, 2));
  logger.info(`Stage ${stageId} marked complete`, { inputHash: marker.inputHash });
}

/**
 * Mark a stage as failed.
 */
export async function markStageFailed(stageId: StageId, error: string, attempt: number): Promise<void> {
  const marker: FailedMarker = {
    stageId,
    failedAt: Date.now(),
    error,
    attempt,
  };

  const path = markerPath(stageId, '.failed');
  await atomicWriteFile(path, JSON.stringify(marker, null, 2));
  logger.warn(`Stage ${stageId} marked failed`, { attempt, error });
}

/**
 * Read a done marker.
 */
export async function readDoneMarker(stageId: StageId): Promise<StageMarker | null> {
  const path = markerPath(stageId, '.done');
  if (!(await exists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as StageMarker;
  } catch {
    return null;
  }
}

/**
 * Read a failed marker.
 */
export async function readFailedMarker(stageId: StageId): Promise<FailedMarker | null> {
  const path = markerPath(stageId, '.failed');
  if (!(await exists(path))) return null;
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as FailedMarker;
  } catch {
    return null;
  }
}

/**
 * Clear a stage's markers.
 */
export async function clearStageMarker(stageId: StageId): Promise<void> {
  for (const suffix of ['.done', '.failed']) {
    const path = markerPath(stageId, suffix);
    if (await exists(path)) {
      await unlink(path);
    }
  }
  logger.info(`Stage ${stageId} markers cleared`);
}

/**
 * Clear ALL stage markers (nuclear option).
 */
export async function clearAllStageMarkers(): Promise<void> {
  const stageIds: StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  for (const stageId of stageIds) {
    await clearStageMarker(stageId);
  }
  logger.info('All stage markers cleared');
}
