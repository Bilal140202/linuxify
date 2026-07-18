/**
 * Doctor check: `host.android`.
 *
 * @module linuxify/doctor/checks/host-android
 *
 * Verifies that the Android version is at least 9 (API level 28). Below 28,
 * proot's seccomp filter crashes on the `clone3` syscall, so Linuxify cannot
 * run reliably.
 *
 * Reads `getprop ro.build.version.sdk` (API level) and
 * `getprop ro.build.version.release` (marketing version) via the Android
 * `getprop` tool. Outside Android (e.g. on a developer laptop), the check
 * is skipped rather than failed — this lets unit tests run on Linux/macOS.
 *
 * @packageDocumentation
 */

import { exec, isAndroid } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/** Minimum Android API level (Android 9). */
const MIN_ANDROID_API = 28;

/**
 * The `host.android` doctor check. Registered in `checks/index.ts`.
 */
export const hostAndroidCheck: DoctorCheck = {
  id: 'host.android',
  name: 'Android',
  category: 'host',
  profile: ['minimal', 'standard', 'deep', 'pre-flight', 'post-install', 'ci'],
  explain: {
    what: "Verifies that you're running Android 9 (API 28) or newer.",
    why: 'Older Android versions lack kernel features that proot needs (specifically, certain seccomp and ptrace behaviors). Android 9 is the minimum Termux itself supports.',
    consequence: 'proot may segfault or hang on older Android versions. Bootstrap will fail during stage 2 (rootfs download) or stage 3 (first-boot apt install).',
    fix: "Update your device's Android version to 9 or newer. If your device is no longer supported by the manufacturer, Linuxify cannot help.",
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'host.android',
      name: 'Android',
      category: 'host',
    };

    if (!isAndroid()) {
      return {
        ...base,
        status: 'skip',
        message: 'Android version check skipped (not running on Android).',
        durationMs: Date.now() - start,
      };
    }

    let apiLevel: number | undefined;
    let release: string | undefined;
    try {
      const sdk = await exec('getprop', ['ro.build.version.sdk'], { timeoutMs: 3000 });
      if (sdk.exitCode === 0) {
        apiLevel = Number.parseInt(sdk.stdout.trim(), 10);
        if (Number.isNaN(apiLevel)) apiLevel = undefined;
      }
      const rel = await exec('getprop', ['ro.build.version.release'], { timeoutMs: 3000 });
      if (rel.exitCode === 0) {
        release = rel.stdout.trim();
      }
    } catch {
      /* fall through to fail */
    }

    if (apiLevel === undefined) {
      return {
        ...base,
        status: 'fail',
        message: 'Could not determine Android API level.',
        detail: { release },
        fixCommand: 'getprop ro.build.version.sdk',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/arm-considerations',
        durationMs: Date.now() - start,
      };
    }

    if (apiLevel < MIN_ANDROID_API) {
      return {
        ...base,
        status: 'fail',
        message: `Android API level ${apiLevel} (Android ${release ?? '?'}) is too old. Linuxify requires Android 9 (API ${MIN_ANDROID_API}) or newer.`,
        detail: { apiLevel, release, minApiLevel: MIN_ANDROID_API },
        fixCommand: 'Upgrade Android or use a supported device.',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/arm-considerations',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `Android API level ${apiLevel} (Android ${release ?? '?'}).`,
      detail: { apiLevel, release },
      durationMs: Date.now() - start,
    };
  },
};
