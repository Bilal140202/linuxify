/**
 * Diagnosis rule registry. Rules are registered at module load time by
 * `builtin-rules.ts` and can be added by plugins.
 *
 * @module linuxify/diagnosis/rules
 */

import { logger } from '../utils/log.js';
import type { DiagnosisRule } from './engine.js';

const rules = new Map<string, DiagnosisRule>();

/**
 * Register a diagnosis rule. If a rule with the same `checkId` already
 * exists, it is replaced (last-wins, allows plugins to override built-ins).
 */
export function registerDiagnosisRules(rule: DiagnosisRule | DiagnosisRule[]): void {
  const arr = Array.isArray(rule) ? rule : [rule];
  for (const r of arr) {
    if (rules.has(r.checkId)) {
      logger.debug({ checkId: r.checkId }, 'overriding existing diagnosis rule');
    }
    rules.set(r.checkId, r);
  }
}

/**
 * Look up the rule for a check ID.
 */
export function getDiagnosisRule(checkId: string): DiagnosisRule | undefined {
  return rules.get(checkId);
}

/**
 * List all registered rules (for introspection / `linuxify fix --list-rules`).
 */
export function listDiagnosisRules(): DiagnosisRule[] {
  return Array.from(rules.values()).sort((a, b) => a.checkId.localeCompare(b.checkId));
}

/**
 * Clear all rules — test-only.
 */
export function _clearDiagnosisRulesForTests(): void {
  rules.clear();
}
