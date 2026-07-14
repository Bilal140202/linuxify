import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { EXIT_CODES } from '../../../src/utils/constants.js';
import { createLogger, type Logger } from '../../../src/utils/log.js';

describe('utils/log', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevNodeEnv: string | undefined;
  let prevLogLevel: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'linuxify-log-test-'));
    prevHome = process.env.LINUXIFY_HOME;
    prevNodeEnv = process.env.NODE_ENV;
    prevLogLevel = process.env.LINUXIFY_LOG_LEVEL;
    process.env.LINUXIFY_HOME = tmpHome;
    // Force JSON output so we can parse structured records from the log file.
    process.env.NODE_ENV = 'production';
    process.env.LINUXIFY_LOG_LEVEL = 'debug';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.LINUXIFY_HOME;
    else process.env.LINUXIFY_HOME = prevHome;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (prevLogLevel === undefined) delete process.env.LINUXIFY_LOG_LEVEL;
    else process.env.LINUXIFY_LOG_LEVEL = prevLogLevel;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  const logFilePath = () => path.join(tmpHome, 'logs', 'linuxify.log');

  /** Read all complete JSON lines from the log file, ignoring partial tail. */
  function readLogLines(): Record<string, unknown>[] {
    if (!existsSync(logFilePath())) return [];
    const text = readFileSync(logFilePath(), 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return { _unparseable: l } as Record<string, unknown>;
        }
      });
  }

  it('creates a logger and opens the log file', () => {
    const log = createLogger('test-create');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
    // pino.destination opens the file synchronously at logger creation.
    expect(existsSync(logFilePath())).toBe(true);
    log.info('hello');
    // After a write, the file should still exist and contain the record.
    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
  });

  it('writes messages to the log file', () => {
    const log = createLogger('test-write');
    log.info('a sample message');
    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = lines[lines.length - 1]!;
    expect(last.msg).toBe('a sample message');
    expect(last.name).toBe('test-write');
    expect(last.level).toBe(30); // pino numeric for INFO
  });

  it('redacts known-secret field names', () => {
    const log = createLogger('test-redact');
    log.info({ api_token: 'supersecret', password: 'hunter2', normal: 'ok' }, 'redact test');
    const lines = readLogLines();
    const last = lines[lines.length - 1]!;
    const text = JSON.stringify(last);
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('hunter2');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('ok');
    expect(last.api_token).toBe('[REDACTED]');
    expect(last.password).toBe('[REDACTED]');
    expect(last.normal).toBe('ok');
  });

  it('redacts authorization and cookie headers', () => {
    const log = createLogger('test-headers');
    log.info({ authorization: 'Bearer abc123', cookie: 'session=xyz' }, 'headers');
    const lines = readLogLines();
    const last = lines[lines.length - 1]!;
    expect(last.authorization).toBe('[REDACTED]');
    expect(last.cookie).toBe('[REDACTED]');
  });

  it('respects LINUXIFY_LOG_LEVEL for level filtering', () => {
    process.env.LINUXIFY_LOG_LEVEL = 'warn';
    const log = createLogger('test-level');
    log.info('this should be filtered out');
    log.warn('this should appear');
    log.error('this should also appear');
    const lines = readLogLines();
    const msgs = lines.map((l) => l.msg);
    expect(msgs).not.toContain('this should be filtered out');
    expect(msgs).toContain('this should appear');
    expect(msgs).toContain('this should also appear');
  });

  it('defaults to info level when LINUXIFY_LOG_LEVEL is unset', () => {
    delete process.env.LINUXIFY_LOG_LEVEL;
    const log = createLogger('test-default-level');
    log.debug('debug should be filtered');
    log.info('info should appear');
    const lines = readLogLines();
    const msgs = lines.map((l) => l.msg);
    expect(msgs).not.toContain('debug should be filtered');
    expect(msgs).toContain('info should appear');
  });

  it('accepts both (msg, obj) and (obj, msg) call orders', () => {
    const log = createLogger('test-order');
    log.info('message first', { key: 'v1' });
    log.info({ key: 'v2' }, 'object first');
    const lines = readLogLines();
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const first = lines[lines.length - 2]!;
    const second = lines[lines.length - 1]!;
    expect(first.msg).toBe('message first');
    expect(first.key).toBe('v1');
    expect(second.msg).toBe('object first');
    expect(second.key).toBe('v2');
  });

  it('exposes the configured level as a property', () => {
    process.env.LINUXIFY_LOG_LEVEL = 'error';
    const log: Logger = createLogger('test-level-prop');
    expect(log.level).toBe('error');
  });

  it('supports child loggers with bound fields', () => {
    const log = createLogger('test-child');
    const child = log.child({ subsystem: 'patcher' });
    child.info('child message');
    const lines = readLogLines();
    const last = lines[lines.length - 1]!;
    expect(last.msg).toBe('child message');
    expect(last.subsystem).toBe('patcher');
  });

  it('redacts nested fields matching the patterns', () => {
    const log = createLogger('test-nested');
    log.info({ config: { api_key: 'nested-secret', public: 'visible' } }, 'nested');
    const lines = readLogLines();
    const text = JSON.stringify(lines[lines.length - 1]!);
    expect(text).not.toContain('nested-secret');
    expect(text).toContain('[REDACTED]');
    expect(text).toContain('visible');
  });

  it('EXIT_CODES constant is re-exported and correct', () => {
    expect(EXIT_CODES.OK).toBe(0);
    expect(EXIT_CODES.GENERIC_ERROR).toBe(1);
    expect(EXIT_CODES.NETWORK_ERROR).toBe(10);
    expect(EXIT_CODES.STORAGE_FULL).toBe(20);
    expect(EXIT_CODES.ROOTFS_CORRUPT).toBe(31);
  });
});
