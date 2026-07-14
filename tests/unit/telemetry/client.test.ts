/**
 * Unit tests for `src/telemetry/client.ts` (the `TelemetryClient` class).
 *
 * These tests exercise the client against the real `src/utils/` modules
 * (fs, crypto, process, constants) — only the logger is mocked (pino's
 * lazy initializer is flaky under vitest's stdio capture; this matches
 * the pattern in `tests/unit/state/store.test.ts`). Each test gets a
 * fresh tmpdir via `mkdtemp` and points `LINUXIFY_HOME` at it so the
 * queue file lands inside the tmpdir.
 *
 * The `LINUXIFY_TELEMETRY=0` env var is set globally in `tests/setup.ts`;
 * tests that need an enabled client must unset it (or set it to `'1'`)
 * for the duration of the test, then restore it in `afterEach`.
 *
 * `fetch` is mocked via `vi.stubGlobal` so the flush tests don't make
 * real network requests.
 */

import { appendFileSync } from 'node:fs';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger — pino's lazy initializer crashes under vitest's stdio
// capture (same pattern as tests/unit/state/store.test.ts).
vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import { DEFAULT_CONFIG } from '../../../src/config/index.js';
import type { Config } from '../../../src/config/index.js';
import { StateStore, defaultState } from '../../../src/state/index.js';
import { TelemetryClient, shouldSample } from '../../../src/telemetry/client.js';
import type { TelemetryEvent } from '../../../src/telemetry/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a config with telemetry enabled (caller must also clear LINUXIFY_TELEMETRY). */
function enabledConfig(overrides: Partial<Config['telemetry']> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    telemetry: {
      ...DEFAULT_CONFIG.telemetry,
      enabled: true,
      endpoint: 'https://telemetry.test.local/v2',
      sample_rate: 1.0,
      ...overrides,
    },
  };
}

/** Read the queue file and parse each non-empty line as JSON. */
async function readQueue(queuePath: string): Promise<TelemetryEvent[]> {
  try {
    const text = await readFile(queuePath, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as TelemetryEvent);
  } catch {
    return [];
  }
}

