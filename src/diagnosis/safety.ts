/**
 * Safety filter for repair plans. Validates that a plan doesn't contain
 * destructive operations and assigns an effective risk level.
 *
 * @module linuxify/diagnosis/safety
 *
 * The safety filter is the LAST line of defense before a repair plan reaches
 * the user. Even if a diagnosis rule generates a destructive plan (bug or
 * malice), the safety filter refuses to present it as auto-applicable.
 */

import { logger } from '../utils/log.js';
import type { RepairPlan, RiskLevel } from './engine.js';

/**
 * Result of assessing a repair plan's safety.
 */
export interface SafetyAssessment {
  /** Whether the risk was escalated (e.g., from `safe` to `risky`). */
  escalatedRisk: boolean;
  /** The effective risk after assessment. */
  effectiveRisk: RiskLevel | null;
  /** Reasons for escalation (if any). */
  reasons: string[];
  /** Whether the plan is refused entirely (too dangerous to present). */
  refused: boolean;
  /** If refused, the refusal reason. */
  refusalReason?: string;
}

/**
 * Forbidden command patterns — if any step's command matches, the plan is refused.
 */
const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-rf\s+\/(\s|$)/, reason: 'refuses to delete filesystem root' },
  { pattern: /\brm\s+-rf\s+~\s/, reason: 'refuses to delete home directory' },
  { pattern: /\brm\s+-rf\s+\$HOME/, reason: 'refuses to delete home directory' },
  { pattern: /\bmkfs\b/, reason: 'refuses to format filesystems' },
  { pattern: /\bdd\b.*of=\/dev\//, reason: 'refuses to write directly to devices' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};/, reason: 'refuses fork bombs' },
  { pattern: /\bchmod\s+[-+]?\s*777\s+\//, reason: 'refuses world-writable root dirs' },
  { pattern: /\bcurl\s+.*\|\s*(sh|bash|zsh)\b/, reason: 'refuses curl-piped shell execution' },
  { pattern: /\bwget\s+.*\|\s*(sh|bash|zsh)\b/, reason: 'refuses wget-piped shell execution' },
  { pattern: /\bshutdown\b/, reason: 'refuses shutdown commands' },
  { pattern: /\breboot\b/, reason: 'refuses reboot commands' },
];

/**
 * Risky command patterns — escalate risk level but don't refuse.
 */
const RISKY_PATTERNS: Array<{ pattern: RegExp; reason: string; level: RiskLevel }> = [
  { pattern: /\brm\s+-rf\b/, reason: 'recursive delete', level: 'risky' },
  { pattern: /\bapt\s+remove\b/, reason: 'package removal', level: 'moderate' },
  { pattern: /\bapt\s+purge\b/, reason: 'package purge', level: 'moderate' },
  { pattern: /\bpip\s+uninstall\b/, reason: 'pip package removal', level: 'moderate' },
  { pattern: /\bnpm\s+uninstall\b/, reason: 'npm package removal', level: 'moderate' },
  { pattern: /\blinuxify\s+distros\s+uninstall\b/, reason: 'distro removal', level: 'risky' },
  { pattern: /\blinuxify\s+distros\s+reset\b/, reason: 'distro reset', level: 'destructive' },
];

/**
 * Assess a repair plan for safety. Returns the assessment; the caller is
 * responsible for respecting `refused` and `escalatedRisk`.
 */
export function assessRepairSafety(plan: RepairPlan): SafetyAssessment {
  const reasons: string[] = [];
  let effectiveRisk: RiskLevel = plan.risk;
  let escalated = false;

  for (const step of plan.steps) {
    if (!step.command) continue;

    // Check forbidden patterns
    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
      if (pattern.test(step.command)) {
        logger.warn({ command: step.command, reason }, 'repair plan refused by safety filter');
        return {
          escalatedRisk: false,
          effectiveRisk: null,
          reasons: [reason],
          refused: true,
          refusalReason: `Command "${step.command.slice(0, 60)}..." ${reason}`,
        };
      }
    }

    // Check risky patterns
    for (const { pattern, reason, level } of RISKY_PATTERNS) {
      if (pattern.test(step.command)) {
        const order: RiskLevel[] = ['safe', 'moderate', 'risky', 'destructive'];
        if (order.indexOf(level) > order.indexOf(effectiveRisk)) {
          effectiveRisk = level;
          escalated = true;
          reasons.push(`step "${step.description}" contains ${reason}`);
        }
      }
    }
  }

  return {
    escalatedRisk: escalated,
    effectiveRisk,
    reasons,
    refused: false,
  };
}
