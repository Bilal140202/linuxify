/**
 * Public API surface for the `packages` module.
 *
 * @module linuxify/packages
 *
 * Re-exports the Zod schema, inferred `PackageDefinition` type, the parser
 * (`parsePackageYaml`, `loadPackageFromFile`, `lintPackage`), the linter
 * (`lint`, `LintReport`, `LintIssue`), and the `PackageManager` class plus
 * its options/result types. Downstream subsystems (CLI, patcher, launcher,
 * registry) should import exclusively from here:
 *
 * ```ts
 * import {
 *   PackageManager,
 *   parsePackageYaml,
 *   loadPackageFromFile,
 *   lint,
 *   PackageSchema,
 *   type PackageDefinition,
 * } from '../packages/index.js';
 * ```
 *
 * @packageDocumentation
 */

// Schema + inferred types.
export {
  PackageSchema,
  RuntimeSchema,
  PackageManagerSchema,
  PatchTypeSchema,
  EnvScopeSchema,
  EnvOverrideSchema,
  EnvValueSchema,
  EnvValueStructuredSchema,
  InstallStepSchema,
  InstallStepObjectSchema,
  InstallBlockSchema,
  PatchDefinitionSchema,
  DoctorCheckSchema,
  PermissionsSchema,
  CompatSchema,
} from './schema.js';

export type {
  PackageDefinition,
  Runtime,
  PackageManagerName,
  PatchType,
  EnvVar,
  InstallStep,
  InstallStepObject,
  InstallBlock,
  PatchDefinition,
  DoctorCheck,
  Permissions,
  CompatBlock,
} from './schema.js';

// Linter.
export { lint } from './linter.js';
export type { LintIssue, LintReport, LintSeverity } from './linter.js';

// Parser.
export { parsePackageYaml, loadPackageFromFile, lintPackage } from './parser.js';
export type { LintResult } from './parser.js';

// Manager.
export { PackageManager } from './manager.js';
export type {
  DistroProvider,
  DistroExecOptions,
  DistroExecResult,
  RuntimeProvider,
  RuntimeInstallOptions,
  RuntimeVersion,
  InstallOpts,
  InstallResult,
  UninstallOpts,
  UninstallResult,
  PackageManagerOptions,
} from './manager.js';
