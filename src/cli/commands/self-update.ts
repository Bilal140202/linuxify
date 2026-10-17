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
 * Exit-code policy (AUDIT-1-016): the placeholder returns
 * {@link EXIT_CODES.GENERIC_ERROR} rather than {@link EXIT_CODES.OK} so CI
 * scripts that call `linuxify self-update && <next-step>` do not silently
 * proceed past a no-op. The `--check` flag (availability probe only) is
 * exempt and still returns OK because the absence of an update is not a
 * failure. The dry-run path also returns OK because it is purely
 * informational.
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
    // `--check` is an availability probe — the absence of an update is not a
    // failure, so we return OK. (We still tell the user the implementation
    // is pending.)
    out.info('Self-update --check is not implemented in this build.');
    out.info('  Visit https://github.com/Bilal140202/linuxify/releases for the latest version.');
    return EXIT_CODES.OK;
  }

  if (ctx.flags.dryRun) {
    // Dry-run is informational only — return OK.
    out.info('Dry run: would check for and apply a self-update.');
    return EXIT_CODES.OK;
  }

  // The full implementation requires a signed-tarball release pipeline; it
  // is scheduled for v1.1. Print a friendly message and exit with
  // GENERIC_ERROR so CI scripts that gate on `linuxify self-update` failing
  // fast instead of silently proceeding (AUDIT-1-016).
  out.info('Self-update is not yet implemented in this build.');
  out.info('  To update manually: npm install -g linuxify-cli@latest');
  out.info('  Or visit: https://github.com/Bilal140202/linuxify/releases');
  return EXIT_CODES.GENERIC_ERROR;
}

/**
 * Register the `self-update` command.
 */
export const registerSelfUpdateCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  // AUDIT-1-016: `--to`, `--prerelease`, and `--force` were previously
  // declared but never read — they gave users the false impression that
  // the placeholder implementation could pin a target version, accept
  // prerelease builds, or force an update past a version-current check.
  // Removed; Commander now rejects them as unknown options. The only
  // accepted flags are `--check` (availability probe) and `--channel
  // <name>` (display-only in the placeholder).
  program
    .command('self-update')
    .description('Update the Linuxify CLI itself.')
    .option('--check', 'Only report availability; do not apply.')
    .option('--channel <name>', 'Release channel (stable | prerelease).')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runSelfUpdate(opts, ctx);
      setExit(code);
    });
};
