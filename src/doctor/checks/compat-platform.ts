/**
 * Doctor check: `compat.platform`.
 *
 * @module linuxify/doctor/checks/compat-platform
 *
 * Verifies that `process.platform` reports `'linux'` when Node is invoked
 * inside the proot. Without the platform-shim patch (applied by the patcher
 * subsystem), Node reports `'android'` inside proot — which breaks packages
 * that gate on `process.platform === 'linux'` (e.g. esbuild, some
 * native-module loaders).
 *
 * The check runs `node -e 'process.stdout.write(process.platform)'` inside
 * the active distro via `proot-distro login`. Skipped when no active distro
 * is set or when the distro is not installed.
 *
 * On failure, suggests `linuxify patch --platform`.
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/** Hard timeout for the proot login + node invocation. */
const PLATFORM_TIMEOUT_MS = 8000;

/**
 * The `compat.platform` doctor check. Registered in `checks/index.ts`.
 */
export const compatPlatformCheck: DoctorCheck = {
  id: 'compat.platform',
  name: 'process.platform',
  category: 'compat',
  profile: ['standard', 'deep', 'post-install', 'ci'],

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'compat.platform',
      name: 'process.platform',
      category: 'compat',
    };

    const active = ctx.state.active_distro;
    if (!active) {
      return {
        ...base,
        status: 'skip',
        message: 'No active distro; skipping platform check.',
        durationMs: Date.now() - start,
      };
    }

    const inState = ctx.state.installed_distros.some((d) => d.name === active);
    if (!inState) {
      return {
        ...base,
        status: 'skip',
        message: `Active distro '${active}' not installed; skipping platform check.`,
        durationMs: Date.now() - start,
      };
    }

    let result;
    try {
      result = await exec(
        'proot-distro',
        ['login', active, '--user', 'linuxify', '--', 'node', '-e', 'process.stdout.write(process.platform)'],
        { timeoutMs: PLATFORM_TIMEOUT_MS, env: { TERM: 'dumb' } },
      );
    } catch (e) {
      return {
        ...base,
        status: 'fail',
        message: `proot login failed: ${(e as Error).message}`,
        detail: { activeDistro: active, error: (e as Error).message },
        fixCommand: 'linuxify init --rebuild-rootfs',
        fixDocs: 'https://docs.linuxify.dev/08-patcher/platform-detection',
        durationMs: Date.now() - start,
      };
    }

    if (result.exitCode !== 0) {
      return {
        ...base,
        status: 'fail',
        message: `node inside proot exited ${result.exitCode}.`,
        detail: {
          activeDistro: active,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 500),
          stderr: result.stderr.slice(0, 500),
        },
        fixCommand: 'linuxify runtimes install node 22',
        fixDocs: 'https://docs.linuxify.dev/06-launcher/runtime-management',
        durationMs: Date.now() - start,
      };
    }

    const reported = result.stdout.trim();
    if (reported === 'linux') {
      return {
        ...base,
        status: 'ok',
        message: `process.platform reports 'linux' inside proot.`,
        detail: { activeDistro: active, reported },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'fail',
      message: `process.platform reports '${reported}' (expected 'linux'); platform shim not applied.`,
      detail: { activeDistro: active, reported, expected: 'linux' },
      fixCommand: 'linuxify patch --platform',
      fixDocs: 'https://docs.linuxify.dev/08-patcher/platform-detection',
      durationMs: Date.now() - start,
    };
  },
};
