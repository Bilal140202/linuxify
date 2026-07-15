/**
 * Doctor check: `path.termux_prefix`.
 *
 * @module linuxify/doctor/checks/path-termux-prefix
 *
 * Verifies that `$PREFIX/bin` (the Termux binary directory) is on the user's
 * `$PATH`. Outside Termux this check is skipped.
 *
 * On failure, suggests reinstalling Termux (a missing `$PREFIX/bin` on PATH
 * is extremely unusual and indicates a broken Termux install).
 *
 * @packageDocumentation
 */

import { getTermuxPrefix, isTermux } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/**
 * The `path.termux_prefix` doctor check. Registered in `checks/index.ts`.
 */
export const pathTermuxPrefixCheck: DoctorCheck = {
  id: 'path.termux_prefix',
  name: 'PATH: $PREFIX/bin',
  category: 'path',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: "Verifies that Termux's `$PREFIX/bin` is on your PATH (where `pkg`, `proot`, and other Termux tools live).",
    why: 'Termux sets this up automatically, but it can be lost if you modify your shell rc files or use a non-default shell. Linuxify relies on Termux tools being available.',
    consequence: "Linuxify won't be able to find `pkg`, `proot`, or other Termux tools. Bootstrap will fail at stage 1.",
    fix: 'Add `export PATH="$PREFIX/bin:$PATH"` to your ~/.bashrc (or ~/.zshrc).',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'path.termux_prefix',
      name: 'PATH: $PREFIX/bin',
      category: 'path',
    };

    if (!isTermux()) {
      return {
        ...base,
        status: 'skip',
        message: 'Not running in Termux; skipping $PREFIX/bin check.',
        durationMs: Date.now() - start,
      };
    }

    const target = `${getTermuxPrefix()}/bin`;
    const pathVar = process.env.PATH ?? '';
    const entries = pathVar.split(':').filter((p) => p.length > 0);
    const found = entries.some((p) => p === target);

    if (!found) {
      return {
        ...base,
        status: 'fail',
        message: `$PREFIX/bin (${target}) is not on PATH.`,
        detail: { target, pathEntries: entries },
        fixCommand: 'Reinstall Termux from F-Droid.',
        fixDocs: 'https://docs.linuxify.dev/23-mobile/termux-internals',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `$PREFIX/bin is on PATH (${target}).`,
      detail: { target },
      durationMs: Date.now() - start,
    };
  },
};
