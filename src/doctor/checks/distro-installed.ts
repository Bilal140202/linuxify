/**
 * Doctor check: `distro.installed`.
 *
 * @module linuxify/doctor/checks/distro-installed
 *
 * Verifies that an active distro is installed and usable. Uses the shared
 * {@link getActiveDistro} helper — the SAME source of truth that bootstrap,
 * Stage 2, Stage 7, and discovery use. This prevents the bug where doctor
 * said "no active distro" even though Ubuntu was installed via proot-distro.
 *
 * Resolution:
 * 1. Check if any containers are installed via `proot-distro list --quiet`
 * 2. If state.json's active_distro matches an installed container → OK
 * 3. If state.json has no active_distro but Ubuntu is installed → OK (adopt)
 * 4. If no containers are installed → FAIL with "run linuxify init"
 *
 * @packageDocumentation
 */

import { getInstalledContainers, getActiveDistro } from '../../utils/distros.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

/**
 * The `distro.installed` doctor check. Registered in `checks/index.ts`.
 */
export const distroInstalledCheck: DoctorCheck = {
  id: 'distro.installed',
  name: 'Distro installed',
  category: 'distro',
  profile: ['minimal', 'standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that an active Linux distribution (Ubuntu by default) is installed inside proot and ready to use.',
    why: 'Linuxify doesn\'t run CLIs directly on Android — it runs them inside a real Linux distro (Ubuntu) that lives inside proot. The distro provides glibc, apt, and the standard Linux filesystem hierarchy that CLIs expect. Without a distro, there is no Linux environment to run anything in.',
    consequence: 'If no distro is installed, `linuxify add cline` and `linuxify run cline` will both fail. There is no Ubuntu to install Cline into.',
    fix: 'linuxify init',
  },

  async run(ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'distro.installed',
      name: 'Distro installed',
      category: 'distro',
    };

    // Use the SHARED helper — same source of truth as bootstrap Stage 2/7.
    const installed = await getInstalledContainers();
    const active = await getActiveDistro(ctx.state.active_distro);

    if (installed.length === 0) {
      return {
        ...base,
        status: 'fail',
        message: 'No active distro. Ubuntu is not installed yet. Run: linuxify init',
        detail: {
          installedContainers: [],
          stateActiveDistro: ctx.state.active_distro,
          source: 'proot-distro list --quiet',
        },
        fixCommand: 'linuxify init',
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/distro-management',
        durationMs: Date.now() - start,
      };
    }

    if (!active) {
      // Containers exist but none is active — shouldn't happen given
      // getActiveDistro's fallback, but handle it.
      return {
        ...base,
        status: 'fail',
        message: `Containers found (${installed.join(', ')}) but none is active. Run: linuxify use ubuntu`,
        detail: {
          installedContainers: installed,
          stateActiveDistro: ctx.state.active_distro,
          source: 'proot-distro list --quiet',
        },
        fixCommand: `linuxify use ${installed[0]}`,
        fixDocs: 'https://docs.linuxify.dev/05-bootstrap/distro-management',
        durationMs: Date.now() - start,
      };
    }

    // Active distro found and installed — report success.
    return {
      ...base,
      status: 'ok',
      message: `Active distro '${active}' is installed.`,
      detail: {
        activeDistro: active,
        installedContainers: installed,
        stateActiveDistro: ctx.state.active_distro,
        source: 'proot-distro list --quiet',
        note: ctx.state.active_distro !== active
          ? `State.json pointed to '${ctx.state.active_distro || '(none)'}' but '${active}' is actually installed — using reality over cached state.`
          : undefined,
      },
      durationMs: Date.now() - start,
    };
  },
};
