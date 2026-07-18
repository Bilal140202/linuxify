/**
 * Unit tests for `src/telemetry/redact.ts`.
 *
 * Verifies the privacy filter strips file paths, env-var values, command
 * args, URLs with credentials, Bearer tokens, inline API keys, and
 * secret-named fields — and that the redactor is recursive over nested
 * objects and arrays.
 */

import { describe, it, expect } from 'vitest';

import {
  redactEvent,
  redactObject,
  redactString,
  PATH_TOKEN,
  ENV_TOKEN,
  ARGS_TOKEN,
  SECRET_TOKEN,
} from '../../../src/telemetry/redact.js';
import type { TelemetryEvent } from '../../../src/telemetry/types.js';

// ---------------------------------------------------------------------------
// Helper: build a minimal event envelope for tests.
// ---------------------------------------------------------------------------
function makeEvent(fields: Record<string, unknown>): TelemetryEvent {
  return {
    event_id: '01901770-0000-7000-8000-000000000001',
    event_type: 'test.event',
    timestamp: '2025-04-10T14:23:11.482Z',
    linuxify_version: '0.1.0-alpha.1',
    user_id: null,
    session_id: '01901770-0000-7000-8000-000000000002',
    os: { android_version: '14', arch: 'aarch64' },
    fields,
  };
}

// ---------------------------------------------------------------------------
// redactString
// ---------------------------------------------------------------------------
describe('redactString', () => {
  it('replaces Unix absolute paths with <path>', () => {
    expect(redactString('/data/data/com.termux/files/home/.linuxify/state.json')).toBe(PATH_TOKEN);
    expect(redactString('/etc/hosts')).toBe(PATH_TOKEN);
    expect(redactString('/home/alice/project/file.js')).toBe(PATH_TOKEN);
  });

  it('replaces ~/.linuxify/... paths with <path>', () => {
    expect(redactString('~/../../home/alice/.linuxify/patches/cline/001.json')).toContain(
      PATH_TOKEN,
    );
  });

  it('replaces Windows drive paths with <path>', () => {
    expect(redactString('C:\\Users\\alice\\config.toml')).toBe(PATH_TOKEN);
  });

  it('replaces relative paths with extension', () => {
    expect(redactString('src/utils/log.ts')).toBe(PATH_TOKEN);
    expect(redactString('patches/cline/001.json')).toBe(PATH_TOKEN);
  });

  it('does NOT redact bare identifiers without slashes', () => {
    expect(redactString('ubuntu')).toBe('ubuntu');
    expect(redactString('aarch64')).toBe('aarch64');
    expect(redactString('node-22')).toBe('node-22');
  });

  it('strips credentials from authenticated URLs', () => {
    expect(redactString('https://alice:hunter2@registry.example.com/v2/events')).toBe(
      'https://<redacted>@registry.example.com/v2/events',
    );
  });

  it('replaces Bearer tokens', () => {
    const out = redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out).toBe(`Authorization: Bearer ${SECRET_TOKEN}`);
  });

  it('replaces inline AWS access keys (AKIA...)', () => {
    expect(redactString('aws key=AKIAIOSFODNN7EXAMPLE')).toBe(`aws key=${SECRET_TOKEN}`);
  });

  it('replaces inline GitHub tokens (gh[pousr]_...)', () => {
    expect(
      redactString('token=ghp_01234567890123456789012345678901234567'),
    ).toBe(`token=${SECRET_TOKEN}`);
  });

  it('replaces inline Slack tokens (xox[baprs]-...)', () => {
    expect(redactString('xoxb-1234567890-abcdef')).toBe(SECRET_TOKEN);
  });

  it('returns empty string unchanged', () => {
    expect(redactString('')).toBe('');
  });

  it('does not redact plain text without sensitive content', () => {
    expect(redactString('bootstrap started')).toBe('bootstrap started');
  });
});

