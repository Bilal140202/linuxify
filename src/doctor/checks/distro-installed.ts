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
 * On failure, suggests `linuxify use <name>` to install + activate the
 * distro.
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
        message: 'No active distro set in state.json.',
        detail: { activeDistro: active },
        fixCommand: 'linuxify use ubuntu',
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
        fixCommand: `linuxify use ${active}`,
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
