/**
 * Zod schema for the Linuxify user configuration file (`~/.linuxify/config.toml`).
 *
 * The schema is the single source of truth for the shape of {@link Config}. The
 * TypeScript type is inferred from the schema via `z.infer`, so the two cannot
 * drift apart. Every section is optional with sensible defaults; an empty TOML
 * document parses successfully into a fully-populated {@link Config}.
 *
 * All objects use `.strict()` so unknown keys are rejected at parse time — this
 * catches typos like `[telmetry]` early instead of silently dropping the user's
 * intent. The recursive {@link ProfileSchema} allows named profiles to contain
 * any subset of the same sections, including nested profiles.
 *
 * See:
 * - docs/02-architecture/data-formats.md §2 (config.toml spec)
 * - docs/02-architecture/data-formats.md §22 (.linuxify.toml project-local)
 * - docs/20-adrs/adr-008-toml-config-over-yaml-json.md
 * - docs/20-adrs/adr-015-zod-for-schema-validation.md
 *
 * @packageDocumentation
 */

import { z } from 'zod';

// ============================================================================
// Section schemas
// ============================================================================

/**
 * Schema for the `[bootstrap]` section. Controls one-shot environment bring-up.
 */
export const BootstrapSchema = z
  .object({
    /** Default distro to install if none is specified. */
    distro: z.string().default('ubuntu'),
    /** Optional rootfs mirror override (URL or local path). */
    mirror: z.string().optional(),
    /** Additional runtimes to install during bootstrap (e.g. ["rust", "go"]). */
    runtimes: z.array(z.string()).default([]),
    /** Maximum parallel downloads during bootstrap (1..64). */
    parallel_downloads: z.number().int().min(1).max(64).default(4),
    /** Locale to set inside the proot environment. */
    locale: z.string().default('en_US.UTF-8'),
    /** Timezone to set inside the proot environment. */
    timezone: z.string().default('UTC'),
  })
  .strict();

/** Inferred type for the [bootstrap] section. */
export type BootstrapConfig = z.infer<typeof BootstrapSchema>;

/**
 * Schema for the `[distro]` section. Holds the active distro selector.
 */
export const DistroSchema = z
  .object({
    /** Distro used when `--distro` is not given on the command line. */
    default: z.string().default('ubuntu'),
  })
  .strict();

/** Inferred type for the [distro] section. */
export type DistroConfig = z.infer<typeof DistroSchema>;

/**
 * Schema for the `[runtime]` section. Holds default runtime versions.
 */
export const RuntimeSchema = z
  .object({
    /** Default Node.js version: "lts", "latest", or a pinned semver. */
    node_default_version: z.string().default('lts'),
    /** Default Python version: a pinned version string like "3.12". */
    python_default_version: z.string().default('3.12'),
  })
  .strict();

/** Inferred type for the [runtime] section. */
export type RuntimeConfig = z.infer<typeof RuntimeSchema>;

/**
 * Schema for the `[telemetry]` section. Telemetry is opt-in only.
 */
export const TelemetrySchema = z
  .object({
    /** Whether anonymous usage telemetry is collected. Defaults to false. */
    enabled: z.boolean().default(false),
    /** Rotating user id assigned on first opt-in. Empty/absent until then. */
    user_id: z.string().optional(),
    /** Telemetry ingestion endpoint. */
    endpoint: z.string().default('https://telemetry.linuxify.sh/v2'),
    /** Sampling rate for high-volume events (0..1). */
    sample_rate: z.number().min(0).max(1).default(0.1),
  })
  .strict();

/** Inferred type for the [telemetry] section. */
export type TelemetryConfig = z.infer<typeof TelemetrySchema>;

/**
 * Schema for the `[sync]` section. Cloud sync is a v2 feature; v1 always has
 * `enabled = false`.
 */
export const SyncSchema = z
  .object({
    /** Whether cloud sync is enabled. Always false in v1. */
    enabled: z.boolean().default(false),
    /** Cloud sync server endpoint. */
    endpoint: z.string().default('https://sync.linuxify.sh'),
    /** Human-readable device name for sync disambiguation. */
    device_name: z.string().optional(),
  })
  .strict();

