/**
 * Unit tests for the docker event helpers in `src/telemetry/events.ts`.
 *
 * Verifies each docker telemetry helper produces a {@link TelemetryEvent}
 * with the correct `event_type` and `fields`, and that the envelope is
 * well-formed (UUIDv7 `event_id`, ISO 8601 `timestamp`, non-empty
 * `session_id`, matching `linuxify_version`, `os.arch` populated,
 * `user_id: null`).
 *
 * Also verifies the privacy-structure of each helper: image references and
 * container names are SHA-256 hashed before storage (never present in the
 * JSON serialization of the event); the raw error code is preserved
 * verbatim (it's a stable `E_*` string, not user data); the host port is
 * preserved verbatim (an integer, not personally identifying); setting
 * names in `dockerConfig` are preserved verbatim (internal symbols, not
 * user data).
 *
 * Pattern follows `tests/unit/telemetry/events.test.ts` — no mocking
 * needed; just call the helpers and assert on the returned envelope.
 */

import {
  describe,
  it,
  expect,
} from 'vitest';

import {
  dockerRunStart,
  dockerRunComplete,
  dockerRunFailed,
  dockerPs,
  dockerStop,
  dockerRm,
  dockerClean,
  dockerDoctor,
  dockerConfig,
} from '../../../src/telemetry/events.js';
import type { TelemetryEvent } from '../../../src/telemetry/types.js';
import { LINUXIFY_VERSION } from '../../../src/utils/constants.js';
import { sha256 } from '../../../src/utils/crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that an event's envelope is well-formed: non-empty `event_id`
 * matching the UUIDv7 shape (36-char with dashes; version nibble is 7;
 * variant nibble is 8/9/a/b), parseable ISO `timestamp`, matching
 * `linuxify_version`, non-empty `session_id`, `os.arch` populated, and
 * `user_id: null` (the client fills it in later).
 */
