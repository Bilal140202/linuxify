/**
 * Doctor output formatters.
 *
 * @module linuxify/doctor/output
 *
 * Four output formats, all rendering the same underlying {@link DoctorReport}:
 *
 * 1. `formatHuman` — colored, grouped by category, summary footer (default).
 * 2. `formatJson` — `linuxify.doctor.v1` JSON schema, 2-space indented.
 * 3. `formatMarkdown` — GitHub-issue-friendly Markdown table.
 * 4. `formatQuiet` — only failures, plain text, one per line.
 *
 * Color is provided by `chalk` and respects the `NO_COLOR` env var (chalk v5
 * auto-disables when `NO_COLOR` is set, so this module does not need to
 * check explicitly — but it does check `process.env.NO_COLOR` to skip the
 * import side effects in unit tests that assert on plain text).
 *
 * @packageDocumentation
 */

import chalk from 'chalk';

import type { DoctorCategory, DoctorReport, DoctorResult, DoctorStatus } from './types.js';

/**
 * Schema version embedded in JSON output. Bumped on every breaking change to
 * the JSON shape; documented as part of the public API in
 * `docs/07-doctor/doctor-engine.md` §5.
 */
export const DOCTOR_JSON_SCHEMA = 'linuxify.doctor.v1';

/**
 * Width of the gutter column (status symbol + spaces) in human output.
 * Keeps the name column aligned across all rows.
 */
const HUMAN_GUTTER_WIDTH = 4;

/**
 * Width of the name column in human output. Names longer than this are
 * truncated with an ellipsis.
 */
const HUMAN_NAME_WIDTH = 18;

/**
 * Render a status as a colored symbol for human output.
 *
 * - `ok`      → green `✔`
 * - `warn`    → yellow `⚠`
 * - `fail`    → red `✖`
 * - `missing` → magenta `✖`
 * - `skip`    → gray `·`
 *
 * @param status - The status to render.
 * @returns The colored symbol string.
 */
function statusSymbol(status: DoctorStatus): string {
  switch (status) {
    case 'ok':
      return chalk.green('✔');
    case 'warn':
      return chalk.yellow('⚠');
    case 'fail':
      return chalk.red('✖');
    case 'missing':
      return chalk.magenta('✖');
    case 'skip':
      return chalk.gray('·');
    default:
      return chalk.gray('?');
  }
}

/**
 * Pad or truncate a string to exactly `width` columns. Strings longer than
 * `width` are truncated and suffixed with `…`; shorter strings are
 * right-padded with spaces.
 *
 * @param s - The string to fit.
 * @param width - The target column width.
 * @returns The fitted string, exactly `width` characters wide.
 */
function fit(s: string, width: number): string {
  if (s.length === width) return s;
  if (s.length > width) return s.slice(0, Math.max(0, width - 1)) + '…';
  return s + ' '.repeat(width - s.length);
}

/**
 * Human-readable category label for the section header in human output.
 *
 * @param category - The category to label.
 * @returns Title-case label (e.g. `Host`, `Bootstrap`).
 */
function categoryLabel(category: DoctorCategory): string {
  switch (category) {
    case 'host':
      return 'Host';
    case 'bootstrap':
      return 'Bootstrap';
    case 'distro':
      return 'Distro';
    case 'runtime':
      return 'Runtime';
    case 'path':
      return 'Path';
    case 'packages':
      return 'Packages';
    case 'compat':
      return 'Compatibility';
    case 'network':
      return 'Network';
    case 'services':
      return 'Services';
    default:
      return String(category);
  }
}

/**
 * Group results by category, preserving the order in which categories first
 * appear in `results`. Within a category, results keep their original order.
 *
 * @param results - The flat results list.
 * @returns An array of `[category, results[]]` tuples in category-first-seen order.
 */
function groupByCategory(results: readonly DoctorResult[]): Array<[DoctorCategory, DoctorResult[]]> {
  const order: DoctorCategory[] = [];
  const map = new Map<DoctorCategory, DoctorResult[]>();
  for (const r of results) {
    let bucket = map.get(r.category);
    if (!bucket) {
      bucket = [];
      map.set(r.category, bucket);
      order.push(r.category);
    }
    bucket.push(r);
  }
  return order.map((c) => [c, map.get(c) ?? []]);
}

/**
 * Render the report as colored human-readable text, grouped by category,
 * with a summary footer. Designed for a phone screen in portrait orientation
 * (lines wrapped at 80 columns by the terminal, not by this formatter —
 * individual result rows are kept short).
 *
 * Respects `NO_COLOR`: chalk auto-disables when that env var is set, so the
 * output degrades to plain text without any code changes here.
 *
 * @param report - The report to render.
 * @returns The formatted string (no trailing newline).
 */
