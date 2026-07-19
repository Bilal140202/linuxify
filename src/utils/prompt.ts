/**
 * Interactive prompt utilities — readline-based yes/no and text prompts.
 *
 * @module linuxify/utils/prompt
 *
 * These utilities provide the real interactive prompt that `linuxify repair`
 * and other commands use for confirmation. They use Node's built-in
 * `readline` module with `process.stdin`/`process.stdout`.
 *
 * **TTY detection:** If stdin is not a TTY (e.g., piped input, CI), the
 * prompt returns the default value immediately without waiting for input.
 * This prevents hangs in non-interactive environments.
 *
 * **Signal handling:** If the user presses Ctrl-C during a prompt, the
 * process receives SIGINT as normal — readline does not suppress it.
 *
 * **Raw mode:** We do NOT use `setRawMode(true)` — that can leave the
 * terminal in a broken state if the process crashes. Standard readline
 * cooked mode is sufficient for y/n prompts and is safe.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

/**
 * Check if stdin is a TTY (interactive terminal).
 */
export function isInteractive(): boolean {
  return Boolean(input.isTTY);
}

/**
 * Prompt the user for a yes/no answer.
 *
 * @param question - The question to ask (without the [y/n] suffix).
 * @param defaultValue - If the user just presses Enter, return this.
 *   `true` = default yes, `false` = default no. Default: `false`.
 * @returns `true` for yes, `false` for no.
 */
export async function confirm(question: string, defaultValue = false): Promise<boolean> {
  // Non-interactive (piped stdin, CI) — return default immediately.
  if (!isInteractive()) {
    return defaultValue;
  }

  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const rl = readline.createInterface({ input, output, terminal: false });

  try {
    const answer = await rl.question(question + suffix + ' ');
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === '') return defaultValue;
    return trimmed === 'y' || trimmed === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Prompt the user for a line of text.
 *
 * @param question - The prompt text.
 * @param defaultValue - If the user just presses Enter, return this.
 * @returns The user's input (trimmed), or the default.
 */
export async function prompt(question: string, defaultValue = ''): Promise<string> {
  if (!isInteractive()) {
    return defaultValue;
  }

  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = await rl.question(question + suffix + ' ');
    const trimmed = answer.trim();
    return trimmed === '' ? defaultValue : trimmed;
  } finally {
    rl.close();
  }
}
