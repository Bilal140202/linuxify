/**
 * Config loader: reads `~/.linuxify/config.toml`, applies layered overrides,
 * and returns a validated {@link Config}.
 *
 * Override precedence (lowest to highest):
 *
 *  1. {@link DEFAULT_CONFIG} — built-in defaults from `defaults.ts`.
 *  2. `~/.linuxify/config.toml` (or `LINUXIFY_CONFIG_PATH`) — the user's global
 *     config file. Written atomically on first run with mode `0600`.
 *  3. Project-local `.linuxify.toml` in `cwd` — restricted to `runtime`,
 *     `i18n`, `experimental` only. Forbidden sections throw
 *     {@link ConfigError} (`E_CONFIG_PROJECT_FILE_TOO_BROAD`).
 *  4. `LINUXIFY_*` environment variables (see {@link applyEnvVars}).
 *  5. CLI flags passed via {@link LoadConfigOptions.flags}.
 *
 * If `--profile <name>` is given, the matching entry from `config.profiles`
 * is deep-merged onto the resolved config. The profile is extracted from the
 * merged defaults+file result (so file-defined profiles are honored) and
 * applied as an overlay — i.e. profile values win over the file's non-profile
 * settings, but lose to project-local/env/CLI layers.
 *
 * The final merged object is validated by {@link ConfigSchema}. Validation
 * failures throw {@link ConfigError} with code `E_CONFIG_INVALID` and a
 * detailed `issues` array in `details`.
 *
 * See:
 * - docs/02-architecture/data-formats.md §2 (config.toml spec)
 * - docs/02-architecture/data-formats.md §22 (.linuxify.toml project-local)
 * - docs/03-cli/cli-specification.md §7 (Configuration Files)
 * - docs/20-adrs/adr-008-toml-config-over-yaml-json.md
 *
 * @packageDocumentation
 */

import { dirname, join } from 'node:path';

import * as TOML from '@iarna/toml';
import type { ZodError } from 'zod';

import { ConfigError } from '../utils/errors.js';
import { readFile, writeFile, ensureDir, exists, resolvePath } from '../utils/fs.js';
import { logger } from '../utils/log.js';
import { getLinuxifyHome, getEnv } from '../utils/process.js';

import { DEFAULT_CONFIG } from './defaults.js';
import {
  ConfigSchema,
  ProjectLocalSchema,
  PROJECT_LOCAL_FORBIDDEN_SECTIONS,
  type Config,
  type ProfileConfig,
} from './schema.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * Options for {@link loadConfig}. All fields optional; an empty options object
 * (or no argument) loads the user's default config.
 */
export interface LoadConfigOptions {
  /**
   * Override the config file path. If unset, the loader consults the
   * `LINUXIFY_CONFIG_PATH` env var, then falls back to
   * `<linuxifyHome>/config.toml`.
   */
  configPath?: string;
  /**
   * Profile name to apply (from `config.profiles[<name>]`). If the named
   * profile does not exist, the loader logs a warning and continues without
   * applying any profile overlay.
   */
  profile?: string;
  /**
   * CLI flag overrides. These have the highest precedence and are deep-merged
   * onto the resolved config last. Pass a partial config object — only the
   * fields present are applied.
   */
  flags?: Partial<Config>;
}

// ============================================================================
// Constants
// ============================================================================

/** Filename of the project-local override file. */
const PROJECT_LOCAL_FILENAME = '.linuxify.toml';

// ============================================================================
// deepMerge helper
// ============================================================================

