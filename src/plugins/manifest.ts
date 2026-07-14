/**
 * Plugin manifest Zod schema, validation, and linting.
 *
 * @module linuxify/plugins/manifest
 *
 * The {@link PluginManifestSchema} is the single source of truth for the
 * shape of `linuxify.plugin.json`. The {@link PluginManifest} type in
 * {@link ./types.ts | types.ts} is the hand-written interface; the Zod schema
 * is the runtime validator. The two are kept in sync by hand; a future
 * refactor could derive the type from the schema via `z.infer`.
 *
 * Two public functions are exported:
 *  - {@link validateManifest} — parse + validate an unknown value, throwing
 *    {@link PluginError} with code `E_PLUGIN_MANIFEST_INVALID` on failure.
 *  - {@link lintManifest} — run semantic checks (name format, semver
 *    validity, hook-name validity) and return a {@link LintReport}.
 *
 * See:
 *  - docs/10-plugin-sdk/plugin-sdk.md §3 (manifest field reference)
 *  - docs/20-adrs/adr-015-zod-for-schema-validation.md
 *
 * @packageDocumentation
 */

import path from 'node:path';

import semver from 'semver';
import { z } from 'zod';

import { PluginError } from '../utils/errors.js';

import type { PluginManifest, PluginHookName } from './types.js';

// ============================================================================
// Zod schema
// ============================================================================

/**
 * Zod schema for the `provides` block of a plugin manifest. Each sub-field is
 * an optional array of non-empty strings. The schema uses `.strict()` so
 * unknown keys (e.g. `runtimes_typo`) are rejected at parse time.
 */
export const PluginProvidesSchema = z
  .object({
    runtimes: z.array(z.string().min(1)).optional(),
    distros: z.array(z.string().min(1)).optional(),
    commands: z.array(z.string().min(1)).optional(),
    doctorChecks: z.array(z.string().min(1)).optional(),
    patchTypes: z.array(z.string().min(1)).optional(),
  })
  .strict();

/**
 * Zod schema for the `hooks` block. Each hook name maps to an optional
 * non-empty string (a relative file path). Unknown hook names are rejected
 * by `.strict()` — this is the "undeclared hook" guard at the manifest level.
 */
export const PluginHooksSchema = z
  .object({
    preInstall: z.string().min(1).optional(),
    postInstall: z.string().min(1).optional(),
    prePatch: z.string().min(1).optional(),
    postPatch: z.string().min(1).optional(),
    preRun: z.string().min(1).optional(),
    postRun: z.string().min(1).optional(),
    doctor: z.string().min(1).optional(),
    bootstrap: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
  })
  .strict();

/**
 * Zod schema for the full `linuxify.plugin.json` manifest.
 *
 * Uses `.passthrough()` at the top level so additional metadata fields
 * (`description`, `author`, `license`, `homepage`, `init`, etc.) documented
 * in `plugin-sdk.md §3` are accepted without being rejected. The inner
 * `provides` and `hooks` objects use `.strict()` to catch typos in those
 * specifically-typed blocks.
 */
export const PluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    linuxify: z.string().min(1),
    description: z.string().optional(),
    provides: PluginProvidesSchema,
    hooks: PluginHooksSchema,
    configSchema: z.string().min(1).optional(),
  })
  .passthrough();

// ============================================================================
// Known hook names
// ============================================================================

/**
 * The canonical list of hook names recognised by the plugin system. Used by
 * {@link lintManifest} to detect undeclared hooks (a manifest that uses a
 * hook name outside this set). The Zod schema's `.strict()` on
 * {@link PluginHooksSchema} already rejects unknown keys at parse time, so
 * this lint check is a belt-and-suspenders defence.
 */
export const KNOWN_HOOK_NAMES: readonly PluginHookName[] = [
  'preInstall',
  'postInstall',
  'prePatch',
  'postPatch',
  'preRun',
  'postRun',
  'doctor',
  'bootstrap',
  'command',
];

// ============================================================================
// Lint report types
// ============================================================================

/** Severity of a manifest lint issue. Errors block loading; warnings are informational. */
export type ManifestLintSeverity = 'error' | 'warning';

/** A single manifest lint finding. */
export interface ManifestLintIssue {
  /** Stable issue code, e.g. `E_LINT_BAD_NAME`. */
  readonly code: string;
  /** Human-readable description. */
  readonly message: string;
  /** Dotted path to the offending field, if applicable. */
  readonly field?: string;
  /** Issue severity. */
  readonly severity: ManifestLintSeverity;
}

