/**
 * Output utilities for the CLI layer.
 *
 * @module linuxify/cli/output
 *
 * The {@link Output} class is the single sink for every user-facing string the
 * CLI emits. Routing every `console.log`/`console.error` through it lets the
 * `--json`, `--quiet`, and `--no-color` flags change behavior in one place,
 * keeps the JSON output schema (see `cli-specification.md` §5) consistent, and
 * makes the CLI testable by letting tests capture stdout/stderr in isolation.
 *
 * The class never throws; print failures are swallowed because a broken stdout
 * pipe should not produce a confusing stack trace on top of the user's real
 * error.
 *
 * Colors are provided by `chalk` and respect both the `--no-color` flag and
 * the `NO_COLOR` environment variable (per the `no-color.org` standard). When
 * colors are disabled, all `chalk` calls degrade to plain-text identity
 * functions automatically — this module does not need to gate each call
 * explicitly.
 *
 * @packageDocumentation
 */

import { Chalk, type ChalkInstance } from 'chalk';

import { logger } from '../utils/log.js';

/**
 * Constructor options for {@link Output}.
 */
export interface OutputOptions {
  /** Emit machine-readable JSON instead of human text. */
  readonly json: boolean;
  /** Suppress all non-error output (overrides success/warn/progress/info). */
  readonly quiet: boolean;
  /** Force-disable ANSI color regardless of TTY detection. */
  readonly noColor: boolean;
}

/**
 * The single sink for every user-facing string the CLI emits.
 *
 * One instance is created per CLI invocation and shared via the
 * {@link CommandContext}. Every subcommand and helper that prints to the
 * terminal goes through this class so that `--json`, `--quiet`, and
 * `--no-color` are handled uniformly.
 *
 * The class intentionally exposes only the high-level methods (`info`,
 * `success`, `warn`, `error`, `table`, `printJson`, `progress`); subcommand
 * code should not reach for `process.stdout.write` directly. Diagnostic
 * logging (not user-facing) still goes through `utils/log.ts`.
 *
 * The `json` flag is exposed as a readonly boolean field so subcommands can
 * short-circuit their own JSON-emission logic (e.g. `if (out.json)
 * out.printJson(...)`).
 *
 * @example
 * ```ts
 * const out = new Output({ json: false, quiet: false, noColor: false });
 * out.success('Linuxify initialized.');
 * out.warn('Cache is 7 days old; consider running `linuxify update`.');
 * out.error('Failed to download rootfs.');
 * ```
 */
export class Output {
  /** Whether `--json` was passed on the command line. */
  readonly json: boolean;
  /** Whether `--quiet` was passed on the command line. */
  readonly quiet: boolean;
  /** Whether `--no-color` was passed (or `NO_COLOR` is set). */
  readonly noColor: boolean;

  /**
   * Dedicated chalk instance, configured to respect `--no-color`.
   *
   * `chalk` v5 auto-disables colors when `NO_COLOR` is set or stdout is not a
   * TTY. We additionally force-disable colors when `--no-color` is given by
   * constructing a fresh `Chalk` instance with `level: 0`. The result is
   * shared across every method so we pay the configuration cost once.
   */
  private readonly chalk: ChalkInstance;

  constructor(opts: OutputOptions) {
    this.json = opts.json;
    this.quiet = opts.quiet;
    this.noColor = opts.noColor || process.env.NO_COLOR !== undefined;
    this.chalk = new Chalk({ level: this.noColor ? 0 : 1 });
  }

  /**
   * Print an informational message to stdout.
   *
   * Suppressed when `--quiet` is set (unless `--json` is also set, in which
   * case the caller should use {@link printJson} instead). Color is not
   * applied — info lines are meant to be plain prose between status markers.
   *
   * @param msg - The message to print.
   */
  info(msg: string): void {
    if (this.quiet || this.json) return;
    this.writeStdout(`${msg}\n`);
  }

  /**
   * Print a success message prefixed with a green `✔` (or `[ok]` when color
   * is disabled).
   *
   * Suppressed under `--quiet` and `--json`. The prefix glyph and the
   * message text are separated by a single space.
   *
   * @param msg - The success message.
   */
  success(msg: string): void {
    if (this.quiet || this.json) return;
    const mark = this.noColor ? '[ok]' : this.chalk.green('✔');
    this.writeStdout(`${mark} ${msg}\n`);
  }

  /**
   * Print a warning message prefixed with a yellow `⚠` (or `[!]` when color
   * is disabled). Warnings are NOT suppressed by `--quiet` (callers may still
   * want to know about degraded behavior) but ARE suppressed by `--json`
   * (warnings surface as structured `warnings[]` entries in the JSON output).
   *
   * @param msg - The warning message.
   */
  warn(msg: string): void {
    if (this.json) return;
    const mark = this.noColor ? '[!]' : this.chalk.yellow('⚠');
    this.writeStdout(`${mark} ${msg}\n`);
  }

