/**
 * Diagnostics engine — matches error output against patterns to produce
 * specific diagnoses with targeted repair commands.
 *
 * @module linuxify/diagnostics/engine
 */

import { logger } from '../utils/log.js';
import { builtinPatterns } from './patterns.js';
import type { Diagnosis, DiagnosticContext, StderrPattern } from './types.js';

/**
 * All registered patterns (built-in + any added via plugins in the future).
 */
const allPatterns: StderrPattern[] = [...builtinPatterns];

/**
 * Register a custom diagnostic pattern (for plugins).
 */
export function registerPattern(pattern: StderrPattern): void {
  allPatterns.unshift(pattern); // Custom patterns take priority
  logger.debug({ patternId: pattern.id }, 'registered diagnostic pattern');
}

/**
 * Diagnose an error by matching stderr/stdout against known patterns.
 *
 * @param ctx - The context (command, exit code, stderr, stdout).
 * @returns A diagnosis if a pattern matched, or null if no pattern matched.
 */
export function diagnoseError(ctx: DiagnosticContext): Diagnosis | null {
  const combinedOutput = `${ctx.stderr}\n${ctx.stdout}`;

  for (const pattern of allPatterns) {
    const match = pattern.pattern.exec(combinedOutput);
    if (match) {
      const diagnosis = pattern.diagnose(match, ctx);
      logger.info(
        { patternId: pattern.id, diagnosisId: diagnosis.id, confidence: diagnosis.confidence },
        'diagnosed error',
      );
      return diagnosis;
    }
  }

  // No pattern matched — return null so the caller can show a generic message.
  logger.info({ command: ctx.command, exitCode: ctx.exitCode }, 'no diagnostic pattern matched');
  return null;
}

/**
 * Format a diagnosis for human-readable display.
 *
 * Produces the "AI mechanic" output the user described:
 *
 *   ━━━ Broken interpreter after Python upgrade ━━━
 *   WHAT:    proot-distro is installed but its shebang points to python3.13...
 *   WHY:     This happens after a Termux Python upgrade (3.13 → 3.14)...
 *   EVIDENCE: bad interpreter: /data/.../python3.13: No such file or directory
 *   REPAIR:  pkg reinstall proot-distro
 *   CONFIDENCE: 99%
 */
export function formatDiagnosis(diagnosis: Diagnosis): string {
  const lines: string[] = [];
  lines.push(`━━━ ${diagnosis.title} ━━━`);
  lines.push(`  WHAT:        ${diagnosis.what}`);
  lines.push(`  WHY:         ${diagnosis.why}`);
  lines.push(`  EVIDENCE:    ${diagnosis.evidence}`);
  lines.push(`  REPAIR:      ${diagnosis.repair}`);
  lines.push(`  CONFIDENCE:  ${Math.round(diagnosis.confidence * 100)}%`);
  if (diagnosis.autoRepairable) {
    lines.push(`  AUTO-REPAIR: yes (safe to apply automatically)`);
  }
  if (diagnosis.docsUrl) {
    lines.push(`  DOCS:        ${diagnosis.docsUrl}`);
  }
  return lines.join('\n');
}
