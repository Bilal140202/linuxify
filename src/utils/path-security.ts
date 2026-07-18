/**
 * Path traversal prevention utilities.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - realpath-based validation (FIX C8)
 * - Unicode normalization protection
 * - Symlink following control
 */

import { resolve, normalize, isAbsolute, relative } from 'node:path';
import { realpath } from 'node:fs/promises';
import { logger } from './log.js';

export class PathSecurityError extends Error {
  readonly code = 'E_PATCH_PATH_OUTSIDE_ROOT';
  constructor(message: string) {
    super(message);
    this.name = 'PathSecurityError';
  }
}

/**
 * Validate that a path does not escape a root directory.
 *
 * Uses realpath to resolve symlinks and normalize to handle Unicode
 * normalization attacks. This is more robust than regex-based checks.
 *
 * @param requestedPath - The path to validate (relative or absolute)
 * @param rootDir - The root directory that must contain the path
 * @returns The resolved, normalized, real path
 * @throws PathSecurityError if the path escapes the root
 */
export async function validatePathWithinRoot(
  requestedPath: string,
  rootDir: string
): Promise<string> {
  // Normalize the root directory
  const resolvedRoot = resolve(rootDir);

  // Resolve the requested path relative to root if not absolute
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(resolvedRoot, requestedPath);

  // Use realpath to resolve symlinks (prevents symlink traversal)
  let realPath: string;
  try {
    realPath = await realpath(candidate);
  } catch {
    // If realpath fails (path doesn't exist), use normalized path
    realPath = normalize(candidate);
  }

  // Normalize Unicode (prevents NFC/NFD attacks)
  const normalizedRoot = resolvedRoot.normalize();
  const normalizedPath = realPath.normalize();

  // Check containment
  const rel = relative(normalizedRoot, normalizedPath);
  if (rel.startsWith('..') || rel === '') {
    throw new PathSecurityError(
      `Path '${requestedPath}' resolves to '${normalizedPath}' which is outside ` +
      `root '${normalizedRoot}'. Possible path traversal attack.`
    );
  }

  logger.debug('Path validated', { requested: requestedPath, resolved: normalizedPath, root: normalizedRoot });
  return normalizedPath;
}

/**
 * Synchronous version for contexts where async is not available.
 * Does NOT resolve symlinks (less secure, use async version when possible).
 */
export function validatePathWithinRootSync(
  requestedPath: string,
  rootDir: string
): string {
  const resolvedRoot = resolve(rootDir);
  const candidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(resolvedRoot, requestedPath);

  const normalizedPath = normalize(candidate).normalize();
  const normalizedRoot = resolvedRoot.normalize();

  const rel = relative(normalizedRoot, normalizedPath);
  if (rel.startsWith('..') || rel === '') {
    throw new PathSecurityError(
      `Path '${requestedPath}' is outside root '${normalizedRoot}' (sync check, symlinks not resolved)`
    );
  }

  return normalizedPath;
}
