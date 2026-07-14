/**
 * Patch-type handler registry.
 *
 * @module linuxify/patcher/types/index
 *
 * Maps each {@link PatchType} literal to its {@link PatchTypeHandler}.
 * The engine dispatches `applyPatch` by looking up `patch.type` in this
 * registry. Unknown types (e.g. a plugin-registered custom type that
 * hasn't been registered yet) fall through to a `undefined` lookup; the
 * engine throws `E_PATCH_TYPE_UNKNOWN` in that case.
 *
 * The registry is a static `Record<PatchType, PatchTypeHandler>` for the
 * six built-in types. Plugin-registered custom types are added at runtime
 * via {@link registerPatchType} (a thin wrapper around a `Map` that
 * shadows the static registry). This keeps the common path (built-in
 * types) zero-allocation and trivially inspectable, while still allowing
 * plugins to extend the type set.
 *
 * @packageDocumentation
 */

import type { PatchType, PatchTypeHandler } from '../types.js';
import { regexHandler } from './regex.js';
import { sedHandler } from './sed.js';
import { shellHandler } from './shell.js';
import { astJsHandler } from './ast-js.js';
import { astTsHandler } from './ast-ts.js';
import { pythonAstHandler } from './python-ast.js';

/**
 * Static registry of built-in patch-type handlers. Keys are the literal
 * `PatchType` union members; values are the corresponding handler
 * implementations. `ast-js`, `ast-ts`, and `python-ast` are present as
 * stubs that throw `E_PATCH_TYPE_UNSUPPORTED` (see their respective
 * modules) so the engine can distinguish "unknown type" (registry miss)
 * from "known but not implemented in v0.1" (stub throws).
 */
export const PATCH_TYPE_HANDLERS: Record<PatchType, PatchTypeHandler> = {
  regex: regexHandler,
  sed: sedHandler,
  shell: shellHandler,
  'ast-js': astJsHandler,
  'ast-ts': astTsHandler,
  'python-ast': pythonAstHandler,
};

/**
 * Runtime-extensible registry for plugin-registered custom patch types.
 * Plugins call {@link registerPatchType} from their `init()` to add a
 * new type; the engine consults this map first, falling back to the
 * static {@link PATCH_TYPE_HANDLERS} if no plugin handler is registered.
 */
const customHandlers = new Map<string, PatchTypeHandler>();

/**
 * Register a custom patch-type handler. Used by plugins from their
 * `init()` to add support for a patch type not in the built-in union
 * (e.g. `binary` for byte-level patches, or `toml-ast` for structured
 * TOML edits).
 *
 * @param name - The patch-type name. Must be a non-empty string. If a
 *   handler is already registered for this name (built-in or custom),
 *   throws `E_PATCH_TYPE_DUPLICATE` to prevent silent shadowing.
 * @param handler - The handler implementation.
 */
export function registerPatchType(name: string, handler: PatchTypeHandler): void {
  if (!name) {
    throw new Error('registerPatchType: name must be a non-empty string');
  }
  if (name in PATCH_TYPE_HANDLERS || customHandlers.has(name)) {
    throw new Error(
      `registerPatchType: patch type '${name}' is already registered`,
    );
  }
  customHandlers.set(name, handler);
}

/**
 * Look up the handler for a patch type. Custom (plugin-registered)
 * handlers take precedence over built-in handlers (so plugins can
 * override a built-in stub with a real implementation — e.g. a plugin
 * that implements `ast-js` using Babel).
 *
 * @param type - The patch-type name.
 * @returns The handler, or `undefined` if no handler is registered for
 *   the given type.
 */
export function getPatchTypeHandler(type: string): PatchTypeHandler | undefined {
  // Custom handlers take precedence (allows plugins to override the
  // built-in stubs).
  const custom = customHandlers.get(type);
  if (custom) return custom;
  // Built-in handlers are present for all six `PatchType` literals.
  return PATCH_TYPE_HANDLERS[type as PatchType];
}

/**
 * Reset the custom-handler registry. Exposed for tests that want to
 * isolate plugin-registered handlers. Production code should not call
 * this.
 */
export function _resetCustomPatchTypesForTests(): void {
  customHandlers.clear();
}
