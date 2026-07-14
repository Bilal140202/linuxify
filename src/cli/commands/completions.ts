/**
 * `linuxify completions <shell>` — generate shell completion scripts.
 *
 * @module linuxify/cli/commands/completions
 *
 * Generates a shell completion script for bash, zsh, or fish. The script is
 * printed to stdout; with `--install`, it is written to the standard
 * completions location and instructions are printed.
 *
 * The generated scripts are static — they cover the subcommand names and
 * the global flags. Dynamic completion (installed package names, distro
 * names) requires shell-specific runtime hooks that are out of scope for v1.
 *
 * @packageDocumentation
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { EXIT_CODES } from '../../utils/constants.js';
import { writeFile, ensureDir } from '../../utils/fs.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/** The supported shells. */
const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish'] as const;
type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** Check whether `name` is a supported shell. */
function isSupportedShell(name: string): name is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(name);
}

/**
 * Generate the bash completion script.
 */
function bashCompletion(): string {
  return `# linuxify bash completion
_linuxify() {
  local cur prev words cword
  _init_completion -n =: || return
  local cmds="init install use add remove run shell update upgrade doctor repair patch list search info config env self-update distros runtimes plugin telemetry snapshot restore snapshots gc completions"
  if [ $cword -eq 1 ]; then
    COMPREPLY=( $(compgen -W "$cmds" -- "$cur") )
  fi
}
complete -F _linuxify linuxify
`;
}

/**
 * Generate the zsh completion script.
 */
function zshCompletion(): string {
  return `#compdef linuxify
# linuxify zsh completion
_linuxify() {
  local -a cmds
  cmds=(
    'init:Bootstrap the Linuxify environment.'
    'install:Interactive alias for init.'
    'use:Switch the active distro.'
    'add:Install a package.'
    'remove:Uninstall a package.'
    'run:Run a package inside the proot.'
    'shell:Open a shell inside the distro.'
    'update:Refresh the package index.'
    'upgrade:Upgrade installed packages.'
    'doctor:Run health checks.'
    'repair:Apply auto-repairs.'
    'patch:Re-apply or rollback patches.'
    'list:List installed packages.'
    'search:Search the registry.'
    'info:Print package details.'
    'config:Read or write config.'
    'env:Print resolved environment.'
    'self-update:Update the Linuxify CLI.'
    'distros:Distro management.'
    'runtimes:Runtime management.'
    'plugin:Plugin management.'
    'telemetry:Telemetry management.'
    'snapshot:Take a snapshot.'
    'restore:Restore a snapshot.'
    'snapshots:List snapshots.'
    'gc:Garbage-collect caches and old logs.'
    'completions:Generate shell completions.'
  )
  _describe 'command' cmds
}
_linuxify "$@"
`;
}

/**
 * Generate the fish completion script.
 */
