/**
 * Default launcher — the "just type `linuxify`" entrypoint.
 *
 * @module linuxify/cli/launcher
 *
 * When the user types `linuxify` with no subcommand, this module decides
 * what to do:
 *
 *   1. Not initialized → run bootstrap, then launch shell
 *   2. Repairable → auto-repair, then launch shell
 *   3. Ready → launch shell immediately
 *   4. Broken → show diagnosis, suggest `linuxify doctor`
 *
 * This is the "state machine" the user envisioned. Most users only ever
 * need one command: `linuxify`. Everything else is an implementation detail.
 */

import { spawn } from 'node:child_process';
import { assessSystemState } from '../system/index.js';
import { confirm } from '../utils/prompt.js';
import { exec } from '../utils/process.js';
import { logger } from '../utils/log.js';
import { EXIT_CODES } from '../utils/constants.js';
import type { CommandContext } from './context.js';

/**
 * The default launch flow. Called when the user types `linuxify` with no
 * subcommand.
 */
export async function launchDefault(ctx: CommandContext): Promise<number> {
  const out = ctx.output;

  out.info('🔍 Checking Linuxify environment…');
  const assessment = await assessSystemState();

  switch (assessment.state) {
    case 'not-initialized': {
      out.info('');
      out.info('Linuxify is not initialized yet.');
      out.info('');
      out.info('This will:');
      out.info('  ✓ Install Ubuntu');
      out.info('  ✓ Configure Linuxify');
      out.info('  ✓ Install runtimes (Node, Python, Git)');
      out.info('  ✓ Create linuxify user');
      out.info('  ✓ Wire up PATH');
      out.info('');

      const proceed = await confirm('Continue with setup?', true);
      if (!proceed) {
        out.info('Setup cancelled. Run `linuxify` again when ready.');
        return EXIT_CODES.OK;
      }

      // Run bootstrap.
      out.info('');
      out.info('Starting setup…');
      const { bootstrap } = await import('../bootstrap/index.js');
      const result = await bootstrap({});

      if (result.failedStage !== null) {
        out.error(`Setup failed at stage ${result.failedStage}: ${result.error}`);
        out.info('Run `linuxify doctor` for diagnostics.');
        return EXIT_CODES.STEP_FAILED;
      }

      out.success('Setup complete!');
      out.info('');

      // Launch the shell.
      return await launchShell(ctx, assessment.activeDistro ?? 'ubuntu');
    }

    case 'repairable': {
      out.info('');
      out.warn(`Found ${assessment.issues.length} issue(s) that need repair:`);
      for (const issue of assessment.issues) {
        out.info(`  • ${issue.description}`);
      }
      out.info('');

      const proceed = await confirm('Repair now?', true);
      if (!proceed) {
        out.info('Repair skipped. Run `linuxify doctor` for details.');
        return EXIT_CODES.OK;
      }

      // Auto-repair each issue.
      for (const issue of assessment.issues) {
        out.info(`Repairing: ${issue.description}`);
        const repaired = await autoRepair(issue, ctx);
        if (repaired) {
          out.success(`  ✓ Fixed`);
        } else {
          out.error(`  ✖ Could not auto-repair. Run \`linuxify doctor\` for details.`);
          return EXIT_CODES.STEP_FAILED;
        }
      }

      out.success('All repairs complete!');
      out.info('');

      // Re-assess and launch.
      return await launchShell(ctx, assessment.activeDistro ?? 'ubuntu');
    }

    case 'ready': {
      // Everything is fine — launch the shell immediately.
      return await launchShell(ctx, assessment.activeDistro ?? 'ubuntu');
    }

    case 'broken': {
      out.error('Linuxify has issues that cannot be auto-repaired.');
      out.info('');
      out.info('Run `linuxify doctor --explain` for detailed diagnostics.');
      return EXIT_CODES.STEP_FAILED;
    }
  }
}

/**
 * Auto-repair a single issue.
 */