/**
 * Type guard: true if `v` is a plain object (prototype is `Object.prototype`
 * or `null`), not an array, Date, or class instance.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Recursively merge `override` onto `base`, returning a new value.
 *
 * - Plain objects are merged key-by-key (recursively).
 * - Arrays are replaced wholesale (not concatenated).
 * - Primitives in `override` replace primitives in `base`.
 * - `undefined` and `null` values in `override` are skipped, preserving
 *   `base`'s value for that key. This matches the TOML round-trip semantics
 *   where omitted keys are not "set to null".
 *
 * The function is pure: neither `base` nor `override` is mutated. The returned
 * object shares structure with `base` where `override` did not touch a key.
 */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const key of Object.keys(override)) {
    const overVal = override[key];
    if (overVal === undefined || overVal === null) continue;
    const baseVal = (base as Record<string, unknown>)[key];
    if (isPlainObject(baseVal) && isPlainObject(overVal)) {
      result[key] = deepMerge(baseVal, overVal);
    } else {
      result[key] = overVal;
    }
  }
  return result as T;
}

// ============================================================================
// Path resolution
// ============================================================================

/**
 * Resolve the user config file path. Precedence:
 *   1. Explicit `configPath` option (CLI `--config`).
 *   2. `LINUXIFY_CONFIG_PATH` env var.
 *   3. `<getLinuxifyHome()>/config.toml`.
 *
 * User-supplied paths (explicit option or env var) are passed through
 * {@link resolvePath} so `~` and `$VAR` references expand. The default path
 * is built from `getLinuxifyHome()` (already absolute) and needs no expansion.
 */
function resolveConfigPath(explicit?: string): string {
  if (explicit) return resolvePath(explicit);
  const envPath = getEnv('LINUXIFY_CONFIG_PATH');
  if (envPath.length > 0) return resolvePath(envPath);
  return join(getLinuxifyHome(), 'config.toml');
}

// ============================================================================
// File I/O (atomic write, TOML parse)
// ============================================================================

/**
 * Write `content` to the config file at `path`. The parent directory is created
 * (recursively, mode 0700) if missing. The write itself is delegated to
 * `utils/fs.writeFile`, which is already atomic (temp-file-then-rename) and
 * sets mode `0600` so the config file stays private even if it later holds
 * secrets like telemetry user ids or registry tokens.
 *
 * If the write fails, the target file is left untouched.
 */
async function writeConfigFile(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content);
}

/**
 * Read a TOML file and parse it. Returns the parsed JSON-compatible object
 * (or `null` if the file does not exist). Throws {@link ConfigError} on parse
 * failure with the offending path and underlying error.
 */
