/**
 * `linuxify discover` — scan the system and report what's installed.
 *
 * @module linuxify/cli/commands/discover
 *
 * Read-only command that scans for:
 *   - Termux, proot, proot-distro
 *   - Existing proot-distro containers (ubuntu, debian, etc.)
 *   - Runtimes inside each container (Node, Python, Git)
 *   - Linuxify state
 *
 * This is the "understand before acting" command. Use it before `linuxify init`
 * to see if you can `linuxify adopt` instead of reinstalling.
 *
 * Usage:
 *   linuxify discover          # human-readable
 *   linuxify discover --json   # machine-readable
 */

import { discoverEnvironment } from '../../discovery/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';
import type { RegisterCommandFn } from './index.js';

/**
 * Run the `discover` command.
 */
export async function runDiscover(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;

  out.info('🔍 Scanning your Termux environment…');
  out.info('');

  const discovery = await discoverEnvironment();

  if (opts.json) {
    out.printJson(discovery);
    return EXIT_CODES.OK;
  }

  // Human-readable output
  out.info('Host Environment:');
  out.info(`  Termux:         ${discovery.host.isTermux ? '✓' : '✗'}`);
  out.info(`  Android:        ${discovery.host.androidVersion ?? 'not detected'}`);
  out.info(`  Architecture:   ${discovery.host.arch}`);
  out.info(`  proot:          ${discovery.host.prootInstalled ? '✓' : '✗'}`);
  out.info(`  proot-distro:   ${discovery.host.prootDistroInstalled ? '✓' : '✗'}${discovery.host.prootDistroVersion ? ` v${discovery.host.prootDistroVersion}` : ''}${discovery.host.prootDistroWorking ? '' : ' (NOT working)'}`);
  out.info('');

  if (discovery.distros.length > 0) {
    out.info(`proot-distro containers (${discovery.distros.length}):`);
    out.info('');
    for (const d of discovery.distros) {
      const status = d.bootable ? '✓' : '✗';
      const managed = d.managedByLinuxify ? ' [Linuxify]' : '';
      out.info(`  ${status} ${d.name}${managed}`);
      if (d.sizeMb > 0) {
        out.info(`     Size: ~${d.sizeMb} MB`);
      }
      if (d.runtimes.length > 0) {
        const found = d.runtimes.filter((r) => r.version);
        if (found.length > 0) {
          out.info(`     Runtimes: ${found.map((r) => `${r.name} ${r.version}`).join(', ')}`);
        }
      }
    }
    out.info('');
    out.info('To adopt an existing environment:');
    out.info(`  linuxify adopt ${discovery.distros[0].name}`);
  } else {
    out.info('No proot-distro containers found.');
    out.info('Run `linuxify init` to install a fresh Ubuntu environment.');
  }

  out.info('');
  if (discovery.linuxifyInitialized) {
    out.info('Linuxify: ✓ initialized');
  } else {
    out.info('Linuxify: not initialized');
  }

  if (discovery.warnings.length > 0) {
    out.info('');
    out.info('Warnings:');
    for (const w of discovery.warnings) {
      out.info(`  ⚠ ${w}`);
    }
  }

  return EXIT_CODES.OK;
}

/**
 * Register the `discover` command.
 */
export const registerDiscoverCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('discover')
    .description('Scan your system for existing proot-distro environments and runtimes.')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runDiscover(opts, ctx);
      setExit(code);
    });
};
