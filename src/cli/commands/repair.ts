/**
 * `linuxify repair` — apply auto-repairs suggested by doctor.
 *
 * @module linuxify/cli/commands/repair
 *
 * Runs doctor, then for each failure with a `fixCommand`, executes it (with
 * confirmation unless `--yes`). Re-runs doctor at the end to confirm.
 *
 * @packageDocumentation
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';


import { formatReport, resolveFormat } from '../../doctor/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

const execAsync = promisify(exec);

/**
 * Run the `repair` command.
 */
export async function runRepair(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const checkId = typeof opts.check === 'string' ? opts.check : undefined;

  // 1. Run doctor to discover issues.
  const doctorCtx = { config: ctx.config, state: ctx.state };
  const initial = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );

  const failures = initial.results.filter((r) => r.status === 'fail' && r.fixCommand);
  if (failures.length === 0) {
    out.success('No repairable issues found.');
    return EXIT_CODES.OK;
  }

  out.info(`Doctor reported ${failures.length} repairable issue(s).`);
  if (ctx.flags.dryRun) {
    out.info('Repair plan (dry run):');
    for (const f of failures) {
      out.info(`  ${f.id}: ${f.fixCommand}`);
    }
    return EXIT_CODES.OK;
  }

  // 2. Confirm unless --yes.
  if (!ctx.flags.yes) {
    out.info('The following commands will be run:');
    for (const f of failures) {
      out.info(`  ${f.fixCommand}`);
    }
    out.info('Re-run with --yes to apply.');
    return EXIT_CODES.OK;
  }

  // 3. Execute each fix command.
  let applied = 0;
  let failed = 0;
  for (const f of failures) {
    out.progress(`Running: ${f.fixCommand}`);
    try {
      await execAsync(f.fixCommand!, { timeout: 60_000 });
      applied++;
    } catch (err) {
      failed++;
      out.warn(`Failed: ${f.fixCommand} — ${(err as Error).message}`);
      logger.warn(
        { check: f.id, cmd: f.fixCommand, err: (err as Error).message },
        'repair step failed',
      );
    }
  }

  // 4. Re-run doctor to confirm.
  const followup = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );

  const format = resolveFormat({ quiet: true });
  const rendered = formatReport(followup, format);
  if (rendered.length > 0) {
    out.info(rendered);
  }

  if (followup.summary.fail === 0) {
    out.success(`Repairs applied: ${applied}/${failures.length}. All checks now passing.`);
    return EXIT_CODES.OK;
  }
  out.warn(`Repairs applied: ${applied}/${failures.length}, failed: ${failed}.`);
  return EXIT_CODES.STEP_FAILED;
}

/**
 * Register the `repair` command.
 */
export const registerRepairCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('repair')
    .description('Apply auto-repairs suggested by doctor.')
    .option('--yes', 'Skip the confirmation prompt.')
    .option('--check <id>', 'Only run repairs for the named check.')
    .option('--dry-run', 'Print the repair plan without applying anything.')
    .option('--reset', 'Wipe state.json and re-derive it from the filesystem (last resort).')
    .option('--from-backup <path>', 'Restore from a known-good backup.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runRepair(opts, ctx);
      setExit(code);
    });
};