export function formatHuman(report: DoctorReport): string {
  const lines: string[] = [];
  const bar = '─'.repeat(48);

  lines.push('');
  lines.push(`Linuxify v${report.linuxifyVersion}`);
  lines.push(bar);
  lines.push(`Profile    ${report.profile}`);
  lines.push(`Timestamp  ${report.timestamp}`);
  lines.push(`Duration   ${report.durationMs} ms`);
  lines.push(bar);

  const groups = groupByCategory(report.results);
  for (const [category, items] of groups) {
    lines.push('');
    lines.push(chalk.bold(categoryLabel(category)));
    for (const r of items) {
      const sym = statusSymbol(r.status);
      const name = fit(r.name, HUMAN_NAME_WIDTH);
      const gutter = ' '.repeat(HUMAN_GUTTER_WIDTH);
      lines.push(`${sym}${gutter}${name}  ${r.message}`);
    }
  }

  lines.push('');
  lines.push(bar);
  const { ok, warn, fail, missing, skip, total } = report.summary;
  lines.push(
    `Total: ${total}  OK: ${ok}  Warn: ${warn}  Fail: ${fail}  Missing: ${missing}  Skip: ${skip}`,
  );

  const issueCount = warn + fail + missing;
  if (issueCount > 0) {
    lines.push(chalk.red(`${issueCount} issue${issueCount === 1 ? '' : 's'} found. Run: linuxify repair`));
  } else {
    lines.push(chalk.green('All checks passed.'));
  }

  return lines.join('\n');
}

/**
 * Render the report as JSON following the `linuxify.doctor.v1` schema. The
 * output is pretty-printed with a 2-space indent and ends with a trailing
 * newline (matching `JSON.stringify` + `\n`).
 *
 * The schema is documented in `docs/07-doctor/doctor-engine.md` §5.2 and is
 * part of the public API: breaking changes require a major version bump.
 *
 * @param report - The report to render.
 * @returns The JSON string.
 */
export function formatJson(report: DoctorReport): string {
  const payload = {
    schema: DOCTOR_JSON_SCHEMA,
    linuxifyVersion: report.linuxifyVersion,
    timestamp: report.timestamp,
    profile: report.profile,
    durationMs: report.durationMs,
    results: report.results,
    summary: report.summary,
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Escape a table cell value for Markdown: pipes are replaced with `\|`,
 * newlines with spaces. Values are coerced to strings.
 *
 * @param value - The cell value.
 * @returns The escaped string.
 */
function escapeMarkdownCell(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * Render a status as a short Markdown badge (no color — Markdown consumers
 * like GitHub render their own colors).
 *
 * @param status - The status to render.
 * @returns A short token: `OK`, `WARN`, `FAIL`, `MISSING`, or `SKIP`.
 */
function statusToken(status: DoctorStatus): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
    case 'missing':
      return 'MISSING';
    case 'skip':
      return 'SKIP';
    default:
      return String(status);
  }
}

/**
 * Render the report as a Markdown document with a summary header and a
 * results table. Suitable for pasting directly into a GitHub issue body.
 *
 * @param report - The report to render.
 * @returns The Markdown string.
 */
export function formatMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('# Linuxify Doctor Report');
  lines.push('');
  lines.push(`- **Linuxify version**: ${report.linuxifyVersion}`);
  lines.push(`- **Profile**: ${report.profile}`);
  lines.push(`- **Timestamp**: ${report.timestamp}`);
  lines.push(`- **Duration**: ${report.durationMs} ms`);
  const { ok, warn, fail, missing, skip, total } = report.summary;
  lines.push(
    `- **Summary**: ${total} total — OK: ${ok}, Warn: ${warn}, Fail: ${fail}, Missing: ${missing}, Skip: ${skip}`,
  );
  lines.push('');

  if (report.results.length === 0) {
    lines.push('_No checks ran._');
    return lines.join('\n');
  }

  lines.push('| ID | Name | Category | Status | Message | Fix |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of report.results) {
    const fix = r.fixCommand ?? '';
    lines.push(
      `| ${escapeMarkdownCell(r.id)} | ${escapeMarkdownCell(r.name)} | ${escapeMarkdownCell(r.category)} | ${statusToken(r.status)} | ${escapeMarkdownCell(r.message)} | ${escapeMarkdownCell(fix)} |`,
    );
  }
  return lines.join('\n');
}

/**
 * Render the report in quiet mode: one line per failing result, plain text,
 * no color. Format: `<id>: <status>: <message>`. Passing checks are omitted.
 *
 * Designed for shell scripts that want to detect issues without parsing
 * color codes.
 *
 * @param report - The report to render.
 * @returns The quiet text (one line per failing result; trailing newline
 *   only if at least one failing result exists).
 */
export function formatQuiet(report: DoctorReport): string {
  const failing = report.results.filter(
    (r) => r.status === 'fail' || r.status === 'warn' || r.status === 'missing',
  );
  if (failing.length === 0) return '';
  return failing.map((r) => `${r.id}: ${r.status}: ${r.message}`).join('\n');
}

/**
 * Dispatch to the right formatter by name. Used by the engine's
 * `formatReport` helper and by tests.
 *
 * @param report - The report to render.
 * @param format - The desired format.
 * @returns The formatted string.
 */
export function formatReport(
  report: DoctorReport,
  format: 'human' | 'json' | 'markdown' | 'quiet',
): string {
  switch (format) {
    case 'human':
      return formatHuman(report);
    case 'json':
      return formatJson(report);
    case 'markdown':
      return formatMarkdown(report);
    case 'quiet':
      return formatQuiet(report);
    default:
      return formatHuman(report);
  }
}
