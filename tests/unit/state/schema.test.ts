/**
 * Unit tests for `src/state/schema.ts`.
 *
 * These tests exercise the Zod schema in isolation — no filesystem, no utils,
 * no mocks. The goal is to verify that:
 *  1. A fully-populated, well-formed State document parses successfully.
 *  2. Each documented rejection case (missing field, wrong type, bad hash,
 *     bad datetime, unknown key, wrong schema_version) is caught.
 *  3. Edge cases (empty `active_distro`, null telemetry fields, empty arrays)
 *     are accepted.
 */

import { describe, it, expect } from 'vitest';

import {
  StateSchema,
  DistroInstallSchema,
  RuntimeInstallSchema,
  PackageInstallSchema,
  PatchApplicationSchema,
  BootstrapProgressSchema,
  TelemetrySchema,
  PluginInstallSchema,
  type State,
} from '../../../src/state/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A 64-character lowercase hex string, valid as a SHA-256 digest. */
const SHA256 = 'a'.repeat(64);

/** A valid ISO 8601 datetime string accepted by `z.string().datetime()`. */
const ISO = '2025-04-10T14:23:14Z';

/** Returns a deep copy of a valid, fully-populated State object. */
function validState(): State {
  return {
    schema_version: 1,
    linuxify_version: '0.1.0-alpha.1',
    active_distro: 'ubuntu',
    installed_distros: [
      {
        name: 'ubuntu',
        version: '24.04',
        installed_at: ISO,
        rootfs_sha256: SHA256,
      },
    ],
    installed_runtimes: [
      {
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/home/u/.linuxify/runtimes/ubuntu/node/22.11.0',
        installed_at: ISO,
        is_default: true,
      },
    ],
    installed_packages: [
      {
        name: 'cline',
        version: '1.2.0',
        distro: 'ubuntu',
        runtime: 'node',
        runtime_version: '22.11.0',
        install_date: ISO,
        launcher_path: '/home/u/.linuxify/bin/cline',
        patches_applied: ['cline-001', 'cline-002'],
      },
    ],
    applied_patches: [
      {
        patch_id: 'cline-001',
        package: 'cline',
        applied_at: ISO,
        applied_to_file: '/usr/lib/node_modules/cline/dist/platform.js',
        original_hash: SHA256,
        patched_hash: SHA256,
        rollback_path: '/home/u/.linuxify/patches/cline/backups/cline-001.orig',
        verified: true,
      },
    ],
    bootstrap_progress: {
      current_stage: 8,
      completed_stages: [0, 1, 2, 3, 4, 5, 6, 7, 8],
      failed_stage: null,
      error: null,
      started_at: ISO,
      last_updated_at: ISO,
    },
    last_doctor_run: {
      timestamp: ISO,
      all_ok: true,
    },
    telemetry: {
      user_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      enabled: true,
      last_flush: ISO,
    },
    plugins: [
      {
        name: 'telemetry-pretty',
        version: '0.1.0',
        source: 'registry://telemetry-pretty@0.1.0',
        installed_at: ISO,
        enabled: true,
        hooks_used: ['telemetry.flush'],
      },
    ],
    created_at: ISO,
    updated_at: ISO,
  };
}

// ---------------------------------------------------------------------------
// StateSchema — valid cases
// ---------------------------------------------------------------------------

