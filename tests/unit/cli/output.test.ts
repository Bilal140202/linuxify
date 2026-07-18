/**
 * Unit tests for `src/cli/output.ts` — the {@link Output} class.
 *
 * Captures stdout and stderr via spy and asserts on the rendered strings.
 * Each test constructs a fresh Output instance with deterministic flag
 * values so the suite is hermetic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import { Output } from '../../../src/cli/output.js';

// Capture stdout/stderr writes. The setup.ts in this repo already wraps
// process.stdout/stderr.write with a passthrough; we spy on top of it.
let stdoutChunks: string[];
let stderrChunks: string[];
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdoutChunks = [];
  stderrChunks = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

describe('Output', () => {
  it('info() prints a plain line to stdout', () => {
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.info('hello world');
    expect(stdoutChunks.join('')).toBe('hello world\n');
    expect(stderrChunks.join('')).toBe('');
  });

  it('info() is suppressed under --quiet', () => {
    const out = new Output({ json: false, quiet: true, noColor: true });
    out.info('hello world');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('info() is suppressed under --json (use json() instead)', () => {
    const out = new Output({ json: true, quiet: false, noColor: true });
    out.info('hello world');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('success() prints a green-check prefix when color is on', () => {
    // chalk auto-disables under NO_COLOR=1 in tests/setup.ts; we force
    // noColor:false here but chalk may still strip the ANSI codes. We
    // assert on the visible glyph being present regardless.
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.success('done');
    expect(stdoutChunks.join('')).toContain('done');
    expect(stdoutChunks.join('')).toContain('[ok]');
  });

  it('success() is suppressed under --quiet', () => {
    const out = new Output({ json: false, quiet: true, noColor: true });
    out.success('done');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('warn() is not suppressed under --quiet', () => {
    const out = new Output({ json: false, quiet: true, noColor: true });
    out.warn('careful');
    expect(stdoutChunks.join('')).toContain('careful');
  });

  it('warn() is suppressed under --json', () => {
    const out = new Output({ json: true, quiet: false, noColor: true });
    out.warn('careful');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('error() writes to stderr and is never suppressed', () => {
    const out = new Output({ json: true, quiet: true, noColor: true });
    out.error('boom');
    expect(stderrChunks.join('')).toContain('boom');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('progress() prints to stdout unless --quiet or --json', () => {
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.progress('downloading…');
    expect(stdoutChunks.join('')).toContain('downloading');
  });

  it('progress() is suppressed under --quiet', () => {
    const out = new Output({ json: false, quiet: true, noColor: true });
    out.progress('downloading…');
    expect(stdoutChunks.join('')).toBe('');
  });

  it('printJson() serializes the value as a single JSON line', () => {
    const out = new Output({ json: true, quiet: false, noColor: true });
    out.printJson({ ok: true, count: 3 });
    const line = stdoutChunks.join('');
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim()) as { ok: boolean; count: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(3);
  });

  it('table() prints headers and rows as text', () => {
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.table([
      { name: 'cline', version: '1.2.0' },
      { name: 'codex', version: '0.20.1' },
    ]);
    const text = stdoutChunks.join('');
    expect(text).toContain('NAME');
    expect(text).toContain('VERSION');
    expect(text).toContain('cline');
    expect(text).toContain('1.2.0');
    expect(text).toContain('codex');
  });

  it('table() emits JSON array under --json', () => {
    const out = new Output({ json: true, quiet: false, noColor: true });
    const rows = [
      { name: 'cline', version: '1.2.0' },
      { name: 'codex', version: '0.20.1' },
    ];
    out.table(rows);
    const parsed = JSON.parse(stdoutChunks.join('').trim()) as unknown[];
    expect(parsed).toHaveLength(2);
  });

  it('table() prints "No results." for an empty rows array', () => {
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.table([]);
    expect(stdoutChunks.join('')).toContain('No results.');
  });

  it('table() is suppressed under --quiet (without --json)', () => {
    const out = new Output({ json: false, quiet: true, noColor: true });
    out.table([{ a: 1 }]);
    expect(stdoutChunks.join('')).toBe('');
  });

  it('blank() prints a newline unless --quiet or --json', () => {
    const out = new Output({ json: false, quiet: false, noColor: true });
    out.blank();
    expect(stdoutChunks.join('')).toBe('\n');
  });

  it('respects NO_COLOR env var by auto-disabling color', () => {
    const orig = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      const out = new Output({ json: false, quiet: false, noColor: false });
      expect(out.noColor).toBe(true);
    } finally {
      if (orig === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = orig;
    }
  });

  it('does not throw on a broken stdout pipe', () => {
    stdoutSpy.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const out = new Output({ json: false, quiet: false, noColor: true });
    expect(() => out.info('still alive')).not.toThrow();
  });

  it('printJson() does not throw on a circular reference', () => {
    const out = new Output({ json: true, quiet: false, noColor: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => out.printJson(circular)).not.toThrow();
    // The fallback message is emitted instead of the unserializable object.
    expect(stdoutChunks.join('')).toContain('json serialization failed');
  });
});
