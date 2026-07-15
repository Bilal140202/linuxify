/**
 * Doctor check: `distro.bootable`.
 *
 * @module linuxify/doctor/checks/distro-bootable
 *
 * Verifies that the active distro can actually be entered via proot, by
 * running `proot-distro login <alias> --user linuxify -- true`. A non-zero
 * exit means proot itself is broken (kernel regression, missing proot
 * binary, corrupted rootfs, etc.).
 *
 * Skipped when no active distro is set or when the distro is not installed
 * (those are surfaced by `distro.installed` instead).
 *
 * @packageDocumentation
 */

import { exec } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/** Hard timeout for the proot login attempt. */
const BOOT_TIMEOUT_MS = 10_000;

/**
 * The `distro.bootable` doctor check. Registered in `checks/index.ts`.
 */
export const distroBootableCheck: DoctorCheck = {
  id: 'distro.bootable',
  name: 'Distro bootable',
  category: 'distro',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that the active distro can actually execute commands (tries running `true` inside proot).',
    why: "A distro can be 'installed' (rootfs present) but not 'bootable' (proot crashes when entering it). This happens after Android OS updates that change kernel behavior, or if the rootfs got corrupted.",
    consequence: "`linuxify run`, `linuxify shell`, and `linuxify add` will all fail. The distro exists on disk but can't be entered.",
    fix: 'Reinstall the distro: `linuxify distros uninstall <name> && linuxify distros install <name>`',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'distro.bootable',
      name: 'Distro bootable',
      category: 'distro',
    };

    const active = ctx.state.active_distro;
    if (!active) {
      return {
        ...base,
        status: 'skip',
        message: 'No active distro; skipping bootable check.',
        detail: { activeDistro: active },
        durationMs: Date.now() - start,
      };
    }

    const inState = ctx.state.installed_distros.some((d) => d.name === active);
    if (!inState) {
      return {
        ...base,
        status: 'skip',
        message: `Active distro '${active}' not installed; skipping bootable check.`,
        detail: { activeDistro: active },
        durationMs: Date.now() - start,
      };
    }

    let result;
    try {
      result = await exec(
        'proot-distro',
        ['login', active, '--user', 'linuxify', '--', 'true'],
        { timeoutMs: BOOT_TIMEOUT_MS, env: { TERM: 'dumb' } },
      );
    } catch (e) {
      return {
        ...base,
        status: 'fail',
        message: `proot login failed to spawn: ${(e as Error).message}`,
        detail: { activeDistro: active, error: (e as Error).message },
        fixCommand: 'linuxify init --rebuild-rootfs',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (result.timedOut) {
      return {
        ...base,
        status: 'fail',
        message: `proot login timed out after ${BOOT_TIMEOUT_MS} ms.`,
        detail: { activeDistro: active, timeoutMs: BOOT_TIMEOUT_MS },
        fixCommand: 'linuxify init --rebuild-rootfs',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    if (result.exitCode !== 0) {
      return {
        ...base,
        status: 'fail',
        message: `proot login exited ${result.exitCode}: ${result.stderr.trim().slice(0, 200)}`,
        detail: {
          activeDistro: active,
          exitCode: result.exitCode,
          stdout: result.stdout.slice(0, 500),
          stderr: result.stderr.slice(0, 1000),
        },
        fixCommand: 'linuxify init --rebuild-rootfs',
        fixDocs: 'https://docs.linuxify.dev/22-operations/troubleshooting',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `proot login to '${active}' succeeded.`,
      detail: { activeDistro: active },
      durationMs: Date.now() - start,
    };
  },
};
