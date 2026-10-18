/**
 * Unit tests for `src/docker/config.ts` — pure helpers + Zod schemas +
 * exported constants.
 *
 * Covers:
 *   - `imageToSlug()`:
 *     - single-component image names pass through (`nginx` → `nginx`)
 *     - registry prefix stripped (`lscr.io/linuxserver/calibre-web:latest`
 *       → `calibre-web`)
 *     - namespace stripped (`iib0011/omni-tools:latest` → `omni-tools`)
 *     - tag stripped (`freshrss/freshrss:edge` → `freshrss`)
 *     - docker.io/library/ prefix stripped (`docker.io/library/postgres:16`
 *       → `postgres`)
 *     - empty string falls back to `container`
 *     - sanitization (`Foo BAR!` → `foo-bar`)
 *   - `PortMappingSchema`:
 *     - valid `{guestPort: 80}` parses
 *     - valid `{hostPort: 8080, guestPort: 80}` parses
 *     - `guestPort: 0` rejected (min 1)
 *     - `guestPort: 70000` rejected (max 65535)
 *     - `hostPort: 80` rejected (min 1024)
 *   - Default constants: `DEFAULT_RESTART_POLICY`,
 *     `DEFAULT_PORT_RANGE_START`, `DEFAULT_PORT_RANGE_END`.
 *
 * No mocks needed — `config.ts` is pure (only imports zod).
 */

import {
  imageToSlug,
  PortMappingSchema,
  DEFAULT_RESTART_POLICY,
  DEFAULT_PORT_RANGE_START,
  DEFAULT_PORT_RANGE_END,
} from '../../../src/docker/config.js';

describe('docker/config — imageToSlug', () => {
  it('passes through single-component image names', () => {
    expect(imageToSlug('nginx')).toBe('nginx');
  });

  it('strips the registry prefix and tag', () => {
    expect(imageToSlug('lscr.io/linuxserver/calibre-web:latest')).toBe('calibre-web');
  });

  it('strips a non-registry namespace and the tag', () => {
    // `iib0011` has no dot so it isn't treated as a registry prefix.
    expect(imageToSlug('iib0011/omni-tools:latest')).toBe('omni-tools');
  });

  it('strips the tag and collapses a repeated namespace/name', () => {
    expect(imageToSlug('freshrss/freshrss:edge')).toBe('freshrss');
  });

  it('strips the docker.io/library/ prefix and tag', () => {
    // `docker.io` has a dot so it's treated as a registry; `library` is
    // the implicit namespace; the last component is `postgres`.
    expect(imageToSlug('docker.io/library/postgres:16')).toBe('postgres');
  });

  it('falls back to "container" on empty input', () => {
    expect(imageToSlug('')).toBe('container');
  });

  it('sanitizes upper-case + punctuation to lowercase kebab', () => {
    expect(imageToSlug('Foo BAR!')).toBe('foo-bar');
  });

  it('sanitizes a slug that collapses to empty back to "container"', () => {
    // All non-alphanumerics → empty after sanitization.
    expect(imageToSlug('!!!')).toBe('container');
  });
});

describe('docker/config — PortMappingSchema', () => {
  it('parses a guest-only mapping', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 80 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.guestPort).toBe(80);
      expect(parsed.data.hostPort).toBeUndefined();
    }
  });

  it('parses a full host+guest mapping', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 8080, guestPort: 80 });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hostPort).toBe(8080);
      expect(parsed.data.guestPort).toBe(80);
    }
  });

  it('rejects guestPort: 0 (min 1)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 0 });
    expect(parsed.success).toBe(false);
  });

  it('rejects guestPort: 70000 (max 65535)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 70000 });
    expect(parsed.success).toBe(false);
  });

  it('rejects hostPort: 80 (min 1024 — non-privileged range only)', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 80, guestPort: 80 });
    expect(parsed.success).toBe(false);
  });

  it('accepts hostPort: 1024 (boundary)', () => {
    const parsed = PortMappingSchema.safeParse({ hostPort: 1024, guestPort: 80 });
    expect(parsed.success).toBe(true);
  });

  it('accepts guestPort: 1 (boundary)', () => {
    const parsed = PortMappingSchema.safeParse({ guestPort: 1 });
    expect(parsed.success).toBe(true);
  });
});

describe('docker/config — exported constants', () => {
  it('exposes DEFAULT_RESTART_POLICY = "unless-stopped"', () => {
    expect(DEFAULT_RESTART_POLICY).toBe('unless-stopped');
  });

  it('exposes DEFAULT_PORT_RANGE_START = 8000', () => {
    expect(DEFAULT_PORT_RANGE_START).toBe(8000);
  });

  it('exposes DEFAULT_PORT_RANGE_END = 8999', () => {
    expect(DEFAULT_PORT_RANGE_END).toBe(8999);
  });
});
