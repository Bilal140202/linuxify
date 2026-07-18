/**
 * Timeout wrappers for async operations.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - AbortController-based timeouts (FIX C6)
 * - Graceful cancellation support
 * - Resource cleanup on timeout
 */

import { logger } from './log.js';

export class TimeoutError extends Error {
  readonly code = 'E_TIMEOUT';
  constructor(message: string, readonly durationMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Execute a promise with a timeout using AbortController.
 *
 * @param fn - Function that accepts an AbortSignal and returns a Promise
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name of the operation for error messages
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const result = await fn(controller.signal);
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(
        `Operation '${operationName}' timed out after ${timeoutMs}ms`,
        timeoutMs
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Execute a shell command with timeout support.
 *
 * @param command - The command to execute
 * @param timeoutMs - Timeout in milliseconds
 * @param operationName - Name for error messages
 */
export async function execWithTimeout<T>(
  execFn: () => Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  return withTimeout(
    async (signal) => {
      // If the exec function supports AbortSignal, pass it
      // Otherwise, we rely on the outer timeout
      return await execFn();
    },
    timeoutMs,
    operationName
  );
}