/** Inferred type for the [sync] section. */
export type SyncConfig = z.infer<typeof SyncSchema>;

/**
 * Schema for the `[registry]` section. Controls where package definitions are
 * fetched from.
 */
export const RegistrySchema = z
  .object({
    /** Git URL of the package registry. */
    url: z.string().default('https://github.com/linuxify/registry'),
    /** Branch/tag to check out from the registry. */
    branch: z.string().default('main'),
    /** Whether to trust self-signed TLS certificates (insecure; CI only). */
    trust_self_signed: z.boolean().default(false),
  })
  .strict();

/** Inferred type for the [registry] section. */
export type RegistryConfig = z.infer<typeof RegistrySchema>;

/**
 * Schema for the `[logging]` section. Controls file and console log output.
 */
export const LoggingSchema = z
  .object({
    /** Minimum log level: error | warn | info | debug | trace. */
    level: z.enum(['error', 'warn', 'info', 'debug', 'trace']).default('info'),
    /** Whether to write logs to ~/.linuxify/logs/. */
    file_enabled: z.boolean().default(true),
    /** Whether to emit logs to the terminal. */
    console_enabled: z.boolean().default(true),
  })
  .strict();

/** Inferred type for the [logging] section. */
export type LoggingConfig = z.infer<typeof LoggingSchema>;

/**
 * Schema for the `[i18n]` section. Controls message catalog locale.
 */
export const I18nSchema = z
  .object({
    /** Locale code (e.g. "en", "pt_BR"). Falls back to "en" if missing. */
    locale: z.string().default('en'),
  })
  .strict();

/** Inferred type for the [i18n] section. */
export type I18nConfig = z.infer<typeof I18nSchema>;

/**
 * Schema for the `[experimental]` section. Gates experimental features.
 */
export const ExperimentalSchema = z
  .object({
    /** List of experimental feature flags to enable (e.g. ["ast_patcher"]). */
    features: z.array(z.string()).default([]),
  })
  .strict();

/** Inferred type for the [experimental] section. */
export type ExperimentalConfig = z.infer<typeof ExperimentalSchema>;

// ============================================================================
// Recursive profile schema
// ============================================================================

/**
 * A profile is a partial config: any subset of the top-level sections, applied
 * as an overlay when `--profile <name>` is given. Profiles may be nested to
 * allow composition (a profile can declare its own sub-profiles).
 *
 * The explicit interface is required because `z.infer` cannot resolve the
 * self-reference in {@link ProfileSchema}'s `z.lazy` definition.
 */
export interface ProfileConfig {
  bootstrap?: BootstrapConfig;
  distro?: DistroConfig;
  runtime?: RuntimeConfig;
  telemetry?: TelemetryConfig;
  sync?: SyncConfig;
  registry?: RegistryConfig;
  logging?: LoggingConfig;
  i18n?: I18nConfig;
  experimental?: ExperimentalConfig;
  /** Nested profiles for composition. */
  profiles?: Record<string, ProfileConfig>;
}

/**
 * Recursive Zod schema for a single profile entry. Defined with `z.lazy` so it
 * can reference itself via the `profiles` field. Strict mode rejects unknown
 * sections so misspelled keys surface immediately.
 *
 * The explicit `as z.ZodType<ProfileConfig>` cast is the standard Zod pattern
 * for recursive schemas whose inner section schemas carry `.default()` values:
 * those defaults make the inner input type strictly narrower than the output
 * type, so the `z.ZodType<T>` annotation cannot be verified statically. The
 * runtime behavior is correct — defaults are applied during `parse`/`safeParse`.
 */
export const ProfileSchema: z.ZodType<ProfileConfig> = z.lazy(() =>
  z
    .object({
      bootstrap: BootstrapSchema.optional(),
      distro: DistroSchema.optional(),
      runtime: RuntimeSchema.optional(),
      telemetry: TelemetrySchema.optional(),
      sync: SyncSchema.optional(),
      registry: RegistrySchema.optional(),
      logging: LoggingSchema.optional(),
      i18n: I18nSchema.optional(),
      experimental: ExperimentalSchema.optional(),
      profiles: z.record(z.string(), ProfileSchema).optional(),
    })
    .strict(),
) as z.ZodType<ProfileConfig>;

