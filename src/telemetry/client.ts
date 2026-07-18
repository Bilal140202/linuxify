/**
 * Telemetry client — opt-in, privacy-preserving event collection.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Bounded queue with LRU eviction (FIX C5)
 * - Redaction at construction time (FIX W4)
 * - Circuit breaker for flush operations (FIX W5)
 * - Daily/burst rate limiting enforced
 */

import { appendFile, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  TELEMETRY_MAX_QUEUE_SIZE,
  TELEMETRY_DAILY_LIMIT,
  TELEMETRY_BURST_LIMIT,
  DEFAULT_NETWORK_TIMEOUT_MS,
  LINUXIFY_VERSION,
} from '../utils/constants.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome } from '../utils/process.js';
import { CircuitBreaker, getCircuitBreaker } from '../utils/circuit-breaker.js';
import { withTimeout } from '../utils/timeout.js';
import type { Config } from '../config/schema.js';

// Redaction patterns applied at CONSTRUCTION time (FIX W4)
const REDACTION_PATTERNS = [
  { pattern: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, replacement: '[REDACTED_CC]' },
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, replacement: '[REDACTED_GH_TOKEN]' },
  { pattern: /sk-[A-Za-z0-9]{48}/g, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[REDACTED_IP]' },
];

interface QueuedEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

interface RateLimitState {
  dailyCount: number;
  dailyReset: number;
  burstCount: number;
  burstReset: number;
}

export class TelemetryClient {
  private enabled = false;
  private queue: QueuedEvent[] = [];
  private rateLimit: RateLimitState;
  private queuePath: string;
  private config: Config['telemetry'];
  private circuitBreaker: CircuitBreaker;

  constructor(config: Config) {
    this.config = config.telemetry;
    this.enabled = config.telemetry.enabled === true && process.env.LINUXIFY_TELEMETRY !== '0';
    this.queuePath = join(getLinuxifyHome(), 'telemetry', 'queue.jsonl');
    this.circuitBreaker = getCircuitBreaker('telemetry-flush');

    this.rateLimit = {
      dailyCount: 0,
      dailyReset: this.getDayStart(),
      burstCount: 0,
      burstReset: Date.now() + 60_000,
    };
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Track an event with pre-construction redaction and rate limiting.
   */
  async track(name: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.enabled) return;

    // FIX W4: Redact at construction time, not post-hoc
    const redactedPayload = this.redactPayload(payload);

    // Check rate limits
    if (!this.checkRateLimits()) {
      return;
    }

    const event: QueuedEvent = {
      id: randomUUID(),
      timestamp: Date.now(),
      name,
      payload: redactedPayload,
    };

    // FIX C5: Bounded queue with LRU eviction
    if (this.queue.length >= TELEMETRY_MAX_QUEUE_SIZE) {
      const evicted = this.queue.shift();
      logger.warn('Telemetry queue full — evicted oldest event', { evictedId: evicted?.id });
    }

    this.queue.push(event);
    this.incrementRateLimits();

    // Persist immediately for durability
    await this.persistQueue();
  }

  /**
   * Flush queue to endpoint with circuit breaker protection.
   */
  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0) return;

    try {
      await this.circuitBreaker.execute(async () => {
        await this.doFlush();
      });
    } catch (err) {
      if ((err as Error & { code?: string }).code === 'E_CIRCUIT_OPEN') {
        logger.warn('Telemetry flush skipped — circuit breaker open');
      } else {
        logger.error('Telemetry flush failed', { error: (err as Error).message });
      }
    }
  }

  private async doFlush(): Promise<void> {
    const events = [...this.queue];
    const endpoint = this.config.endpoint;

    try {
      const response = await withTimeout(
        async (signal) => {
          return fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-ndjson',
              'X-Linuxify-Version': LINUXIFY_VERSION,
            },
            body: events.map(e => JSON.stringify(e)).join('\n'),
            signal,
          });
        },
        DEFAULT_NETWORK_TIMEOUT_MS,
        'telemetry-flush'
      );

      if (response.status === 200) {
        // Success: clear queue
        this.queue = [];
        await this.persistQueue();
        logger.debug('Telemetry flushed', { count: events.length });
      } else if (response.status >= 400 && response.status < 500) {
        // Client error: drop bad data
        logger.warn('Telemetry rejected (4xx) — dropping events', { status: response.status });
        this.queue = [];
        await this.persistQueue();
      } else {
        // Server error: keep for retry
        throw new Error(`Server returned ${response.status}`);
      }
    } catch (err) {
      throw err;
    }
  }

  private redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(payload);
    let redacted = json;
    for (const { pattern, replacement } of REDACTION_PATTERNS) {
      redacted = redacted.replace(pattern, replacement);
    }
    return JSON.parse(redacted);
  }

  private checkRateLimits(): boolean {
    const now = Date.now();

    // Reset daily counter if needed
    if (now >= this.rateLimit.dailyReset) {
      this.rateLimit.dailyCount = 0;
      this.rateLimit.dailyReset = this.getDayStart();
    }

    // Reset burst counter if needed
    if (now >= this.rateLimit.burstReset) {
      this.rateLimit.burstCount = 0;
      this.rateLimit.burstReset = now + 60_000;
    }

    if (this.rateLimit.dailyCount >= TELEMETRY_DAILY_LIMIT) {
      return false;
    }
    if (this.rateLimit.burstCount >= TELEMETRY_BURST_LIMIT) {
      return false;
    }

    return true;
  }

  private incrementRateLimits(): void {
    this.rateLimit.dailyCount++;
    this.rateLimit.burstCount++;
  }

  private getDayStart(): number {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    return now.getTime() + 24 * 60 * 60 * 1000;
  }

  private async persistQueue(): Promise<void> {
    const lines = this.queue.map(e => JSON.stringify(e)).join('\n');
    if (lines) {
      await appendFile(this.queuePath, lines + '\n', { mode: 0o600 });
    }
  }
}
