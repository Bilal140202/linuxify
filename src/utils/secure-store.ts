/**
 * Transactional state store with WAL pattern.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Write-ahead log for ACID state management (FIX W6)
 * - Automatic rollback on corruption
 * - Checksum verification for integrity
 */

import { readFile, writeFile, rename, unlink, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { exists } from './fs.js';
import { logger } from './log.js';
import { atomicWriteFile } from './atomic-write.js';

export interface WALEntry {
  readonly timestamp: number;
  readonly operation: string;
  readonly checksum: string;
  readonly data: string;
}

export class TransactionalStateStore<T extends Record<string, unknown>> {
  private readonly statePath: string;
  private readonly walPath: string;
  private readonly backupPath: string;
  private state: T;
  private wal: WALEntry[] = [];

  constructor(statePath: string, defaultState: T) {
    this.statePath = statePath;
    this.walPath = `${statePath}.wal`;
    this.backupPath = `${statePath}.backup`;
    this.state = { ...defaultState };
  }

  /**
   * Load state from disk with WAL replay and integrity verification.
   */
  async load(): Promise<void> {
    // Check for WAL first (recovery from crash)
    if (await exists(this.walPath)) {
      await this.replayWAL();
    }

    if (await exists(this.statePath)) {
      const raw = await readFile(this.statePath, 'utf-8');
      const stored = JSON.parse(raw) as T & { _checksum?: string };

      // Verify checksum if present
      if (stored._checksum) {
        const expected = stored._checksum;
        delete stored._checksum;
        const computed = this.computeChecksum(stored);
        if (computed !== expected) {
          logger.error('State checksum mismatch — attempting recovery from backup');
          await this.recoverFromBackup();
          return;
        }
      }

      this.state = stored as T;
    }
  }

  /**
   * Save state atomically with WAL.
   */
  async save(): Promise<void> {
    // Write WAL entry first
    const data = JSON.stringify(this.state);
    const checksum = this.computeChecksum(this.state);
    const entry: WALEntry = {
      timestamp: Date.now(),
      operation: 'save',
      checksum,
      data,
    };

    this.wal.push(entry);
    await atomicWriteFile(this.walPath, JSON.stringify(this.wal));

    // Create backup of current state
    if (await exists(this.statePath)) {
      await copyFile(this.statePath, this.backupPath);
    }

    // Write new state with checksum
    const stateWithChecksum = { ...this.state, _checksum: checksum };
    await atomicWriteFile(this.statePath, JSON.stringify(stateWithChecksum, null, 2));

    // Clear WAL on successful write
    this.wal = [];
    await unlink(this.walPath).catch(() => { /* ignore */ });
  }

  get(): T {
    return { ...this.state };
  }

  set(partial: Partial<T>): void {
    this.state = { ...this.state, ...partial };
  }

  private computeChecksum(data: unknown): string {
    return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  }

  private async replayWAL(): Promise<void> {
    try {
      const raw = await readFile(this.walPath, 'utf-8');
      const entries = JSON.parse(raw) as WALEntry[];

      for (const entry of entries) {
        const computed = this.computeChecksum(JSON.parse(entry.data));
        if (computed === entry.checksum) {
          this.state = JSON.parse(entry.data) as T;
          logger.info('Replayed WAL entry', { timestamp: entry.timestamp, operation: entry.operation });
        } else {
          logger.warn('WAL entry checksum mismatch — skipping', { timestamp: entry.timestamp });
        }
      }
    } catch (err) {
      logger.error('WAL replay failed', { error: (err as Error).message });
    }
  }

  private async recoverFromBackup(): Promise<void> {
    if (await exists(this.backupPath)) {
      try {
        const raw = await readFile(this.backupPath, 'utf-8');
        this.state = JSON.parse(raw) as T;
        logger.info('Recovered state from backup');
      } catch (err) {
        logger.error('Backup recovery failed', { error: (err as Error).message });
      }
    }
  }
}