describe('StateSchema — valid inputs', () => {
  it('accepts a fully-populated state document', () => {
    const result = StateSchema.safeParse(validState());
    expect(result.success).toBe(true);
  });

  it('accepts a minimal state with empty arrays and null optionals', () => {
    const minimal: State = {
      schema_version: 1,
      linuxify_version: '0.1.0',
      active_distro: '',
      installed_distros: [],
      installed_runtimes: [],
      installed_packages: [],
      applied_patches: [],
      bootstrap_progress: {
        current_stage: 0,
        completed_stages: [],
        failed_stage: null,
        error: null,
        started_at: ISO,
        last_updated_at: ISO,
      },
      last_doctor_run: null,
      telemetry: {
        user_id: null,
        enabled: false,
        last_flush: null,
      },
      plugins: [],
      created_at: ISO,
      updated_at: ISO,
    };
    const result = StateSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });

  it('accepts a failed bootstrap_progress with a non-null error and failed_stage', () => {
    const state = validState();
    state.bootstrap_progress = {
      current_stage: 4,
      completed_stages: [0, 1, 2, 3],
      failed_stage: 4,
      error: 'E_BOOTSTRAP_ROOTFS_DOWNLOAD_FAILED',
      started_at: ISO,
      last_updated_at: ISO,
    };
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('accepts a state with telemetry disabled and user_id null', () => {
    const state = validState();
    state.telemetry = { user_id: null, enabled: false, last_flush: null };
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// StateSchema — invalid cases
// ---------------------------------------------------------------------------

describe('StateSchema — invalid inputs', () => {
  it('rejects a wrong schema_version', () => {
    const state = validState();
    (state as unknown as { schema_version: number }).schema_version = 2;
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a missing required field (linuxify_version)', () => {
    const state = validState();
    delete (state as Partial<State>).linuxify_version;
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict mode)', () => {
    const state = validState() as State & { extra_field?: unknown };
    state.extra_field = 'should not be here';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a non-string active_distro', () => {
    const state = validState();
    (state as unknown as { active_distro: number }).active_distro = 42;
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a bad SHA-256 hash in installed_distros', () => {
    const state = validState();
    state.installed_distros[0]!.rootfs_sha256 = 'not-a-hash';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a malformed datetime in created_at', () => {
    const state = validState();
    state.created_at = '2025-04-10 14:23:14';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a non-array installed_packages', () => {
    const state = validState();
    (state as unknown as { installed_packages: string }).installed_packages = 'cline';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean verified in applied_patches', () => {
    const state = validState();
    state.applied_patches[0]!.verified = 'yes';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a negative current_stage', () => {
    const state = validState();
    state.bootstrap_progress.current_stage = -1;
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a non-null non-number failed_stage', () => {
    const state = validState();
    (state.bootstrap_progress as unknown as { failed_stage: string }).failed_stage = 'oops';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects an empty-string error (min(1) constraint)', () => {
    const state = validState();
    state.bootstrap_progress.failed_stage = 2;
    state.bootstrap_progress.error = '';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean telemetry.enabled', () => {
    const state = validState();
    (state.telemetry as unknown as { enabled: string }).enabled = 'true';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key in a nested object (strict mode)', () => {
    const state = validState();
    const patched = state.telemetry as State['telemetry'] & { extra?: unknown };
    patched.extra = 'nope';
    const result = StateSchema.safeParse(state);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sub-schema smoke tests
// ---------------------------------------------------------------------------

describe('Sub-schemas', () => {
  it('DistroInstallSchema accepts a valid entry', () => {
    expect(
      DistroInstallSchema.safeParse({
        name: 'ubuntu',
        version: '24.04',
        installed_at: ISO,
        rootfs_sha256: SHA256,
      }).success,
    ).toBe(true);
  });

  it('RuntimeInstallSchema rejects a missing is_default', () => {
    expect(
      RuntimeInstallSchema.safeParse({
        name: 'node',
        version: '22.11.0',
        distro: 'ubuntu',
        path: '/x',
        installed_at: ISO,
      }).success,
    ).toBe(false);
  });

  it('PackageInstallSchema accepts an empty patches_applied array', () => {
    expect(
      PackageInstallSchema.safeParse({
        name: 'codex',
        version: '0.20.1',
        distro: 'ubuntu',
        runtime: 'node',
        runtime_version: '22.11.0',
        install_date: ISO,
        launcher_path: '/x/codex',
        patches_applied: [],
      }).success,
    ).toBe(true);
  });

  it('PatchApplicationSchema rejects a bad patched_hash', () => {
    expect(
      PatchApplicationSchema.safeParse({
        patch_id: 'cline-001',
        package: 'cline',
        applied_at: ISO,
        applied_to_file: '/x.js',
        original_hash: SHA256,
        patched_hash: 'deadbeef',
        rollback_path: '/x.orig',
        verified: true,
      }).success,
    ).toBe(false);
  });

  it('BootstrapProgressSchema accepts current_stage 0 with empty completed_stages', () => {
    expect(
      BootstrapProgressSchema.safeParse({
        current_stage: 0,
        completed_stages: [],
        failed_stage: null,
        error: null,
        started_at: ISO,
        last_updated_at: ISO,
      }).success,
    ).toBe(true);
  });

  it('TelemetrySchema accepts all-null optional fields', () => {
    expect(
      TelemetrySchema.safeParse({
        user_id: null,
        enabled: false,
        last_flush: null,
      }).success,
    ).toBe(true);
  });

  it('PluginInstallSchema accepts an empty hooks_used array', () => {
    expect(
      PluginInstallSchema.safeParse({
        name: 'p',
        version: '1.0.0',
        source: 'registry://p@1.0.0',
        installed_at: ISO,
        enabled: false,
        hooks_used: [],
      }).success,
    ).toBe(true);
  });
});