// ---------------------------------------------------------------------------
// redactObject
// ---------------------------------------------------------------------------
describe('redactObject', () => {
  it('returns primitives unchanged', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(null)).toBe(null);
    expect(redactObject(undefined)).toBe(undefined);
  });

  it('passes string primitives through redactString', () => {
    expect(redactObject('/etc/passwd')).toBe(PATH_TOKEN);
  });

  it('replaces secret-named fields with ***REDACTED*** regardless of type', () => {
    const out = redactObject({
      api_token: 'sk-abc123',
      password: 'hunter2',
      authorization: 'Bearer xyz',
      cookie: 'session=abc',
      secret: { nested: 'value' },
      api_key: ['array', 'of', 'values'],
    });
    expect(out.api_token).toBe(SECRET_TOKEN);
    expect(out.password).toBe(SECRET_TOKEN);
    expect(out.authorization).toBe(SECRET_TOKEN);
    expect(out.cookie).toBe(SECRET_TOKEN);
    expect(out.secret).toBe(SECRET_TOKEN);
    expect(out.api_key).toBe(SECRET_TOKEN);
  });

  it('matches secret field names case-insensitively and as substrings', () => {
    const out = redactObject({
      GITHUB_TOKEN: 'ghp_xxx',
      UserPassword: 'hunter2',
      myApiKey: 'sk-xxx',
      bearer_value: 'Bearer xxx',
    });
    expect(out.GITHUB_TOKEN).toBe(SECRET_TOKEN);
    expect(out.UserPassword).toBe(SECRET_TOKEN);
    expect(out.myApiKey).toBe(SECRET_TOKEN);
    expect(out.bearer_value).toBe(SECRET_TOKEN);
  });

  it('replaces env-var container values with <redacted>, preserving keys', () => {
    const out = redactObject({
      env: { PATH: '/usr/bin', HOME: '/home/alice', OPENAI_API_KEY: 'sk-xxx' },
    });
    expect(out.env).toEqual({
      PATH: ENV_TOKEN,
      HOME: ENV_TOKEN,
      OPENAI_API_KEY: ENV_TOKEN,
    });
  });

  it('handles `environment` and `env_vars` field names too', () => {
    const out = redactObject({
      environment: { FOO: 'bar' },
      env_vars: { BAZ: 'qux' },
    });
    expect(out.environment).toEqual({ FOO: ENV_TOKEN });
    expect(out.env_vars).toEqual({ BAZ: ENV_TOKEN });
  });

  it('replaces args array contents with <args>, preserving length', () => {
    const out = redactObject({ args: ['--api-key', 'sk-xxx', '--file', '/etc/passwd'] });
    expect(out.args).toEqual([ARGS_TOKEN, ARGS_TOKEN, ARGS_TOKEN, ARGS_TOKEN]);
    expect(out.args).toHaveLength(4);
  });

  it('handles argv field name too', () => {
    const out = redactObject({ argv: ['a', 'b'] });
    expect(out.argv).toEqual([ARGS_TOKEN, ARGS_TOKEN]);
  });

  it('recursively redacts nested objects', () => {
    const out = redactObject({
      outer: {
        inner: {
          path: '/etc/shadow',
          token: 'secret',
        },
      },
    });
    expect(out.outer.inner.path).toBe(PATH_TOKEN);
    expect(out.outer.inner.token).toBe(SECRET_TOKEN);
  });

  it('recursively redacts arrays of objects', () => {
    const out = redactObject({
      stages: [
        { name: 'preflight', file: '/x/y.json' },
        { name: 'rootfs', file: '/a/b.tar.gz' },
      ],
    });
    expect(out.stages[0]!.file).toBe(PATH_TOKEN);
    expect(out.stages[1]!.file).toBe(PATH_TOKEN);
    expect(out.stages[0]!.name).toBe('preflight');
  });

  it('does not mutate the input', () => {
    const input = { path: '/etc/passwd', token: 'secret' };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactObject(input);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// redactEvent
// ---------------------------------------------------------------------------
describe('redactEvent', () => {
  it('redacts fields but leaves the envelope intact', () => {
    const event = makeEvent({
      stage: 0,
      error_message: 'failed at /home/alice/.linuxify/patches/cline/001.json',
      api_token: 'sk-xxx',
    });
    const out = redactEvent(event);
    // Envelope preserved.
    expect(out.event_id).toBe(event.event_id);
    expect(out.event_type).toBe(event.event_type);
    expect(out.timestamp).toBe(event.timestamp);
    expect(out.linuxify_version).toBe(event.linuxify_version);
    expect(out.user_id).toBe(event.user_id);
    expect(out.session_id).toBe(event.session_id);
    expect(out.os).toEqual(event.os);
    // Fields redacted.
    expect(out.fields.stage).toBe(0);
    expect(out.fields.error_message).toContain(PATH_TOKEN);
    expect(out.fields.api_token).toBe(SECRET_TOKEN);
  });

  it('does not mutate the input event', () => {
    const event = makeEvent({ path: '/etc/passwd' });
    const snapshot = JSON.parse(JSON.stringify(event));
    redactEvent(event);
    expect(event).toEqual(snapshot);
  });

  it('handles empty fields object', () => {
    const event = makeEvent({});
    const out = redactEvent(event);
    expect(out.fields).toEqual({});
  });

  it('redacts env vars inside fields', () => {
    const event = makeEvent({
      env: { PATH: '/usr/bin', SECRET: 'hunter2' },
    });
    const out = redactEvent(event);
    expect(out.fields.env).toEqual({
      PATH: ENV_TOKEN,
      SECRET: ENV_TOKEN,
    });
  });
});
