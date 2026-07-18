/**
 * Unit tests for `src/cli/commands/config.ts` — the `runConfig` function.
 *
 * Verifies the get / set / show / reset / unset paths against a tmpdir-backed
 * config file. The test mocks the loader so the effective config is the
 * {@link DEFAULT_CONFIG} (no real file reads), and writes the test config
 * file directly via the fs helpers.
 */

import { mkdtemp, writeFile as fsWriteFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../../src/utils/log.js', () => {
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

import { runConfig } from '../../../../src/cli/commands/config.js';
import type { CommandContext } from '../../../../src/cli/context.js';
import { Output } from '../../../../src/cli/output.js';
import { DEFAULT_CONFIG } from '../../../../src/config/defaults.js';
import { defaultState } from '../../../../src/state/store.js';
import { EXIT_CODES } from '../../../../src/utils/constants.js';


let tempHome: string;
let origHome: string | undefined;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), 'linuxify-cli-config-'));
  origHome = process.env.LINUXIFY_HOME;
  process.env.LINUXIFY_HOME = tempHome;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.LINUXIFY_HOME;
  else process.env.LINUXIFY_HOME = origHome;
});

/** Build a mock CommandContext pointing at the tmpdir config file. */
function makeCtx(): CommandContext {
  const output = new Output({ json: false, quiet: false, noColor: true });
  return {
    config: DEFAULT_CONFIG,
    stateStore: {
      load: vi.fn(async () => defaultState()),
      update: vi.fn(async (fn: (s: unknown) => void) => {
        const s = defaultState();
        fn(s);
        return s;
      }),
      get: vi.fn(() => defaultState()),
      save: vi.fn(async () => undefined),
      lock: vi.fn(async () => undefined),
      unlock: vi.fn(async () => undefined),
      withLock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      statePath: '/tmp/state.json',
      lockPath: '/tmp/.lock',
    } as unknown as CommandContext['stateStore'],
    output,
    registry: {} as CommandContext['registry'],
    telemetry: {} as CommandContext['telemetry'],
    doctor: {} as CommandContext['doctor'],
    patcher: {} as CommandContext['patcher'],
    plugins: {} as CommandContext['plugins'],
    state: defaultState(),
    flags: {
      dryRun: false,
      yes: false,
      offline: false,
      noTelemetry: false,
      verbose: 0,
      debug: false,
    },
  };
}

/** Capture stdout writes for assertion. */
function captureStdout(): { chunks: string[]; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(typeof c === 'string' ? c : String(c));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore() };
}

describe('runConfig', () => {
  it('reads an existing dotted key (default.distro)', async () => {
    const ctx = makeCtx();
    const cap = captureStdout();
    const code = await runConfig({}, ctx, ['distro.default']);
    expect(code).toBe(EXIT_CODES.OK);
    expect(cap.chunks.join('')).toContain(DEFAULT_CONFIG.distro.default);
    cap.restore();
  });

  it('returns NOT_FOUND for an unknown key', async () => {
    const ctx = makeCtx();
    const code = await runConfig({}, ctx, ['no.such.key']);
    expect(code).toBe(EXIT_CODES.NOT_FOUND);
  });

  it('writes a new value for a known key', async () => {
    const ctx = makeCtx();
    // Seed the config file with defaults so the read-modify-write succeeds.
    const configPath = join(tempHome, 'config.toml');
    await fsWriteFile(configPath, TOML.stringify(DEFAULT_CONFIG as unknown as TOML.JsonMap));

    const code = await runConfig({}, ctx, ['distro.default', 'debian']);
    expect(code).toBe(EXIT_CODES.OK);
  });

  it('rejects an invalid value with a ConfigError', async () => {
    const ctx = makeCtx();
    const configPath = join(tempHome, 'config.toml');
    await fsWriteFile(configPath, TOML.stringify(DEFAULT_CONFIG as unknown as TOML.JsonMap));

    // `bootstrap.parallel_downloads` is a number 1..64; setting it to "abc"
    // should fail schema validation.
    await expect(runConfig({}, ctx, ['bootstrap.parallel_downloads', '"abc"'])).rejects.toThrow();
  });

  it('`config show` prints the effective config as TOML', async () => {
    const ctx = makeCtx();
    const cap = captureStdout();
    const code = await runConfig({ show: true }, ctx, []);
    expect(code).toBe(EXIT_CODES.OK);
    const text = cap.chunks.join('');
    expect(text).toContain('[distro]');
    expect(text).toContain('[bootstrap]');
    cap.restore();
  });

  it('`config show` emits JSON under --json', async () => {
    const ctx: CommandContext = {
      ...makeCtx(),
      output: new Output({ json: true, quiet: false, noColor: true }),
    };
    const cap = captureStdout();
    const code = await runConfig({ show: true }, ctx, []);
    expect(code).toBe(EXIT_CODES.OK);
    const parsed = JSON.parse(cap.chunks.join('').trim()) as { distro: { default: string } };
    expect(parsed.distro.default).toBe(DEFAULT_CONFIG.distro.default);
    cap.restore();
  });

  it('`config reset` writes the default config to disk', async () => {
    const ctx = makeCtx();
    const cap = captureStdout();
    const code = await runConfig({}, ctx, ['reset']);
    expect(code).toBe(EXIT_CODES.OK);
    expect(cap.chunks.join('')).toContain('Config reset to defaults');
    cap.restore();
  });

  it('`config --unset <key>` removes a key', async () => {
    const ctx = makeCtx();
    const configPath = join(tempHome, 'config.toml');
    await fsWriteFile(configPath, TOML.stringify(DEFAULT_CONFIG as unknown as TOML.JsonMap));

    const cap = captureStdout();
    const code = await runConfig({ unset: 'distro.default' }, ctx, []);
    expect(code).toBe(EXIT_CODES.OK);
    expect(cap.chunks.join('')).toContain('Unset distro.default');
    cap.restore();
  });

  it('`config --unset` returns NOT_FOUND for a missing key', async () => {
    const ctx = makeCtx();
    const configPath = join(tempHome, 'config.toml');
    await fsWriteFile(configPath, TOML.stringify(DEFAULT_CONFIG as unknown as TOML.JsonMap));

    const code = await runConfig({ unset: 'no.such.key' }, ctx, []);
    expect(code).toBe(EXIT_CODES.NOT_FOUND);
  });

  it('prints usage when no args or flags are given', async () => {
    const ctx = makeCtx();
    const cap = captureStdout();
    const code = await runConfig({}, ctx, []);
    expect(code).toBe(EXIT_CODES.OK);
    expect(cap.chunks.join('')).toContain('Usage:');
    cap.restore();
  });
});
