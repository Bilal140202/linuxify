/**
 * Command context — the shared bundle passed to every CLI subcommand.
 *
 * @module linuxify/cli/context
 *
 * The CLI's top-level router builds one {@link CommandContext} per invocation
 * and passes it to every registered subcommand action. The context bundles
 * the resolved config, the open state store, the output formatter, the
 * registry client, the doctor engine, the patcher engine, the plugin system,
 * and a minimal telemetry shim. Subcommands never reach into the global
 * process state or import subsystem singletons directly; they go through the
 * context so that tests can substitute in-memory implementations.
 *
 * The context is intentionally a concrete class with readonly fields (not a
 * bare interface) so that downstream code can rely on field ordering for
 * debugging (`util.inspect(ctx)` produces a stable, readable dump).
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import type { Config } from '../config/index.js';
import { loadConfig } from '../config/index.js';
import { createDoctorEngine, type DoctorEngine } from '../doctor/index.js';
import { PatcherEngine } from '../patcher/index.js';
import { createPluginSystem, type PluginSystem } from '../plugins/index.js';
import type { RegistryClient } from '../registry/index.js';
import { createRegistryClient } from '../registry/index.js';
import { StateStore, type State } from '../state/index.js';
import { getLinuxifyHome } from '../utils/process.js';

import { Output } from './output.js';

/**
 * Minimal telemetry client interface.
 *
 * The dedicated `telemetry` subsystem is not yet present in the v1 build, so
 * the CLI layer ships a thin shim backed by the `state.json#telemetry` block.
 * The shim satisfies this interface; when a real telemetry client lands, it
 * can drop in by implementing the same shape.
 */
export interface TelemetryClient {
  /** Whether telemetry is currently enabled. */
  isEnabled(): Promise<boolean>;
  /** Enable telemetry (sets `state.telemetry.enabled = true`). */
  enable(): Promise<void>;
  /** Disable telemetry (sets `state.telemetry.enabled = false`). */
  disable(): Promise<void>;
  /** Best-effort flush of any queued events. No-op in the v1 shim. */
  flush(): Promise<void>;
  /** Purge any persisted telemetry queue. No-op in the v1 shim. */
  purge(): Promise<void>;
  /** Return the last known flush timestamp, or `null`. */
  lastFlush(): Promise<string | null>;
}

/**
 * State-backed telemetry shim.
 *
 * Reads/writes the `state.json#telemetry` block only — no network, no event
 * queue. The CLI's `telemetry show / enable / disable / flush / purge`
 * commands go through this implementation; the real telemetry engine will
 * replace it without changing the {@link TelemetryClient} interface.
 */
class StateTelemetryClient implements TelemetryClient {
  constructor(private readonly stateStore: StateStore) {}

  async isEnabled(): Promise<boolean> {
    const state = await this.stateStore.load();
    return state.telemetry.enabled;
  }

  async enable(): Promise<void> {
    await this.stateStore.update((s) => {
      s.telemetry.enabled = true;
    });
  }

  async disable(): Promise<void> {
    await this.stateStore.update((s) => {
      s.telemetry.enabled = false;
    });
  }

  async flush(): Promise<void> {
    await this.stateStore.update((s) => {
      s.telemetry.last_flush = new Date().toISOString();
    });
  }

  async purge(): Promise<void> {
    await this.stateStore.update((s) => {
      s.telemetry.last_flush = null;
    });
  }

  async lastFlush(): Promise<string | null> {
    const state = await this.stateStore.load();
    return state.telemetry.last_flush;
  }
}

/**
 * The bundle of subsystems passed to every CLI subcommand action.
 *
 * Every field is populated by {@link createCommandContext}. Subcommands
 * receive the context as their second argument (after the commander `options`
 * object); they may freely read fields but must not mutate them.
 */
export interface CommandContext {
  /** The resolved Linuxify configuration (config.toml + env + flags). */
  readonly config: Config;
  /** The open state store for `~/.linuxify/state.json`. */
  readonly stateStore: StateStore;
  /** The shared {@link Output} instance (respects `--json`/`--quiet`/`--no-color`). */
  readonly output: Output;
  /** The registry client (clone + cache + search). */
  readonly registry: RegistryClient;
  /** The telemetry client shim. */
  readonly telemetry: TelemetryClient;
  /** The doctor engine, pre-loaded with every built-in check. */
  readonly doctor: DoctorEngine;
  /** The patcher engine, bound to the shared state store. */
  readonly patcher: PatcherEngine;
  /** The plugin system bundle (loader + registry + dispatcher). */
  readonly plugins: PluginSystem;
  /** The currently-loaded state (read once at startup; subcommands may reload). */
  readonly state: State;
  /** Parsed global flags. */
  readonly flags: Readonly<{
    /** `--dry-run` flag. */
    dryRun: boolean;
    /** `--yes` flag. */
    yes: boolean;
    /** `--offline` flag. */
    offline: boolean;
    /** `--no-telemetry` flag. */
    noTelemetry: boolean;
    /** `--distro <name>` override. */
    distro?: string;
    /** `--profile <name>` value. */
    profile?: string;
    /** `--verbose` count (0..3). */
    verbose: number;
    /** `--debug` flag. */
    debug: boolean;
  }>;
}

