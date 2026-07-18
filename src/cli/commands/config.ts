/**
 * `linuxify config <key> [value]` — read/write user configuration.
 *
 * @module linuxify/cli/commands/config
 *
 * Without a value, prints the current value of the dotted key. With a value,
 * sets it. `config show` prints the entire effective config. `config reset`
 * restores defaults.
 *
 * The current implementation reads from the in-memory {@link Config} loaded
 * by the context (which already merged config.toml + env + flags). Writes
 * are written back to the user's config.toml via the loader's path
 * resolution (`LINUXIFY_CONFIG_PATH` → `~/.linuxify/config.toml`).
 *
 * @packageDocumentation
 */

import { dirname, join } from 'node:path';

import * as TOML from '@iarna/toml';

import { ConfigSchema, type Config } from '../../config/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { ConfigError } from '../../utils/errors.js';
import { readFile, writeFile, ensureDir, exists } from '../../utils/fs.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Resolve the user config file path. Mirrors the loader's precedence:
 * `LINUXIFY_CONFIG_PATH` env var → `~/.linuxify/config.toml`.
 */
function resolveConfigPath(explicit?: string): string {
  if (explicit) return explicit;
  const envPath = process.env.LINUXIFY_CONFIG_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return join(getLinuxifyHome(), 'config.toml');
}

/**
 * Read a dotted key from a plain object. Returns `undefined` if any segment
 * is missing.
 */
function readDotted(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Write a dotted key into a plain object, creating intermediate objects.
 */
function writeDotted(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof cur[part] !== 'object' || cur[part] === null) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Delete a dotted key from a plain object. Returns `true` if the key was
 * present and removed.
 */
function deleteDotted(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (typeof cur[part] !== 'object' || cur[part] === null) return false;
    cur = cur[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

/**
 * Run the `config` command.
 */
export async function runConfig(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  args: string[],
): Promise<number> {
  const out = ctx.output;
  const configPath = resolveConfigPath(
    typeof opts.config === 'string' ? opts.config : undefined,
  );

  // `config show` — print the effective config.
  if (!!(opts.show) || args[0] === 'show') {
    if (ctx.output.json) {
      out.printJson(ctx.config);
      return EXIT_CODES.OK;
    }
    const toml = TOML.stringify(ctx.config as unknown as TOML.JsonMap);
    out.info(toml);
    return EXIT_CODES.OK;
  }

  // `config reset` — restore defaults.
  if (args[0] === 'reset') {
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would reset ${configPath} to defaults.`);
      return EXIT_CODES.OK;
    }
    const defaults = ConfigSchema.parse({});
    await ensureDir(dirname(configPath));
    await writeFile(configPath, TOML.stringify(defaults as unknown as TOML.JsonMap));
    out.success(`Config reset to defaults at ${configPath}.`);
    return EXIT_CODES.OK;
  }

  // `config --unset <key>` — delete a key.
  if (opts.unset) {
    const key = typeof opts.unset === 'string' ? opts.unset : args[0];
    if (!key) {
      out.error('Usage: linuxify config --unset <key>');
      return EXIT_CODES.GENERIC_ERROR;
    }
    if (!(await exists(configPath))) {
      out.error(`Config file not found: ${configPath}`);
      return EXIT_CODES.NOT_FOUND;
    }
    const raw = await readFile(configPath);
    const parsed = TOML.parse(raw) as Record<string, unknown>;
    if (!deleteDotted(parsed, key)) {
      out.error(`Key '${key}' not found in config.`);
      return EXIT_CODES.NOT_FOUND;
    }
    await writeFile(configPath, TOML.stringify(parsed as unknown as TOML.JsonMap));
    out.success(`Unset ${key}.`);
    return EXIT_CODES.OK;
  }

  // `config <key>` — read a value.
  if (args.length === 1) {
    const value = readDotted(ctx.config as unknown as Record<string, unknown>, args[0]!);
    if (value === undefined) {
      out.error(`Key '${args[0]}' not found in config.`);
      return EXIT_CODES.NOT_FOUND;
    }
    if (ctx.output.json) {
      out.printJson({ key: args[0], value });
      return EXIT_CODES.OK;
    }
    out.info(typeof value === 'object' ? JSON.stringify(value) : String(value));
    return EXIT_CODES.OK;
  }

  // `config <key> <value>` — set a value.
  if (args.length >= 2) {
    const key = args[0]!;
    const rawValue = args[1]!;
    // Parse the value: try JSON first, fall back to string.
    let value: unknown = rawValue;
    try {
      value = JSON.parse(rawValue);
    } catch {
      // Not JSON — keep as string.
    }

    // Read the existing file (or start from defaults).
    let parsed: Record<string, unknown>;
    if (await exists(configPath)) {
      const raw = await readFile(configPath);
      parsed = TOML.parse(raw) as Record<string, unknown>;
    } else {
      parsed = ConfigSchema.parse({}) as unknown as Record<string, unknown>;
    }

    writeDotted(parsed, key, value);

    // Validate the merged result before writing.
    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigError(
        `Invalid value for ${key}: ${result.error.issues.map((i) => i.message).join('; ')}`,
        { code: 'E_CONFIG_INVALID', details: { key, value: rawValue, issues: result.error.issues } },
      );
    }

    if (ctx.flags.dryRun) {
      out.info(`Dry run: would set ${key} = ${JSON.stringify(value)}.`);
      return EXIT_CODES.OK;
    }

    await ensureDir(dirname(configPath));
    await writeFile(configPath, TOML.stringify(parsed as unknown as TOML.JsonMap));
    out.success(`Set ${key} = ${JSON.stringify(value)}.`);
    return EXIT_CODES.OK;
  }

  // No args and no flags — show usage.
  out.info('Usage: linuxify config <key> [value] | --show | --unset <key>');
  return EXIT_CODES.OK;
}

/**
 * Register the `config` command.
 */
export const registerConfigCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const cmd = program
    .command('config [key] [value]')
    .description('Read or write keys in ~/.linuxify/config.toml.')
    .option('--show', 'Print the entire effective config.')
    .option('--unset <key>', 'Delete a key.')
    .option('--effective', 'Include compiled defaults in --show output.')
    .option('--global', 'Force write to the user config even when a project-local file exists.')
    .allowUnknownOption(true)
    .action(async (key: string | undefined, value: string | undefined, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const args: string[] = [];
      if (key !== undefined) args.push(key);
      if (value !== undefined) args.push(value);
      const code = await runConfig(opts, ctx, args);
      setExit(code);
    });
  void cmd;
};

// Re-export Config type for tests that import from this module.
export type { Config };
