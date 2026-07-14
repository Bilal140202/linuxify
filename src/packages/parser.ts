/**
 * Package YAML parser — reads, parses, and validates package definitions.
 *
 * @module linuxify/packages/parser
 *
 * The parser is a three-stage pipeline:
 *  1. **YAML parse** (`js-yaml`): converts the raw YAML text into a plain
 *     JS object. Failures throw {@link PackageError} with code
 *     `E_PACKAGE_PARSE_FAILED`.
 *  2. **Schema validation** (Zod): validates the parsed object against
 *     {@link PackageSchema}. Failures throw {@link PackageError} with code
 *     `E_PACKAGE_SCHEMA_INVALID` and the Zod issues array in `details`.
 *  3. **Lint** (optional): runs the {@link lint} semantic checks. The lint
 *     result is returned but does not throw — callers decide whether
 *     warnings block install.
 *
 * `loadPackageFromFile(path)` additionally checks that the package's `name`
 * field matches the YAML filename (e.g. `cline.yml` → `name: cline`). A
 * mismatch is logged as a warning but does not throw (the registry lint
 * workflow treats it as an error; the local install path is more lenient).
 *
 * All errors are thrown as {@link PackageError} (extends {@link
 * ../utils/errors.ts | LinuxifyError}) with stable `E_PACKAGE_*` codes,
 * suitable for `--json` output and programmatic handling.
 *
 * @packageDocumentation
 */

import { basename, extname } from 'node:path';

import yaml from 'js-yaml';

import { PackageError } from '../utils/errors.js';
import { readFile } from '../utils/fs.js';
import { logger } from '../utils/log.js';

import { lint, type LintIssue, type LintReport } from './linter.js';
import { PackageSchema, type PackageDefinition } from './schema.js';

// ============================================================================
// Public types
// ============================================================================

/**
 * Result of {@link lintPackage}. A flattened view of {@link LintReport}:
 * `issues` combines errors and warnings (each tagged with `severity`),
 * and `passed` is `true` iff there are no errors.
 */