  /**
   * Print an error message to stderr prefixed with a red `✖` (or `[x]` when
   * color is disabled). Errors are never suppressed — not by `--quiet` and
   * not by `--json` — because the JSON error payload is emitted separately by
   * the router's error handler. The CLI convention is that the human error
   * line is always visible so a user piping to `less` still sees what went
   * wrong.
   *
   * @param msg - The error message.
   */
  error(msg: string): void {
    const mark = this.noColor ? '[x]' : this.chalk.red('✖');
    this.writeStderr(`${mark} ${msg}\n`);
  }

  /**
   * Print a progress message. Progress lines are meant to be transient
   * (overwritten by the next line in a TTY) but this implementation prints
   * them as plain lines for portability with pipes and logs. Suppressed under
   * `--quiet` and `--json`.
   *
   * @param msg - The progress message.
   */
  progress(msg: string): void {
    if (this.quiet || this.json) return;
    const prefix = this.noColor ? '[..]' : this.chalk.cyan('↓');
    this.writeStdout(`${prefix} ${msg}\n`);
  }

  /**
   * Print a structured object as a JSON document to stdout. This is the
   * machine-readable output mode; when `--json` is set, every command's
   * final result is emitted through this method. The output is a single line
   * per call (no indentation) to keep line-oriented tools (`jq -c`, `grep`,
   * `awk`) working.
   *
   * @param data - The value to serialize. Must be JSON-serializable.
   */
  printJson(data: unknown): void {
    try {
      this.writeStdout(`${JSON.stringify(data)}\n`);
    } catch (err) {
      // Should not happen for any well-formed payload, but a circular
      // reference would throw — degrade to a placeholder and log.
      logger.error({ err: (err as Error).message }, 'failed to serialize JSON output');
      this.writeStdout('{"ok":false,"error":"internal: json serialization failed"}\n');
    }
  }

  /**
   * Print a list of row objects as an aligned text table.
   *
   * Column headers are derived from the union of every row's keys (in
   * insertion order of the first appearance). Values are stringified; long
   * values are not truncated (the terminal will wrap them). The table is
   * suppressed under `--quiet` and replaced with a JSON array under `--json`.
   *
   * Empty `rows` prints a `No results.` message (still suppressed under
   * `--quiet`).
   *
   * @param rows - The rows to print. Each row is a plain object.
   */
  table(rows: readonly unknown[]): void {
    if (this.json) {
      this.printJson(rows);
      return;
    }
    if (this.quiet) return;
    if (rows.length === 0) {
      this.writeStdout('No results.\n');
      return;
    }
    const headers = this.collectHeaders(rows);
    const lines: string[] = [];
    const headerLine = headers
      .map((h) => (this.noColor ? h.toUpperCase() : this.chalk.bold(h.toUpperCase())))
      .join('  ');
    lines.push(headerLine);
    const sepLine = headers.map((h) => '─'.repeat(Math.max(h.length, 4))).join('  ');
    lines.push(sepLine);
    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      lines.push(headers.map((h) => this.formatCell(obj[h])).join('  '));
    }
    this.writeStdout(`${lines.join('\n')}\n`);
  }

  /**
   * Print a newline. Useful between sections of human output. Suppressed
   * under `--quiet` and `--json`.
   */
  blank(): void {
    if (this.quiet || this.json) return;
    this.writeStdout('\n');
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * Collect the ordered list of header keys across all rows. The first row
   * that defines a key determines its column position. Rows that omit a key
   * leave that column blank.
   */
  private collectHeaders(rows: readonly unknown[]): string[] {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of rows) {
      const obj = row as Record<string, unknown>;
      if (obj === null || typeof obj !== 'object') continue;
      for (const key of Object.keys(obj)) {
        if (!seen.has(key)) {
          seen.add(key);
          ordered.push(key);
        }
      }
    }
    return ordered;
  }

  /**
   * Format a single cell value as a string for table output. `undefined` and
   * `null` become the empty string; objects are JSON-stringified; everything
   * else goes through `String()`.
   */
  private formatCell(value: unknown): string {
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return '[object]';
      }
    }
    return String(value);
  }

  /**
   * Write a string to stdout, swallowing any error (broken pipe, etc.). A
   * broken stdout pipe should not crash the CLI on top of whatever else is
   * happening; the underlying error is logged via the diagnostic logger.
   */
  private writeStdout(s: string): void {
    try {
      process.stdout.write(s);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'stdout write failed');
    }
  }

  /**
   * Write a string to stderr, swallowing any error. See {@link writeStdout}
   * for the rationale.
   */
  private writeStderr(s: string): void {
    try {
      process.stderr.write(s);
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'stderr write failed');
    }
  }
}
