/**
 * AST-based TypeScript patch-type handler (stub).
 *
 * @module linuxify/patcher/types/ast-ts
 *
 * v0.1 ships this handler as a stub: it throws `E_PATCH_TYPE_UNSUPPORTED`
 * so the engine can surface a clear "not implemented in v0.1" error if a
 * package YAML declares `type: ast-ts`. The full implementation (planned
 * for v0.2) will use `ts-morph` (a wrapper around the TypeScript
 * compiler API) to parse `.ts`/`.tsx` files, transform the AST, and
 * regenerate source with TypeScript syntax preserved — see
 * `docs/08-patcher/patcher-engine.md` §5.3.
 *
 * See {@link ./ast-js.ts} for the rationale behind shipping a stub
 * rather than omitting the type from the registry.
 */

import { PatcherError } from '../../utils/errors.js';

import type { PatchTypeHandler } from '../types.js';

/**
 * {@link PatchTypeHandler} stub for the `ast-ts` patch type. Always
 * throws `E_PATCH_TYPE_UNSUPPORTED` on `apply`. See the module docstring
 * for the v0.2 plan.
 */
export const astTsHandler: PatchTypeHandler = {
  async apply(_content, patch): Promise<never> {
    throw new PatcherError(
      `ast-ts patches are not implemented in v0.1 ` +
        `(patch '${patch.patch_id}' on file '${patch.file}'); ` +
        `use 'regex', 'sed', or 'shell' instead, or wait for v0.2`,
      {
        code: 'E_PATCH_TYPE_UNSUPPORTED',
        details: { type: 'ast-ts', patchId: patch.patch_id, file: patch.file },
        docsUrl: 'https://docs.linuxify.dev/08-patcher/patcher-engine#ast-ts',
      },
    );
  },
};
