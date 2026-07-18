/**
 * `linuxify doctor` — run health checks and print a report.
 *
 * @module linuxify/cli/commands/doctor
 *
 * Creates a {@link DoctorEngine}, runs the selected profile's checks, formats
 * the report (human / JSON / markdown / quiet), and prints it. Exit codes:
 * 0 if all ok, 1 if warnings, 2 if failures (per `cli-specification.md` §6).
 *
 * Flags:
 *  - `--profile <name>`: select a built-in profile (minimal, standard, deep,
 *    pre-flight, post-install, ci).
 *  - `--json`: emit `linuxify.doctor.v1` JSON.
 *  - `--markdown`: emit a GitHub-friendly Markdown table.
 *  - `--quiet`: only print failures, one per line.
 *  - `--check <id>`: run only the named check (overrides the profile).
 *  - `--ci`: elevate warnings to failures for exit-code purposes.
 *  - `--explain`: for each failing check, show "why this matters" — a
 *    plain-English explanation of what the check verifies, why it matters
 *    for running Linux CLIs on Android, what breaks if it's not fixed, and
 *    the recommended fix command. Lowers the learning curve for new users.
 *
 * @packageDocumentation
 */


import {
  ALL_PROFILES,
  formatReport,
  isBuiltinProfile,
  resolveFormat,
  type DoctorProfile,
} from '../../doctor/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import type { DoctorCheck } from '../../doctor/types.js';
import { listChecks } from '../../doctor/checks/index.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `doctor` command.
 */
export async function runDoctor(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;

  // ── --explain mode: show "why this matters" for failing checks ──────
  if (!!(opts.explain)) {
    return runExplain(opts, ctx);
  }

  // Resolve the profile (default `standard`).
  const profileRaw = typeof opts.profile === 'string' ? opts.profile : 'standard';
  if (!isBuiltinProfile(profileRaw)) {
    out.error(
      `Unknown profile '${profileRaw}'. Available: ${ALL_PROFILES.join(', ')}.`,
    );
    return EXIT_CODES.GENERIC_ERROR;
  }
  const profile = profileRaw as DoctorProfile;

  // Resolve --check (overrides the profile filter).
  const checkIds =
    typeof opts.check === 'string' ? [opts.check] : undefined;

  // Run the doctor.
  const doctorCtx = {
    config: ctx.config,
    state: ctx.state,
  };
  const report = await ctx.doctor.run(
    {
      profile,
      json: !!(opts.json),
      markdown: !!(opts.markdown),
      quiet: !!(opts.quiet),
      checkIds,
    },
    doctorCtx,
  );

  // Pick the format.
  const format = resolveFormat({
    json: !!(opts.json),
    markdown: !!(opts.markdown),
    quiet: !!(opts.quiet),
  });

  const rendered = formatReport(report, format);
  // The doctor's JSON/markdown formatters already include a trailing
  // newline; we emit the rendered string via the output formatter so
  // --quiet can still suppress it if the caller really wants silence.
  if (format === 'json') {
    out.printJson(JSON.parse(rendered));
  } else {
    out.info(rendered);
  }

  // Compute the exit code. CI mode elevates warnings to failures.
  const ci = !!(opts.ci);
  const { fail, warn } = report.summary;
  if (fail > 0) {
    logger.info({ fail, warn }, 'doctor: exiting with failures');
    return EXIT_CODES.STEP_FAILED;
  }
  if (ci && warn > 0) {
    logger.info({ warn }, 'doctor: --ci elevates warnings to failures');
    return EXIT_CODES.GENERIC_ERROR;
  }
  if (warn > 0) {
    return EXIT_CODES.GENERIC_ERROR;
  }
  return EXIT_CODES.OK;
}

/**
 * `--explain` mode: run doctor, then for each failing check, print a
 * detailed "why this matters" explanation.
 *
 * The explanation comes from the check's static `explain` field (see
 * {@link DoctorCheck.explain}). It's written for a new user who doesn't
 * know what PATH is, what proot does, or why `process.platform` matters.
 */
async function runExplain(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;

  // Run doctor first to find failures.
  const doctorCtx = {
    config: ctx.config,
    state: ctx.state,
  };
  const report = await ctx.doctor.run(
    {
      profile: 'standard',
      quiet: true,
      checkIds: typeof opts.check === 'string' ? [opts.check] : undefined,
    },
    doctorCtx,
  );

  const failing = report.results.filter(
    (r) => r.status === 'fail' || r.status === 'missing',
  );
  const warnings = report.results.filter((r) => r.status === 'warn');

  if (failing.length === 0 && warnings.length === 0) {
    out.success('No issues found. Nothing to explain.');
    return EXIT_CODES.OK;
  }

  // Build a lookup from check ID to the DoctorCheck object (which has `explain`).
  const allChecks = listChecks();
  const checkMap = new Map<string, DoctorCheck>();
  for (const c of allChecks) {
    checkMap.set(c.id, c);
  }

  out.info('');
  if (failing.length > 0) {
    out.info(`Failing checks (${failing.length}):`);
    out.info('');
    for (const result of failing) {
      const check = checkMap.get(result.id);
      printExplanation(result.id, result.message, result.status, check, out);
    }
  }

  if (warnings.length > 0) {
    out.info('');
    out.info(`Warnings (${warnings.length}):`);
    out.info('');
    for (const result of warnings) {
      const check = checkMap.get(result.id);
      printExplanation(result.id, result.message, result.status, check, out);
    }
  }

  out.info('');
  out.info('To apply fixes, run: linuxify repair');
  out.info('For AI-assisted diagnosis, run: linuxify fix');

  return failing.length > 0 ? EXIT_CODES.STEP_FAILED : EXIT_CODES.GENERIC_ERROR;
}

/**
 * Print a single check's explanation in the "why this matters" format.
 */
function printExplanation(
  checkId: string,
  message: string,
  status: string,
  check: DoctorCheck | undefined,
  out: CommandContext['output'],
): void {
  const icon = status === 'fail' ? '✖' : status === 'warn' ? '⚠' : '·';
  out.info(`━━━ ${icon} ${checkId} ━━━`);
  out.info(`  Status:  ${status}`);
  out.info(`  Issue:   ${message}`);

  if (check?.explain) {
    out.info('');
    out.info(`  What this checks:`);
    out.info(`    ${check.explain.what}`);
    out.info('');
    out.info(`  Why it matters:`);
    out.info(`    ${check.explain.why}`);
    out.info('');
    out.info(`  If not fixed:`);
    out.info(`    ${check.explain.consequence}`);
    out.info('');
    out.info(`  Recommended fix:`);
    out.info(`    ${check.explain.fix}`);
  } else {
    out.info('');
    out.info(`  (No explanation available for this check.)`);
  }
  out.info('');
}

/**
 * Register the `doctor` command.
 */
export const registerDoctorCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('doctor')
    .description('Run health checks and print a report.')
    .option('--profile <name>', 'Select a built-in profile (minimal, standard, deep, …).')
    .option('--json', 'Emit linuxify.doctor.v1 JSON.')
    .option('--markdown', 'Emit a Markdown table suitable for a GitHub issue.')
    .option('--quiet', 'Only print failures, one per line.')
    .option('--check <id>', 'Run only the named check (overrides the profile).')
    .option('--ci', 'Elevate warnings to failures for exit-code purposes.')
    .option('--explain', 'Explain why each failing check matters and how to fix it.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runDoctor(opts, ctx);
      setExit(code);
    });
};
