/**
 * Unit tests for `src/telemetry/events.ts` (event constructor helpers).
 *
 * Verifies each helper produces a {@link TelemetryEvent} with the correct
 * `event_type` and `fields`, and that the envelope is well-formed
 * (UUIDv7 `event_id`, ISO 8601 `timestamp`, non-empty `session_id`,
 * `linuxify_version` matching the constant, `os.arch` populated).
 *
 * The privacy-structure of the helpers is also tested: `cliInvoked`
 * accepts only the command name (not args), and `errorThrown` accepts
 * only the error code (not the message).
 */

import { describe, it, expect } from 'vitest';

import {
  bootstrapStart,
  bootstrapStageComplete,
  packageInstallStart,
  packageInstallComplete,
  doctorRunComplete,
  cliInvoked,
  errorThrown,
} from '../../../src/telemetry/events.js';
import type { TelemetryEvent } from '../../../src/telemetry/types.js';
import { LINUXIFY_VERSION } from '../../../src/utils/constants.js';
import { sha256 } from '../../../src/utils/crypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assert that an event's envelope is well-formed: non-empty `event_id`,
 * parseable ISO `timestamp`, matching `linuxify_version`, non-empty
 * `session_id`, and `os.arch` populated.
 */
function expectValidEnvelope(event: TelemetryEvent): void {
  expect(event.event_id).toBeTruthy();
  expect(event.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(() => new Date(event.timestamp).toISOString()).not.toThrow();
  expect(event.linuxify_version).toBe(LINUXIFY_VERSION);
  expect(event.session_id).toBeTruthy();
  expect(event.os.arch).toBeTruthy();
  // user_id is null by default (the client fills it in).
  expect(event.user_id).toBeNull();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrapStart', () => {
  it('produces a bootstrap.start event with default fields', () => {
    const event = bootstrapStart();
    expectValidEnvelope(event);
    expect(event.event_type).toBe('bootstrap.start');
    expect(event.fields.stages_planned).toBe(9);
    expect(event.fields.resume).toBe(false);
    expect(event.fields.from_bundle).toBe(false);
  });

  it('accepts custom arguments', () => {
    const event = bootstrapStart(7, true, true);
    expect(event.fields.stages_planned).toBe(7);
    expect(event.fields.resume).toBe(true);
    expect(event.fields.from_bundle).toBe(true);
  });
});

describe('bootstrapStageComplete', () => {
  it('produces a bootstrap.stage_complete event with stage and duration', () => {
    const event = bootstrapStageComplete(2, 42180);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('bootstrap.stage_complete');
    expect(event.fields.stage).toBe(2);
    expect(event.fields.duration_ms).toBe(42180);
    expect(event.fields.stage_name).toBeNull();
  });

  it('accepts an optional stage name', () => {
    const event = bootstrapStageComplete(0, 412, 'preflight');
    expect(event.fields.stage_name).toBe('preflight');
  });
});

describe('packageInstallStart', () => {
  it('produces a package.install_start event with hashed package name', () => {
    const event = packageInstallStart('cline', '1.2.0');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('package.install_start');
    expect(event.fields.package_hash).toBe(sha256('cline'));
    expect(event.fields.version).toBe('1.2.0');
  });

  it('produces different hashes for different package names', () => {
    const a = packageInstallStart('cline', '1.0.0');
    const b = packageInstallStart('codex', '1.0.0');
    expect(a.fields.package_hash).not.toBe(b.fields.package_hash);
  });

  it('does NOT include the raw package name', () => {
    const event = packageInstallStart('cline', '1.2.0');
    // The raw name should not appear in the event JSON.
    const json = JSON.stringify(event);
    expect(json).not.toContain('"cline"');
  });
});

describe('packageInstallComplete', () => {
  it('produces a package.install_complete event with duration and patch count', () => {
    const event = packageInstallComplete('cline', '1.2.0', 4280, 2);
    expectValidEnvelope(event);
    expect(event.event_type).toBe('package.install_complete');
    expect(event.fields.package_hash).toBe(sha256('cline'));
    expect(event.fields.version).toBe('1.2.0');
    expect(event.fields.duration_ms).toBe(4280);
    expect(event.fields.patches_applied).toBe(2);
  });

  it('defaults patches_applied to 0', () => {
    const event = packageInstallComplete('cline', '1.2.0', 4280);
    expect(event.fields.patches_applied).toBe(0);
  });
});

describe('doctorRunComplete', () => {
  it('produces a doctor.run_complete event with aggregate counts', () => {
    const event = doctorRunComplete(
      { ok: 14, warn: 1, fail: 0, missing: 1 },
      1842,
    );
    expectValidEnvelope(event);
    expect(event.event_type).toBe('doctor.run_complete');
    expect(event.fields.duration_ms).toBe(1842);
    expect(event.fields.pass_count).toBe(14);
    expect(event.fields.warn_count).toBe(1);
    expect(event.fields.fail_count).toBe(0);
    expect(event.fields.missing_count).toBe(1);
  });

  it('does NOT include check names or check details', () => {
    const event = doctorRunComplete({ ok: 14, warn: 1, fail: 0, missing: 1 }, 1842);
    const json = JSON.stringify(event);
    expect(json).not.toContain('check_name');
    expect(json).not.toContain('check_detail');
  });
});

describe('cliInvoked', () => {
  it('produces a cli.invoked event with the command name', () => {
    const event = cliInvoked('add');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('cli.invoked');
    expect(event.fields.command).toBe('add');
  });

  it('accepts an optional duration_ms', () => {
    const event = cliInvoked('doctor', 4280);
    expect(event.fields.command).toBe('doctor');
    expect(event.fields.duration_ms).toBe(4280);
  });

  it('does NOT accept args (privacy property in the signature)', () => {
    // TypeScript enforces this — the function takes only (command, durationMs?).
    // We verify at runtime that no args field is present.
    const event = cliInvoked('run');
    expect(event.fields.args).toBeUndefined();
    expect(event.fields.argv).toBeUndefined();
  });
});

describe('errorThrown', () => {
  it('produces an error.thrown event with the error code', () => {
    const event = errorThrown('E_PATCH_VERIFY_FAILED');
    expectValidEnvelope(event);
    expect(event.event_type).toBe('error.thrown');
    expect(event.fields.error_code).toBe('E_PATCH_VERIFY_FAILED');
  });

  it('accepts optional command and exit_code', () => {
    const event = errorThrown('E_PATCH_VERIFY_FAILED', 'add', 4);
    expect(event.fields.error_code).toBe('E_PATCH_VERIFY_FAILED');
    expect(event.fields.command).toBe('add');
    expect(event.fields.exit_code).toBe(4);
  });

  it('does NOT accept an error message (privacy property in the signature)', () => {
    // TypeScript enforces this — the function takes only (code, command?, exitCode?).
    // We verify at runtime that no message field is present.
    const event = errorThrown('E_FOO');
    expect(event.fields.message).toBeUndefined();
    expect(event.fields.error_message).toBeUndefined();
    expect(event.fields.stack).toBeUndefined();
  });
});

describe('session context', () => {
  it('reuses the same session_id across multiple events', () => {
    const a = bootstrapStart();
    const b = bootstrapStageComplete(0, 100);
    const c = cliInvoked('doctor');
    expect(a.session_id).toBe(b.session_id);
    expect(b.session_id).toBe(c.session_id);
  });

  it('uses a fresh event_id per event', () => {
    const a = bootstrapStart();
    const b = bootstrapStart();
    expect(a.event_id).not.toBe(b.event_id);
  });
});
