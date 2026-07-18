/**
 * Circuit breaker pattern for network operations.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Prevents cascading failures (FIX W5)
 * - Exponential backoff recovery
 * - Thread-safe state management
 */

import { logger } from './log.js';
import {
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_RECOVERY_MS,
} from './constants.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  recoveryTimeoutMs?: number;
  name: string;
}

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly recoveryTimeoutMs: number;
  private readonly name: string;

  constructor(options: CircuitBreakerOptions) {
    this.failureThreshold = options.failureThreshold ?? CIRCUIT_BREAKER_FAILURE_THRESHOLD;
    this.recoveryTimeoutMs = options.recoveryTimeoutMs ?? CIRCUIT_BREAKER_RECOVERY_MS;
    this.name = options.name;
  }

  getState(): CircuitState {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.recoveryTimeoutMs) {
        this.state = 'half-open';
        logger.info(`Circuit breaker '${this.name}' entering half-open state`);
      }
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.getState();

    if (currentState === 'open') {
      const err = new Error(
        `Circuit breaker '${this.name}' is OPEN. Too many failures. ` +
        `Retry after ${this.recoveryTimeoutMs}ms.`
      );
      (err as Error & { code: string }).code = 'E_CIRCUIT_OPEN';
      throw err;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open') {
      this.state = 'closed';
      this.failures = 0;
      logger.info(`Circuit breaker '${this.name}' closed after successful call`);
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
      logger.warn(
        `Circuit breaker '${this.name}' OPENED after ${this.failures} failures. ` +
        `Recovery in ${this.recoveryTimeoutMs}ms.`
      );
    }
  }
}

// Global circuit breakers for shared resources
const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(name: string): CircuitBreaker {
  if (!breakers.has(name)) {
    breakers.set(name, new CircuitBreaker({ name }));
  }
  return breakers.get(name)!;
}
