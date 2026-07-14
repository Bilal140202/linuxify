/**
 * `linuxify fix` command — AI-assisted diagnosis with local rules engine.
 *
 * Runs doctor, identifies the highest-impact failure, produces a structured
 * diagnosis, and optionally applies the repair (with user consent).
 *
 * Usage:
 *   linuxify fix                 # diagnose + prompt to apply
 *   linuxify fix --dry-run       # diagnose only, no apply
 *   linuxify fix --apply         # skip prompt, apply safe repairs
 *   linuxify fix --check <id>    # diagnose only this check
 *   linuxify fix --list-rules    # list registered diagnosis rules
 *   linuxify fix --json          # machine-readable output
 *
 * In v0.1 the "AI" is a local rules engine (see `src/diagnosis/`).
 * In v2 this gains an optional LLM backend (`--ai` flag).
 *
 * Exit codes:
 *   0 — no problems found, or all repairs applied successfully
 *   1 — problems found but not repaired (user declined or --dry-run)
 *   2 — problems found, repairs attempted but some failed
 *   4 — internal error during diagnosis
 */

import { logger } from '../../utils/log.js';
import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';
import type { RegisterCommandFn } from './index.js';
import { diagnose, type Diagnosis, type RepairPlan } from '../../diagnosis/index.js';
import { listDiagnosisRules, getDiagnosisRule } from '../../diagnosis/rules.js';
import { assessRepairSafety } from '../../diagnosis/safety.js';
import { exec } from '../../utils/process.js';

interface FixOptions {
  dryRun?: boolean;
  apply?: boolean;
  check?: string;
  listRules?: boolean;
  json?: boolean;
}

/**
 * Implement the `linuxify fix` command.
 */
