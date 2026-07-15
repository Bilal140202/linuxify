/**
 * Diagnosis subsystem — `linuxify fix` AI-assisted diagnosis with local rules engine.
 *
 * @module linuxify/diagnosis
 *
 * `linuxify fix` runs doctor, identifies the highest-impact failure, then
 * produces a structured diagnosis:
 *
 *   1. WHAT went wrong (plain English)
 *   2. WHY it likely went wrong (root-cause hypothesis)
 *   3. EVIDENCE (which checks revealed it, what the values were)
 *   4. SAFE REPAIR (the exact command to run, or a sequence of steps)
 *   5. RISK ASSESSMENT (what the repair changes, what it doesn't)
 *
 * In v0.1 the "AI" is a local rules engine — a curated knowledge base mapping
 * doctor check IDs to diagnoses. Each rule is hand-authored by maintainers
 * based on real bug reports. The rules engine is extensible: packages can
 * register their own rules via the plugin SDK.
 *
 * In v2 this gains an optional LLM backend (`linuxify fix --ai`) that calls
 * an LLM (Cline, Codex, or local Ollama) with the diagnosis context as
 * structured input. The LLM proposes repair steps; the rules engine validates
 * them against a safety allowlist before presenting to the user. The user
 * always approves before any repair runs.
 *
 * Safety contract:
 *   - NEVER auto-apply repairs without explicit user consent
 *   - NEVER propose destructive repairs (rm -rf, format, etc.) — those are
 *     refused by the safety filter
 *   - ALWAYS show the user the diagnosis before the repair
 *   - ALWAYS offer a `--dry-run` path
 *   - ALWAYS log the diagnosis + chosen repair for audit
 */

export {
  diagnose,
  type Diagnosis,
  type DiagnosisRule,
  type DiagnosisEvidence,
  type RepairPlan,
  type RepairStep,
  type RiskLevel,
} from './engine.js';
export { registerDiagnosisRules, listDiagnosisRules, getDiagnosisRule } from './rules.js';
export { builtinRules } from './builtin-rules.js';
export { assessRepairSafety, type SafetyAssessment } from './safety.js';
