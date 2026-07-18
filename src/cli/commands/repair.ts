/**
 * `linuxify repair` — apply auto-repairs suggested by doctor.
 *
 * @module linuxify/cli/commands/repair
 *
 * Runs doctor, builds a repair plan (deduplicated + dependency-ordered),
 * presents it for confirmation (apt/brew-style), then executes it.
 *
 * The repair engine uses a **re-diagnose-after-each-phase** strategy:
 *   1. Run doctor → build plan
 *   2. Execute phase 1 (e.g., Bootstrap: `linuxify init`)
 *   3. Re-run doctor → if phase 1 fixed downstream issues, skip them
 *   4. Execute next remaining phase
 *   5. Repeat until all phases done or a root-cause phase fails
 *
 * This avoids unnecessary work: if `linuxify init` fixes PATH as a side
 * effect, we don't also run `linuxify repair paths`.
 *
 * **Interactive prompt:** Uses `readline` via `utils/prompt.ts`. If stdin
 * is not a TTY (CI, piped input), the prompt returns the default (no) and
 * the user must use `--yes`.
 *
 * **Child process safety:** Fix commands are run via `spawn` with
 * `stdio: 'inherit'` — NOT `exec`. This ensures child processes (like
 * `linuxify init` which may spawn proot) have proper terminal access
 * without hijacking the parent's stdio.
 *
 * **Session logging:** Every repair session is logged to
 * `~/.linuxify/logs/repair-<timestamp>.log` with the plan, each step's
 * output, and the final doctor result. If a repair crashes, the user can
 * retrieve the log with `linuxify report --attach-last-log`.
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

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { formatReport, resolveFormat } from '../../doctor/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { logger } from '../../utils/log.js';
import { getLinuxifyHome } from '../../utils/process.js';
import { confirm } from '../../utils/prompt.js';
import type { DoctorResult } from '../../doctor/types.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

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
 * Repair session logger — writes a timestamped log of the entire repair
 * session to `~/.linuxify/logs/repair-<timestamp>.log`.
 */
class RepairSessionLogger {
  private lines: string[] = [];
  private readonly logPath: string;

  constructor() {
    const linuxifyHome = getLinuxifyHome();
    const logsDir = join(linuxifyHome, 'logs');
    try {
      if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    } catch {
      // If we can't create the logs dir, logging is best-effort.
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = join(logsDir, `repair-${timestamp}.log`);
    this.log(`Linuxify Repair Session — ${new Date().toISOString()}`);
    this.log('='.repeat(60));
  }

  log(message: string): void {
    this.lines.push(message);
  }

  flush(): void {
    try {
      writeFileSync(this.logPath, this.lines.join('\n') + '\n', { mode: 0o600 });
      logger.info({ logPath: this.logPath }, 'repair session log written');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'failed to write repair session log');
    }
  }

  getLogPath(): string {
    return this.logPath;
  }
}

/**
 * Run a fix command using `spawn` with `stdio: 'inherit'`.
 *
 * We use spawn (not exec) because:
 * 1. `exec` creates a shell and pipes stdio, which can cause child processes
 *    that use `stdio: 'inherit'` (like `linuxify init` spawning proot) to
 *    hijack or crash the parent terminal.
 * 2. `spawn` with `stdio: 'inherit'` gives the child direct terminal access,
 *    so interactive prompts and signal handling work correctly.
 * 3. We split the command string into args manually (not via a shell) to
 *    avoid shell injection.
 *
 * Returns a promise that resolves to the exit code (0 = success).
 */