/** Result of {@link lintManifest}. `passed` is `true` iff `errors` is empty. */
export interface LintReport {
  /** Issues that must be fixed before the manifest can be loaded. */
  readonly errors: readonly ManifestLintIssue[];
  /** Issues that should be fixed but do not block loading. */
  readonly warnings: readonly ManifestLintIssue[];
  /** `true` iff `errors` is empty. */
  readonly passed: boolean;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Format a Zod error's issues into a single semicolon-joined string.
 *
 * @param issues - The Zod issues array from a failed `safeParse`.
 * @returns A string like `name: must be string; version: invalid semver`.
 */
function formatZodIssues(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>,
): string {
  return issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '<root>'}: ${i.message}`)
    .join('; ');
}

/**
 * Parse and validate an unknown value as a {@link PluginManifest}.
 *
 * @param data - The raw parsed JSON from `linuxify.plugin.json`.
 * @returns The validated manifest (typed as {@link PluginManifest}).
 * @throws {PluginError} with code `E_PLUGIN_MANIFEST_INVALID` if the value
 *   fails schema validation. The Zod issues are preserved on `details.issues`
 *   and the formatted message is in `message`.
 *
 * @example
 * ```ts
 * import { readJson } from '../utils/fs.js';
 * import { validateManifest } from './manifest.js';
 *
 * const raw = await readJson('/path/to/linuxify.plugin.json');
 * const manifest = validateManifest(raw);
 * console.log(manifest.name, manifest.version);
 * ```
 */
export function validateManifest(data: unknown): PluginManifest {
  const result = PluginManifestSchema.safeParse(data);
  if (!result.success) {
    throw new PluginError(
      `Plugin manifest failed schema validation: ${formatZodIssues(result.error.issues)}`,
      {
        code: 'E_PLUGIN_MANIFEST_INVALID',
        details: { issues: result.error.issues },
      },
    );
  }
  return result.data as PluginManifest;
}

// ============================================================================
// Linting
// ============================================================================

/**
 * Regex matching the required plugin name format: lowercase kebab-case,
 * 1-128 characters, starting with a letter. Per `plugin-sdk.md §3`, the name
 * must match the npm package name (which follows the same convention).
 */
const NAME_REGEX = /^[a-z][a-z0-9-]{0,127}$/;

/**
 * Run semantic checks on a validated manifest and return a {@link LintReport}.
 *
 * Checks performed:
 *  1. **Name format** — `name` must match {@link NAME_REGEX} (lowercase
 *     kebab-case, starting with a letter).
 *  2. **Version** — `version` must be a valid semver string.
 *  3. **Linuxify range** — `linuxify` must be a valid semver range.
 *  4. **Hook paths** — every hook path declared in `hooks` must be a
 *     non-empty relative path (the loader checks existence on disk; this lint
 *     only checks the string shape).
 *  5. **Undeclared hooks** — every key in `hooks` must be a known hook name
 *     (already enforced by the Zod schema's `.strict()`, but re-checked here
 *     as a belt-and-suspenders defence for manifests that bypass the schema).
 *
 * @param manifest - The validated manifest to lint.
 * @returns A {@link LintReport} with `errors` (blocking) and `warnings`
 *   (informational). `passed` is `true` iff `errors` is empty.
 *
 * @example
 * ```ts
 * import { validateManifest, lintManifest } from './manifest.js';
 *
 * const manifest = validateManifest(raw);
 * const report = lintManifest(manifest);
 * if (!report.passed) {
 *   for (const err of report.errors) {
 *     console.error(`[${err.code}] ${err.message}`);
 *   }
 * }
 * ```
 */
export function lintManifest(manifest: PluginManifest): LintReport {
  const errors: ManifestLintIssue[] = [];
  const warnings: ManifestLintIssue[] = [];

  // 1. Name format.
  if (!NAME_REGEX.test(manifest.name)) {
    errors.push({
      code: 'E_LINT_BAD_NAME',
      message: `Plugin name '${manifest.name}' must be lowercase kebab-case starting with a letter (regex: ${NAME_REGEX.source}).`,
      field: 'name',
      severity: 'error',
    });
  }

  // 2. Version.
  if (semver.valid(manifest.version) === null) {
    errors.push({
      code: 'E_LINT_BAD_VERSION',
      message: `Plugin version '${manifest.version}' is not a valid semver string.`,
      field: 'version',
      severity: 'error',
    });
  }

  // 3. Linuxify range.
  if (semver.validRange(manifest.linuxify) === null) {
    errors.push({
      code: 'E_LINT_BAD_LINUXIFY_RANGE',
      message: `Linuxify compatibility range '${manifest.linuxify}' is not a valid semver range.`,
      field: 'linuxify',
      severity: 'error',
    });
  }

  // 4 & 5. Hooks.
  const hookEntries = Object.entries(manifest.hooks) as ReadonlyArray<
    [string, string | undefined]
  >;
  for (const [hookName, hookPath] of hookEntries) {
    if (!KNOWN_HOOK_NAMES.includes(hookName as PluginHookName)) {
      errors.push({
        code: 'E_PLUGIN_UNDECLARED_HOOK',
        message: `Manifest declares unknown hook '${hookName}'. Known hooks: ${KNOWN_HOOK_NAMES.join(', ')}.`,
        field: `hooks.${hookName}`,
        severity: 'error',
      });
      continue;
    }
    if (hookPath !== undefined) {
      if (hookPath.length === 0) {
        errors.push({
          code: 'E_LINT_EMPTY_HOOK_PATH',
          message: `Hook '${hookName}' has an empty path.`,
          field: `hooks.${hookName}`,
          severity: 'error',
        });
      } else if (path.isAbsolute(hookPath)) {
        warnings.push({
          code: 'E_LINT_ABSOLUTE_HOOK_PATH',
          message: `Hook '${hookName}' path '${hookPath}' is absolute; relative paths are recommended (resolved against the plugin root).`,
          field: `hooks.${hookName}`,
          severity: 'warning',
        });
      }
    }
  }

  // 6. Provides — warn if any declared runtime/distro/command name is empty
  //    (the Zod schema already enforces min(1), but this is a defence for
  //    manifests that bypass the schema).
  const provides = manifest.provides;
  for (const key of ['runtimes', 'distros', 'commands', 'doctorChecks', 'patchTypes'] as const) {
    const arr = provides[key];
    if (arr) {
      for (const item of arr) {
        if (typeof item !== 'string' || item.length === 0) {
          warnings.push({
            code: 'E_LINT_EMPTY_PROVIDES_ENTRY',
            message: `provides.${key} contains an empty entry.`,
            field: `provides.${key}`,
            severity: 'warning',
          });
        }
      }
    }
  }

  return {
    errors,
    warnings,
    passed: errors.length === 0,
  };
}