// ============================================================================
// Top-level config schema
// ============================================================================

/**
 * Top-level config object. All fields have defaults; an empty TOML file parses
 * into a fully-populated Config. The `profiles` field maps profile names to
 * partial configs used by `--profile <name>`.
 *
 * Inferred from {@link ConfigSchema} via `z.infer`, so the type and the schema
 * cannot drift apart.
 */
export type Config = {
  /** Schema version. Bumped on every breaking change to the config shape. */
  config_schema_version: 1;
  bootstrap: BootstrapConfig;
  distro: DistroConfig;
  runtime: RuntimeConfig;
  telemetry: TelemetryConfig;
  sync: SyncConfig;
  registry: RegistryConfig;
  logging: LoggingConfig;
  i18n: I18nConfig;
  /** Named profiles, selected via `--profile <name>`. */
  profiles: Record<string, ProfileConfig>;
  experimental: ExperimentalConfig;
};

/**
 * Zod schema for the entire `~/.linuxify/config.toml` file. Strict mode rejects
 * unknown top-level keys; every section has a default so `{}` parses cleanly.
 *
 * Use `ConfigSchema.parse(unknown)` to validate and apply defaults, or
 * `ConfigSchema.safeParse(unknown)` for a non-throwing variant.
 */
export const ConfigSchema = z
  .object({
    config_schema_version: z.literal(1).default(1),
    bootstrap: BootstrapSchema.default({}),
    distro: DistroSchema.default({}),
    runtime: RuntimeSchema.default({}),
    telemetry: TelemetrySchema.default({}),
    sync: SyncSchema.default({}),
    registry: RegistrySchema.default({}),
    logging: LoggingSchema.default({}),
    i18n: I18nSchema.default({}),
    profiles: z.record(z.string(), ProfileSchema).default({}),
    experimental: ExperimentalSchema.default({}),
  })
  .strict();

// ============================================================================
// Project-local .linuxify.toml schema (restricted subset)
// ============================================================================

/**
 * Allowed top-level section names in a project-local `.linuxify.toml` file.
 * The project-local file is intentionally restricted: it must not be able to
 * override user-wide concerns like telemetry, bootstrap mirrors, sync, or the
 * registry URL — those are owned by the user's global `config.toml`.
 */
export const PROJECT_LOCAL_ALLOWED_SECTIONS = [
  'runtime',
  'i18n',
  'experimental',
] as const;

/**
 * Sections explicitly forbidden in a project-local `.linuxify.toml`. Encoded as
 * a const tuple so the error message can name them precisely.
 */
export const PROJECT_LOCAL_FORBIDDEN_SECTIONS = [
  'bootstrap',
  'telemetry',
  'sync',
  'registry',
  'distro',
  'logging',
  'profiles',
] as const;

/**
 * Schema for the project-local `.linuxify.toml` file. A strict subset of
 * {@link ConfigSchema}: only `runtime`, `i18n`, and `experimental` are honored.
 * The `config_schema_version` scalar is allowed as a harmless top-level field.
 * Any other section triggers a validation error which the loader converts to a
 * {@link ConfigError} with code `E_CONFIG_PROJECT_FILE_TOO_BROAD`.
 *
 * IMPORTANT: the section schemas here are intentionally defined WITHOUT
 * `.default()` values. A project-local file is a partial overlay — only the
 * fields the user explicitly wrote should appear in the parsed result. If we
 * reused {@link RuntimeSchema} (which has defaults), every absent field would
 * be filled in with its default, and those defaults would then override the
 * user's global config during deep-merge — exactly the opposite of what an
 * overlay should do. The final {@link ConfigSchema} validation on the fully
 * merged config fills in any remaining defaults.
 */
export const ProjectLocalSchema = z
  .object({
    config_schema_version: z.literal(1).optional(),
    runtime: z
      .object({
        node_default_version: z.string().optional(),
        python_default_version: z.string().optional(),
      })
      .strict()
      .optional(),
    i18n: z
      .object({
        locale: z.string().optional(),
      })
      .strict()
      .optional(),
    experimental: z
      .object({
        features: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