/**
 * Options accepted by {@link createCommandContext}.
 */
export interface CreateCommandContextOptions {
  /** Override the config file path (`--config`). */
  readonly configPath?: string;
  /** Apply a named profile (`--profile <name>`). */
  readonly profile?: string;
  /** Override the active distro for this invocation (`--distro <name>`). */
  readonly distro?: string;
  /** Whether `--json` was passed. */
  readonly json?: boolean;
  /** Whether `--quiet` was passed. */
  readonly quiet?: boolean;
  /** Whether `--no-color` was passed. */
  readonly noColor?: boolean;
  /** Whether `--dry-run` was passed. */
  readonly dryRun?: boolean;
  /** Whether `--yes` was passed. */
  readonly yes?: boolean;
  /** Whether `--offline` was passed. */
  readonly offline?: boolean;
  /** Whether `--no-telemetry` was passed. */
  readonly noTelemetry?: boolean;
  /** Verbose count (0..3). */
  readonly verbose?: number;
  /** Whether `--debug` was passed. */
  readonly debug?: boolean;
}

/**
 * Build a fully-wired {@link CommandContext} from the resolved flags.
 *
 * Steps:
 *  1. Load the config (config.toml + env + flags). The `--distro` flag is
 *     applied as a CLI flag override so every consumer sees the active distro.
 *  2. Open the state store and load the current state.
 *  3. Create the {@link Output} formatter.
 *  4. Create the registry client.
 *  5. Create the telemetry shim.
 *  6. Create the doctor engine (built-in checks auto-registered).
 *  7. Create the patcher engine bound to the state store.
 *  8. Create the plugin system (loader + registry + dispatcher).
 *  9. Return the bundle.
 *
 * @param opts - The resolved global flag values.
 * @returns A populated {@link CommandContext}.
 */
export async function createCommandContext(
  opts: CreateCommandContextOptions = {},
): Promise<CommandContext> {
  // 1. Load config. The `--distro` flag is applied as a CLI flag overlay so
  // every consumer sees the right active distro without having to read the
  // flag themselves.
  const flagOverlay: Partial<Config> = {};
  if (opts.distro) {
    flagOverlay.distro = { default: opts.distro };
  }
  const config = await loadConfig({
    configPath: opts.configPath,
    profile: opts.profile,
    flags: flagOverlay,
  });

  // 2. Open the state store and load the current state. The state store is
  // constructed with the canonical path; the path honors `LINUXIFY_HOME` so
  // tests can substitute a tmpdir.
  const statePath = join(getLinuxifyHome(), 'state.json');
  const stateStore = new StateStore(statePath);
  const state = await stateStore.load();

  // 3. Output formatter.
  const output = new Output({
    json: opts.json ?? false,
    quiet: opts.quiet ?? false,
    noColor: opts.noColor ?? false,
  });

  // 4. Registry client.
  const registry = createRegistryClient(config);

  // 5. Telemetry shim.
  const telemetry = new StateTelemetryClient(stateStore);

  // 6. Doctor engine.
  const doctor = createDoctorEngine();

  // 7. Patcher engine.
  const patcher = new PatcherEngine({ stateStore });

  // 8. Plugin system. The loader has not loaded any plugins yet — subcommands
  // that need them (e.g. `linuxify plugin list`) call `loader.loadAll()`
  // themselves. This avoids paying the discovery cost on every invocation.
  const plugins = createPluginSystem({ stateStore, config });

  return {
    config,
    stateStore,
    output,
    registry,
    telemetry,
    doctor,
    patcher,
    plugins,
    state,
    flags: {
      dryRun: opts.dryRun ?? false,
      yes: opts.yes ?? false,
      offline: opts.offline ?? false,
      noTelemetry: opts.noTelemetry ?? false,
      distro: opts.distro,
      profile: opts.profile,
      verbose: opts.verbose ?? 0,
      debug: opts.debug ?? false,
    },
  };
}
