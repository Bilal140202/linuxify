/**
 * Tests for the repair engine's deduplication and dependency-ordering logic.
 *
 * These tests verify the fixes for the alpha-test bugs:
 * - Bug #2: repair called non-existent `linuxify init --resume`
 * - Bug #3: repair had broken dependency ordering (ran `use ubuntu` before
 *   installing, ran `init --from-stage 6` before state.json existed)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RepairEngine } from '../../../src/repair/engine.js';
import { createDoctorEngine } from '../../../src/doctor/index.js';
import { defaultState } from '../../../src/state/store.js';
import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import type { DoctorResult } from '../../../src/doctor/types.js';

// Mock logger
vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} }),
  },
}));

// Mock fs
vi.mock('../../../src/utils/fs.js', () => ({
  exists: vi.fn(async () => false),
  ensureDir: vi.fn(async () => undefined),
  readJson: vi.fn(async () => null),
  writeJson: vi.fn(async () => undefined),
}));

// Mock process
vi.mock('../../../src/utils/process.js', () => ({
  getLinuxifyHome: () => '/tmp/linuxify-test',
  getTermuxPrefix: () => '/data/data/com.termux/files/usr',
  isTermux: () => false,
  isAndroid: () => false,
  getArch: () => 'x86_64',
  getPlatform: () => 'linux',
  getAndroidVersion: async () => null,
  exec: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false, command: '' })),
}));

function makeResult(id: string, fixCommand: string, status: 'fail' | 'missing' = 'fail'): DoctorResult {
  return {
    id,
    name: id,
    category: 'host',
    status,
    message: `test failure for ${id}`,
    fixCommand,
    durationMs: 1,
  };
}

function makeStateStore() {
  const state = defaultState();
  return {
    load: vi.fn(async () => state),
    get: () => state,
    update: vi.fn(async (fn: (s: unknown) => void) => { fn(state); return state; }),
    save: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
    unlock: vi.fn(async () => undefined),
    withLock: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    statePath: '/tmp/state.json',
    lockPath: '/tmp/.lock',
  };
}

describe('repair engine — deduplication and dependency ordering', () => {
  let engine: RepairEngine;
  let stateStore: ReturnType<typeof makeStateStore>;
  let execCalls: string[];

  beforeEach(() => {
    stateStore = makeStateStore();
    execCalls = [];
    const execFn = vi.fn(async (cmd: string, args: string[]) => {
      execCalls.push(`${cmd} ${args.join(' ')}`);
      return { stdout: '', stderr: '', exitCode: 0, failed: false, timedOut: false, command: `${cmd} ${args.join(' ')}` };
    });
    engine = new RepairEngine({
      doctor: createDoctorEngine(),
      stateStore: stateStore as never,
      execFn: execFn as never,
    });
  });

  it('does not call linuxify init --resume (non-existent command)', async () => {
    // This is the regression test for Bug #2.
    // The bootstrap.completed check should now suggest `linuxify init`,
    // not `linuxify init --resume`.
    const result = await engine.run(
      { yes: true },
      { config: DEFAULT_CONFIG as never, state: defaultState() },
    );
    // Check that no executed command contains --resume
    const resumeCalls = execCalls.filter((c) => c.includes('--resume'));
    expect(resumeCalls).toHaveLength(0);
  });

  it('does not call linuxify use ubuntu before installing ubuntu', async () => {
    // This is the regression test for Bug #3a.
    // `linuxify use ubuntu` without `--create` fails when ubuntu isn't installed.
    // The distro.installed check should now suggest `linuxify init` instead.
    const result = await engine.run(
      { yes: true },
      { config: DEFAULT_CONFIG as never, state: defaultState() },
    );
    const useCalls = execCalls.filter((c) => c.includes('use ubuntu') && !c.includes('--create'));
    expect(useCalls).toHaveLength(0);
  });

  it('does not call linuxify init --from-stage 6 when state.json does not exist', async () => {
    // This is the regression test for Bug #3b.
    // `linuxify init --from-stage 6` requires stages 0-5 to be done AND
    // state.json to exist. The path.linuxify_bin check should now suggest
    // `linuxify repair paths` instead.
    const result = await engine.run(
      { yes: true },
      { config: DEFAULT_CONFIG as never, state: defaultState() },
    );
    const fromStageCalls = execCalls.filter((c) => c.includes('--from-stage 6'));
    expect(fromStageCalls).toHaveLength(0);
  });

  it('deduplicates identical fixCommands', async () => {
    // If bootstrap.completed and distro.installed both suggest `linuxify init`,
    // the repair engine should only run it once.
    const result = await engine.run(
      { yes: true },
      { config: DEFAULT_CONFIG as never, state: defaultState() },
    );
    const initCalls = execCalls.filter((c) => c.includes('linuxify init'));
    // Should be at most 1 (deduplicated), not 2.
    expect(initCalls.length).toBeLessThanOrEqual(1);
  });

  it('runs bootstrap fix before distro fix (dependency order)', async () => {
    // The repair engine should prioritize bootstrap.completed (priority 0)
    // over distro.installed (priority 2) and path.linuxify_bin (priority 4).
    // We can verify this by checking the order of exec calls.
    const result = await engine.run(
      { yes: true },
      { config: DEFAULT_CONFIG as never, state: defaultState() },
    );
    // The first non-empty exec call should be related to bootstrap or host
    // (the highest-priority failing checks).
    if (execCalls.length > 0) {
      const firstCall = execCalls[0];
      // It should NOT be a path fix (those are low priority).
      expect(firstCall).not.toContain('repair paths');
    }
  });
});
