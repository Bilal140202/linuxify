/**
 * `linuxify list` — print installed packages.
 *
 * @module linuxify/cli/commands/list
 *
 * Default output is a table; `--json` emits the per-package JSON documents;
 * `--verbose` adds install date, patch status, and runtime version.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `list` command.
 */
export async function runList(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const verbose = !!(opts.verbose);
  const allDistros = !!(opts.allDistros);
  const distroFilter = typeof opts.distro === 'string' ? opts.distro : undefined;

  const state = await ctx.stateStore.load();
  let packages = state.installed_packages;
  if (!allDistros) {
    const distro = distroFilter ?? ctx.flags.distro ?? state.active_distro;
    if (distro) {
      packages = packages.filter((p) => p.distro === distro);
    }
  }

  if (packages.length === 0) {
    out.info('No packages installed.');
    return EXIT_CODES.OK;
  }

  // Build the table rows.
  const rows = packages.map((p) => {
    if (verbose) {
      return {
        name: p.name,
        version: p.version,
        runtime: `${p.runtime}@${p.runtime_version}`,
        patches: p.patches_applied.length,
        distro: p.distro,
        installed: p.install_date,
      };
    }
    return {
      name: p.name,
      version: p.version,
      runtime: `${p.runtime}@${p.runtime_version}`,
      patches: p.patches_applied.length > 0 ? 'yes' : 'no',
      distro: p.distro,
    };
  });

  if (ctx.output.json) {
    // Emit the full per-package JSON documents (matching `packages/<name>.json`).
    out.printJson(packages);
    return EXIT_CODES.OK;
  }

  out.table(rows);
  return EXIT_CODES.OK;
}

/**
 * Register the `list` command.
 */
export const registerListCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('list')
    .description('Print installed packages for the active (or --distro) distro.')
    .option('--distro <name>', 'List packages installed under this distro.')
    .option('--json', 'Emit per-package JSON documents.')
    .option('--verbose', 'Add install date, patch status, and runtime version.')
    .option('--all-distros', 'List packages across every distro.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runList(opts, ctx);
      setExit(code);
    });
};
