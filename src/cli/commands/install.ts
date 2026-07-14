/**
 * `linuxify install` — interactive alias for `init`.
 *
 * @module linuxify/cli/commands/install
 *
 * Per `cli-specification.md` §4, `install` is the interactive form of `init`:
 * it prompts the user to choose a distro, confirm shell-rc modification, and
 * select runtimes. Scripts and CI should call `init --yes` directly. The v1
 * implementation delegates to {@link runInit} and converts `--non-interactive`
 * to `--yes` semantics.
 *
 * @packageDocumentation
 */


import type { CommandContext } from '../context.js';

import { runInit } from './init.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `install` command.
 */
export async function runInstall(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const nonInteractive = !!(opts.nonInteractive);

  if (!nonInteractive && !ctx.flags.yes) {
    out.info('Welcome to Linuxify. This will set up a Linux environment on your device.');
    out.info('Choose a distro: ubuntu (default), debian, arch, alpine');
    out.info('Run `linuxify init --distro <name> --yes` to skip prompts.');
    out.info('Proceeding with the default distro (ubuntu)…');
  }

  // Delegate to init's run function. We pass through the same options so the
  // user's `--force` / `--offline` flags are honored.
  return runInit(opts, ctx);
}

/**
 * Register the `install` command.
 */
export const registerInstallCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('install')
    .description('Interactive alias for `init`. Scripts should call `init --yes`.')
    .option('--force', 'Re-run every stage regardless of existing markers.')
    .option('--offline', 'Use a pre-bundled tarball; skip network probes.')
    .option('--bundle <path>', 'Path to the offline bundle tarball.')
    .option('--non-interactive', 'Convert back to `init --yes` semantics.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runInstall(opts, ctx);
      setExit(code);
    });
};
