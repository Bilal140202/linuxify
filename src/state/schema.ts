/**
 * Zod schema definitions for `~/.linuxify/state.json`.
 *
 * `state.json` is the live internal state of Linuxify, mutated by every
 * state-changing subsystem. It is **not** a rebuildable cache (unlike
 * `manifest.json` and `runtimes.json`); losing it requires re-running
 * `linuxify init --recover-state`. All field names use `snake_case` to match
 * the on-disk JSON format documented in
 * {@link ../../docs/02-architecture/data-formats.md | data-formats.md §3}.
 *
 * Every object schema uses `.strict()` so that unknown keys are rejected at
 * parse time — this catches hand-edited or version-mismatched state files
 * early and surfaces them as `E_STATE_CORRUPT` (see `store.ts`).
 *
 * @packageDocumentation
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/** Regex for a lowercase-or-uppercase hex SHA-256 digest (64 chars). */
const SHA256_REGEX = /^[a-fA-F0-9]{64}$/;

/**
 * Zod schema for a `DistroInstall` entry inside `state.installed_distros`.
 *
 * Mirrors the `installed` marker file under
 * `~/.linuxify/distros/<name>/installed` plus the rootfs SHA-256 captured at
 * install time so that `linuxify doctor` can detect a tampered rootfs.
 */
export const DistroInstallSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    installed_at: z.string().datetime(),
    rootfs_sha256: z.string().regex(SHA256_REGEX),
  })
  .strict();

/**
 * Zod schema for a `RuntimeInstall` entry inside `state.installed_runtimes`.
 *
 * Runtimes are scoped to a distro (a Node 22 install under Ubuntu is distinct
 * from a Node 22 install under Debian). `is_default` is true for at most one
 * runtime of each name per distro.
 */
export const RuntimeInstallSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    distro: z.string().min(1),
    path: z.string().min(1),
    installed_at: z.string().datetime(),
    is_default: z.boolean(),
  })
  .strict();

/**
 * Zod schema for a `PackageInstall` entry inside `state.installed_packages`.
 *
 * `patches_applied` is a list of `patch_id` strings (e.g. `"cline-001"`)
 * referencing the per-patch records under `~/.linuxify/patches/<pkg>/`.
 */
export const PackageInstallSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    distro: z.string().min(1),
    runtime: z.string().min(1),
    runtime_version: z.string().min(1),
    install_date: z.string().datetime(),
    launcher_path: z.string().min(1),
    patches_applied: z.array(z.string()),
  })
  .strict();

/**
 * Zod schema for a `PatchApplication` entry inside `state.applied_patches`.
 *
 * The global `applied_patches` array is a denormalized summary indexed for
 * fast lookup without scanning `~/.linuxify/patches/`. The full per-patch
 * record (with the verbatim YAML definition and verify output) lives in
 * `~/.linuxify/patches/<pkg>/<NNN>.json` (see data-formats.md §6).
 */
export const PatchApplicationSchema = z
  .object({
    patch_id: z.string().min(1),
    package: z.string().min(1),
    applied_at: z.string().datetime(),
    applied_to_file: z.string().min(1),
    original_hash: z.string().regex(SHA256_REGEX),
    patched_hash: z.string().regex(SHA256_REGEX),
    rollback_path: z.string().min(1),
    verified: z.boolean(),
  })
  .strict();

/**
 * Zod schema for the `bootstrap_progress` block.
 *
 * Tracks stages 0–8 of `linuxify init` (see bootstrap-design.md §2).
 * `current_stage` is `0` for a fresh state; `8` when bootstrap is complete.
 * `failed_stage` and `error` are `null` unless a stage has failed.
 */
export const BootstrapProgressSchema = z
  .object({
    current_stage: z.number().int().min(0),
    completed_stages: z.array(z.number().int().min(0)),
    failed_stage: z.number().int().min(0).nullable(),
    error: z.string().min(1).nullable(),
    started_at: z.string().datetime(),
    last_updated_at: z.string().datetime(),
  })
  .strict();

