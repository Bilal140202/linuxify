/**
 * `linuxify host` — hosting subsystem commands.
 *
 * @module linuxify/cli/commands/host
 *
 * Commands:
 *   linuxify host init              — prepare hosting environment
 *   linuxify host auto              — detect and deploy current project
 *   linuxify host deploy <path>    — deploy a specific project
 *   linuxify host add <service>     — install database
 *   linuxify host expose <app>      — configure public access
 *   linuxify host list              — list deployed apps
 *   linuxify host status            — show service health
 *   linuxify host logs <app>        — view logs
 *   linuxify host start <app>       — start a stopped app
 *   linuxify host stop <app>        — stop a running app
 *   linuxify host restart <app>     — restart an app
 *   linuxify host remove <app>      — remove deployment
 *   linuxify host doctor            — diagnose hosting
 */

import { HostingEngine } from '../../hosting/index.js';
import { getActiveDistro } from '../../utils/distros.js';
import { confirm } from '../../utils/prompt.js';
import { EXIT_CODES } from '../../utils/constants.js';
import type { CommandContext } from '../context.js';
import type { RegisterCommandFn } from './index.js';

async function getEngine(ctx: CommandContext): Promise<HostingEngine> {
  const distro = await getActiveDistro(ctx.state.active_distro) ?? 'ubuntu';
  return new HostingEngine(distro);
}