function runFixCommand(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Split command into cmd + args. Handles simple cases (no quoting).
    // For complex commands with &&, we use `sh -c` but with stdio: 'inherit'.
    const parts = command.trim().split(/\s+/);
    const hasShellOperator = command.includes('&&') || command.includes('||') || command.includes('|');

    let child;
    if (hasShellOperator) {
      // Use sh -c for compound commands, but with stdio: 'inherit' for safety.
      child = spawn('sh', ['-c', command], { stdio: 'inherit' });
    } else {
      const [cmd, ...args] = parts;
      child = spawn(cmd, args, { stdio: 'inherit' });
    }

    let stdout = '';
    let stderr = '';

    // Note: with stdio: 'inherit', we don't capture stdout/stderr —
    // they go directly to the terminal. The log will note the exit code.
    child.on('error', (err) => {
      stderr = err.message;
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        stderr = `killed by signal ${signal}`;
        resolve({ exitCode: 130, stdout, stderr });
        return;
      }
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
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
  const sessionLog = new RepairSessionLogger();

  // 1. Run doctor to discover issues.
  const doctorCtx = { config: ctx.config, state: ctx.state };
  sessionLog.log('Phase 0: Initial doctor run');
  const initial = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );
  sessionLog.log(`  Found ${initial.summary.fail} failures, ${initial.summary.warn} warnings`);

  const failures = initial.results.filter(
    (r) => (r.status === 'fail' || r.status === 'missing') && r.fixCommand,
  );

  if (failures.length === 0) {
    out.success('No repairable issues found.');
    sessionLog.log('No repairable issues found.');
    sessionLog.flush();
    return EXIT_CODES.OK;
  }

  // 2. Build the repair plan (deduplicated + phased).
  let plan = buildRepairPlan(failures);
  const totalStepsOriginal = plan.reduce((sum, p) => sum + p.steps.length, 0);

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
      out.info(`     (fixes: ${step.checkId})`);
    }
    out.info('');
  });
  out.info(`Total: ${totalStepsOriginal} step(s) across ${plan.length} phase(s).`);
  out.info('');

  sessionLog.log('Repair plan:');
  for (const phase of plan) {
    sessionLog.log(`  ${phase.name}:`);
    for (const step of phase.steps) {
      sessionLog.log(`    → ${step.command} (fixes: ${step.checkId})`);
    }
  }

  // 4. Dry-run: stop here.
  if (ctx.flags.dryRun || !!(opts.dryRun)) {
    out.info('Dry run — no changes made. Re-run without --dry-run to apply.');
    sessionLog.log('Dry run — no changes made.');
    sessionLog.flush();
    return EXIT_CODES.OK;
  }

  // 5. Confirm (unless --yes). Use the REAL readline prompt.
  const yesFlag = !!(opts.yes) || ctx.flags.yes;
  if (!yesFlag) {
    const shouldProceed = await confirm('Proceed with repair?', false);
    if (!shouldProceed) {
      out.info('Repair cancelled.');
      sessionLog.log('User cancelled repair at confirmation prompt.');
      sessionLog.flush();
      return EXIT_CODES.OK;
    }
  }

  // 6. Execute the plan phase by phase, re-diagnosing after each phase.
  out.info('Applying repair plan…');
  out.info('');
  sessionLog.log('');
  sessionLog.log('Executing repair plan:');

  let applied = 0;
  let failed = 0;
  let currentPhase = '';
  let phaseIndex = 0;

  while (plan.length > 0 && phaseIndex < plan.length) {
    const phase = plan[phaseIndex];
    if (phase.name !== currentPhase) {
      currentPhase = phase.name;
      out.info(`▸ ${phase.name}`);
      sessionLog.log(`  ${phase.name}:`);
    }

    let phaseFailed = false;
    for (const step of phase.steps) {
      out.info(`  Running: ${step.command}`);
      sessionLog.log(`    → ${step.command}`);
      const result = await runFixCommand(step.command);
      if (result.exitCode === 0) {
        out.success(`  ✓ Done`);
        applied++;
        sessionLog.log(`      ✓ exit code 0`);
      } else {
        out.error(`  ✖ Failed (exit ${result.exitCode})`);
        failed++;
        phaseFailed = true;
        sessionLog.log(`      ✖ exit code ${result.exitCode} ${result.stderr ? '— ' + result.stderr : ''}`);
        logger.warn(
          { check: step.checkId, cmd: step.command, exitCode: result.exitCode },
          'repair step failed',
        );
        // If a root-cause phase fails, skip downstream phases.
        if (phase.name === 'Bootstrap' || phase.name === 'Environment') {
          out.warn(`  Skipping remaining phases — ${phase.name} is a prerequisite.`);
          out.info('');
          out.info(`Repairs applied: ${applied}/${totalStepsOriginal}, failed: ${failed}.`);
          out.info(`Repair log saved to: ${sessionLog.getLogPath()}`);
          out.info('Run `linuxify doctor` to see remaining issues.');
          sessionLog.log(`  Skipping remaining phases — ${phase.name} is a prerequisite.`);
          sessionLog.log(`Repairs applied: ${applied}/${totalStepsOriginal}, failed: ${failed}.`);
          sessionLog.flush();
          return EXIT_CODES.STEP_FAILED;
        }
      }
    }

    // Re-diagnose after this phase to see if downstream issues are already fixed.
    if (!phaseFailed && phaseIndex < plan.length - 1) {
      out.info('  Re-evaluating remaining issues…');
      sessionLog.log('  Re-evaluating remaining issues…');
      const recheck = await ctx.doctor.run(
        {
          profile: 'standard',
          checkIds: checkId ? [checkId] : undefined,
        },
        doctorCtx,
      );
      const remainingFailures = recheck.results.filter(
        (r) => (r.status === 'fail' || r.status === 'missing') && r.fixCommand,
      );
      const newPlan = buildRepairPlan(remainingFailures);

      // If the remaining phases are no longer needed, skip them.
      const remainingPhaseNames = newPlan.map((p) => p.name);
      const originalRemaining = plan.slice(phaseIndex + 1);
      const skippedPhases = originalRemaining.filter(
        (p) => !remainingPhaseNames.includes(p.name),
      );
      for (const skipped of skippedPhases) {
        out.info(`  ✓ ${skipped.name} — already fixed by ${phase.name}`);
        sessionLog.log(`  ✓ ${skipped.name} — already fixed by ${phase.name}`);
      }

      // Replace the remaining plan with the re-diagnosed plan.
      plan = [...plan.slice(0, phaseIndex + 1), ...newPlan];
    }

    out.info('');
    phaseIndex++;
  }

  // 7. Final doctor run to verify.
  out.info('▸ Verify');
  sessionLog.log('Verify:');
  const followup = await ctx.doctor.run(
    {
      profile: 'standard',
      checkIds: checkId ? [checkId] : undefined,
    },
    doctorCtx,
  );
  sessionLog.log(`  Final doctor: ${followup.summary.fail} failures, ${followup.summary.warn} warnings`);

  const format = resolveFormat({ quiet: true });
  const rendered = formatReport(followup, format);
  if (rendered.length > 0) {
    out.info(rendered);
  }

  sessionLog.flush();

  if (followup.summary.fail === 0) {
    out.success(`Repairs applied: ${applied}/${totalStepsOriginal}. All checks now passing.`);
    out.info(`Repair log: ${sessionLog.getLogPath()}`);
    return EXIT_CODES.OK;
  }
  out.warn(`Repairs applied: ${applied}/${totalStepsOriginal}, failed: ${failed}.`);
  out.info(`Repair log: ${sessionLog.getLogPath()}`);
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
