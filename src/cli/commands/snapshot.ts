/**
 * `linuxify snapshot` / `linuxify restore` / `linuxify snapshots` — snapshot
 * management subcommands.
 *
 * @module linuxify/cli/commands/snapshot
 *
 * The implementation delegates to the active distro provider's `snapshot`
 * and `restore` methods (defined by `DistroProvider`).
 *
 * Subcommands:
 *  - `linuxify snapshot <name>` — take a snapshot of the active distro's rootfs.
 *  - `linuxify restore <name>` — restore a snapshot.
 *  - `linuxify snapshots list` — list snapshots for the active distro.
 *
 * @packageDocumentation
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';


import { getDistro } from '../../distros/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { isLinuxifyError } from '../../utils/errors.js';
import { exists } from '../../utils/fs.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Run `snapshot <name>`.
 */
async function runSnapshotTake(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify snapshot <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const distroName = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distroName) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  let provider;
  try {
    provider = getDistro(distroName);
  } catch {
    out.error(`Distro '${distroName}' is not registered.`);
    return EXIT_CODES.NOT_FOUND;
  }

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would snapshot distro '${distroName}' as '${name}'.`);
    return EXIT_CODES.OK;
  }

  out.progress(`Taking snapshot '${name}' of distro '${distroName}'…`);
  try {
    const snapshotPath = await provider.snapshot(name);
    out.success(`Snapshot saved: ${snapshotPath}`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to take snapshot: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run `restore <name>`.
 */
async function runSnapshotRestore(
  ctx: CommandContext,
  name: string,
): Promise<number> {
  const out = ctx.output;
  if (!name) {
    out.error('Usage: linuxify restore <name>');
    return EXIT_CODES.GENERIC_ERROR;
  }

  const distroName = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distroName) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  let provider;
  try {
    provider = getDistro(distroName);
  } catch {
    out.error(`Distro '${distroName}' is not registered.`);
    return EXIT_CODES.NOT_FOUND;
  }

  // Locate the snapshot file. The provider's snapshot() wrote it to
  // `~/.linuxify/snapshots/<distro>/<name>.tar.zst`.
  const snapshotPath = join(
    getLinuxifyHome(),
    'snapshots',
    distroName,
    `${name}.tar.zst`,
  );

  if (ctx.flags.dryRun) {
    out.info(`Dry run: would restore snapshot '${name}' into '${distroName}'.`);
    return EXIT_CODES.OK;
  }

  // Confirm unless --yes (restore is destructive).
  if (!ctx.flags.yes) {
    out.warn(`Restoring '${name}' will REPLACE the current '${distroName}' rootfs.`);
    out.warn('Any packages installed since the snapshot will be lost.');
    out.info('Re-run with --yes to proceed.');
    return EXIT_CODES.OK;
  }

  out.progress(`Restoring snapshot '${name}' into '${distroName}'…`);
  try {
    await provider.restore(snapshotPath);
    out.success(`Snapshot '${name}' restored.`);
    return EXIT_CODES.OK;
  } catch (err) {
    if (isLinuxifyError(err)) {
      out.error(err.message);
      return err.exitCode;
    }
    out.error(`Failed to restore snapshot: ${(err as Error).message}`);
    return EXIT_CODES.STEP_FAILED;
  }
}

/**
 * Run `snapshots list`.
 */
async function runSnapshotsList(ctx: CommandContext): Promise<number> {
  const out = ctx.output;
  const distroName = ctx.flags.distro ?? ctx.state.active_distro;
  if (!distroName) {
    out.error('No active distro. Run `linuxify use <distro>` first.');
    return EXIT_CODES.ENV_NOT_READY;
  }

  const snapshotsDir = join(getLinuxifyHome(), 'snapshots', distroName);
  if (!(await exists(snapshotsDir))) {
    out.info(`No snapshots for distro '${distroName}'.`);
    return EXIT_CODES.OK;
  }

  let entries: string[];
  try {
    entries = await readdir(snapshotsDir);
  } catch (err) {
    out.error(`Failed to list snapshots: ${(err as Error).message}`);
    return EXIT_CODES.GENERIC_ERROR;
  }

  const snapshots = entries
    .filter((e) => e.endsWith('.tar.zst'))
    .map((e) => e.slice(0, -'.tar.zst'.length));
  if (snapshots.length === 0) {
    out.info(`No snapshots for distro '${distroName}'.`);
    return EXIT_CODES.OK;
  }

  if (ctx.output.json) {
    out.printJson({ distro: distroName, snapshots });
    return EXIT_CODES.OK;
  }

  out.info(`Snapshots for distro '${distroName}':`);
  for (const s of snapshots) {
    out.info(`  ${s}`);
  }
  return EXIT_CODES.OK;
}

/**
 * Run the `snapshot` / `restore` / `snapshots` command.
 */
export async function runSnapshot(
  _opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string,
  name?: string,
): Promise<number> {
  // `linuxify snapshot <name>` (no subcommand).
  if (!subcommand || subcommand === 'take') {
    return runSnapshotTake(ctx, name ?? '');
  }
  switch (subcommand) {
    case 'restore':
      return runSnapshotRestore(ctx, name ?? '');
    case 'list':
      return runSnapshotsList(ctx);
    default:
      ctx.output.error(`Unknown snapshot subcommand: ${subcommand}`);
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Register the `snapshot`, `restore`, and `snapshots` commands.
 */
export const registerSnapshotCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  program
    .command('snapshot <name>')
    .description('Take a snapshot of the active distro rootfs.')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runSnapshot({}, ctx, 'take', name);
      setExit(code);
    });

  program
    .command('restore <name>')
    .description('Restore a previously-taken snapshot (destructive).')
    .action(async (name: string) => {
      const ctx = await getCtx();
      const code = await runSnapshot({}, ctx, 'restore', name);
      setExit(code);
    });

  const snapshots = program.command('snapshots').description('List snapshots.');
  snapshots
    .command('list')
    .description('List snapshots for the active distro.')
    .action(async () => {
      const ctx = await getCtx();
      const code = await runSnapshot({}, ctx, 'list');
      setExit(code);
    });
};
