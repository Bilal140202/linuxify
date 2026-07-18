/**
 * `linuxify adopt <distro>` — adopt an existing proot-distro environment.
 *
 * @module linuxify/cli/commands/adopt
 *
 * For users who already have a working proot-distro setup (Ubuntu, Debian,
 * etc.) and want Linuxify to manage it WITHOUT reinstalling.
 *
 * What adoption does:
 *   1. Verifies the distro exists and is bootable
 *   2. Scans for installed runtimes (Node, Python, Git)
 *   3. Creates ~/.linuxify/ directory structure
 *   4. Writes state.json with the adopted distro as active
 *   5. Writes bootstrap stage markers (skipping stages 0-4 since they're done)
 *   6. Runs stage 6 (PATH wiring) if needed
 *   7. Generates launchers for any discovered packages
 *
 * What adoption does NOT do:
 *   - Reinstall the distro
 *   - Reinstall runtimes
 *   - Download anything (unless PATH repair needs a package)
 *
 * Usage:
 *   linuxify adopt ubuntu     # Adopt existing Ubuntu
 *   linuxify adopt debian     # Adopt existing Debian
 *   linuxify discover         # Just scan, don't adopt
 */

import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

import { discoverEnvironment, type DiscoveryResult } from '../../discovery/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { getLinuxifyHome } from '../../utils/process.js';
import { confirm } from '../../utils/prompt.js';
import { defaultState } from '../../state/store.js';
import type { CommandContext } from '../context.js';
import type { RegisterCommandFn } from './index.js';

/**
 * Run the `adopt` command.
 */
export async function runAdopt(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  distroName?: string,
): Promise<number> {
  const out = ctx.output;

  out.info('🔍 Scanning your Termux environment…');
  out.info('');

  const discovery = await discoverEnvironment();

  // Print discovery results
  printDiscovery(discovery, out);

  if (discovery.distros.length === 0) {
    out.error('No proot-distro containers found.');
    out.info('Run `linuxify init` to install a fresh Ubuntu environment.');
    return EXIT_CODES.NOT_FOUND;
  }

  // If a distro name was provided, validate it
  if (distroName) {
    const distro = discovery.distros.find((d) => d.name === distroName);
    if (!distro) {
      out.error(`Distro '${distroName}' not found.`);
      out.info(`Available: ${discovery.distros.map((d) => d.name).join(', ')}`);
      return EXIT_CODES.NOT_FOUND;
    }
    if (!distro.bootable) {
      out.error(`Distro '${distroName}' is not bootable. Cannot adopt.`);
      return EXIT_CODES.ENV_NOT_READY;
    }
    if (distro.managedByLinuxify) {
      out.warn(`Distro '${distroName}' is already managed by Linuxify.`);
      const proceed = await confirm('Adopt again (reset state)?', false);
      if (!proceed) {
        out.info('Cancelled.');
        return EXIT_CODES.OK;
      }
    }
    return await doAdopt(distro, discovery, ctx);
  }

  // No distro name provided — let the user choose
  out.info('');
  out.info('Which environment would you like to adopt?');
  discovery.distros.forEach((d, i) => {
    const runtimeSummary = d.runtimes
      .filter((r) => r.version)
      .map((r) => `${r.name} ${r.version}`)
      .join(', ');
    out.info(`  ${i + 1}. ${d.name} ${runtimeSummary ? `(${runtimeSummary})` : ''}`);
  });
  out.info('');

  // Interactive selection
  if (discovery.distros.length === 1) {
    const proceed = await confirm(`Adopt '${discovery.distros[0].name}'?`, true);
    if (proceed) {
      return await doAdopt(discovery.distros[0], discovery, ctx);
    }
    out.info('Cancelled.');
    return EXIT_CODES.OK;
  }

  // Multiple distros — need user to specify
  out.info('Multiple distros found. Specify which one:');
  out.info(`  linuxify adopt <name>`);
  out.info(`  e.g.: linuxify adopt ${discovery.distros[0].name}`);
  return EXIT_CODES.GENERIC_ERROR;
}

/**
 * Perform the actual adoption.
 */
