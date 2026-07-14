/**
 * `linuxify init` — bootstrap the Linuxify environment.
 *
 * @module linuxify/cli/commands/init
 *
 * Runs the nine-stage bootstrap pipeline (preflight → host deps → rootfs →
 * first-boot → runtimes → home setup → PATH wiring → verify → tips) and
 * prints progress per stage. On success the user is greeted with a welcome
 * banner pointing at `linuxify add`; on failure the user is told to run
 * `linuxify repair`.
 *
 * Flags:
 *  - `--force`: re-run every stage regardless of `.done` markers.
 *  - `--from-stage <N>`: resume from stage N (0..8).
 *  - `--offline`: use a pre-bundled tarball; skip network probes.
 *  - `--bundle <path>`: path to the offline bundle.
 *
 * @packageDocumentation
 */


import { bootstrap, type StageId } from '../../bootstrap/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `init` command.
 *
 * @param opts - Commander options object.
 * @param ctx - The shared command context.
 * @returns The exit code.
 */
export async function runInit(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const force = !!(opts.force);
  const offline = !!(opts.offline) || ctx.flags.offline;
  const bundlePath = typeof opts.bundle === 'string' ? opts.bundle : undefined;
  const fromStageRaw = opts.fromStage;
  let fromStage: StageId | undefined;
  if (typeof fromStageRaw === 'string') {
    const n = Number.parseInt(fromStageRaw, 10);
    if (n >= 0 && n <= 8) {
      fromStage = n as StageId;
    }
  }

  if (ctx.flags.dryRun) {
    out.info('Dry run: would bootstrap with the following options:');
    out.info(`  force: ${force}`);
    out.info(`  from-stage: ${fromStage ?? '(start)'}`);
    out.info(`  offline: ${offline}`);
    if (bundlePath) out.info(`  bundle: ${bundlePath}`);
    return EXIT_CODES.OK;
  }

  out.progress('Starting Linuxify bootstrap…');
  const result = await bootstrap({ force, fromStage, offline, bundlePath });

  if (result.failedStage !== null) {
    out.error(
      `Bootstrap failed at stage ${result.failedStage}: ${result.error ?? 'unknown error'}`,
    );
    out.info('Recovery options:');
    out.info(`  linuxify init --from-stage ${result.failedStage}`);
    out.info('  linuxify repair');
    logger.warn({ failedStage: result.failedStage, error: result.error }, 'bootstrap failed');
    return EXIT_CODES.STEP_FAILED;
  }

  out.success('Linuxify initialized.');
  out.info('Welcome! Next steps:');
  out.info('  linuxify search <query>     # find a package');
  out.info('  linuxify add <package>      # install a package');
  out.info('  linuxify doctor             # run health checks');
  return EXIT_CODES.OK;
}

/**
 * Register the `init` command with the commander program.
 */
export const registerInitCommand: RegisterCommandFn = (
  program,
  getCtx,
  setExit,
): void => {
  program
    .command('init')
    .description('Bootstrap the Linuxify environment (proot, distro, runtimes, PATH).')
    .option('--force', 'Re-run every stage regardless of existing markers.')
    .option('--from-stage <n>', 'Resume from stage N (0..8).')
    .option('--offline', 'Use a pre-bundled tarball; skip network probes.')
    .option('--bundle <path>', 'Path to the offline bundle tarball.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runInit(opts, ctx);
      setExit(code);
    });
};
