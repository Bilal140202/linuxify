/**
 * `linuxify search <query>` — search the package registry.
 *
 * @module linuxify/cli/commands/search
 *
 * Delegates to {@link RegistryClient.search} (fuzzy match on name and
 * description, narrow by `--tag` / `--runtime`). Results are printed as a
 * table by default or as JSON when `--json` is given.
 *
 * @packageDocumentation
 */


import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `search` command.
 */
export async function runSearch(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  query: string,
): Promise<number> {
  const out = ctx.output;

  if (!query) {
    out.error('Usage: linuxify search <query>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const runtime = typeof opts.runtime === 'string' ? opts.runtime : undefined;
  const category = typeof opts.category === 'string' ? opts.category : undefined;
  const tagStr = typeof opts.tag === 'string' ? opts.tag : undefined;
  const tags = tagStr ? [tagStr] : undefined;
  const limitRaw = typeof opts.limit === 'string' ? Number.parseInt(opts.limit, 10) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 20;

  let results;
  try {
    results = await ctx.registry.search({ query, runtime, category, tags, limit });
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Search failed: ${(err as Error).message}`);
    return EXIT_CODES.NETWORK_ERROR;
  }

  if (results.length === 0) {
    out.info(`No packages matched '${query}'.`);
    return EXIT_CODES.OK;
  }

  if (ctx.output.json) {
    out.printJson(results);
    return EXIT_CODES.OK;
  }

  const rows = results.map((r) => ({
    name: r.name,
    version: r.version,
    description: r.description,
    runtime: r.runtime,
    score: r.score.toFixed(2),
  }));
  out.table(rows);
  return EXIT_CODES.OK;
}

/**
 * Register the `search` command.
 */
export const registerSearchCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('search <query>')
    .description('Search the registry for packages matching the query.')
    .option('--tag <t>', 'Filter by tag (repeatable in v1.1).')
    .option('--category <c>', 'Filter by category (ai, dev, sec, …).')
    .option('--runtime <r>', 'Filter by runtime (node, python, …).')
    .option('--limit <n>', 'Maximum results to return (default 20).')
    .option('--offline', 'Search the local index only.')
    .action(async (query: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runSearch(opts, ctx, query);
      setExit(code);
    });
};
