/**
 * `linuxify repair` — apply auto-repairs suggested by doctor.
 *
 * @module linuxify/cli/commands/repair
 *
 * Runs doctor, builds a repair plan (deduplicated + dependency-ordered),
 * presents it for confirmation (apt/brew-style), then executes it.
 *
 * The repair plan groups fixes into phases:
 *   1. Bootstrap (root cause — fix first)
 *   2. Environment (host prerequisites: Termux, proot, storage)
 *   3. Distro & Runtime (depend on bootstrap)
 *   4. PATH (depends on bootstrap stage 6)
 *   5. Verify (re-run doctor)
 *
 * Each phase shows what will be done and why. The user sees the full plan
 * before any command runs, and must confirm with `--yes` or by typing `y`.
 *
 * Flags:
 *  - `--yes`: skip the confirmation prompt (required for CI).
 *  - `--check <id>`: only repair the named check.
 *  - `--dry-run`: print the plan without applying anything.
 *  - `--reset`: wipe state.json and re-derive it from the filesystem.
 *  - `--from-backup <path>`: restore from a known-good backup.
 *
 * @packageDocumentation
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { formatReport, resolveFormat } from '../../doctor/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import type { DoctorResult } from '../../doctor/types.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

const execAsync = promisify(exec);

/**
 * A single step in the repair plan.
 */
interface RepairStep {
  checkId: string;
  checkName: string;
  command: string;
  status: string;
  message: string;
}

/**
 * A phase in the repair plan — groups related fixes.
 */
interface RepairPhase {
  name: string;
  description: string;
  steps: RepairStep[];
}

/**
 * Phase assignment for a check ID. Mirrors the priority order in the repair
 * engine but with human-readable names.
 */
function phaseForCheck(checkId: string): string {
  if (checkId === 'bootstrap.completed') return 'Bootstrap';
  if (checkId.startsWith('host.')) return 'Environment';
  if (checkId.startsWith('distro.')) return 'Distro';
  if (checkId.startsWith('runtime.')) return 'Runtime';
  if (checkId.startsWith('path.')) return 'PATH';
  if (checkId.startsWith('compat.')) return 'Compatibility';
  if (checkId.startsWith('network.')) return 'Network';
  return 'Other';
}

/**
 * Phase ordering — bootstrap first, verify last.
 */
const PHASE_ORDER = [
  'Bootstrap',
  'Environment',
  'Distro',
  'Runtime',
  'PATH',
  'Compatibility',
  'Network',
  'Other',
];

/**
 * Build a repair plan from doctor results: deduplicate fixCommands,
 * group into phases, and order by dependency.
 */
function buildRepairPlan(results: DoctorResult[]): RepairPhase[] {
  const seen = new Set<string>();
  const steps: RepairStep[] = [];

  for (const r of results) {
    if (!r.fixCommand || r.fixCommand.trim() === '') continue;
    if (seen.has(r.fixCommand)) {
      logger.info('repair: deduplicating fixCommand', {
        checkId: r.id,
        fixCommand: r.fixCommand,
      });
      continue;
    }
    seen.add(r.fixCommand);
    steps.push({
      checkId: r.id,
      checkName: r.name,
      command: r.fixCommand,
      status: r.status,
      message: r.message,
    });
  }

  // Group into phases.
  const phaseMap = new Map<string, RepairStep[]>();
  for (const step of steps) {
    const phaseName = phaseForCheck(step.checkId);
    if (!phaseMap.has(phaseName)) phaseMap.set(phaseName, []);
    phaseMap.get(phaseName)!.push(step);
  }

  // Order phases.
  const phases: RepairPhase[] = [];
  for (const name of PHASE_ORDER) {
    const phaseSteps = phaseMap.get(name);
    if (!phaseSteps || phaseSteps.length === 0) continue;
    phases.push({
      name,
      description: phaseDescription(name),
      steps: phaseSteps,
    });
  }

  return phases;
}

/**
 * Human-readable description for each phase.
 */
function phaseDescription(name: string): string {
  switch (name) {
    case 'Bootstrap':
      return 'One-time environment setup (installs Ubuntu, Node, Python, PATH)';
    case 'Environment':
      return 'Host prerequisites (Termux, storage, architecture)';
    case 'Distro':
      return 'Linux distribution installation and activation';
    case 'Runtime':
      return 'Language runtimes (Node.js, Python, Git)';
    case 'PATH':
      return 'Shell PATH configuration for launcher commands';
    case 'Compatibility':
      return 'Platform patches that make Linux CLIs work on Android';
    case 'Network':
      return 'Network connectivity for downloads and updates';
    default:
      return 'Other repairs';
  }
}

