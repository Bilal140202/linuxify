/**
 * Unit tests for `src/cli/router.ts` — the {@link runCli} entry point.
 *
 * Focuses on the global-flag short-circuits (`--version`, `--help`) and the
 * unknown-subcommand error path. The full subcommand dispatch is exercised
 * by the per-command tests (e.g. `commands/doctor.test.ts`).
 *
 * The tests use commander's `exitOverride` behavior: `--help` and
 * `--version` throw a `CommanderError` with `exitCode === 0`; the router
 * catches it and returns the code.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger so the test output stays quiet and we avoid the pino
// multistream initialization that opens a log file.
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

import { runCli } from '../../../src/cli/router.js';
import { LINUXIFY_VERSION } from '../../../src/utils/constants.js';

let tempHome: string;
let origHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'linuxify-cli-router-'));
  origHome = process.env.LINUXIFY_HOME;
  process.env.LINUXIFY_HOME = tempHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.LINUXIFY_HOME;
  else process.env.LINUXIFY_HOME = origHome;
  vi.restoreAllMocks();
});

describe('runCli', () => {
  it('returns 0 for --version and prints the version', async () => {
    // Capture stdout to verify the version string is printed.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(typeof c === 'string' ? c : String(c));
      return true;
    });
    const code = await runCli(['--version']);
    expect(code).toBe(0);
    expect(chunks.join('')).toContain(LINUXIFY_VERSION);
    spy.mockRestore();
  });

  it('returns 0 for -V (short version flag)', async () => {
    const code = await runCli(['-V']);
    expect(code).toBe(0);
  });

  it('returns 0 for --help and prints usage', async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(typeof c === 'string' ? c : String(c));
      return true;
    });
    const code = await runCli(['--help']);
    expect(code).toBe(0);
    const text = chunks.join('');
    expect(text).toContain('Usage:');
    expect(text).toContain('linuxify');
    spy.mockRestore();
  });

  it('returns 0 for -h (short help flag)', async () => {
    const code = await runCli(['-h']);
    expect(code).toBe(0);
  });

  it('returns non-zero for an unknown subcommand', async () => {
    const code = await runCli(['not-a-real-command']);
    expect(code).not.toBe(0);
  });

  it('returns non-zero for an unknown flag', async () => {
    // commander rejects unknown options; the error exit code is 1.
    const code = await runCli(['--definitely-not-a-flag']);
    expect(code).not.toBe(0);
  });

  it('returns 0 for a no-op invocation (no subcommand)', async () => {
    // No subcommand: commander prints help (to stderr by default) and exits 0.
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      chunks.push(typeof c === 'string' ? c : String(c));
      return true;
    });
    const code = await runCli([]);
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('Usage:');
    spy.mockRestore();
  });

  it('pre-scans --json from anywhere in argv', async () => {
    // Verify the pre-scan picks up --json even after a subcommand name.
    // We don't actually run a subcommand here; instead we verify that
    // --version still short-circuits with exit 0 even when --json is
    // present (the pre-scan should not interfere with commander's parse).
    const code = await runCli(['--json', '--version']);
    expect(code).toBe(0);
  });

  it('pre-scans --no-color without crashing', async () => {
    const code = await runCli(['--no-color', '--version']);
    expect(code).toBe(0);
  });
});