/**
 * Zod schema for the `last_doctor_run` summary block.
 *
 * `all_ok` is `true` only when every doctor check returned `ok` (no warns,
 * no fails, no missing). A more detailed report lives at
 * `~/.linuxify/logs/doctor-<timestamp>.json` (data-formats.md §11).
 */
export const LastDoctorRunSchema = z
  .object({
    timestamp: z.string().datetime(),
    all_ok: z.boolean(),
  })
  .strict();

/**
 * Zod schema for the `telemetry` block.
 *
 * `user_id` is `null` until the user opts in (it is then a UUIDv4, resettable
 * via `linuxify config reset-user-id`). `last_flush` is `null` until the first
 * successful telemetry flush. This block is the reason `state.json` is written
 * with mode `0600`.
 */
export const TelemetrySchema = z
  .object({
    user_id: z.string().nullable(),
    enabled: z.boolean(),
    last_flush: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Zod schema for a `PluginInstall` entry inside `state.plugins`.
 *
 * `source` is the install source URI (`registry://<name>@<ver>`,
 * `file:///path/to/plugin`, or `github:owner/repo`). `hooks_used` lists the
 * hook names the plugin has registered handlers for, so that
 * `linuxify doctor` can warn about plugins that subscribe to deprecated
 * hooks.
 */
export const PluginInstallSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    source: z.string().min(1),
    installed_at: z.string().datetime(),
    enabled: z.boolean(),
    hooks_used: z.array(z.string()),
  })
  .strict();

/**
 * Zod schema for a `DockerContainer` entry inside `state.docker.containers`.
 *
 * Tracks a docker container launched via `linuxify docker run` so that
 * `linuxify docker ps` / `stop` / `rm` / `logs` can find it again without
 * re-parsing the runtime's output. The `name` is the user-facing handle
 * (or the auto-generated slug from the image name); the `container_id` is
 * the runtime's internal ID (the docker/podman container short ID, or
 * `podroid-<name>` for Podroid-managed forwards). The `host_port` is the
 * port exposed on the Android device; `guest_port` is the port inside the
 * container. `forward_rule_id` is the Podroid forwarding rule identifier
 * (empty string when no forward was needed, e.g. when running on
 * proot-distro Docker directly).
 */
export const DockerContainerSchema = z
  .object({
    name: z.string().min(1),
    image: z.string().min(1),
    container_id: z.string(),
    runtime: z.enum(['podroid', 'docker', 'podman']),
    host_port: z.number().int().min(1).max(65535),
    guest_port: z.number().int().min(1).max(65535),
    forward_rule_id: z.string(),
    started_at: z.string().datetime(),
    restart_policy: z.enum(['no', 'unless-stopped', 'always', 'on-failure']),
    status: z.enum(['running', 'stopped', 'paused', 'failed', 'unknown']),
    volumes: z.array(z.object({
      host_path: z.string().min(1),
      container_path: z.string().min(1),
      mode: z.enum(['ro', 'rw']),
    })),
    env: z.array(z.object({
      key: z.string().min(1),
      value: z.string(),
    })),
  })
  .strict();

/**
 * Zod schema for the `docker` block of `state.json`.
 *
 * The `containers` array is the source of truth for `linuxify docker ps`.
 * The `next_port_hint` field is the lower bound for the next auto-allocated
 * host port — we bump it whenever a new container grabs a port so that
 * `linuxify docker run <image>` can hand out the same port to the same
 * image across restarts (stable URL, easier bookmarking). The
 * `default_runtime` field is what `linuxify docker run` uses when the
 * user doesn't pass `--runtime`; it's auto-detected on first run (Podroid
 * preferred, falling back to docker inside the active proot-distro).
 */