function expectValidEnvelope(event: TelemetryEvent): void {
  expect(event.event_id).toBeTruthy();
  expect(event.event_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  expect(event.linuxify_version).toBe(LINUXIFY_VERSION);
  expect(event.session_id).toBeTruthy();
  expect(event.os.arch).toBeTruthy();
  // user_id is null by default (the client fills it in).
  expect(event.user_id).toBeNull();
}

// ---------------------------------------------------------------------------
// Tests — dockerRunStart (3 tests)
// ---------------------------------------------------------------------------

describe('dockerRunStart', () => {
  it('produces a docker.run_start event with image_hash + runtime + force_pull', () => {
    const event = dockerRunStart('nginx', 'podroid', true);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.run_start');
    expect(event.fields.image_hash).toBe(sha256('nginx'));
    expect(event.fields.runtime).toBe('podroid');
    expect(event.fields.force_pull).toBe(true);
  });

  it('produces different image_hash for different image strings; deterministic for the same image', () => {
    const a = dockerRunStart('nginx', 'podroid', false);
    const b = dockerRunStart('lscr.io/linuxserver/calibre-web:latest', 'podroid', false);
    const c = dockerRunStart('nginx', 'podroid', false);
    expect(a.fields.image_hash).not.toBe(b.fields.image_hash);
    // Same image string → same hash (deterministic).
    expect(a.fields.image_hash).toBe(c.fields.image_hash);
  });

  it('does NOT include the raw image string in the JSON serialization', () => {
    const image = 'lscr.io/linuxserver/calibre-web:latest';
    const event = dockerRunStart(image, 'docker', false);
    const json = JSON.stringify(event);
    expect(json).not.toContain(image);
    // The hash IS present in the JSON.
    expect(json).toContain(event.fields.image_hash as string);
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerRunComplete (3 tests)
// ---------------------------------------------------------------------------

describe('dockerRunComplete', () => {
  it('produces a docker.run_complete event with all 5 fields', () => {
    const event = dockerRunComplete('nginx', 'podroid', 8000, 4280, true);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.run_complete');
    expect(event.fields.image_hash).toBe(sha256('nginx'));
    expect(event.fields.runtime).toBe('podroid');
    expect(event.fields.host_port).toBe(8000);
    expect(event.fields.duration_ms).toBe(4280);
    expect(event.fields.pulled).toBe(true);
  });

  it('host_port is preserved as the integer the caller passed (not hashed)', () => {
    const event = dockerRunComplete('nginx', 'docker', 8080, 1000, false);
    expect(event.fields.host_port).toBe(8080);
    // Integers are not personally identifying — useful for port-range
    // utilization analysis. The host port should appear verbatim in JSON.
    const json = JSON.stringify(event);
    expect(json).toContain('"host_port":8080');
  });

  it('pulled: false is preserved (when image was cached)', () => {
    const event = dockerRunComplete('nginx', 'podroid', 8000, 50, false);
    expect(event.fields.pulled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerRunFailed (3 tests)
// ---------------------------------------------------------------------------

describe('dockerRunFailed', () => {
  it('produces a docker.run_failed event with image_hash + runtime + error_code', () => {
    const event = dockerRunFailed('nginx', 'podroid', 'E_DOCKER_NO_FREE_PORT');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.run_failed');
    expect(event.fields.image_hash).toBe(sha256('nginx'));
    expect(event.fields.runtime).toBe('podroid');
    expect(event.fields.error_code).toBe('E_DOCKER_NO_FREE_PORT');
  });

  it('preserves the error_code verbatim (e.g. E_DOCKER_NO_FREE_PORT)', () => {
    const event = dockerRunFailed('nginx', 'docker', 'E_DOCKER_PULL_FAILED');
    expect(event.fields.error_code).toBe('E_DOCKER_PULL_FAILED');
    // The error code is a stable string, not user data — it appears verbatim.
    const json = JSON.stringify(event);
    expect(json).toContain('E_DOCKER_PULL_FAILED');
  });

  it('does NOT include the raw image string in the JSON; the error code IS present', () => {
    const image = 'lscr.io/linuxserver/calibre-web:latest';
    const event = dockerRunFailed(image, 'podroid', 'E_DOCKER_RUN_FAILED');
    const json = JSON.stringify(event);
    expect(json).not.toContain(image);
    expect(json).toContain('E_DOCKER_RUN_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerPs (2 tests)
// ---------------------------------------------------------------------------

describe('dockerPs', () => {
  it('produces a docker.ps event with container_count + runtime', () => {
    const event = dockerPs(5, 'podroid');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.ps');
    expect(event.fields.container_count).toBe(5);
    expect(event.fields.runtime).toBe('podroid');
  });

  it('preserves container_count: 0 (empty state)', () => {
    const event = dockerPs(0, null);
    expect(event.fields.container_count).toBe(0);
    expect(event.fields.runtime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerStop + dockerRm (4 tests)
// ---------------------------------------------------------------------------

describe('dockerStop', () => {
  it('produces a docker.stop event with name_hash + success=true', () => {
    const event = dockerStop('my-app', true);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.stop');
    expect(event.fields.name_hash).toBe(sha256('my-app'));
    expect(event.fields.success).toBe(true);
  });

  it('produces the same name_hash for the same name; preserves success=false', () => {
    const a = dockerStop('my-app', true);
    const b = dockerStop('my-app', false);
    expect(a.fields.name_hash).toBe(b.fields.name_hash);
    expect(b.fields.success).toBe(false);
  });
});

describe('dockerRm', () => {
  it('produces a docker.rm event with the same shape as docker.stop', () => {
    const event = dockerRm('my-app', true);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.rm');
    expect(event.fields.name_hash).toBe(sha256('my-app'));
    expect(event.fields.success).toBe(true);
    // Same field names as docker.stop (privacy contract: only name_hash + success).
    expect(Object.keys(event.fields).sort()).toEqual(['name_hash', 'success']);
  });
});

describe('dockerStop + dockerRm — privacy', () => {
  it('does NOT include the raw container name in the JSON of either', () => {
    const name = 'my-app-12345';
    const stop = dockerStop(name, true);
    const rm = dockerRm(name, true);
    expect(JSON.stringify(stop)).not.toContain(name);
    expect(JSON.stringify(rm)).not.toContain(name);
    // The hash IS present.
    expect(JSON.stringify(stop)).toContain(stop.fields.name_hash as string);
    expect(JSON.stringify(rm)).toContain(rm.fields.name_hash as string);
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerClean (2 tests)
// ---------------------------------------------------------------------------

describe('dockerClean', () => {
  it('produces a docker.clean event with stopped_count + forwards_removed', () => {
    const event = dockerClean(3, 2);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.clean');
    expect(event.fields.stopped_count).toBe(3);
    expect(event.fields.forwards_removed).toBe(2);
  });

  it('preserves both integers verbatim (including zero)', () => {
    const event = dockerClean(0, 0);
    expect(event.fields.stopped_count).toBe(0);
    expect(event.fields.forwards_removed).toBe(0);
    // They appear verbatim in JSON.
    const json = JSON.stringify(event);
    expect(json).toContain('"stopped_count":0');
    expect(json).toContain('"forwards_removed":0');
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerDoctor (3 tests)
// ---------------------------------------------------------------------------

describe('dockerDoctor', () => {
  it('produces a docker.doctor event with all 4 fields', () => {
    const event = dockerDoctor(true, 5, 1, 'podroid');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.doctor');
    expect(event.fields.initialized).toBe(true);
    expect(event.fields.container_count).toBe(5);
    expect(event.fields.issue_count).toBe(1);
    expect(event.fields.runtime).toBe('podroid');
  });

  it('preserves initialized: false (when subsystem not initialized)', () => {
    const event = dockerDoctor(false, 0, 1, null);
    expect(event.fields.initialized).toBe(false);
    expect(event.fields.container_count).toBe(0);
  });

  it('preserves runtime: null (when runtime is unavailable)', () => {
    const event = dockerDoctor(true, 2, 3, null);
    expect(event.fields.runtime).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — dockerConfig (3 tests)
// ---------------------------------------------------------------------------

describe('dockerConfig', () => {
  it('produces a docker.config event with changed_keys + initialized', () => {
    const event = dockerConfig(['wake_lock_enabled'], true);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('docker.config');
    expect(event.fields.changed_keys).toEqual(['wake_lock_enabled']);
    expect(event.fields.initialized).toBe(true);
  });

  it('preserves changed_keys: [] (edge case)', () => {
    // The engine never actually emits an empty array (the "No changes"
    // path returns early before track()), but the helper itself should
    // still produce a well-formed event if called with [].
    const event = dockerConfig([], false);
    expect(event.fields.changed_keys).toEqual([]);
    expect(event.fields.initialized).toBe(false);
  });

  it('preserves changed_keys with multiple entries verbatim (no hashing of setting names)', () => {
    // Setting names are internal symbols, not user data — they're preserved
    // verbatim (no hashing). This lets the server aggregate by setting.
    const keys = ['wake_lock_enabled', 'port_range'];
    const event = dockerConfig(keys, true);
    expect(event.fields.changed_keys).toBe(keys);
    const json = JSON.stringify(event);
    expect(json).toContain('wake_lock_enabled');
    expect(json).toContain('port_range');
  });
});

// ---------------------------------------------------------------------------
// Tests — envelope well-formedness (2 tests)
// ---------------------------------------------------------------------------

describe('envelope well-formedness', () => {
  it('every docker helper produces an envelope with UUIDv7 event_id + ISO timestamp + matching version + non-empty session_id + os.arch + user_id: null', () => {
    const events: TelemetryEvent[] = [
      dockerRunStart('nginx', 'podroid', false),
      dockerRunComplete('nginx', 'podroid', 8000, 100, true),
      dockerRunFailed('nginx', 'podroid', 'E_DOCKER_RUN_FAILED'),
      dockerPs(0, null),
      dockerStop('nginx', true),
      dockerRm('nginx', true),
      dockerClean(0, 0),
      dockerDoctor(false, 0, 0, null),
      dockerConfig(['wake_lock_enabled'], false),
    ];
    for (const event of events) {
      expectValidEnvelope(event);
    }
  });

  it('session_id is reused across multiple docker events in the same test', () => {
    // The session context is a per-process singleton; events emitted in the
    // same test should share the same session_id.
    const a = dockerRunStart('nginx', 'podroid', false);
    const b = dockerPs(5, 'podroid');
    const c = dockerConfig(['port_range'], true);
    expect(a.session_id).toBe(b.session_id);
    expect(b.session_id).toBe(c.session_id);
    // But each event gets its own event_id.
    expect(a.event_id).not.toBe(b.event_id);
    expect(b.event_id).not.toBe(c.event_id);
  });
});
