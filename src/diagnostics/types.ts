/**
 * Diagnostics type definitions.
 *
 * @module linuxify/diagnostics/types
 */

/**
 * A pattern that matches against stderr/stdout and produces a diagnosis.
 */
export interface StderrPattern {
  /** Unique pattern ID (e.g., `bad-interpreter`). */
  id: string;
  /** Human-readable name (e.g., "Broken interpreter after Python upgrade"). */
  name: string;
  /** Regex matched against stderr (case-insensitive, multiline). */
  pattern: RegExp;
  /**
   * Function that produces a diagnosis from the match. Receives the regex
   * match result and the context (command, exit code, etc.) so it can
   * customize the diagnosis (e.g., extract the missing interpreter path).
   */
  diagnose: (match: RegExpMatchArray, ctx: DiagnosticContext) => Diagnosis;
}

/**
 * Context passed to diagnostic patterns.
 */
export interface DiagnosticContext {
  /** The command that was run. */
  command: string;
  /** The exit code. */
  exitCode: number;
  /** The stderr output. */
  stderr: string;
  /** The stdout output. */
  stdout: string;
  /** Optional: the package name being checked (e.g., "proot-distro"). */
  packageName?: string;
}

/**
 * A diagnosis produced by the diagnostics engine.
 */
export interface Diagnosis {
  /** Stable diagnosis ID (e.g., `bad-interpreter.python-upgrade`). */
  id: string;
  /** One-line summary (e.g., "Broken interpreter after Python upgrade"). */
  title: string;
  /** WHAT went wrong, plain English, 1-3 sentences. */
  what: string;
  /** WHY it likely happened, plain English, 1-3 sentences. */
  why: string;
  /** The matching evidence (the stderr line that triggered this diagnosis). */
  evidence: string;
  /** The exact command to fix the issue. */
  repair: string;
  /** Whether the repair is safe to auto-apply (reinstall = safe). */
  autoRepairable: boolean;
  /** Confidence 0-1. */
  confidence: number;
  /** Optional: docs URL. */
  docsUrl?: string;
}