/** Returns the low 9 bits of the file mode (the permission bits). */
async function fileMode(path: string): Promise<number> {
  const s = await stat(path);
  return s.mode & 0o777;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryClient', () => {
  let tmpDir: string;
  let queuePath: string;
  let stateStore: StateStore;
  let originalLinuxifyHome: string | undefined;
  let originalLinuxifyTelemetry: string | undefined;

  beforeEach(async () => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    originalLinuxifyTelemetry = process.env.LINUXIFY_TELEMETRY;
    tmpDir = await mkdtemp(join(tmpdir(), 'linuxify-telemetry-'));
    process.env.LINUXIFY_HOME = tmpDir;
    queuePath = join(tmpDir, 'telemetry', 'queue.jsonl');
    stateStore = new StateStore(join(tmpDir, 'state.json'));
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) delete process.env.LINUXIFY_HOME;
    else process.env.LINUXIFY_HOME = originalLinuxifyHome;
    if (originalLinuxifyTelemetry === undefined) delete process.env.LINUXIFY_TELEMETRY;
    else process.env.LINUXIFY_TELEMETRY = originalLinuxifyTelemetry;
    vi.unstubAllGlobals();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // isEnabled()
  // -------------------------------------------------------------------------

  describe('isEnabled()', () => {
    it('returns false when config.telemetry.enabled is false', () => {
      delete process.env.LINUXIFY_TELEMETRY;
      const client = new TelemetryClient({
        config: DEFAULT_CONFIG,
        stateStore,
        queuePath,
      });
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when LINUXIFY_TELEMETRY=0 even if config enables it', () => {
      process.env.LINUXIFY_TELEMETRY = '0';
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      expect(client.isEnabled()).toBe(false);
    });

    it('returns true when config enables it and env var is not 0', () => {
      delete process.env.LINUXIFY_TELEMETRY;
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      expect(client.isEnabled()).toBe(true);
    });

    it('returns true when config enables it and env var is "1"', () => {
      process.env.LINUXIFY_TELEMETRY = '1';
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      expect(client.isEnabled()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // track() — disabled
  // -------------------------------------------------------------------------

  describe('track() — disabled', () => {
    it('does nothing when disabled (no queue file created)', () => {
      process.env.LINUXIFY_TELEMETRY = '0';
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      const result = client.track('bootstrap.start', { stages_planned: 9 });
      expect(result).toBe(false);
    });

    it('does nothing when config has telemetry.enabled=false', () => {
      delete process.env.LINUXIFY_TELEMETRY;
      const client = new TelemetryClient({
        config: DEFAULT_CONFIG,
        stateStore,
        queuePath,
      });
      const result = client.track('cli.invoked', { command: 'doctor' });
      expect(result).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // track() — enabled
  // -------------------------------------------------------------------------

  describe('track() — enabled', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('writes the event to the queue file', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      const result = client.track('bootstrap.start', { stages_planned: 9 });
      expect(result).toBe(true);

      const events = await readQueue(queuePath);
      expect(events).toHaveLength(1);
      expect(events[0]!.event_type).toBe('bootstrap.start');
      expect(events[0]!.fields.stages_planned).toBe(9);
      expect(events[0]!.event_id).toBeTruthy();
      expect(events[0]!.timestamp).toBeTruthy();
      expect(events[0]!.session_id).toBeTruthy();
      expect(events[0]!.os.arch).toBeTruthy();
    });

    it('writes the queue file with mode 0600', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      expect(await fileMode(queuePath)).toBe(0o600);
    });

    it('redacts sensitive fields before writing', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('cli.invoked', {
        command: 'add',
        api_token: 'sk-secret',
        path: '/etc/passwd',
      });
      const events = await readQueue(queuePath);
      expect(events[0]!.fields.api_token).toBe('***REDACTED***');
      expect(events[0]!.fields.path).toBe('<path>');
      expect(events[0]!.fields.command).toBe('add');
    });

    it('appends multiple events as separate JSONL lines', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', { stages_planned: 9 });
      client.track('bootstrap.stage_complete', { stage: 0, duration_ms: 412 });
      client.track('bootstrap.complete', { total_duration_ms: 824000 });
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(3);
      expect(events[0]!.event_type).toBe('bootstrap.start');
      expect(events[1]!.event_type).toBe('bootstrap.stage_complete');
      expect(events[2]!.event_type).toBe('bootstrap.complete');
    });

    it('uses the same session_id across events from one client', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      client.track('bootstrap.complete', {});
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(2);
      expect(events[0]!.session_id).toBe(events[1]!.session_id);
    });

    it('uses different event_ids for each event', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      client.track('bootstrap.complete', {});
      const events = await readQueue(queuePath);
      expect(events[0]!.event_id).not.toBe(events[1]!.event_id);
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('drops events beyond the per-minute limit (100/min)', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      let accepted = 0;
      // 105 events — first 100 accepted, last 5 dropped.
      for (let i = 0; i < 105; i++) {
        if (client.track('bootstrap.stage_complete', { stage: i, duration_ms: 1 })) {
          accepted++;
        }
      }
      expect(accepted).toBe(100);
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(100);
    });

    it('does not drop low-volume event types under normal load', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      // 50 events — all should be accepted (under 100/min).
      for (let i = 0; i < 50; i++) {
        client.track('bootstrap.stage_complete', { stage: i, duration_ms: 1 });
      }
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(50);
    });
  });

  // -------------------------------------------------------------------------
  // Sampling
  // -------------------------------------------------------------------------

  describe('sampling', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('drops all cli.invoked events when sample_rate is 0', async () => {
      const client = new TelemetryClient({
        config: enabledConfig({ sample_rate: 0 }),
        stateStore,
        queuePath,
      });
      for (let i = 0; i < 20; i++) {
        client.track('cli.invoked', { command: 'doctor' });
      }
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(0);
    });

    it('keeps all cli.invoked events when sample_rate is 1', async () => {
      const client = new TelemetryClient({
        config: enabledConfig({ sample_rate: 1 }),
        stateStore,
        queuePath,
      });
      for (let i = 0; i < 20; i++) {
        client.track('cli.invoked', { command: 'doctor' });
      }
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(20);
    });

    it('does not sample non-cli.invoked events even at sample_rate=0', async () => {
      const client = new TelemetryClient({
        config: enabledConfig({ sample_rate: 0 }),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', { stages_planned: 9 });
      client.track('error.thrown', { error_code: 'E_FOO' });
      const events = await readQueue(queuePath);
      expect(events).toHaveLength(2);
    });

    it('shouldSample is deterministic per event_id', () => {
      const eventId = '01901770-0000-7000-8000-000000000abc';
      const a = shouldSample(eventId, 0.5);
      const b = shouldSample(eventId, 0.5);
      expect(a).toBe(b);
    });

    it('shouldSample at rate 0 always returns false', () => {
      expect(shouldSample('any-id', 0)).toBe(false);
    });

    it('shouldSample at rate 1 always returns true', () => {
      expect(shouldSample('any-id', 1)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // show()
  // -------------------------------------------------------------------------

  describe('show()', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('returns an empty array when the queue file does not exist', () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      expect(client.show()).toEqual([]);
    });

    it('returns the queued events', () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      client.track('bootstrap.complete', {});
      const events = client.show();
      expect(events).toHaveLength(2);
    });

    it('skips unparseable lines', () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      // Append a corrupt line manually.
      appendFileSync(queuePath, '{ not valid json\n', 'utf8');
      const events = client.show();
      expect(events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // purge()
  // -------------------------------------------------------------------------

  describe('purge()', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('deletes the queue file', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.purge();
      expect(client.show()).toEqual([]);
    });

    it('is idempotent when the queue file does not exist', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await expect(client.purge()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // export()
  // -------------------------------------------------------------------------

  describe('export()', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('returns the queue as a pretty-printed JSON string', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', { stages_planned: 9 });
      const json = await client.export();
      const parsed = JSON.parse(json) as TelemetryEvent[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.event_type).toBe('bootstrap.start');
    });

    it('returns an empty array when the queue is empty', async () => {
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      const json = await client.export();
      expect(JSON.parse(json)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // flush()
  // -------------------------------------------------------------------------

  describe('flush()', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('does nothing when the queue is empty', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await client.flush();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('POSTs the queue to <endpoint>/events as NDJSON', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', { stages_planned: 9 });
      await client.flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0]!;
      expect(call[0]).toBe('https://telemetry.test.local/v2/events');
      const init = call[1] as RequestInit;
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-ndjson',
      );
      const body = init.body as string;
      expect(body.split('\n').filter((l) => l.trim())).toHaveLength(1);
    });

    it('clears the queue on 200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      client.track('bootstrap.complete', {});
      await client.flush();
      expect(client.show()).toEqual([]);
    });

    it('updates state.telemetry.last_flush on 200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 200 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      // Pre-populate state so update() can mutate it.
      await stateStore.save(defaultState());

      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();

      const state = await stateStore.load();
      expect(state.telemetry.last_flush).not.toBeNull();
    });

    it('clears the queue on 4xx (does not retry bad data)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 400 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(client.show()).toEqual([]);
    });

    it('clears the queue on 429 (server-side rate limit)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 429 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(client.show()).toEqual([]);
    });

    it('retries on 5xx with exponential backoff (up to 3 retries)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 500 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      // 1 initial + 3 retries = 4 calls.
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('keeps the queue when all 5xx retries fail', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(null, { status: 503 }),
      );
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      expect(client.show()).toHaveLength(1);
    });

    it('clears the queue when a 5xx retry succeeds', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(client.show()).toEqual([]);
    });

    it('keeps the queue on network error (fetch throws)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      vi.stubGlobal('fetch', fetchMock);
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      client.track('bootstrap.start', {});
      await client.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(client.show()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // init()
  // -------------------------------------------------------------------------

  describe('init()', () => {
    beforeEach(() => {
      delete process.env.LINUXIFY_TELEMETRY;
    });

    it('generates a user_id on first enable if state.telemetry.user_id is null', async () => {
      await stateStore.save(defaultState());
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await client.init();
      const state = await stateStore.load();
      expect(state.telemetry.user_id).not.toBeNull();
      expect(state.telemetry.enabled).toBe(true);
    });

    it('preserves an existing user_id', async () => {
      const existing = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const s = defaultState();
      s.telemetry.user_id = existing;
      s.telemetry.enabled = true;
      await stateStore.save(s);

      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await client.init();
      const state = await stateStore.load();
      expect(state.telemetry.user_id).toBe(existing);
    });

    it('does not generate a user_id when telemetry is disabled', async () => {
      process.env.LINUXIFY_TELEMETRY = '0';
      await stateStore.save(defaultState());
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await client.init();
      const state = await stateStore.load();
      expect(state.telemetry.user_id).toBeNull();
    });

    it('is idempotent (subsequent calls do not regenerate user_id)', async () => {
      await stateStore.save(defaultState());
      const client = new TelemetryClient({
        config: enabledConfig(),
        stateStore,
        queuePath,
      });
      await client.init();
      const firstId = (await stateStore.load()).telemetry.user_id;
      await client.init();
      const secondId = (await stateStore.load()).telemetry.user_id;
      expect(firstId).toBe(secondId);
    });
  });
});
