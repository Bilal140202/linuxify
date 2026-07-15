/**
 * Doctor check: `distro.installed`.
 *
 * @module linuxify/doctor/checks/distro-installed
 *
 * Verifies that the active distro (per `state.active_distro`) is installed —
 * i.e. its install marker file exists at
 * `~/.linuxify/distros/<name>/installed` AND it appears in
 * `state.installed_distros`.
 *
 * On failure with no active distro: suggests `linuxify init` (which installs
 * the default distro as part of bootstrap).
 *
 * On failure with an active distro that's missing: suggests
 * `linuxify distros install <name>` followed by `linuxify use <name>`.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import { exists } from '../../utils/fs.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `distro.installed` doctor check. Registered in `checks/index.ts`.
 */
export const distroInstalledCheck: DoctorCheck = {
  id: 'distro.installed',
  name: 'Distro installed',
  category: 'distro',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'distro.installed',
      name: 'Distro installed',
      category: 'distro',
    };

    const active = ctx.state.active_distro;
    if (!active) {
      return {
        ...base,
        status: 'fail',
        message:
          'No active distro. Ubuntu is not installed yet. Run: linuxify init',
        detail: { activeDistro: active, installedDistros: ctx.state.installed_distros.map((d) => d.name) },
        // `linuxify init` installs the default distro (Ubuntu) as part of
        // bootstrap stage 2. `linuxify use ubuntu` alone won't work because
        // `use` doesn't auto-install (it needs `--create`).
        fixCommand: 'linuxify init',
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/distro-management',
        durationMs: Date.now() - start,
      };
    }

    const inState = ctx.state.installed_distros.some((d) => d.name === active);
    const markerPath = join(getLinuxifyHome(), 'distros', active, 'installed');
    const markerExists = await exists(markerPath);

    if (!inState || !markerExists) {
      return {
        ...base,
        status: 'fail',
        message: `Active distro '${active}' is not installed (state: ${inState}, marker: ${markerExists}).`,
        detail: { activeDistro: active, inState, markerExists, markerPath },
        // Two-step fix: install the distro, then activate it.
        fixCommand: `linuxify distros install ${active} && linuxify use ${active}`,
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/distro-management',
        durationMs: Date.now() - start,
      };
    }

    const entry = ctx.state.installed_distros.find((d) => d.name === active);
    return {
      ...base,
      status: 'ok',
      message: `Active distro '${active}' (${entry?.version ?? '?'}) installed.`,
      detail: { activeDistro: active, version: entry?.version, markerPath },
      durationMs: Date.now() - start,
    };
  },
};