function fishCompletion(): string {
  return `# linuxify fish completion
complete -c linuxify -n '__fish_use_subcommand' -a 'init' -d 'Bootstrap the Linuxify environment.'
complete -c linuxify -n '__fish_use_subcommand' -a 'install' -d 'Interactive alias for init.'
complete -c linuxify -n '__fish_use_subcommand' -a 'use' -d 'Switch the active distro.'
complete -c linuxify -n '__fish_use_subcommand' -a 'add' -d 'Install a package.'
complete -c linuxify -n '__fish_use_subcommand' -a 'remove' -d 'Uninstall a package.'
complete -c linuxify -n '__fish_use_subcommand' -a 'run' -d 'Run a package.'
complete -c linuxify -n '__fish_use_subcommand' -a 'shell' -d 'Open a shell inside the distro.'
complete -c linuxify -n '__fish_use_subcommand' -a 'update' -d 'Refresh the package index.'
complete -c linuxify -n '__fish_use_subcommand' -a 'upgrade' -d 'Upgrade packages.'
complete -c linuxify -n '__fish_use_subcommand' -a 'doctor' -d 'Run health checks.'
complete -c linuxify -n '__fish_use_subcommand' -a 'repair' -d 'Apply auto-repairs.'
complete -c linuxify -n '__fish_use_subcommand' -a 'patch' -d 'Re-apply or rollback patches.'
complete -c linuxify -n '__fish_use_subcommand' -a 'list' -d 'List installed packages.'
complete -c linuxify -n '__fish_use_subcommand' -a 'search' -d 'Search the registry.'
complete -c linuxify -n '__fish_use_subcommand' -a 'info' -d 'Print package details.'
complete -c linuxify -n '__fish_use_subcommand' -a 'config' -d 'Read or write config.'
complete -c linuxify -n '__fish_use_subcommand' -a 'env' -d 'Print resolved environment.'
complete -c linuxify -n '__fish_use_subcommand' -a 'self-update' -d 'Update the Linuxify CLI.'
complete -c linuxify -n '__fish_use_subcommand' -a 'distros' -d 'Distro management.'
complete -c linuxify -n '__fish_use_subcommand' -a 'runtimes' -d 'Runtime management.'
complete -c linuxify -n '__fish_use_subcommand' -a 'plugin' -d 'Plugin management.'
complete -c linuxify -n '__fish_use_subcommand' -a 'telemetry' -d 'Telemetry management.'
complete -c linuxify -n '__fish_use_subcommand' -a 'snapshot' -d 'Take a snapshot.'
complete -c linuxify -n '__fish_use_subcommand' -a 'restore' -d 'Restore a snapshot.'
complete -c linuxify -n '__fish_use_subcommand' -a 'snapshots' -d 'List snapshots.'
complete -c linuxify -n '__fish_use_subcommand' -a 'gc' -d 'Garbage-collect.'
complete -c linuxify -n '__fish_use_subcommand' -a 'completions' -d 'Generate shell completions.'
`;
}

/**
 * Generate the completion script for the given shell.
 */
function generateCompletion(shell: SupportedShell): string {
  switch (shell) {
    case 'bash':
      return bashCompletion();
    case 'zsh':
      return zshCompletion();
    case 'fish':
      return fishCompletion();
  }
}

/**
 * Resolve the install path for the given shell's completion script.
 */
function installPath(shell: SupportedShell): string {
  const home = homedir();
  switch (shell) {
    case 'bash':
      return join(home, '.bashrc.d', 'linuxify.sh');
    case 'zsh':
      return join(home, '.zsh', 'completions', '_linuxify');
    case 'fish':
      return join(home, '.config', 'fish', 'completions', 'linuxify.fish');
  }
}

/**
 * Run the `completions` command.
 */
export async function runCompletions(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  shell: string,
): Promise<number> {
  const out = ctx.output;

  if (!shell || !isSupportedShell(shell)) {
    out.error(`Unsupported shell: '${shell ?? '(none)'}'.`);
    out.info(`  Supported shells: ${SUPPORTED_SHELLS.join(', ')}.`);
    return EXIT_CODES.NOT_FOUND;
  }

  const script = generateCompletion(shell);

  if (opts.install) {
    const dest = installPath(shell);
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would write completions to ${dest}.`);
      return EXIT_CODES.OK;
    }
    try {
      await ensureDir(join(dest, '..'));
      await writeFile(dest, script);
    } catch (err) {
      out.error(`Failed to install completions: ${(err as Error).message}`);
      return EXIT_CODES.GENERIC_ERROR;
    }
    out.success(`Installed to ${dest}`);
    if (shell === 'zsh') {
      out.info('Add this to ~/.zshrc: fpath+=(~/.zsh/completions); autoload -Uz compinit && compinit');
    } else if (shell === 'bash') {
      out.info('Add this to ~/.bashrc: [ -f ~/.bashrc.d/linuxify.sh ] && source ~/.bashrc.d/linuxify.sh');
    } else if (shell === 'fish') {
      out.info('Fish picks up completions from ~/.config/fish/completions/ automatically.');
    }
    return EXIT_CODES.OK;
  }

  // Default: print to stdout.
  out.info(script);
  return EXIT_CODES.OK;
}

/**
 * Register the `completions` command.
 */
export const registerCompletionsCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('completions <shell>')
    .description('Generate a shell completion script (bash, zsh, fish).')
    .option('--install', 'Write to the standard location and print instructions.')
    .action(async (shell: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runCompletions(opts, ctx, shell);
      setExit(code);
    });
};
