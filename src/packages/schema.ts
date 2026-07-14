/**
 * Zod schema for the Linuxify package YAML format.
 *
 * @module linuxify/packages/schema
 *
 * This schema is the single source of truth for "is this YAML a valid
 * package definition?" It is validated at parse time by
 * {@link ./parser.ts | parsePackageYaml} and is the counterpart to the
 * JSON Schema in `docs/09-registry/package-spec.md` §1. Every object uses
 * `.strict()` so unknown keys are rejected at parse time — this catches
 * typos like `runtime_min_verison` early rather than silently ignoring them.
 *
 * The inferred {@link PackageDefinition} type is exported via `z.infer`, so
 * the TypeScript type and the runtime schema cannot drift apart. Downstream
 * consumers (parser, linter, manager, patcher, launcher) import the type
 * from here or from the {@link ./index.ts | barrel}.
 *
 * Design notes:
 *  - The `install` field accepts both the simple form (array of shell
 *    command strings) and the structured form (`{ steps, env, cwd }`).
 *    The {@link ./manager.ts | PackageManager} normalizes both forms into a
 *    flat step list at execution time.
 *  - `patches` and `doctor` are defined inline here (not imported from the
 *    patcher/doctor subsystems) because the patcher and doctor modules are
 *    built by later agents. The shapes match the task spec; the patcher
 *    module will refine them when it lands.
 *  - `permissions.setuid` is a literal `false` — v1 never allows setuid.
 *  - `env` values are either a bare string (simple form) or a structured
 *    object with `value`, `scope`, and `override`.
 *
 * See:
 *  - docs/09-registry/package-spec.md §1-§8 (canonical field reference)
 *  - docs/20-adrs/adr-002-yaml-package-definitions.md (YAML chosen over TOML/JSON)
 *  - docs/20-adrs/adr-015-zod-for-schema-validation.md (Zod chosen over ajv)
 *
 * @packageDocumentation
 */

import { z } from 'zod';

// ============================================================================
// Enum-like schemas
// ============================================================================

/**
 * Supported runtime identifiers. A runtime is the language runtime the
 * package's install commands expect to find on `$PATH` inside the proot
 * distro (Node, Python, Rust, Go, Bun, Deno). The value `'none'` (static
 * binaries) is intentionally omitted per the task spec — packages that need
 * no runtime still declare one of the six values and leave `runtime_min_version`
 * empty-ish; the linter flags the mismatch.
 */
export const RuntimeSchema = z.enum(['node', 'python', 'rust', 'go', 'bun', 'deno']);

/** Inferred runtime name union. */
export type Runtime = z.infer<typeof RuntimeSchema>;

/**
 * Upstream package manager grammar. `'binary'` covers packages that ship a
 * pre-built binary (downloaded via `curl`/`wget` in the install steps rather
 * than installed via a language package manager). When omitted, the manager
 * infers the value from {@link RuntimeSchema} (node→npm, python→pip,
 * rust→cargo, go→go, bun→bun, deno→deno).
 */
export const PackageManagerSchema = z.enum(['npm', 'pip', 'cargo', 'go', 'binary']);

/** Inferred package-manager name union. */
export type PackageManagerName = z.infer<typeof PackageManagerSchema>;

/**
 * Patch application strategy. `regex` is the default (find/replace via JS
 * regex). `ast-js`/`ast-ts` use Babel/the TS compiler for structural edits.
 * `sed` is for multi-line rewrites. `python-ast` uses `ast.parse`. `shell`
 * delegates to a shell command that performs the edit.
 */
export const PatchTypeSchema = z.enum([
  'regex',
  'ast-js',
  'ast-ts',
  'sed',
  'python-ast',
  'shell',
]);

/** Inferred patch-type union. */
export type PatchType = z.infer<typeof PatchTypeSchema>;

// ============================================================================
// Install steps
// ============================================================================

/**
 * Structured install step. The `command` is run inside the proot distro via
 * `bash -c`. `expect` is the expected exit code (default `0`). `retry` is the
 * number of times to retry on failure (default `0`). `on_fail` controls
 * behavior when the step fails after retries: `abort` (default) fails the
 * entire install; `continue` logs the failure and proceeds.
 *
 * `name` is required in the object form so install logs are readable; the
 * simple (string) form has no name and the manager assigns `step-N`.
 */
export const InstallStepObjectSchema = z
  .object({
    /** Human-readable label shown in install logs. */
    name: z.string().min(1),
    /** Shell command to execute inside the proot distro via `bash -c`. */
    command: z.string().min(1),
    /** Expected exit code; any other value is a failure. Defaults to `0`. */
    expect: z.number().int().optional(),
    /** Number of times to retry on failure (2-second delay between attempts). */
    retry: z.number().int().min(0).optional(),
    /** Behavior when the step fails after retries. */
    on_fail: z.enum(['continue', 'abort']).optional(),
  })
  .strict();

