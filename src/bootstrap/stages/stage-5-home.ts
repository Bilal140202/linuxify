// src/bootstrap/stages/stage-5-home.ts
//
// Stage 5 — Linuxify home setup.
//
// Creates the `~/.linuxify/` directory tree on the Termux host (not inside
// the proot) and seeds it with default configuration. The tree is the
// canonical layout every other Linuxify subsystem assumes; if any of these
// directories is missing, downstream stages (6-8) and other subsystems
// (launcher, patcher, doctor) will fail with confusing errors.
//
// See docs/05-bootstrap/bootstrap-design.md §1 (filesystem footprint) and
// §2 (Stage 5).

import { join } from 'node:path';

import { defaultState } from '../../state/index.js';
import type { State } from '../../state/index.js';
import { ensureDir, exists, writeFile } from '../../utils/fs.js';
import { logger } from '../../utils/log.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Subdirectories created under `~/.linuxify/`. Each is owned by exactly one
 * subsystem; cross-subsystem writes are forbidden by convention.
 */
export const LINUXIFY_HOME_SUBDIRS: readonly string[] = [
  'config',
  'state',
  'logs',
  'logs/runs',
  'packages',
  'patches',
  'distros',
  'plugins',
  'telemetry',
  'cache',
  'backups',
  'bin',
  '.bootstrap',
] as const;

/**
 * Default `config.toml` content written by Stage 5 when no config exists.
 * The shape matches the Zod schema in `src/config/schema.ts` (ConfigSchema)
 * — every section uses snake_case keys and is accepted by `ConfigSchema.parse`.
 *
 * The file is intentionally commented so a user opening it for the first
 * time understands what each section does. Stage 5 refuses to overwrite an
 * existing `config.toml` (preserving user edits across re-runs); to reset
 * to defaults the user deletes the file and re-runs
 * `linuxify init --from-stage 5`.
 */
export const DEFAULT_CONFIG_TOML = `# ~/.linuxify/config.toml — written by Linuxify bootstrap Stage 5.
# Safe to hand-edit; Linuxify will not overwrite this file. To reset to
# defaults, delete it and run 'linuxify init --from-stage 5'.

config_schema_version = 1

# Bootstrap controls one-shot environment bring-up (linuxify init).
[bootstrap]
distro = "ubuntu"
runtimes = ["node", "python"]
parallel_downloads = 4
locale = "en_US.UTF-8"
timezone = "UTC"
# mirror = "auto"  # uncomment to pin a specific rootfs mirror

# Distro selection when --distro is not given on the command line.
[distro]
default = "ubuntu"

# Default runtime versions. node_default_version accepts "lts", "latest",
# or a pinned semver like "22.11.0". python_default_version is a pinned
# version string like "3.12".
[runtime]
node_default_version = "lts"
python_default_version = "3.12"

# Telemetry is opt-in only. enabled = false until you explicitly turn it on.
[telemetry]
enabled = false
endpoint = "https://telemetry.linuxify.sh/v2"
sample_rate = 0.1

# Cloud sync is a v2 feature; v1 always has enabled = false.
[sync]
enabled = false
endpoint = "https://sync.linuxify.sh"

# Registry controls where package definitions are fetched from.
[registry]
url = "https://github.com/linuxify/registry"
branch = "main"
trust_self_signed = false

# Logging controls file and console output.
[logging]
level = "info"
file_enabled = true
console_enabled = true

# Internationalisation: message-catalog locale (falls back to "en").
[i18n]
locale = "en"

# Experimental feature flags. Empty by default.
[experimental]
features = []
`;

/**
 * Bootstrap Stage 5: Linuxify home setup.
 *
 * 1. Creates every directory in {@link LINUXIFY_HOME_SUBDIRS} under
 *    `~/.linuxify/`.
 * 2. Writes `~/.linuxify/config.toml` from {@link DEFAULT_CONFIG_TOML} if
 *    and only if no config exists (preserves user edits across re-runs).
 * 3. Initialises `~/.linuxify/state.json` via the supplied `StateStore`,
 *    using the state module's `defaultState()` and stamping the current
 *    Linuxify version. If `state.json` already exists, it is left alone
 *    (idempotency).
 *
 * @param ctx - Bootstrap context. Uses `ctx.stateStore` to write
 *   `state.json` and `ctx.linuxifyHome` / `ctx.markersDir` for paths.
 */
export async function stage5Home(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  try {
    // 1. Directory tree.
    for (const sub of LINUXIFY_HOME_SUBDIRS) {
      await ensureDir(join(ctx.linuxifyHome, sub));
    }
    logger.info('stage 5: directory tree created', {
      home: ctx.linuxifyHome,
      subdirs: LINUXIFY_HOME_SUBDIRS.length,
    });

    // 2. Default config.toml (only if missing).
    const configPath = join(ctx.linuxifyHome, 'config.toml');
    let configWritten = false;
    if (!(await exists(configPath))) {
      await writeFile(configPath, DEFAULT_CONFIG_TOML);
      configWritten = true;
      logger.info('stage 5: wrote default config.toml', { path: configPath });
    } else {
      logger.info('stage 5: config.toml already exists, preserving', { path: configPath });
    }

    // 3. state.json — delegate to StateStore. We check existence first so
    // we don't clobber an existing state file (idempotency). If the file
    // is corrupt or unparseable, we let the StateStore handle the repair
    // (its own concern).
    const statePath = join(ctx.linuxifyHome, 'state.json');
    let stateWritten = false;
    if (!(await exists(statePath))) {
      // Use the state module's `defaultState()` to get a schema-valid
      // State, then stamp the linuxify version from the bootstrap context.
      const state: State = {
        ...defaultState(),
        linuxify_version: ctx.linuxifyVersion,
      };
      await ctx.stateStore.save(state);
      stateWritten = true;
      logger.info('stage 5: wrote default state.json', { path: statePath });
    } else {
      logger.info('stage 5: state.json already exists, preserving', { path: statePath });
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        home: ctx.linuxifyHome,
        subdirsCreated: LINUXIFY_HOME_SUBDIRS.length,
        configWritten,
        stateWritten,
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 5 threw: ${(e as Error).message}`,
      details: { name: (e as Error).name, home: ctx.linuxifyHome },
    };
  }
}