async function autoRepair(issue: { id: string; repairAction?: string }, ctx: CommandContext): Promise<boolean> {
  const out = ctx.output;

  switch (issue.repairAction) {
    case 'bootstrap': {
      const { bootstrap } = await import('../bootstrap/index.js');
      const result = await bootstrap({});
      return result.failedStage === null;
    }

    case 'install-distro': {
      try {
        const r = await exec('proot-distro', ['install', 'ubuntu'], { timeoutMs: 15 * 60 * 1000 });
        return r.exitCode === 0 || /already exists/i.test(r.stderr + r.stdout);
      } catch {
        return false;
      }
    }

    case 'create-user': {
      try {
        const r = await exec(
          'proot-distro',
          ['login', 'ubuntu', '--', 'sh', '-c',
           "id linuxify >/dev/null 2>&1 || (echo 'linuxify:x:1000:1000:Linuxify:/home/linuxify:/bin/bash' >> /etc/passwd && echo 'linuxify:*:19000:0:99999:7:::' >> /etc/shadow && echo 'linuxify:x:1000:' >> /etc/group && mkdir -p /home/linuxify && chown 1000:1000 /home/linuxify)"],
          { timeoutMs: 30000 },
        );
        return r.exitCode === 0;
      } catch {
        return false;
      }
    }

    case 'repair-state': {
      // Re-run bootstrap stages 5+ (home setup, state.json creation).
      const { bootstrap } = await import('../bootstrap/index.js');
      const result = await bootstrap({ fromStage: 5 });
      return result.failedStage === null;
    }

    default:
      out.warn(`  No auto-repair for issue: ${issue.id}`);
      return false;
  }
}

/**
 * Launch the Ubuntu shell via proot-distro login.
 *
 * First ensures essential packages are installed (as root), then drops
 * to the linuxify user's interactive shell. This guarantees Ubuntu uses
 * its OWN Node.js/npm (not Termux's), and that curl, git, build-essential
 * are available inside the container.
 */
async function launchShell(ctx: CommandContext, distro: string): Promise<number> {
  const out = ctx.output;

  out.info(`Opening ${distro}…`);
  out.info('');

  // Step 1: Ensure essential packages are installed as root.
  // This runs apt update + apt install inside Ubuntu as root (no --user flag
  // = root by default in proot-distro). We install curl, git, build-essential,
  // nodejs, npm so that Ubuntu uses its own runtimes, NOT Termux's.
  out.info('Ensuring essential packages are installed inside Ubuntu…');
  try {
    const ensureResult = await exec(
      'proot-distro',
      ['login', distro, '--', 'bash', '-c',
       'export DEBIAN_FRONTEND=noninteractive; ' +
       'apt-get update -qq && ' +
       'apt-get install -y -qq curl git build-essential nodejs npm python3 python3-pip 2>&1 | tail -5'],
      { timeoutMs: 300_000, env: { TERM: 'dumb' } }, // 5 min timeout for apt
    );

    if (ensureResult.exitCode !== 0) {
      out.warn('  Package installation had issues — continuing anyway.');
      logger.warn({ exitCode: ensureResult.exitCode, stderr: ensureResult.stderr.slice(0, 500) }, 'apt install in launchShell had non-zero exit');
    } else {
      out.success('  ✓ Packages ready');
    }
  } catch (err) {
    out.warn(`  Package check failed: ${(err as Error).message} — continuing to shell.`);
    logger.warn({ err: (err as Error).message }, 'apt install threw in launchShell');
  }

  // Step 2: Ensure the linuxify user exists (auto-create if missing).
  try {
    const userCheck = await exec(
      'proot-distro',
      ['login', distro, '--', 'sh', '-c',
       "id linuxify >/dev/null 2>&1 || " +
       "(echo 'linuxify:x:1000:1000:Linuxify:/home/linuxify:/bin/bash' >> /etc/passwd && " +
       "echo 'linuxify:*:19000:0:99999:7:::' >> /etc/shadow && " +
       "echo 'linuxify:x:1000:' >> /etc/group && " +
       "mkdir -p /home/linuxify && chown 1000:1000 /home/linuxify)"],
      { timeoutMs: 30_000, env: { TERM: 'dumb' } },
    );
    if (userCheck.exitCode !== 0) {
      out.warn('  Could not verify linuxify user — will try root shell instead.');
    }
  } catch {
    // Non-fatal — we'll try to login as linuxify, and if that fails, root.
  }

  out.info('');

  // Step 3: Launch interactive shell as the linuxify user.
  // If the linuxify user doesn't exist, proot-distro will fail — fall back
  // to root (no --user flag).
  return new Promise<number>((resolve) => {
    const child = spawn('proot-distro', ['login', distro, '--user', 'linuxify'], {
      stdio: 'inherit',
      env: { ...process.env, TERM: process.env.TERM || 'xterm-256color' },
    });

    child.on('error', (err) => {
      out.error(`Failed to launch ${distro} as linuxify user: ${err.message}`);
      out.info('  Trying root shell instead…');
      // Fallback: login as root (no --user flag).
      const rootChild = spawn('proot-distro', ['login', distro], { stdio: 'inherit' });
      rootChild.on('error', (err2) => {
        out.error(`Failed to launch ${distro}: ${err2.message}`);
        resolve(EXIT_CODES.STEP_FAILED);
      });
      rootChild.on('exit', (code) => {
        resolve(code ?? EXIT_CODES.OK);
      });
    });

    child.on('exit', (code) => {
      resolve(code ?? EXIT_CODES.OK);
    });
  });
}
