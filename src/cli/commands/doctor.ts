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
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runDoctor(opts, ctx);
      setExit(code);
    });
};
