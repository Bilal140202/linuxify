/**
 * Barrel + registration helper for CLI subcommands.
 *
 * @module linuxify/cli/commands
 *
 * Every subcommand lives in its own file under `src/cli/commands/<name>.ts`.
 * Each file exports a `register<Name>Command(program, getCtx, setExit)`
 * function that attaches a commander `Command` to the program and wires its
 * action callback. This module's {@link registerAllCommands} calls each
 * registration function in turn, producing the full command tree.
 *
 * The registration API is parameterized by a context-builder (`getCtx`) and
 * an exit-code setter (`setExit`) so commands can be registered without
 * forcing the full {@link CommandContext} to be constructed at registration
 * time. The context is built lazily on first dispatch (after `--help` /
 * `--version` short-circuits have already returned).
 *
 * @packageDocumentation
 */


import type { Command } from 'commander';

import type { CommandContext } from '../context.js';

import { registerAddCommand } from './add.js';
import { registerCompletionsCommand } from './completions.js';
import { registerConfigCommand } from './config.js';
import { registerDistrosCommand } from './distros.js';
import { registerDoctorCommand } from './doctor.js';
import { registerEnvCommand } from './env.js';
import { registerGcCommand } from './gc.js';
import { registerInfoCommand } from './info.js';
import { registerInitCommand } from './init.js';
import { registerInstallCommand } from './install.js';
import { registerListCommand } from './list.js';
import { registerPatchCommand } from './patch.js';
import { registerPluginsCommand } from './plugins.js';
import { registerRemoveCommand } from './remove.js';
import { registerRepairCommand } from './repair.js';
import { registerRunCommand } from './run.js';
import { registerRuntimesCommand } from './runtimes.js';
import { registerSearchCommand } from './search.js';
import { registerSelfUpdateCommand } from './self-update.js';
import { registerShellCommand } from './shell.js';
import { registerSnapshotCommand } from './snapshot.js';
import { registerTelemetryCommand } from './telemetry.js';
import { registerUpdateCommand } from './update.js';
import { registerUpgradeCommand } from './upgrade.js';
import { registerUseCommand } from './use.js';

/**
 * Function that returns the shared {@link CommandContext}, building it on
 * first call. Subcommand actions call this to obtain the context — the
 * indirection lets the router skip context construction for `--help` /
 * `--version` short-circuits.
 */
export type GetContext = () => Promise<CommandContext>;

/**
 * Function that records the action's exit code. Subcommand actions call this
 * with their return value before resolving; the router reads the most recent
 * value after `parseAsync` completes.
 */
export type SetExitCode = (code: number) => void;

/**
 * Registration function type — each command file exports one of these.
 */
export type RegisterCommandFn = (
  program: Command,
  getCtx: GetContext,
  setExit: SetExitCode,
) => void;

/**
 * Register every built-in subcommand with the given commander program.
 *
 * The order in which commands are registered determines the order they
 * appear in `linuxify --help`. We register them in the order documented in
 * `cli-specification.md` §4 (init, install, use, add, remove, run, shell,
 * update, upgrade, doctor, repair, patch, list, search, info, config, env,
 * self-update, completions) followed by the management commands (distros,
 * runtimes, plugins, telemetry, snapshot, gc) which are listed in the
 * "Additional commands" section of the command-reference doc.
 *
 * @param program - The commander program to attach commands to.
 * @param getCtx - Lazy context builder; called when a subcommand action runs.
 * @param setExit - Exit-code setter; called by each action with its result.
 */
export function registerAllCommands(
  program: Command,
  getCtx: GetContext,
  setExit: SetExitCode,
): void {
  // Bootstrap / lifecycle.
  registerInitCommand(program, getCtx, setExit);
  registerInstallCommand(program, getCtx, setExit);
  registerUseCommand(program, getCtx, setExit);

  // Package lifecycle.
  registerAddCommand(program, getCtx, setExit);
  registerRemoveCommand(program, getCtx, setExit);
  registerRunCommand(program, getCtx, setExit);
  registerShellCommand(program, getCtx, setExit);

  // Updates.
  registerUpdateCommand(program, getCtx, setExit);
  registerUpgradeCommand(program, getCtx, setExit);

  // Diagnostics & repair.
  registerDoctorCommand(program, getCtx, setExit);
  registerRepairCommand(program, getCtx, setExit);
  registerPatchCommand(program, getCtx, setExit);

  // Discovery.
  registerListCommand(program, getCtx, setExit);
  registerSearchCommand(program, getCtx, setExit);
  registerInfoCommand(program, getCtx, setExit);

  // Config / env.
  registerConfigCommand(program, getCtx, setExit);
  registerEnvCommand(program, getCtx, setExit);
  registerSelfUpdateCommand(program, getCtx, setExit);

  // Management commands.
  registerDistrosCommand(program, getCtx, setExit);
  registerRuntimesCommand(program, getCtx, setExit);
  registerPluginsCommand(program, getCtx, setExit);
  registerTelemetryCommand(program, getCtx, setExit);
  registerSnapshotCommand(program, getCtx, setExit);
  registerGcCommand(program, getCtx, setExit);

  // Shell completions.
  registerCompletionsCommand(program, getCtx, setExit);
}
