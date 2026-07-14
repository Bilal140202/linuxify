/**
 * `linuxify patch <package>` — re-apply or rollback compatibility patches.
 *
 * @module linuxify/cli/commands/patch
 *
 * Re-applies (or with `--rollback`/`--rollback-all`, undoes) the
 * compatibility patches declared in the package's YAML. Useful after a
 * manual `npm update` inside the distro that overwrote patched files.
 *
 * @packageDocumentation
 */

import { join } from 'node:path';


import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { logger } from '../../utils/log.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run the `patch` command.
 */
export async function runPatch(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  packageName: string,
): Promise<number> {
  const out = ctx.output;

  if (!packageName) {
    out.error('Usage: linuxify patch <package>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const state = await ctx.stateStore.load();
  const install = state.installed_packages.find((p) => p.name === packageName);
  if (!install) {
    out.error(`Package '${packageName}' is not installed.`);
    return EXIT_CODES.NOT_FOUND;
  }

  // --list: print declared patches and exit.
  if (opts.list) {
    const applied = state.applied_patches.filter((p) => p.package === packageName);
    if (applied.length === 0) {
      out.info(`No patches applied for ${packageName}.`);
    } else {
      out.info(`Applied patches for ${packageName}:`);
      for (const p of applied) {
        out.info(`  ${p.patch_id}  ${p.applied_to_file}  (verified: ${p.verified})`);
      }
    }
    return EXIT_CODES.OK;
  }

  // Fetch the package definition to get the patch list.
  const pkg = await ctx.registry.getPackage(packageName);
  if (!pkg) {
    out.error(`Package '${packageName}' is not in the registry.`);
    return EXIT_CODES.NOT_FOUND;
  }

  const patchCtx = {
    packageInstallPath: join(getLinuxifyHome(), 'packages', packageName),
    distro: install.distro,
    stateStore: ctx.stateStore,
  };

  // --rollback-all: undo every patch.
  if (opts.rollbackAll) {
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would roll back all patches for ${packageName}.`);
      return EXIT_CODES.OK;
    }
    try {
      await ctx.patcher.rollbackAll(packageName, patchCtx);
      out.success(`Rolled back all patches for ${packageName}.`);
      return EXIT_CODES.OK;
    } catch (err) {
      if (isLinuxifyError(err)) {
        out.error(err.message);
        return err.exitCode;
      }
      out.error(`Internal error: ${(err as Error).message}`);
      return EXIT_CODES.GENERIC_ERROR;
    }
  }

  // --rollback <patch_id>: undo a single patch.
  const rollbackId = typeof opts.rollback === 'string' ? opts.rollback : undefined;
  if (rollbackId) {
    if (ctx.flags.dryRun) {
      out.info(`Dry run: would roll back patch ${rollbackId}.`);
      return EXIT_CODES.OK;
    }
    try {
      const ok = await ctx.patcher.rollbackPatch(rollbackId, packageName, patchCtx);
      if (ok) {
        out.success(`Rolled back patch ${rollbackId}.`);
        return EXIT_CODES.OK;
      }
      out.warn(`Patch ${rollbackId} not found in state; nothing to roll back.`);
      return EXIT_CODES.PATCH_ALREADY_APPLIED;
    } catch (err) {
      if (isLinuxifyError(err)) {
        out.error(err.message);
        return err.exitCode;
      }
      out.error(`Internal error: ${(err as Error).message}`);
      return EXIT_CODES.GENERIC_ERROR;
    }
  }

  // Default: re-apply all declared patches.
  if (pkg.patches.length === 0) {
    out.info(`${packageName} declares no patches.`);
    return EXIT_CODES.OK;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would apply ${pkg.patches.length} patch(es) to ${packageName}.`);
    for (const p of pkg.patches) {
      out.info(`  ${p.patch_id}  ${p.file}`);
    }
    return EXIT_CODES.OK;
  }

  out.progress(`Applying ${pkg.patches.length} patch(es) to ${packageName}…`);
  try {
    const results = await ctx.patcher.applyPatches(pkg.patches, patchCtx, {
      force: !!(opts.force),
      onProgress: (msg) => out.progress(msg),
    });
    const applied = results.filter((r) => r.applied).length;
    const failed = results.filter((r) => !r.success).length;
    if (failed > 0) {
      out.warn(`Applied ${applied}, failed ${failed}.`);
      return EXIT_CODES.STEP_FAILED;
    }
    out.success(`${applied} patch(es) applied.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    logger.error({ err: (err as Error).message }, 'patch command crashed');
    out.error(`Internal error: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `patch` command.
 */
export const registerPatchCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('patch <package>')
    .description('Re-apply or rollback compatibility patches for a package.')
    .option('--force', 'Re-apply patches even if state records them as applied.')
    .option('--rollback <patch_id>', 'Roll back a single patch by its stable id.')
    .option('--rollback-all', 'Roll back every patch applied to the package.')
    .option('--list', 'Print the declared patches without applying them.')
    .option('--dry-run', 'Print what would be done without modifying files.')
    .action(async (packageName: string, opts: Record<string, unknown>) => {
      const ctx = await getCtx();
      const code = await runPatch(opts, ctx, packageName);
      setExit(code);
    });
};
