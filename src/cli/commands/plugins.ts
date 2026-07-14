/**
 * `linuxify plugin` — plugin management subcommands.
 *
 * @module linuxify/cli/commands/plugins
 *
 * Subcommands:
 *  - `linuxify plugin list` — list discovered plugins.
 *  - `linuxify plugin install <name>` — install a plugin (v1.1: registry
 *    install is not yet wired; this command records a plugin in state after
 *    the user has manually placed it under `~/.linuxify/plugins/`).
 *  - `linuxify plugin uninstall <name>` — remove a plugin.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run `plugin list`.
 */
async function runPluginList(ctx: CommandContext): Promise<number> {
  const out = ctx.output;

  // Discover available plugins on disk.
  let manifests;
  try {
    manifests = await ctx.plugins.loader.discover();
  } catch (err) {
    out.error(`Failed to discover plugins: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }

  if (manifests.length === 0) {
    out.info('No plugins found.');
    out.info('  Plugins are loaded from ~/.linuxify/plugins/<name>/linuxify.plugin.json');
    return EXIT_CODES.OK;
  }

  // Cross-reference with the in-memory registry to get enabled status.
  const rows = manifests.map((m) => {
    const registered = ctx.plugins.registry.get(m.name);
    const stateEntry = ctx.state.plugins.find((p) => p.name === m.name);
    return {
      name: m.name,
      version: m.version,
      enabled: registered?.enabled ?? stateEntry?.enabled ?? false,
      hooks: Object.keys(m.hooks).length,
    };
  });

  if (ctx.output.json) {
    out.printJson(rows);
    return EXIT_CODES.OK;
  }
  out.table(rows);
  return EXIT_CODES.OK;
}

/**
 * Run `plugin install <name>`.
 *
 * v1: loads the plugin from disk (it must already be placed at
 * `~/.linuxify/plugins/<name>/`) and records it in state.
 */
async function runPluginInstall(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify plugin install <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would install plugin '${name}'.`);
    return EXIT_CODES.OK;
  }

  try {
    const plugin = await ctx.plugins.loader.load(name);
    ctx.plugins.registry.register(plugin);
    await ctx.stateStore.update((s) => {
      if (!s.plugins.some((p) => p.name === name)) {
        s.plugins.push({
          name,
          version: plugin.manifest.version,
          source: `file://${plugin.path}`,
          installed_at: new Date().toISOString(),
          enabled: true,
          hooks_used: Object.keys(plugin.hooks),
        });
      }
    });
    out.success(`Plugin '${name}' installed.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to install plugin: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run `plugin uninstall <name>`.
 */
async function runPluginUninstall(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify plugin uninstall <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would uninstall plugin '${name}'.`);
    return EXIT_CODES.OK;
  }

  try {
    ctx.plugins.registry.unregister(name);
    try {
      await ctx.plugins.loader.unload(name);
    } catch (err) {
      logger.debug(
        { name, err: (err as Error).message },
        'failed to unload plugin during uninstall',
      );
    }
    await ctx.stateStore.update((s) => {
      s.plugins = s.plugins.filter((p) => p.name !== name);
    });
    out.success(`Plugin '${name}' uninstalled.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to uninstall plugin: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run the `plugin` command.
 */
export async function runPlugins(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string,
  name?: string,
): Promise<number> {
  switch (subcommand) {
    case 'list':
      return runPluginList(ctx);
    case 'install':
      return runPluginInstall(ctx, name ?? '');
    case 'uninstall':
      return runPluginUninstall(ctx, name ?? '');
    default:
      ctx.output.error(`Unknown plugin subcommand: ${subcommand ?? '(none)'}`);
      ctx.output.info('  Available: list, install, uninstall');
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `plugin` command with its subcommands.
 */
export const registerPluginsCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const plugin = program.command('plugin').description('Plugin management.');

  plugin
    .command('list')
    .description('List discovered plugins.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runPlugins({}, ctx, 'list');
      setExit(code);
    });

  plugin
    .command('install <name>')
    .description('Install (load) a plugin from ~/.linuxify/plugins/.')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runPlugins({}, ctx, 'install', name);
      setExit(code);
    });

  plugin
    .command('uninstall <name>')
    .description('Uninstall (unload) a plugin.')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runPlugins({}, ctx, 'uninstall', name);
      setExit(code);
    });
};