/** Inferred type for a structured install step object. */
export type InstallStepObject = z.infer<typeof InstallStepObjectSchema>;

/**
 * An install step is either a bare shell-command string (simple form) or a
 * structured {@link InstallStepObject} (with `name`, `expect`, `retry`,
 * `on_fail`). Both forms are valid in the same `install:` array.
 */
export const InstallStepSchema = z.union([z.string(), InstallStepObjectSchema]);

/** Inferred type for an install step (simple or structured form). */
export type InstallStep = z.infer<typeof InstallStepSchema>;

/**
 * The `install:` block. Accepts either:
 *  - An array of {@link InstallStepSchema} (simple form), or
 *  - An object with `steps`, optional `env`, and optional `cwd` (structured
 *    form).
 *
 * The manager normalizes both forms into a flat `InstallStep[]` at execution
 * time; the `env` and `cwd` from the structured form are merged into the
 * step execution environment.
 */
export const InstallBlockSchema = z.union([
  z.array(InstallStepSchema),
  z
    .object({
      steps: z.array(InstallStepSchema),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().optional(),
    })
    .strict(),
]);

/** Inferred type for the `install:` block. */
export type InstallBlock = z.infer<typeof InstallBlockSchema>;

// ============================================================================
// Patches
// ============================================================================

/**
 * A compatibility patch applied after install. The patcher subsystem (built
 * by a later agent) consumes this definition; the shapes here are the subset
 * the package YAML carries and are intentionally simpler than the patcher's
 * full runtime representation (e.g. `verify` is a bare command string, not
 * `{ command, expect }`).
 *
 * `rollback: true` means the patcher should record a reverse edit so
 * `linuxify patch --rollback <id>` can undo it. `condition` is an opaque
 * string the patcher interprets (e.g. `"distro:alpine"` or
 * `"runtime_min_version:20"`); the schema accepts any non-empty string.
 */
export const PatchDefinitionSchema = z
  .object({
    /** User-facing short id, e.g. `fix-platform-check`. */
    id: z.string().min(1),
    /** Canonical `<package>-<NNN>` form, assigned by the patcher. */
    patch_id: z.string().min(1),
    /** Human-readable description shown in `linuxify info <pkg> --patches`. */
    description: z.string().min(1),
    /** Path to the file to patch, relative to the package install root. */
    file: z.string().min(1),
    /** Patch application strategy. */
    type: PatchTypeSchema,
    /** Pattern to find (required for `regex`/`ast-*`/`sed`). */
    find: z.string(),
    /** Replacement string (backreferences `$1`/`$2` work for `regex`). */
    replace: z.string(),
    /** Shell command to run after the patch; non-zero exit rolls it back. */
    verify: z.string(),
    /** Whether the patcher should record a reverse edit for rollback. */
    rollback: z.boolean(),
    /** Opaque condition string the patcher evaluates before applying. */
    condition: z.string().optional(),
  })
  .strict();

/** Inferred type for a single patch definition. */
export type PatchDefinition = z.infer<typeof PatchDefinitionSchema>;

// ============================================================================
// Env
// ============================================================================

/** Scope at which an env var is set. */
export const EnvScopeSchema = z.enum(['runtime', 'run', 'always']);

/** How an env var interacts with an existing value. */
export const EnvOverrideSchema = z.enum(['merge', 'replace', 'append']);

/**
 * Structured env-var value. `scope: 'runtime'` sets the var only during
 * install steps; `scope: 'run'` sets it only during `linuxify run`;
 * `scope: 'always'` (default) sets it during both.
 */
export const EnvValueStructuredSchema = z
  .object({
    /** The env var's value (always a string). */
    value: z.string(),
    /** When the var is set. Defaults to `'always'`. */
    scope: EnvScopeSchema.default('always'),
    /** How to combine with an existing value. Defaults to `'merge'`. */
    override: EnvOverrideSchema.default('merge'),
  })
  .strict();

/** Inferred type for a structured env-var value. */
export type EnvVar = z.infer<typeof EnvValueStructuredSchema>;

/**
 * An env-var value is either a bare string (simple form; scope defaults to
 * `'always'`, override to `'merge'`) or a structured {@link EnvVar}.
 */
export const EnvValueSchema = z.union([z.string(), EnvValueStructuredSchema]);

// ============================================================================
// Doctor checks
// ============================================================================

/**
 * A package-specific health check run by `linuxify doctor`. `severity: 'ok'`
 * means the check is informational; `'warn'` continues with a warning;
 * `'fail'` fails the doctor run.
 */