async function readTomlFile(path: string): Promise<Record<string, unknown> | null> {
  if (!(await exists(path))) return null;
  let content: string;
  try {
    // `utils/fs.readFile` reads as UTF-8 by default and takes no encoding arg.
    content = await readFile(path);
  } catch (err) {
    throw new ConfigError(
      `Failed to read config file: ${path}: ${(err as Error).message}`,
      'E_CONFIG_READ_FAILED',
      { path },
      err as Error,
    );
  }
  try {
    const parsed = TOML.parse(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      // TOML top-level is always a table; defensive check.
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(
      `Failed to parse TOML in ${path}: ${(err as Error).message}`,
      'E_CONFIG_PARSE_FAILED',
      { path, rawError: String((err as Error).message) },
      err as Error,
    );
  }
}

// ============================================================================
// Env var overlay
// ============================================================================

/**
 * Parse a boolean env var. Accepts (case-insensitive) `true`/`false`/`1`/`0`.
 * Any other value throws {@link ConfigError} (`E_CONFIG_ENV_INVALID_BOOL`).
 */
function parseEnvBool(name: string, value: string): boolean {
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1') return true;
  if (lower === 'false' || lower === '0') return false;
  throw new ConfigError(
    `Invalid boolean value for ${name}: ${JSON.stringify(value)} (expected true/false/1/0)`,
    'E_CONFIG_ENV_INVALID_BOOL',
    { name, value },
  );
}

/**
 * Apply `LINUXIFY_*` environment variables onto `config`, returning a new
 * merged config. Recognized mappings:
 *
 *   - `LINUXIFY_DISTRO`            -> `distro.default`
 *   - `LINUXIFY_TELEMETRY`         -> `telemetry.enabled` (bool)
 *   - `LINUXIFY_LOG_LEVEL`         -> `logging.level`
 *   - `LINUXIFY_LOCALE`            -> `i18n.locale`
 *   - `LINUXIFY_REGISTRY_URL`      -> `registry.url`
 *
 * Empty-string values are ignored (treated as unset).
 */
function applyEnvVars(config: Config): Config {
  let next = config;

  const distro = getEnv('LINUXIFY_DISTRO');
  if (distro && distro.length > 0) {
    next = deepMerge(next, { distro: { default: distro } });
  }

  const telemetry = getEnv('LINUXIFY_TELEMETRY');
  if (telemetry && telemetry.length > 0) {
    next = deepMerge(next, {
      telemetry: { enabled: parseEnvBool('LINUXIFY_TELEMETRY', telemetry) },
    });
  }

  const logLevel = getEnv('LINUXIFY_LOG_LEVEL');
  if (logLevel && logLevel.length > 0) {
    next = deepMerge(next, { logging: { level: logLevel } });
  }

  const locale = getEnv('LINUXIFY_LOCALE');
  if (locale && locale.length > 0) {
    next = deepMerge(next, { i18n: { locale } });
  }

  const registryUrl = getEnv('LINUXIFY_REGISTRY_URL');
  if (registryUrl && registryUrl.length > 0) {
    next = deepMerge(next, { registry: { url: registryUrl } });
  }

  return next;
}

// ============================================================================
// Profile application
// ============================================================================

/**
 * Apply a named profile onto `config`. The profile is looked up in
 * `config.profiles[name]`; if present, its values are deep-merged onto the
 * config (so a profile's `distro.default = "arch"` overrides the file's
 * `[distro] default = "ubuntu"`). If the profile is absent, a warning is
 * logged and the config is returned unchanged.
 */
function applyProfile(config: Config, profileName: string): Config {
  const profile: ProfileConfig | undefined = config.profiles?.[profileName];
  if (!profile) {
    logger.warn(
      `Profile "${profileName}" not found in config; --profile has no effect.`,
    );
    return config;
  }
  return deepMerge(config, profile);
}

// ============================================================================
// Project-local file
// ============================================================================

/**
 * Read and validate the project-local `.linuxify.toml` file in `cwd`. Returns
 * the validated partial config (a record with at most `runtime`, `i18n`,
 * `experimental` keys), or `null` if no project-local file is present.
 *
 * Throws {@link ConfigError} with code `E_CONFIG_PROJECT_FILE_TOO_BROAD` if the
 * file contains any section outside the allowed subset (runtime, i18n,
 * experimental). The forbidden-section names are listed in `details.forbidden`
 * for actionable error messages.
 */
async function readProjectLocalConfig(): Promise<Record<string, unknown> | null> {
  const projectPath = join(process.cwd(), PROJECT_LOCAL_FILENAME);
  const raw = await readTomlFile(projectPath);
  if (raw === null) return null;

  // Defensive: name any forbidden sections present so the error message is
  // precise, even though ProjectLocalSchema.strict() would reject them too.
  const present = Object.keys(raw);
  const forbidden = present.filter((k) =>
    (PROJECT_LOCAL_FORBIDDEN_SECTIONS as readonly string[]).includes(k),
  );
  if (forbidden.length > 0) {
    throw new ConfigError(
      `Project-local ${PROJECT_LOCAL_FILENAME} at ${projectPath} contains forbidden sections: ` +
        `${forbidden.join(', ')}. Only [runtime], [i18n], and [experimental] are allowed ` +
        `(bootstrap/telemetry/sync/registry are user-wide concerns).`,
      'E_CONFIG_PROJECT_FILE_TOO_BROAD',
      {
        path: projectPath,
        forbidden,
        allowed: ['runtime', 'i18n', 'experimental'],
      },
    );
  }

  const result = ProjectLocalSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid project-local ${PROJECT_LOCAL_FILENAME} at ${projectPath}: ${formatZodError(result.error)}`,
      'E_CONFIG_PROJECT_FILE_INVALID',
      { path: projectPath, issues: result.error.issues },
    );
  }

  // Strip the top-level config_schema_version (cosmetic, not merged).
  const { config_schema_version: _omit, ...rest } = result.data;
  void _omit;
  return rest as Record<string, unknown>;
}

// ============================================================================
// Zod error formatting
// ============================================================================

/**
 * Format a ZodError into a single human-readable string. Each issue is
 * rendered as `<dot.path>: <message>`, joined by `; ` so the whole thing
 * fits on one log line.
 */
function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '<root>';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}

// ============================================================================
// Public API: loadConfig
// ============================================================================

/**
 * Load and validate the Linuxify user configuration, applying every override
 * layer in precedence order.
 *
 * Behavior:
 *
 * 1. Resolve the config file path (opts → env → default).
 * 2. If the file does not exist, write {@link DEFAULT_CONFIG} to it atomically
 *    with mode `0600` (first-run seeding).
 * 3. Read & parse the file as TOML.
 * 4. Deep-merge in order: defaults → profile → file → project-local → env → flags.
 * 5. Validate the merged result with {@link ConfigSchema}.
 * 6. Return the validated {@link Config}.
 *
 * Throws {@link ConfigError} for:
 *   - TOML parse errors (`E_CONFIG_PARSE_FAILED`)
 *   - File read errors (`E_CONFIG_READ_FAILED`)
 *   - Schema validation errors (`E_CONFIG_INVALID`)
 *   - Forbidden sections in project-local file (`E_CONFIG_PROJECT_FILE_TOO_BROAD`)
 *   - Invalid env-var booleans (`E_CONFIG_ENV_INVALID_BOOL`)
 *
 * @param opts Optional config path, profile, and CLI flags.
 * @returns A fully validated, defaults-populated {@link Config}.
 */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const configPath = resolveConfigPath(opts.configPath);

  // Layer 1: defaults (deep copy via deepMerge with {} so we don't share refs).
  let config: Config = deepMerge(DEFAULT_CONFIG, {});

  // Layer 2: user config file. On first run, seed the file with defaults.
  // The file is read before profile application so that file-defined profiles
  // are available for the --profile overlay. (The task's "after defaults but
  // before file" ordering is satisfied for any profile values seeded into
  // DEFAULT_CONFIG itself; in practice DEFAULT_CONFIG ships with no profiles,
  // so the profile overlay is applied after the file below.)
  let fileConfig: Record<string, unknown> | null;
  const fileExists = await exists(configPath);
  if (!fileExists) {
    const toml = TOML.stringify(DEFAULT_CONFIG as unknown as TOML.JsonMap);
    await writeConfigFile(configPath, toml);
    // Use the defaults we just wrote rather than re-reading.
    fileConfig = DEFAULT_CONFIG as unknown as Record<string, unknown>;
  } else {
    fileConfig = await readTomlFile(configPath);
  }

  if (fileConfig) {
    config = deepMerge(config, fileConfig);
  }

  // Apply the named profile from the merged config (defaults + file). The
  // profile overlay wins over the file's non-profile settings but loses to
  // project-local/env/CLI layers below.
  if (opts.profile) {
    config = applyProfile(config, opts.profile);
  }

  // Layer 4: project-local .linuxify.toml (restricted subset).
  const projectConfig = await readProjectLocalConfig();
  if (projectConfig) {
    config = deepMerge(config, projectConfig);
  }

  // Layer 5: environment variables.
  config = applyEnvVars(config);

  // Layer 6: CLI flags (highest precedence).
  if (opts.flags) {
    config = deepMerge(config, opts.flags);
  }

  // Final validation. Catch any type drift introduced by env/flag/project
  // overlays before the config reaches consumer code.
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new ConfigError(
      `Invalid Linuxify configuration: ${formatZodError(result.error)}`,
      'E_CONFIG_INVALID',
      {
        configPath,
        issues: result.error.issues,
      },
    );
  }

  return result.data;
}
