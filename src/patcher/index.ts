/**
 * Public API surface for the `patcher` module.
 *
 * @module linuxify/patcher
 *
 * Re-exports the {@link PatcherEngine} class, the patcher type
 * definitions, the per-type handlers, the verify step, and a
 * lazily-initialized factory that binds the engine to the default
 * {@link StateStore}.
 *
 * Subsystem code (the package manager, the CLI) should import from here
 * (`../patcher` or `linuxify/patcher`) rather than reaching into
 * individual files, so internal layout changes don't ripple.
 *
 * @example
 * ```ts
 * import { PatcherEngine, type PatchContext } from '../patcher/index.js';
 *
 * const engine = new PatcherEngine({ stateStore });
 * const results = await engine.applyPatches(pkg.patches, ctx, {
 *   onProgress: (msg) => console.log(msg),
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { StateStore } from '../state/index.js';

import { PatcherEngine } from './engine.js';

// Type definitions.
export type {
  PatchType,
  PatchDefinition,
  PatchApplication,
  PatchResult,
  ApplyPatchesOptions,
  PatchContext,
  PatchHandlerResult,
  PatchTypeHandler,
  VerifyResult,
} from './types.js';

// Engine.
export { PatcherEngine } from './engine.js';

// Per-type handlers (exported for direct unit testing and for plugins
// that want to register a custom type using a built-in as a base).
export { applyRegexPatch, regexHandler } from './types/regex.js';
export { applySedPatch, sedHandler } from './types/sed.js';
export { applyShellPatch, shellHandler } from './types/shell.js';
export { astJsHandler } from './types/ast-js.js';
export { astTsHandler } from './types/ast-ts.js';
export { pythonAstHandler } from './types/python-ast.js';

// Type registry.
export {
  PATCH_TYPE_HANDLERS,
  registerPatchType,
  getPatchTypeHandler,
  _resetCustomPatchTypesForTests,
} from './types/index.js';

// Verify step.
export { verifyPatch, lintVerifyCommand } from './verify.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Cached singleton instance of {@link PatcherEngine}, bound to the
 * default {@link StateStore}.
 *
 * Lazily initialized on first call so that importing the patcher module
 * does not perform any I/O. Subsequent calls return the cached instance.
 *
 * Tests that need an engine pointed at a tmpdir-backed state store
 * should construct their own: `new PatcherEngine({ stateStore })`. The
 * singleton is for production code that wants the shared state store.
 */
let _instance: PatcherEngine | undefined;

/**
 * Get the default {@link PatcherEngine} instance, bound to the given
 * {@link StateStore}.
 *
 * The first call constructs the instance; subsequent calls return the
 * cached instance (ignoring the `stateStore` argument). Tests that need
 * a fresh engine should construct their own with `new PatcherEngine`.
 *
 * @param stateStore - The shared state store. Required on first call;
 *   ignored on subsequent calls (the cached instance is returned).
 * @returns The shared default {@link PatcherEngine}.
 */
export function getPatcherEngine(stateStore: StateStore): PatcherEngine {
  if (!_instance) {
    _instance = new PatcherEngine({ stateStore });
  }
  return _instance;
}

/**
 * Reset the cached singleton. Exposed for tests that want to override
 * the state store and have {@link getPatcherEngine} pick up the new
 * value. Production code should not call this.
 */
export function _resetPatcherEngineForTests(): void {
  _instance = undefined;
}