export async function runHost(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand?: string,
  arg?: string,
): Promise<number> {
  const out = ctx.output;

  if (!subcommand) {
    out.info('Linuxify Hosting');
    out.info('');
    out.info('Commands:');
    out.info('  linuxify host init              Prepare hosting environment');
    out.info('  linuxify host auto              Detect and deploy current project');
    out.info('  linuxify host deploy <path>     Deploy a specific project');
    out.info('  linuxify host add <service>     Install database (postgres/mariadb/redis)');
    out.info('  linuxify host expose <app>      Configure public access');
    out.info('  linuxify host list               List deployed apps');
    out.info('  linuxify host status             Show service health');
    out.info('  linuxify host logs <app>         View logs');
    out.info('  linuxify host start <app>        Start app');
    out.info('  linuxify host stop <app>          Stop app');
    out.info('  linuxify host restart <app>     Restart app');
    out.info('  linuxify host remove <app>       Remove deployment');
    out.info('  linuxify host doctor             Diagnose hosting');
    out.info('');
    out.info('Run: linuxify host init to get started.');
    return EXIT_CODES.OK;
  }

  const engine = await getEngine(ctx);

  switch (subcommand) {
    case 'init': {
      out.info('Initializing hosting environment…');
      const result = await engine.init();
      if (result.success) {
        out.success(result.message);
      } else {
        out.error(result.message);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'auto': {
      const initialized = await engine.isInitialized();
      if (!initialized) {
        out.error('Hosting not initialized. Run: linuxify host init');
        return EXIT_CODES.ENV_NOT_READY;
      }

      const projectPath = process.cwd();
      out.info(`Detecting project type in ${projectPath}…`);
      const plan = await engine.plan(projectPath);

      out.info('');
      out.info('Deployment Plan:');
      out.info(`  Project: ${plan.detection.framework}`);
      out.info(`  Type: ${plan.detection.type}`);
      out.info(`  Name: ${plan.name}`);
      out.info(`  Port: ${plan.port}`);
      for (const step of plan.steps) {
        out.info(`  → ${step}`);
      }
      out.info('');

      if (plan.detection.type === 'unknown') {
        out.error('Could not detect project type. Try: linuxify host deploy <path>');
        return EXIT_CODES.NOT_FOUND;
      }

      const proceed = await confirm('Deploy now?', true);
      if (!proceed) {
        out.info('Deployment cancelled.');
        return EXIT_CODES.OK;
      }

      const result = await engine.deploy(projectPath);
      if (result.success) {
        out.success(result.message);
        out.info(`  URL: ${result.url}`);
      } else {
        out.error(result.message);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'deploy': {
      if (!arg) {
        out.error('Usage: linuxify host deploy <path>');
        return EXIT_CODES.GENERIC_ERROR;
      }

      const initialized = await engine.isInitialized();
      if (!initialized) {
        out.error('Hosting not initialized. Run: linuxify host init');
        return EXIT_CODES.ENV_NOT_READY;
      }

      out.info(`Deploying ${arg}…`);
      const result = await engine.deploy(arg);
      if (result.success) {
        out.success(result.message);
      } else {
        out.error(result.message);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'add': {
      if (!arg || !['postgres', 'mariadb', 'redis'].includes(arg)) {
        out.error('Usage: linuxify host add <postgres|mariadb|redis>');
        return EXIT_CODES.GENERIC_ERROR;
      }

      const initialized = await engine.isInitialized();
      if (!initialized) {
        out.error('Hosting not initialized. Run: linuxify host init');
        return EXIT_CODES.ENV_NOT_READY;
      }

      out.info(`Installing ${arg}…`);
      const result = await engine.addService(arg as 'postgres' | 'mariadb' | 'redis');
      if (result) {
        out.success(`${arg} installed. Listening on localhost only.`);
      } else {
        out.error(`Failed to install ${arg}.`);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'expose': {
      if (!arg) {
        out.error('Usage: linuxify host expose <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const result = await engine.expose(arg);
      out.info(result.message);
      if (result.url) {
        out.success(`URL: ${result.url}`);
      }
      return EXIT_CODES.OK;
    }

    case 'list': {
      const apps = await engine.list();
      if (apps.length === 0) {
        out.info('No deployed apps. Run: linuxify host auto');
        return EXIT_CODES.OK;
      }
      out.info('');
      out.info('Deployed Apps:');
      for (const app of apps) {
        const statusIcon = app.status === 'running' ? '✔' : '✖';
        const fw = app.framework ?? app.type;
        out.info(`  ${statusIcon} ${app.name.padEnd(20)} ${fw.padEnd(12)} port ${app.port}  ${app.status}`);
      }
      return EXIT_CODES.OK;
    }

    case 'status': {
      const status = await engine.status();
      out.info('');
      out.info('Apps:');
      for (const app of status.apps) {
        const icon = app.status === 'running' ? '✔' : '✖';
        out.info(`  ${icon} ${app.name.padEnd(20)} ${app.status}  port ${app.port}`);
      }
      if (status.services.length > 0) {
        out.info('');
        out.info('Services:');
        for (const svc of status.services as Array<{ name: string; status: string; port: number }>) {
          out.info(`  ${svc.status === 'running' ? '✔' : '✖'} ${svc.name.padEnd(12)} ${svc.status}  port ${svc.port}`);
        }
      }
      return EXIT_CODES.OK;
    }

    case 'logs': {
      if (!arg) {
        out.error('Usage: linuxify host logs <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const logs = await engine.logs(arg);
      out.info(logs);
      return EXIT_CODES.OK;
    }

    case 'start': {
      if (!arg) {
        out.error('Usage: linuxify host start <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const ok = await engine.startApp(arg);
      if (ok) {
        out.success(`Started ${arg}`);
      } else {
        out.error(`Failed to start ${arg}`);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'stop': {
      if (!arg) {
        out.error('Usage: linuxify host stop <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const ok = await engine.stopApp(arg);
      if (ok) {
        out.success(`Stopped ${arg}`);
      } else {
        out.error(`Failed to stop ${arg}`);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'restart': {
      if (!arg) {
        out.error('Usage: linuxify host restart <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const ok = await engine.restartApp(arg);
      if (ok) {
        out.success(`Restarted ${arg}`);
      } else {
        out.error(`Failed to restart ${arg}`);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'remove': {
      if (!arg) {
        out.error('Usage: linuxify host remove <app>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const proceed = await confirm(`Remove '${arg}'? This cannot be undone.`, false);
      if (!proceed) {
        out.info('Cancelled.');
        return EXIT_CODES.OK;
      }
      const ok = await engine.removeApp(arg);
      if (ok) {
        out.success(`Removed ${arg}`);
      } else {
        out.error(`Failed to remove ${arg}`);
        return EXIT_CODES.STEP_FAILED;
      }
      return EXIT_CODES.OK;
    }

    case 'doctor': {
      const result = await engine.doctor();
      out.info('');
      out.info(`Hosting: ${result.initialized ? '✔ Initialized' : '✖ Not initialized'}`);
      out.info(`nginx: ${result.nginxOk ? '✔' : '✖'}`);
      out.info(`PM2: ${result.pm2Ok ? '✔' : '✖'}`);
      if (result.issues.length > 0) {
        out.info('');
        out.info('Issues:');
        for (const issue of result.issues) {
          out.info(`  ⚠ ${issue}`);
        }
      }
      return EXIT_CODES.OK;
    }

    case 'stack': {
      out.info('Stack creation coming soon. Use:');
      out.info('  linuxify host deploy <frontend>');
      out.info('  linuxify host add postgres');
      out.info('  linuxify host deploy <backend>');
      return EXIT_CODES.OK;
    }

    default:
      out.error(`Unknown host subcommand: ${subcommand}`);
      out.info('Run: linuxify host --help');
      return EXIT_CODES.GENERIC_ERROR;
  }
}

export const registerHostCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('host [subcommand] [arg]')
    .description('Hosting subsystem — deploy and manage web apps on Android.')
    .allowUnknownOption(true)
    .action(async (subcommand: string | undefined, arg: string | undefined) => {
      const ctx = await getCtx();
      const code = await runHost({}, ctx, subcommand, arg);
      setExit(code);
    });
};