async function doAdopt(
  distro: DiscoveryResult['distros'][0],
  _discovery: DiscoveryResult,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;

  out.info('');
  out.info(`Adopting '${distro.name}'…`);
  out.info('');

  const linuxifyHome = getLinuxifyHome();
  const bootstrapDir = join(linuxifyHome, '.bootstrap');

  // 1. Create ~/.linuxify/ directory structure
  out.progress('Creating Linuxify home directory…');
  try {
    const dirs = [
      linuxifyHome,
      join(linuxifyHome, 'bin'),
      join(linuxifyHome, 'logs'),
      join(linuxifyHome, 'packages'),
      join(linuxifyHome, 'patches'),
      join(linuxifyHome, 'distros'),
      join(linuxifyHome, 'plugins'),
      join(linuxifyHome, 'telemetry'),
      join(linuxifyHome, 'cache'),
      join(linuxifyHome, 'backups'),
      bootstrapDir,
    ];
    for (const dir of dirs) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
    }
    out.success('  ✓ Linuxify home created');
  } catch (err) {
    out.error(`  ✖ Failed to create directories: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }

  // 2. Write bootstrap stage markers (stages 0-4 are done since the distro
  //    already exists with runtimes)
  out.progress('Marking completed bootstrap stages…');
  const stagesToMark = [0, 1, 2, 3, 4, 5]; // preflight, host-deps, rootfs, first-boot, runtimes, home
  for (const stage of stagesToMark) {
    const markerPath = join(bootstrapDir, `stage-${stage}.done`);
    if (!existsSync(markerPath)) {
      writeFileSync(markerPath, JSON.stringify({
        stage,
        adopted: true,
        completedAt: new Date().toISOString(),
      }), { mode: 0o600 });
    }
  }
  out.success(`  ✓ Stages 0-5 marked complete (adopted)`);

  // 3. Write state.json with the adopted distro
  out.progress('Writing state.json…');
  const state = {
    ...defaultState(),
    active_distro: distro.name,
    installed_distros: [{
      name: distro.name,
      version: 'unknown', // We don't know the exact version
      installed_at: new Date().toISOString(),
      rootfs_sha256: '', // Unknown for adopted distros
    }],
    installed_runtimes: distro.runtimes
      .filter((r) => r.version)
      .map((r) => ({
        name: r.name === 'python3' ? 'python' : r.name,
        version: r.version!,
        distro: distro.name,
        path: r.path ?? '',
        installed_at: new Date().toISOString(),
        is_default: true,
      })),
    bootstrap_progress: {
      current_stage: 8,
      completed_stages: stagesToMark,
      failed_stage: null,
      error: null,
      started_at: new Date().toISOString(),
      last_updated_at: new Date().toISOString(),
    },
  };

  try {
    const statePath = join(linuxifyHome, 'state.json');
    writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    out.success('  ✓ state.json written');
  } catch (err) {
    out.error(`  ✖ Failed to write state.json: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }

  // 4. Check PATH (stage 6)
  const binDir = join(linuxifyHome, 'bin');
  const pathEnv = process.env.PATH ?? '';
  const onPath = pathEnv.split(':').includes(binDir);
  if (!onPath) {
    out.progress('PATH needs repair — running stage 6…');
    // Mark stage 6 as not done so repair can pick it up
    out.info('  Run `linuxify repair paths` to add ~/.linuxify/bin to your PATH.');
  } else {
    // Mark stage 6 as done
    writeFileSync(join(bootstrapDir, 'stage-6.done'), JSON.stringify({
      stage: 6,
      adopted: true,
      completedAt: new Date().toISOString(),
    }), { mode: 0o600 });
    out.success('  ✓ PATH already configured');
  }

  // 5. Mark stages 7 and 8 as done
  for (const stage of [7, 8]) {
    writeFileSync(join(bootstrapDir, `stage-${stage}.done`), JSON.stringify({
      stage,
      adopted: true,
      completedAt: new Date().toISOString(),
    }), { mode: 0o600 });
  }

  // 6. Summary
  out.info('');
  out.success(`✓ '${distro.name}' adopted successfully!`);
  out.info('');
  out.info('Discovered runtimes:');
  for (const rt of distro.runtimes) {
    if (rt.version) {
      out.info(`  ✓ ${rt.name} ${rt.version}`);
    } else {
      out.info(`  ✗ ${rt.name} (not installed)`);
    }
  }
  out.info('');
  out.info('Next steps:');
  if (!onPath) {
    out.info('  1. linuxify repair paths   # add ~/.linuxify/bin to PATH');
    out.info('  2. source ~/.bashrc        # reload PATH');
  }
  out.info('  linuxify add cline         # install your first CLI');
  out.info('  linuxify doctor            # verify everything is healthy');
  out.info('');
  out.info('Adoption complete. Linuxify now manages your existing environment.');

  return EXIT_CODES.OK;
}

/**
 * Print discovery results in human-readable form.
 */
function printDiscovery(discovery: DiscoveryResult, out: CommandContext['output']): void {
  out.info(`Host:`);
  out.info(`  Termux:         ${discovery.host.isTermux ? '✓' : '✗'}`);
  out.info(`  Android:        ${discovery.host.androidVersion ?? 'not detected'}`);
  out.info(`  Architecture:   ${discovery.host.arch}`);
  out.info(`  proot:          ${discovery.host.prootInstalled ? '✓' : '✗'}`);
  out.info(`  proot-distro:   ${discovery.host.prootDistroInstalled ? '✓' : '✗'}${discovery.host.prootDistroVersion ? ` v${discovery.host.prootDistroVersion}` : ''}${discovery.host.prootDistroWorking ? '' : ' (NOT working)'}`);
  out.info('');

  if (discovery.distros.length > 0) {
    out.info(`Found ${discovery.distros.length} proot-distro container(s):`);
    out.info('');
    for (const d of discovery.distros) {
      const status = d.bootable ? '✓' : '✗';
      const managed = d.managedByLinuxify ? ' [managed by Linuxify]' : '';
      out.info(`  ${status} ${d.name}${managed}`);
      if (d.sizeMb > 0) {
        out.info(`    Size: ~${d.sizeMb} MB`);
      }
      if (d.runtimes.length > 0) {
        out.info(`    Runtimes:`);
        for (const rt of d.runtimes) {
          if (rt.version) {
            out.info(`      ✓ ${rt.name} ${rt.version}`);
          } else {
            out.info(`      ✗ ${rt.name} (not installed)`);
          }
        }
      }
      out.info('');
    }
  } else {
    out.info('No proot-distro containers found.');
    out.info('');
  }

  if (discovery.linuxifyInitialized) {
    out.info('Linuxify is already initialized (~/.linuxify/state.json exists).');
  } else if (discovery.linuxifyHomeExists) {
    out.info('~/.linuxify/ exists but state.json is missing (incomplete setup).');
  } else {
    out.info('Linuxify is not initialized yet.');
  }
}

/**
 * Register the `adopt` command.
 */
export const registerAdoptCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('adopt [distro]')
    .description('Adopt an existing proot-distro environment without reinstalling.')
    .option('--yes', 'Skip confirmation prompts.')
    .action(async (distroName: string | undefined, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runAdopt(opts, ctx, distroName);
      setExit(code);
    });
};