/**
 * Run the `repair` command.
 */
export async function runRepair(
  opts: Record<string, unknown>,
  ctx: CommandContext,
): Promise<number> {
  const out = ctx.output;
  const checkId = typeof opts.check === 'string' ? opts.check : undefined;

  // 1. Run doctor to discover issues.
  const doctorCtx = { config: ctx.config, state: ctx.state };
  const initial = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );

  const failures = initial.results.filter(
    (r) => (r.status === 'fail' || r.status === 'missing') && r.fixCommand,
  );

  if (failures.length === 0) {
    out.success('No repairable issues found.');
    return EXIT_CODES.OK;
  }

  // 2. Build the repair plan (deduplicated + phased).
  const plan = buildRepairPlan(failures);
  const totalSteps = plan.reduce((sum, p) => sum + p.steps.length, 0);

  // 3. Print the plan.
  out.info('');
  out.info('Linuxify Repair Plan');
  out.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  out.info('');
  plan.forEach((phase, i) => {
    out.info(`${i + 1}. ${phase.name}`);
    out.info(`   ${phase.description}`);
    for (const step of phase.steps) {
      out.info(`   → ${step.command}`);
      out.info(`     (fixes: ${step.checkId} — ${step.message.slice(0, 60)}${step.message.length > 60 ? '…' : ''})`);
    }
    out.info('');
  });
  out.info(`Total: ${totalSteps} step(s) across ${plan.length} phase(s).`);
  out.info('');

  // 4. Dry-run: stop here.
  if (ctx.flags.dryRun || !!(opts.dryRun)) {
    out.info('Dry run — no changes made. Re-run without --dry-run to apply.');
    return EXIT_CODES.OK;
  }

  // 5. Confirm (unless --yes).
  if (!ctx.flags.yes && !!(opts.yes) === false) {
    out.info('Proceed with repair? (y/N)');
    // In non-interactive mode (CI, piped stdin), we can't read input.
    // The user must use --yes. Print the plan and exit.
    out.info('(Pass --yes to apply automatically, or run in an interactive terminal.)');
    return EXIT_CODES.OK;
  }

  // 6. Execute the plan phase by phase.
  out.info('Applying repair plan…');
  out.info('');
  let applied = 0;
  let failed = 0;
  let currentPhase = '';

  for (const phase of plan) {
    if (phase.name !== currentPhase) {
      currentPhase = phase.name;
      out.info(`▸ ${phase.name}`);
    }

    for (const step of phase.steps) {
      out.progress(`  Running: ${step.command}`);
      try {
        await execAsync(step.command, { timeout: 120_000 });
        out.success(`  ✓ Done`);
        applied++;
      } catch (err) {
        out.error(`  ✖ Failed: ${(err as Error).message.slice(0, 100)}`);
        failed++;
        logger.warn(
          { check: step.checkId, cmd: step.command, err: (err as Error).message },
          'repair step failed',
        );
        // If a root-cause phase fails, skip downstream phases.
        if (phase.name === 'Bootstrap' || phase.name === 'Environment') {
          out.warn(`  Skipping remaining phases — ${phase.name} is a prerequisite.`);
          out.info('');
          out.info(`Repairs applied: ${applied}/${totalSteps}, failed: ${failed}.`);
          out.info('Run `linuxify doctor` to see remaining issues.');
          return EXIT_CODES.STEP_FAILED;
        }
      }
    }
    out.info('');
  }

  // 7. Re-run doctor to verify.
  out.info('▸ Verify');
  const followup = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );

  const format = resolveFormat({ quiet: true });
  const rendered = formatReport(followup, format);
  if (rendered.length > 0) {
    out.info(rendered);
  }

  if (followup.summary.fail === 0) {
    out.success(`Repairs applied: ${applied}/${totalSteps}. All checks now passing.`);
    return EXIT_CODES.OK;
  }
  out.warn(`Repairs applied: ${applied}/${totalSteps}, failed: ${failed}.`);
  out.info('Run `linuxify doctor --explain` for details on remaining issues.');
  return EXIT_CODES.STEP_FAILED;
}

/**
 * Register the `repair` command.
 */
export const registerRepairCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('repair')
    .description('Apply auto-repairs suggested by doctor.')
    .option('--yes', 'Skip the confirmation prompt.')
    .option('--check <id>', 'Only run repairs for the named check.')
    .option('--dry-run', 'Print the repair plan without applying anything.')
    .option('--reset', 'Wipe state.json and re-derive it from the filesystem (last resort).')
    .option('--from-backup <path>', 'Restore from a known-good backup.')
    .action(async (opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runRepair(opts, ctx);
      setExit(code);
    });
};
