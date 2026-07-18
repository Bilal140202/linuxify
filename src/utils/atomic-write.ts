/**
 * Atomic file write utilities with fsync support.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Proper atomic writes with fsync before rename (FIX C4)
 * - Automatic temp file cleanup on failure
 * - Cross-platform compatibility
 */

import { writeFile, rename, unlink, open, close } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from './log.js';

/**
 * Write data to a file atomically using temp file + fsync + rename.
 *
 * The algorithm:
 * 1. Write to a temp file in the same directory as the target
 * 2. fsync the temp file to ensure data hits the disk
 * 3. fsync the directory to ensure the rename is durable
 * 4. rename() the temp file over the target (atomic on POSIX)
 * 5. Clean up temp file if it still exists
 *
 * @param targetPath - The final file path
 * @param data - The data to write
 * @param options - Optional encoding (default utf-8) and mode
 */
export async function atomicWriteFile(
  targetPath: string,
  data: string | Buffer,
  options: { encoding?: BufferEncoding; mode?: number } = {}
): Promise<void> {
  const dir = dirname(targetPath);
  const tmpName = `.tmp.${randomBytes(8).toString('hex')}.${Date.now()}`;
  const tmpPath = join(dir, tmpName);

  let fd: number | undefined;

  try {
    // Write to temp file
    await writeFile(tmpPath, data, {
      encoding: options.encoding ?? 'utf-8',
      mode: options.mode ?? 0o644,
    });

    // FIX C4: fsync the temp file for durability
    fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();
    fd = undefined;

    // Atomic rename
    await rename(tmpPath, targetPath);

    // fsync the directory to ensure rename is committed
    const dirFd = await open(dir, 'r');
    await dirFd.sync();
    await dirFd.close();

    logger.debug('Atomic write completed', { target: targetPath, tmp: tmpPath });
  } catch (err) {
    // Clean up temp file on any error
    try {
      await unlink(tmpPath);
    } catch { /* temp file may not exist */ }

    if (fd !== undefined) {
      try { await close(fd); } catch { /* ignore */ }
    }

    throw err;
  }
}

/**
 * Create a backup of a file before modifying it.
 *
 * @param filePath - The file to back up
 * @param suffix - Backup suffix (default '.linuxify.bak')
 * @returns The backup file path
 */
export async function createBackup(
  filePath: string,
  suffix = '.linuxify.bak'
): Promise<string> {
  const backupPath = `${filePath}${suffix}`;
  const { copyFile } = await import('node:fs/promises');
  await copyFile(filePath, backupPath);
  logger.info('Created backup', { original: filePath, backup: backupPath });
  return backupPath;
}