export interface LintResult {
  /** All issues (errors first, then warnings), each tagged with severity. */
  readonly issues: ReadonlyArray<LintIssue>;
  /** `true` iff there are no error-severity issues. */
  readonly passed: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a Zod error into a single human-readable string for the error
 * message. Each issue is `<path>: <message>`, joined by `; `.
 *
 * @param issues - The Zod `issues` array from a failed `safeParse`.
 * @returns A semicolon-joined string of `<path>: <message>` entries.
 */
function formatZodIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse a YAML string into a validated {@link PackageDefinition}.
 *
 * Three-stage pipeline: YAML parse → Zod schema validation → (no lint; use
 * {@link lintPackage} for semantic checks). Throws {@link PackageError} on
 * any failure:
 *  - `E_PACKAGE_PARSE_FAILED` — the YAML is syntactically invalid.
 *  - `E_PACKAGE_SCHEMA_INVALID` — the YAML parses but fails schema
 *    validation (missing required field, bad regex, unknown key, …).
 *
 * @param yamlText - The raw YAML text.
 * @returns The parsed and schema-validated {@link PackageDefinition}.
 * @throws {PackageError} with code `E_PACKAGE_PARSE_FAILED` or
 *   `E_PACKAGE_SCHEMA_INVALID`.
 *
 * @example
 * ```ts
 * import { readFileSync } from 'node:fs';
 * import { parsePackageYaml } from './parser.js';
 *
 * const yaml = readFileSync('./cline.yml', 'utf8');
 * const pkg = parsePackageYaml(yaml); // throws PackageError on invalid YAML
 * console.log(pkg.name, pkg.version);
 * ```
 */
export function parsePackageYaml(yamlText: string): PackageDefinition {
  // Stage 1: YAML parse.
  let raw: unknown;
  try {
    raw = yaml.load(yamlText);
  } catch (error) {
    throw new PackageError(
      `Failed to parse package YAML: ${(error as Error).message}`,
      {
        code: 'E_PACKAGE_PARSE_FAILED',
        cause: error,
      },
    );
  }

  // A valid YAML document can be `null` (empty file) or a non-object scalar.
  // The Zod schema will reject these, but we give a clearer error first.
  if (raw === null || raw === undefined) {
    throw new PackageError('Package YAML is empty', {
      code: 'E_PACKAGE_PARSE_FAILED',
    });
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PackageError(
      `Package YAML must be a mapping (object), got ${Array.isArray(raw) ? 'array' : typeof raw}`,
      { code: 'E_PACKAGE_PARSE_FAILED' },
    );
  }

  // Stage 2: Zod schema validation.
  const result = PackageSchema.safeParse(raw);
  if (!result.success) {
    const formatted = formatZodIssues(result.error.issues);
    logger.debug({ issues: result.error.issues }, 'package YAML failed schema validation');
    throw new PackageError(`Package YAML failed schema validation: ${formatted}`, {
      code: 'E_PACKAGE_SCHEMA_INVALID',
      details: { issues: result.error.issues },
    });
  }

  return result.data;
}

/**
 * Load a package definition from a YAML file on disk.
 *
 * Reads the file via {@link ../utils/fs.ts | readFile} (which wraps `node:fs`
 * errors in `LinuxifyError`), then delegates to {@link parsePackageYaml}.
 * After parsing, checks that the `name` field matches the filename (without
 * extension). A mismatch is logged as a warning but does not throw — the
 * registry CI lint treats it as an error, but the local install path
 * (`linuxify add ./my-pkg.yml`) is lenient.
 *
 * @param filePath - Absolute or relative path to the `.yml`/`.yaml` file.
 * @returns The parsed and schema-validated {@link PackageDefinition}.
 * @throws {PackageError} with code `E_PACKAGE_PARSE_FAILED` or
 *   `E_PACKAGE_SCHEMA_INVALID` (from {@link parsePackageYaml}).
 * @throws {LinuxifyError} with code `E_FS_READ_FAILED` if the file cannot be
 *   read (from {@link readFile}).
 *
 * @example
 * ```ts
 * import { loadPackageFromFile } from './parser.js';
 *
 * const pkg = await loadPackageFromFile('./packages/cline.yml');
 * console.log(pkg.name); // 'cline'
 * ```
 */
export async function loadPackageFromFile(filePath: string): Promise<PackageDefinition> {
  const text = await readFile(filePath);
  const pkg = parsePackageYaml(text);

  // Filename ↔ name consistency check (warning, not error).
  const filename = basename(filePath);
  const ext = extname(filename);
  const stem = ext ? filename.slice(0, -ext.length) : filename;
  if (stem !== pkg.name) {
    logger.warn(
      { filename, name: pkg.name },
      `package name '${pkg.name}' does not match filename '${filename}' (expected '${stem}.yml')`,
    );
  }

  return pkg;
}

/**
 * Run the semantic linter on a parsed package definition and return a
 * flattened {@link LintResult}.
 *
 * This is a convenience wrapper around {@link lint} that flattens the
 * `errors`/`warnings` arrays into a single `issues` array (errors first,
 * then warnings, each tagged with its `severity`). Use {@link lint} directly
 * if you need the errors/warnings split.
 *
 * @param pkg - The parsed and schema-validated package definition.
 * @returns A {@link LintResult} with `issues` and a `passed` flag.
 *
 * @example
 * ```ts
 * import { parsePackageYaml, lintPackage } from './parser.js';
 *
 * const pkg = parsePackageYaml(yamlText);
 * const result = lintPackage(pkg);
 * if (!result.passed) {
 *   for (const issue of result.issues) {
 *     console.error(`[${issue.severity}] ${issue.code}: ${issue.message}`);
 *   }
 * }
 * ```
 */
export function lintPackage(pkg: PackageDefinition): LintResult {
  const report: LintReport = lint(pkg);
  return {
    issues: [...report.errors, ...report.warnings],
    passed: report.passed,
  };
}