export const DockerStateSchema = z
  .object({
    initialized: z.boolean(),
    default_runtime: z.enum(['podroid', 'docker', 'podman']).nullable(),
    next_port_hint: z.number().int().min(1024).max(65535),
    port_range_start: z.number().int().min(1024).max(65535),
    port_range_end: z.number().int().min(1024).max(65535),
    wake_lock_enabled: z.boolean(),
    containers: z.array(DockerContainerSchema),
    initialized_at: z.string().datetime().nullable(),
  })
  .strict();

/**
 * Default value for the `docker` block. Exposed so the docker subsystem
 * and migration stubs can rehydrate it for old `state.json` files that
 * predate the docker block's introduction.
 */
export const DEFAULT_DOCKER_STATE: z.infer<typeof DockerStateSchema> = {
  initialized: false,
  default_runtime: null,
  next_port_hint: 8000,
  port_range_start: 8000,
  port_range_end: 8999,
  wake_lock_enabled: false,
  containers: [],
  initialized_at: null,
};

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the top-level `state.json` document.
 *
 * `schema_version` is pinned to literal `1`; a future breaking change to the
 * shape bumps this and adds a migration in `src/state/migrate.ts` (to be
 * written). `active_distro` is allowed to be an empty string for a fresh
 * install with no distros yet activated.
 *
 * The `docker` block is `.default(DEFAULT_DOCKER_STATE)` so that legacy
 * state.json files written before the docker subsystem existed are
 * backfilled automatically on load — no migration required for the simple
 * "add a new optional block" case.
 */
export const StateSchema = z
  .object({
    schema_version: z.literal(1),
    linuxify_version: z.string().min(1),
    active_distro: z.string(),
    installed_distros: z.array(DistroInstallSchema),
    installed_runtimes: z.array(RuntimeInstallSchema),
    installed_packages: z.array(PackageInstallSchema),
    applied_patches: z.array(PatchApplicationSchema),
    bootstrap_progress: BootstrapProgressSchema,
    last_doctor_run: LastDoctorRunSchema.nullable(),
    telemetry: TelemetrySchema,
    plugins: z.array(PluginInstallSchema),
    docker: DockerStateSchema.default(DEFAULT_DOCKER_STATE),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred TypeScript types
// ---------------------------------------------------------------------------

/** Inferred type for {@link DistroInstallSchema}. */
export type DistroInstall = z.infer<typeof DistroInstallSchema>;

/** Inferred type for {@link RuntimeInstallSchema}. */
export type RuntimeInstall = z.infer<typeof RuntimeInstallSchema>;

/** Inferred type for {@link PackageInstallSchema}. */
export type PackageInstall = z.infer<typeof PackageInstallSchema>;

/** Inferred type for {@link PatchApplicationSchema}. */
export type PatchApplication = z.infer<typeof PatchApplicationSchema>;

/** Inferred type for {@link BootstrapProgressSchema}. */
export type BootstrapProgress = z.infer<typeof BootstrapProgressSchema>;

/** Inferred type for {@link LastDoctorRunSchema}. */
export type LastDoctorRun = z.infer<typeof LastDoctorRunSchema>;

/** Inferred type for {@link TelemetrySchema}. */
export type Telemetry = z.infer<typeof TelemetrySchema>;

/** Inferred type for {@link PluginInstallSchema}. */
export type PluginInstall = z.infer<typeof PluginInstallSchema>;

/** Inferred type for {@link DockerContainerSchema}. */
export type DockerContainer = z.infer<typeof DockerContainerSchema>;

/** Inferred type for {@link DockerStateSchema}. */
export type DockerState = z.infer<typeof DockerStateSchema>;

/**
 * Inferred TypeScript type for the top-level `state.json` document.
 *
 * This is the shape that every subsystem reads via `state.load()` and mutates
 * via `state.update()`. The Zod schema ({@link StateSchema}) is the source of
 * truth; this type is inferred from it so that runtime validation and
 * compile-time types can never drift.
 */
export type State = z.infer<typeof StateSchema>;
