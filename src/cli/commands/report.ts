/**
 * `linuxify report` command — generates an environment report for bug filing.
 *
 * Output formats:
 *   - `--text` (default): human-readable, ANSI if TTY
 *   - `--json`: machine-readable
 *   - `--markdown`: fenced code block for GitHub issues
 *   - `--fingerprint`: compact one-liner
 *
 * Usage:
 *   linuxify report
 *   linuxify report --markdown
 *   linuxify report --json > report.json
 *   linuxify report --fingerprint
 *
 * Exit codes:
 *   0 — report generated successfully
 *   1 — generation failed
 */

import { logger } from '../../utils/log.js';
import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';
import type { RegisterCommandFn } from './index.js';
import { generateReport, formatReport, type ReportFormat } from '../../report/index.js';

/**
 * Implement the `linuxify report` command.
 */
export async function runReport(
  opts: { json?: boolean; markdown?: boolean; fingerprint?: boolean },
  ctx: CommandContext,
): Promise<number> {
  try {
    const report = await generateReport({
      config: ctx.config,
      stateStore: ctx.stateStore,
      doctorEngine: ctx.doctor,
    });

    const format: ReportFormat = opts.fingerprint
      ? 'fingerprint'
      : opts.json
        ? 'json'
        : opts.markdown
          ? 'markdown'
          : 'text';

    const output = formatReport(report, format);
    ctx.output.info(output);

    if (report.warnings.length > 0 && format === 'text') {
      // Warnings are already in the text output; for JSON/markdown, the
      // warnings field is in the report itself.
    }

    return EXIT_CODES.OK;
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'report generation failed');
    ctx.output.error(`Failed to generate report: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `report` command with the CLI.
 */
export const registerReportCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('report')
    .description('Generate an environment report for bug filing and support.')
    .option('--json', 'Emit machine-readable JSON (linuxify.report.v1 schema).')
    .option('--markdown', 'Emit a fenced code block suitable for GitHub issues.')
    .option('--fingerprint', 'Emit a compact one-line fingerprint only.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runReport(opts as { json?: boolean; markdown?: boolean; fingerprint?: boolean }, ctx);
      setExit(code);
    });
};