export const DoctorCheckSchema = z
  .object({
    /** Stable id, conventionally `<package>-<check-name>`. */
    id: z.string().min(1),
    /** Human-readable label shown in doctor output. */
    name: z.string().min(1),
    /** Shell command run inside the proot distro. */
    command: z.string().min(1),
    /** Expected exit code (the command's exit code must match). */
    expect: z.number().int(),
    /** Command to run via `linuxify repair` to fix this issue. */
    fix_command: z.string().min(1),
    /** What the doctor does when the expectation is not met. */
    severity: z.enum(['ok', 'warn', 'fail']),
  })
  .strict();

/** Inferred type for a doctor check. */
export type DoctorCheck = z.infer<typeof DoctorCheckSchema>;

// ============================================================================
// Permissions
// ============================================================================

/**
 * Run-time permissions the package requests. The user approves these on
 * first install (or all are granted with `--yes`). `setuid` is pinned to
 * `false` in v1 — a future "trusted packages" tier may allow `true`.
 *
 * `filesystem.binds` entries are `host:guest` or `host:guest:ro`.
 * `services.start` lists system services Linuxify ensures are running
 * before `linuxify run`.
 */
export const PermissionsSchema = z
  .object({
    /** Whether the package needs outbound network at run time. */
    network: z.boolean(),
    /** Filesystem bind mounts beyond the default `/sdcard:/workspace`. */
    filesystem: z
      .object({
        binds: z.array(z.string()),
      })
      .strict(),
    /** System services to start before `linuxify run`. */
    services: z
      .object({
        start: z.array(z.string()),
      })
      .strict(),
    /** Always `false` in v1; reserved for a future trusted-packages tier. */
    setuid: z.literal(false).default(false),
  })
  .strict();

/** Inferred type for the permissions block. */
export type Permissions = z.infer<typeof PermissionsSchema>;

// ============================================================================
// Repair recipes
// ============================================================================

/**
 * Schema for a single declarative repair recipe.
 *
 * A repair recipe tells `linuxify fix` what to do when a specific doctor
 * check fails for this package. Recipes are declarative — they describe
 * the *what* (steps to run) and the *when* (which failing check triggers
 * this recipe), not the *how* (the diagnosis engine handles presentation,
 * safety filtering, and user confirmation).
 *
 * Recipes are checked BEFORE the built-in generic diagnosis rules, so a
 * package author can override the default behavior for package-specific
 * checks (e.g., `cline.binary`).
 *
 * Example:
 * ```yaml
 * repair:
 *   - when: cline.binary
 *     strategy: reinstall
 *     description: "Cline binary is broken — reinstall and re-patch"
 *     risk: moderate
 *     steps:
 *       - linuxify remove cline
 *       - linuxify add cline
 * ```
 */
export const RepairRecipeSchema = z
  .object({
    /** Doctor check ID that triggers this recipe (e.g., `cline.binary`). */
    when: z.string().min(1),
    /** Named strategy for display + deduplication (`reinstall`, `patch-platform`, `clear-cache`). */
    strategy: z.string().min(1),
    /** Human-readable description shown in `linuxify fix` output. */
    description: z.string().min(1),
    /** Risk level: `safe` (default), `moderate`, `risky`, `destructive`. */
    risk: z.enum(['safe', 'moderate', 'risky', 'destructive']).default('safe'),
    /** Ordered shell commands to execute. Empty for manual-only recipes. */
    steps: z.array(z.string()).default([]),
    /** What this recipe fixes (one-line summary, shown to user). */
    fixes: z.string().optional(),
    /** Whether this recipe requires network access (default: true). */
    requires_network: z.boolean().default(true),
  })
  .strict();

/** Inferred type for a repair recipe. */
export type RepairRecipe = z.infer<typeof RepairRecipeSchema>;

// ============================================================================
// Compat
// ============================================================================

/**
 * Compatibility declarations. `min_linuxify` is the minimum Linuxify CLI
 * version that can install this package. `tested_distros`/`tested_runtimes`
 * are author-attested (CI tests a superset). `known_issues` is an opaque
 * array of issue objects (the schema accepts any shape; the linter does
 * deeper validation). `not_supported` is a list of distro/runtime names
 * where the package is known not to work.
 */
export const CompatSchema = z
  .object({
    /** Minimum Linuxify CLI version (semver). */
    min_linuxify: z.string().min(1),
    /** Maximum Linuxify CLI version (optional; null/absent = no upper bound). */
    max_linuxify: z.string().optional(),
    /** Distro names the author has personally tested on. */
    tested_distros: z.array(z.string()),
    /** Runtime names the author has personally tested on. */
    tested_runtimes: z.array(z.string()),
    /** Known issues (opaque objects with at least an `id` and `description`). */
    known_issues: z.array(z.unknown()),
    /** Distro/runtime names where the package is known not to work. */
    not_supported: z.array(z.string()),
  })
  .strict();

