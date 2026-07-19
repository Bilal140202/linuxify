/**
 * Doctor check: `path.proot-distro-usable`.
 *
 * @module linuxify/doctor/checks/path-proot-distro-usable
 *
 * Verifies that proot-distro is not only installed but actually USABLE —
 * that `proot-distro list` exits 0. This catches the "bad interpreter"
 * bug where a Python upgrade breaks the proot-distro script's shebang.
 *
 * When the check fails, it runs the diagnostics engine to produce a
 * specific diagnosis (e.g., "bad interpreter after Python upgrade") and
 * suggests the targeted repair (e.g., `pkg reinstall proot-distro`).
 */

import { exec } from '../../utils/process.js';
import { diagnoseError } from '../../diagnostics/index.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/**
 * The `path.proot-distro-usable` doctor check.
 */
export const pathProotDistroUsableCheck: DoctorCheck = {
  id: 'path.proot-distro-usable',
  name: 'proot-distro usable',
  category: 'path',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that `proot-distro list` actually works — not just that the binary exists, but that it can execute without errors.',
    why: 'After a Termux Python upgrade, the proot-distro script\'s shebang can point to a Python version that no longer exists (e.g., python3.13 when you now have python3.14). The binary is "installed" but cannot run. This is the most common cause of "proot-distro not working" on devices that recently updated Python.',
    consequence: 'If proot-distro can\'t run, Linuxify cannot enter any distro. Every `linuxify run`, `linuxify shell`, and `linuxify add` will fail because there is no way to enter the distro environment.',
    fix: 'pkg reinstall proot-distro  # fixes the shebang to point to the current Python',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'path.proot-distro-usable',
      name: 'proot-distro usable',
      category: 'path',
    };

    try {
      const result = await exec('proot-distro', ['list'], { timeoutMs: 10000 });

      if (result.exitCode === 0) {
        return {
          ...base,
          status: 'ok',
          message: 'proot-distro is working (proot-distro list exits 0).',
          detail: { exitCode: 0 },
          durationMs: Date.now() - start,
        };
      }

      // proot-distro list failed — run diagnostics.
      const diagnosis = diagnoseError({
        command: 'proot-distro list',
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.stdout,
        packageName: 'proot-distro',
      });

      if (diagnosis) {
        return {
          ...base,
          status: 'fail',
          message: `proot-distro is broken — ${diagnosis.title}`,
          detail: {
            exitCode: result.exitCode,
            stderr: result.stderr.slice(0, 500),
            diagnosis,
          },
          fixCommand: diagnosis.repair,
          fixDocs: diagnosis.docsUrl,
          durationMs: Date.now() - start,
        };
      }

      // No specific diagnosis — generic failure.
      return {
        ...base,
        status: 'fail',
        message: `proot-distro list failed (exit ${result.exitCode}). ${result.stderr.slice(0, 200)}`,
        detail: {
          exitCode: result.exitCode,
          stderr: result.stderr.slice(0, 500),
        },
        fixCommand: 'pkg reinstall proot-distro',
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        ...base,
        status: 'fail',
        message: `Could not run proot-distro: ${(err as Error).message}`,
        detail: { error: (err as Error).message },
        fixCommand: 'pkg install proot-distro',
        durationMs: Date.now() - start,
      };
    }
  },
};
