/**
 * `linuxify telemetry` — telemetry management subcommands.
 *
 * @module linuxify/cli/commands/telemetry
 *
 * Subcommands:
 *  - `linuxify telemetry show` — print the current telemetry state.
 *  - `linuxify telemetry enable` — opt in to anonymous telemetry.
 *  - `linuxify telemetry disable` — opt out.
 *  - `linuxify telemetry flush` — best-effort flush of any queued events.
 *  - `linuxify telemetry purge` — purge any persisted telemetry queue.
 *
 * The v1 implementation is backed by the `state.json#telemetry` block (see
 * `context.ts` `StateTelemetryClient`). When a real telemetry engine lands,
 * it can drop in by implementing the same `TelemetryClient` interface.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run `telemetry show`.
 */
async function runTelemetryShow(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  const enabled = await ctx.telemetry.isEnabled();
  const lastFlush = await ctx.telemetry.lastFlush();
  const userId = ctx.state.telemetry.user_id;

  if (ctx.output.json) {
    out.printJson({
      enabled,
      user_id: userId,
      last_flush: lastFlush,
      endpoint: ctx.config.telemetry.endpoint,
    });
    return EXIT_CODES.OK;
  }

  out.info(`enabled:     ${enabled ? 'yes' : 'no'}`);
  out.info(`user_id:     ${userId ?? '(not set)'}`);
  out.info(`last_flush:  ${lastFlush ?? '(never)'}`);
  out.info(`endpoint:    ${ctx.config.telemetry.endpoint}`);
  out.info(`sample_rate: ${ctx.config.telemetry.sample_rate}`);
  return EXIT_CODES.OK;
}

/**
 * Run `telemetry enable`.
 */
async function runTelemetryEnable(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  if (ctx.flags.dryRun) {
    out.info('Dry run: would enable telemetry.');
    return EXIT_CODES.OK;
  }
  await ctx.telemetry.enable();
  out.success('Telemetry enabled. Thank you for helping improve Linuxify!');
  out.info('  You can disable it at any time with: linuxify telemetry disable');
  return EXIT_CODES.OK;
}

/**
 * Run `telemetry disable`.
 */
async function runTelemetryDisable(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  if (ctx.flags.dryRun) {
    out.info('Dry run: would disable telemetry.');
    return EXIT_CODES.OK;
  }
  await ctx.telemetry.disable();
  out.success('Telemetry disabled.');
  return EXIT_CODES.OK;
}

/**
 * Run `telemetry flush`.
 */
async function runTelemetryFlush(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  if (ctx.flags.dryRun) {
    out.info('Dry run: would flush the telemetry queue.');
    return EXIT_CODES.OK;
  }
  await ctx.telemetry.flush();
  out.success('Telemetry queue flushed.');
  return EXIT_CODES.OK;
}

/**
 * Run `telemetry purge`.
 */
async function runTelemetryPurge(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  if (ctx.flags.dryRun) {
    out.info('Dry run: would purge the telemetry queue.');
    return EXIT_CODES.OK;
  }
  await ctx.telemetry.purge();
  out.success('Telemetry queue purged.');
  return EXIT_CODES.OK;
}

/**
 * Run the `telemetry` command.
 */
export async function runTelemetry(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string,
): Promise<number> {
  switch (subcommand) {
    case 'show':
      return runTelemetryShow(ctx);
    case 'enable':
      return runTelemetryEnable(ctx);
    case 'disable':
      return runTelemetryDisable(ctx);
    case 'flush':
      return runTelemetryFlush(ctx);
    case 'purge':
      return runTelemetryPurge(ctx);
    default:
      ctx.output.error(`Unknown telemetry subcommand: ${subcommand ?? '(none)'}`);
      ctx.output.info('  Available: show, enable, disable, flush, purge');
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `telemetry` command with its subcommands.
 */
export const registerTelemetryCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const telemetry = program.command('telemetry').description('Telemetry management.');

  telemetry
    .command('show')
    .description('Print the current telemetry state.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runTelemetry({}, ctx, 'show');
      setExit(code);
    });

  telemetry
    .command('enable')
    .description('Opt in to anonymous telemetry.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runTelemetry({}, ctx, 'enable');
      setExit(code);
    });

  telemetry
    .command('disable')
    .description('Opt out of telemetry.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runTelemetry({}, ctx, 'disable');
      setExit(code);
    });

  telemetry
    .command('flush')
    .description('Best-effort flush of any queued telemetry events.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runTelemetry({}, ctx, 'flush');
      setExit(code);
    });

  telemetry
    .command('purge')
    .description('Purge any persisted telemetry queue.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runTelemetry({}, ctx, 'purge');
      setExit(code);
    });
};
