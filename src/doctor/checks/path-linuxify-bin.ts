/**
 * Doctor check: `path.linuxify_bin`.
 *
 * @module linuxify/doctor/checks/path-linuxify-bin
 *
 * Verifies that `~/.linuxify/bin` is on the user's `$PATH`. The launcher
 * subsystem writes shell-script shims there, and if the directory is not on
 * PATH, the user cannot invoke installed CLIs by name (e.g. `cline`,
 * `codex`).
 *
 * Reads `process.env.PATH` (split on `:`) and checks for an exact match
 * against `~/.linuxify/bin`. Does NOT consult the user's shell rc files —
 * that requires sourcing the rc, which the doctor cannot do safely.
 *
 * On failure, suggests `linuxify init --from-stage 6` (the PATH-stage of
 * bootstrap, which appends the directory to the rc file).
 *
 * @packageDocumentation
 */

import path from 'node:path';

import { getLinuxifyHome } from '../../utils/process.js';
import type { DoctorCheck, DoctorResult } from '../types.js';

/**
 * The `path.linuxify_bin` doctor check. Registered in `checks/index.ts`.
 */
export const pathLinuxifyBinCheck: DoctorCheck = {
  id: 'path.linuxify_bin',
  name: 'PATH: linuxify/bin',
  category: 'path',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that `~/.linuxify/bin` is on your shell PATH. This is the directory where Linuxify installs launcher shims — small shell scripts that let you type `cline` instead of `linuxify run cline`.',
    why: 'When you run `linuxify add cline`, Linuxify creates a launcher script at `~/.linuxify/bin/cline` that enters proot and runs the real Cline binary. For the `cline` command to work from any terminal, `~/.linuxify/bin` must be on your PATH, just like `/usr/bin` or `/data/data/com.termux/files/usr/bin`.',
    consequence: 'Commands like `cline`, `codex`, `aider` won\'t be found. You\'d have to type the full path (`~/.linuxify/bin/cline`) or use `linuxify run cline` every time.',
    fix: 'linuxify repair paths',
  },

  async run(): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'path.linuxify_bin',
      name: 'PATH: linuxify/bin',
      category: 'path',
    };

    const target = path.join(getLinuxifyHome(), 'bin');
    const pathVar = process.env.PATH ?? '';
    const entries = pathVar.split(':').filter((p) => p.length > 0);
    const found = entries.some((p) => p === target);

    if (!found) {
      return {
        ...base,
        status: 'fail',
        message: `~/.linuxify/bin (${target}) is not on PATH.`,
        detail: { target, pathEntries: entries },
        // `linuxify repair paths` directly fixes shell rc files without
        // needing full bootstrap. `linuxify init --from-stage 6` would also
        // work but requires stages 0-5 to be complete first.
        fixCommand: 'linuxify repair paths',
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/bootstrap-design',
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'ok',
      message: `~/.linuxify/bin is on PATH (${target}).`,
      detail: { target },
      durationMs: Date.now() - start,
    };
  },
};
