// src/bootstrap/markers.ts
//
// Marker file helpers for the bootstrap pipeline.
//
// Each stage, on success, writes a `stage-N.done` marker file in
// `~/.linuxify/.bootstrap/`. On failure, it writes `stage-N.failed` with a
// JSON payload describing the error. The orchestrator reads these markers to
// decide which stages to skip (resumability) and which to re-run (`--force`).
//
// Marker file contents are intentionally small JSON blobs — never large — so
// the orchestrator can read them synchronously with negligible cost on every
// `linuxify init` invocation.

import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureDir, exists, readFile, writeFile } from '../utils/fs.js';

import type { StageId } from './types.js';

/**
 * Shape of a `stage-N.done` marker file. Written by the orchestrator after a
 * stage returns `success: true`.
 */
export interface StageDoneMarker {
  /** Stage id (mirrors the filename). */
  readonly stage: StageId;
  /** Stage name (human-readable, for `linuxify status`). */
  readonly name: string;
  /** ISO timestamp of completion. */
  readonly completedAt: string;
  /** Wall-clock duration of the stage in milliseconds. */
  readonly durationMs: number;
  /** Linuxify version that wrote the marker. */
  readonly linuxifyVersion: string;
  /** Optional structured payload (mirror URL, package list, etc.). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Shape of a `stage-N.failed` marker file. Written when a stage returns
 * `success: false` (or when the orchestrator catches an unexpected throw).
 */
export interface StageFailedMarker {
  /** Stage id (mirrors the filename). */
  readonly stage: StageId;
  /** Stage name. */
  readonly name: string;
  /** ISO timestamp of failure. */
  readonly failedAt: string;
  /** Human-readable error message. */
  readonly error: string;
  /** Optional stack trace (for debugging). */
  readonly stack?: string;
  /** Optional structured payload (exit code, stderr tail, etc.). */
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Filename suffix for success markers. */
export const DONE_SUFFIX = '.done';

/** Filename suffix for failure markers. */
export const FAILED_SUFFIX = '.failed';

/**
 * Compute the absolute path of the `.done` marker for a stage.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 * @returns Absolute marker path (e.g. `/home/u/.linuxify/.bootstrap/stage-3.done`).
 */
export function doneMarkerPath(markersDir: string, stageId: StageId): string {
  return join(markersDir, `stage-${stageId}${DONE_SUFFIX}`);
}

/**
 * Compute the absolute path of the `.failed` marker for a stage.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 * @returns Absolute marker path (e.g. `/home/u/.linuxify/.bootstrap/stage-3.failed`).
 */
export function failedMarkerPath(markersDir: string, stageId: StageId): string {
  return join(markersDir, `stage-${stageId}${FAILED_SUFFIX}`);
}

/**
 * Check whether a stage's `.done` marker exists.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 * @returns `true` if the `.done` marker is present.
 */
export async function isStageComplete(
  markersDir: string,
  stageId: StageId,
): Promise<boolean> {
  return exists(doneMarkerPath(markersDir, stageId));
}

/**
 * Read and parse a stage's `.done` marker. Returns `null` if the marker is
 * absent or unparseable (defensive — a corrupt marker should not crash the
 * orchestrator; the orchestrator will simply re-run the stage).
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 */
export async function readDoneMarker(
  markersDir: string,
  stageId: StageId,
): Promise<StageDoneMarker | null> {
  const path = doneMarkerPath(markersDir, stageId);
  try {
    const raw = await readFile(path);
    return JSON.parse(raw) as StageDoneMarker;
  } catch {
    return null;
  }
}

/**
 * Read and parse a stage's `.failed` marker. Returns `null` if absent or
 * unparseable.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 */
export async function readFailedMarker(
  markersDir: string,
  stageId: StageId,
): Promise<StageFailedMarker | null> {
  const path = failedMarkerPath(markersDir, stageId);
  try {
    const raw = await readFile(path);
    return JSON.parse(raw) as StageFailedMarker;
  } catch {
    return null;
  }
}

/**
 * Write a `.done` marker for a stage. Ensures the markers directory exists.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param marker - Marker payload.
 */
export async function markStageComplete(
  markersDir: string,
  marker: StageDoneMarker,
): Promise<void> {
  await ensureDir(markersDir);
  // Remove any stale .failed marker left by a previous run.
  await clearStageMarker(markersDir, marker.stage);
  await writeFile(doneMarkerPath(markersDir, marker.stage), JSON.stringify(marker, null, 2));
}

/**
 * Write a `.failed` marker for a stage.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param marker - Marker payload.
 */
export async function markStageFailed(
  markersDir: string,
  marker: StageFailedMarker,
): Promise<void> {
  await ensureDir(markersDir);
  // Remove any stale .done marker so the next run re-executes this stage.
  await removeFile(doneMarkerPath(markersDir, marker.stage));
  await writeFile(failedMarkerPath(markersDir, marker.stage), JSON.stringify(marker, null, 2));
}

/**
 * Remove both `.done` and `.failed` markers for a stage. Used by `--force`
 * and by retry logic. Silently no-ops if neither marker exists.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 * @param stageId - Numeric stage id.
 */
export async function clearStageMarker(
  markersDir: string,
  stageId: StageId,
): Promise<void> {
  await removeFile(doneMarkerPath(markersDir, stageId));
  await removeFile(failedMarkerPath(markersDir, stageId));
}

/**
 * Remove all stage markers (0 through 8). Used by `--force` before the
 * pipeline starts. The `markersDir` itself is preserved so subsequent writes
 * do not need to re-`mkdir`.
 *
 * @param markersDir - Absolute path to `~/.linuxify/.bootstrap/`.
 */
export async function clearAllStageMarkers(markersDir: string): Promise<void> {
  const stageIds: StageId[] = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  await Promise.all(stageIds.map((id) => clearStageMarker(markersDir, id)));
}

/**
 * Best-effort `unlink`. Swallows ENOENT (file does not exist) and re-throws
 * other errors. We rely on the `fs` util's `exists` check first to avoid a
 * race-condition log warning on common paths.
 */
async function removeFile(path: string): Promise<void> {
  if (!(await exists(path))) return;
  await unlink(path).catch(() => {
    /* swallow — best-effort cleanup */
  });
}
