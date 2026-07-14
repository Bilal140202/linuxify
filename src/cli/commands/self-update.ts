/**
 * `linuxify self-update` — update the Linuxify CLI itself.
 *
 * @module linuxify/cli/commands/self-update
 *
 * The v1 implementation is a placeholder: it prints the current version and
 * a pointer to the project's GitHub releases. The real implementation
 * (download → verify → swap binary → run migrations) lands in v1.1 alongside
 * the release-pipeline tooling (see `docs/14-cicd/release-pipeline.md`).
 *
 * @packageDocumentation
 */


import { EXIT_CODES, LINUXIFY_VERSION } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `self-update` command.
 */
export async function runSelfUpdate(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const check = !!(opts.check);
  const channel = typeof opts.channel === 'string' ? opts.channel : 'stable';

  out.info(`Current version: ${LINUXIFY_VERSION} (channel: ${channel})`);

  if (check) {
    out.info('Self-update --check is not implemented in this build.');
    out.info('  Visit https://github.com/Bilal140202/linuxify/releases for the latest version.');
    return EXIT_CODES.OK;
  }

  if (ctx.flags.dryRun) {
    out.info('Dry run: would check for and apply a self-update.');
    return EXIT_CODES.OK;
  }

  // The full implementation requires a signed-tarball release pipeline; it
  // is scheduled for v1.1. For now we print a friendly message and exit 0
  // so CI scripts that call `linuxify self-update` don't break.
  out.info('Self-update is not yet implemented in this build.');
  out.info('  To update manually: npm install -g linuxify@latest');
  out.info('  Or visit: https://github.com/Bilal140202/linuxify/releases');
  return EXIT_CODES.OK;
}

/**
 * Register the `self-update` command.
 */
export const registerSelfUpdateCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('self-update')
    .description('Update the Linuxify CLI itself.')
    .option('--check', 'Only report availability; do not apply.')
    .option('--to <version>', 'Pin the target version.')
    .option('--channel <name>', 'Release channel (stable | prerelease).')
    .option('--prerelease', 'Allow prerelease versions.')
    .option('--force', 'Force the update even if the version is current.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runSelfUpdate(opts, ctx);
      setExit(code);
    });
};