/** Inferred type for the compat block. */
export type CompatBlock = z.infer<typeof CompatSchema>;

// ============================================================================
// Top-level package schema
// ============================================================================

/**
 * Zod schema for the top-level package YAML document.
 *
 * Required fields: `name`, `version`, `description`, `homepage`, `license`,
 * `runtime`, `runtime_min_version`, `package`, `launcher`, `install`,
 * `compat`, `permissions`.
 *
 * Fields with defaults: `tags` (`[]`), `patches` (`[]`), `env` (`{}`),
 * `doctor` (`[]`), `deprecated` (`false`), `replaces` (`[]`),
 * `conflicts` (`[]`).
 *
 * Optional fields: `maintainer`, `category`, `runtime_max_version`,
 * `package_manager`, `uninstall`, `notes`, `alias_of`.
 *
 * `additionalProperties: false` (via `.strict()`) so typos surface at lint
 * time rather than silently being ignored at install time.
 */
export const PackageSchema = z
  .object({
    /** Package name; lowercase, `^[a-z][a-z0-9-]{1,62}$`; must match filename. */
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    /** Linuxify package version (semver, optionally with `-<pre-release>`). */
    version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/),
    /** 1–200 char description shown in `linuxify search` and `linuxify info`. */
    description: z.string().min(1).max(200),
    /** Upstream project URL. */
    homepage: z.string().url(),
    /** SPDX identifier (`MIT`, `Apache-2.0`, …) or `proprietary`. */
    license: z.string().min(1),
    /** Linuxify package maintainer (GitHub handle or email). */
    maintainer: z.string().optional(),
    /** Free-form tags; convention: lowercase, hyphenated. */
    tags: z.array(z.string()).default([]),
    /** Category: `ai`, `dev`, `sec`, `net`, `util`, `data`, or a custom string. */
    category: z.string().optional(),
    /** Language runtime the package's install commands expect. */
    runtime: RuntimeSchema,
    /** Minimum runtime version (semver-ish: `"20"`, `"3.12"`, `"1.74.0"`). */
    runtime_min_version: z.string().min(1),
    /** Maximum runtime version (optional; rarely set). */
    runtime_max_version: z.string().optional(),
    /** Upstream package name (`cline` for `npm install -g cline`). */
    package: z.string().min(1),
    /** Binary name users type (`cline`, `aider`, `codex`). */
    launcher: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
    /** Package manager grammar; inferred from `runtime` if omitted. */
    package_manager: PackageManagerSchema.optional(),
    /** Install steps (simple array or structured object). */
    install: InstallBlockSchema,
    /** Uninstall commands (array of shell strings); inferred if omitted. */
    uninstall: z.array(z.string()).optional(),
    /** Compatibility patches applied after install. */
    patches: z.array(PatchDefinitionSchema).default([]),
    /** Env vars set during install and/or `linuxify run`. */
    env: z.record(z.string(), EnvValueSchema).default({}),
    /** Compatibility declarations. */
    compat: CompatSchema,
    /** Package-specific doctor checks. */
    doctor: z.array(DoctorCheckSchema).default([]),
    /**
     * Declarative repair recipes — what `linuxify fix` should do when this
     * package's doctor checks fail. Each recipe maps a failing check ID to a
     * named repair strategy (e.g., `reinstall`, `patch-platform`, `clear-cache`).
     * The diagnosis engine looks these up by `checkId` before falling back to
     * the built-in generic rules.
     *
     * Example:
     * ```yaml
     * repair:
     *   - when: cline.binary
     *     strategy: reinstall
     *     description: "Reinstall Cline and re-apply patches"
     *     steps:
     *       - linuxify remove cline
     *       - linuxify add cline
     *   - when: compat.platform
     *     strategy: patch-platform
     *     steps:
     *       - linuxify patch cline
     * ```
     */
    repair: z.array(RepairRecipeSchema).default([]),
    /** Run-time permissions the package requests. */
    permissions: PermissionsSchema,
    /** Free-form maintainer notes shown in `linuxify info`. */
    notes: z.string().optional(),
    /** Marks the package as deprecated; `linuxify add` warns. */
    deprecated: z.boolean().default(false),
    /** If present, this YAML is an alias for another package. */
    alias_of: z.string().optional(),
    /** Package names this package supersedes. */
    replaces: z.array(z.string()).default([]),
    /** Package names that cannot coexist with this one. */
    conflicts: z.array(z.string()).default([]),
  })
  .strict();

/**
 * The parsed and validated package definition. Inferred from
 * {@link PackageSchema} via `z.infer`, so the type and the schema cannot
 * drift apart. This is the type the parser produces, the manager consumes,
 * and the patcher/launcher receive.
 */
export type PackageDefinition = z.infer<typeof PackageSchema>;