export async function runFix(opts: FixOptions, ctx: CommandContext): Promise<number> {
  // ── --list-rules: print registered diagnosis rules ────────────────
  if (opts.listRules) {
    const rules = listDiagnosisRules();
    if (opts.json) {
      ctx.output.printJson({ rules: rules.map((r) => ({ checkId: r.checkId, name: r.name })) });
    } else {
      ctx.output.info(`Diagnosis rules (${rules.length}):`);
      for (const rule of rules) {
        ctx.output.info(`  ${rule.checkId.padEnd(28)} ${rule.name}`);
      }
    }
    return EXIT_CODES.OK;
  }

  // ── Run doctor ────────────────────────────────────────────────────
  const out = ctx.output;
  out.info('Running diagnostics...');
  const doctorReport = await ctx.doctor.run(
    { profile: opts.check ? 'deep' : 'standard', quiet: true },
    { config: ctx.config, state: await ctx.stateStore.load() },
  );

  if (doctorReport.summary.fail === 0 && doctorReport.summary.missing === 0) {
    if (doctorReport.summary.warn === 0) {
      out.success('No issues found. Everything looks good.');
    } else {
      out.info(`No failures, but ${doctorReport.summary.warn} warnings. Run \`linuxify doctor\` for details.`);
    }
    return EXIT_CODES.OK;
  }

  // ── Diagnose ──────────────────────────────────────────────────────
  let diagnoses: Diagnosis[] = [];
  try {
    diagnoses = await diagnose(doctorReport);
  } catch (err) {
    out.error(`Diagnosis failed: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }

  if (opts.check) {
    diagnoses = diagnoses.filter((d) => d.evidence.some((e) => e.checkId === opts.check));
    if (diagnoses.length === 0) {
      // Maybe the check ID has no rule — try fetching it directly
      const rule = getDiagnosisRule(opts.check);
      if (!rule) {
        out.error(`No diagnosis rule found for check '${opts.check}'.`);
        out.info('Available rules: run `linuxify fix --list-rules`');
        return EXIT_CODES.NOT_FOUND;
      }
    }
  }

  if (diagnoses.length === 0) {
    out.info('Doctor found failures, but no diagnosis rules matched. Run `linuxify doctor` for raw output.');
    return EXIT_CODES.GENERIC_ERROR;
  }

  // ── JSON output ───────────────────────────────────────────────────
  if (opts.json) {
    ctx.output.printJson({ diagnoses });
    return EXIT_CODES.GENERIC_ERROR; // problems exist
  }

  // ── Human-readable diagnosis ──────────────────────────────────────
  out.info('');
  out.info(`Found ${diagnoses.length} issue(s):`);
  out.info('');

  for (const diag of diagnoses) {
    printDiagnosis(diag, out);
  }

  // ── Apply repairs ─────────────────────────────────────────────────
  const applicable = diagnoses.filter((d) => d.repair !== null);
  if (applicable.length === 0) {
    out.info('No automatic repairs available. See the diagnoses above for manual steps.');
    return EXIT_CODES.GENERIC_ERROR;
  }

  if (opts.dryRun) {
    out.info('');
    out.info(`${applicable.length} repair plan(s) available. Re-run without --dry-run to apply.`);
    return EXIT_CODES.GENERIC_ERROR;
  }

  // Apply each repair (with confirmation unless --apply)
  let allSucceeded = true;
  for (const diag of applicable) {
    const plan = diag.repair!;
    const safety = assessRepairSafety(plan);

    if (safety.refused) {
      out.error(`Refused to apply repair for ${diag.title}: ${safety.refusalReason}`);
      allSucceeded = false;
      continue;
    }

    const effectivePlan = safety.escalatedRisk && safety.effectiveRisk
      ? { ...plan, risk: safety.effectiveRisk }
      : plan;

    // Confirm with user (unless --apply for safe plans)
    const shouldApply = opts.apply && effectivePlan.risk === 'safe'
      ? true
      : await confirmRepair(diag, effectivePlan, ctx);

    if (!shouldApply) {
      out.info(`Skipped: ${diag.title}`);
      continue;
    }

    out.info(`Applying: ${effectivePlan.summary}`);
    const result = await applyRepair(effectivePlan, ctx);
    if (result.success) {
      out.success(`✓ ${diag.title} — repaired`);
    } else {
      out.error(`✗ ${diag.title} — repair failed: ${result.error}`);
      allSucceeded = false;
    }
  }

  return allSucceeded ? EXIT_CODES.OK : EXIT_CODES.STEP_FAILED;
}

function printDiagnosis(diag: Diagnosis, out: CommandContext['output']): void {
  out.info(`━━━ ${diag.title} ━━━`);
  out.info(`  WHAT: ${diag.what}`);
  out.info(`  WHY:  ${diag.why}`);
  for (const ev of diag.evidence) {
    out.info(`  EVIDENCE: [${ev.status}] ${ev.checkId} — ${ev.message}`);
  }
  if (diag.repair) {
    out.info(`  REPAIR: ${diag.repair.summary} (risk: ${diag.repair.risk}, ~${diag.repair.estimatedDurationSeconds}s)`);
    for (const step of diag.repair.steps) {
      out.info(`    → ${step.description}${step.command ? `  [\x1b[2m${step.command}\x1b[0m]` : ''}`);
    }
  }
  if (diag.alternatives.length > 0) {
    out.info(`  ALTERNATIVES:`);
    for (const alt of diag.alternatives) {
      out.info(`    · ${alt.summary} (risk: ${alt.risk})`);
    }
  }
  if (diag.docsUrl) {
    out.info(`  DOCS: ${diag.docsUrl}`);
  }
  out.info(`  CONFIDENCE: ${Math.round(diag.confidence * 100)}%`);
  out.info('');
}

async function confirmRepair(
  diag: Diagnosis,
  plan: RepairPlan,
  ctx: CommandContext,
): Promise<boolean> {
  if (ctx.flags.yes) return true;

  // In a real implementation, this would prompt the user interactively.
  // For now, we print the plan and ask the user to re-run with --apply.
  ctx.output.info(`Repair available for: ${diag.title}`);
  ctx.output.info(`  Risk: ${plan.risk}`);
  ctx.output.info(`  Steps: ${plan.steps.length}`);
  ctx.output.info('  Re-run with --apply to execute, or run the steps manually.');
  return false;
}

async function applyRepair(
  plan: RepairPlan,
  ctx: CommandContext,
): Promise<{ success: boolean; error?: string }> {
  for (const step of plan.steps) {
    if (!step.command) {
      // Manual step — skip (user must do it)
      ctx.output.info(`  Manual step: ${step.description}`);
      continue;
    }
    try {
      const result = await exec('sh', ['-c', step.command], { timeoutMs: 60000 });
      if (result.exitCode !== 0) {
        return { success: false, error: `Step "${step.description}" exited ${result.exitCode}: ${result.stderr}` };
      }
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }
  return { success: true };
}

/**
 * Register the `fix` command with the CLI.
 */
export const registerFixCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('fix')
    .description('Diagnose issues and propose or apply repairs. AI-assisted (local rules engine in v0.1).')
    .option('--dry-run', 'Diagnose only; do not apply any repairs.')
    .option('--apply', 'Apply safe repairs without prompting.')
    .option('--check <id>', 'Diagnose only the named check.')
    .option('--list-rules', 'List all registered diagnosis rules and exit.')
    .option('--json', 'Emit machine-readable JSON.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runFix(opts as FixOptions, ctx);
      setExit(code);
    });
};

// Import log only for potential debug; suppressed to satisfy lint.
void logger;
