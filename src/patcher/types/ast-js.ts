/**
 * AST-based JavaScript patch-type handler (stub).
 *
 * @module linuxify/patcher/types/ast-js
 *
 * v0.1 ships this handler as a stub: it throws `E_PATCH_TYPE_UNSUPPORTED`
 * so the engine can surface a clear "not implemented in v0.1" error if a
 * package YAML declares `type: ast-js`. The full implementation (planned
 * for v0.2) will use `acorn` to parse, `ast-grep`-style selectors to
 * match, and `astring` or `babel` to regenerate source — see
 * `docs/08-patcher/patcher-engine.md` §5.2 and the v2 roadmap entry
 * "AST patches (acorn + ast-grep)".
 *
 * The stub exists (rather than the type being absent from the registry)
 * so that:
 *   1. The `PatchType` union can include `ast-js` today, matching the
 *      package YAML schema (`PatchTypeSchema` enumerates all six types).
 *   2. A package YAML declaring `type: ast-js` fails with a precise
 *      error code (`E_PATCH_TYPE_UNSUPPORTED`) instead of a generic
 *      `E_PATCH_TYPE_UNKNOWN` from the registry miss.
 *   3. The v0.2 implementation can drop in a real handler without
 *      changing the registry shape or the engine dispatch.
 */

import { PatcherError } from '../../utils/errors.js';

import type { PatchTypeHandler } from '../types.js';

/**
 * {@link PatchTypeHandler} stub for the `ast-js` patch type. Always
 * throws `E_PATCH_TYPE_UNSUPPORTED` on `apply`. See the module docstring
 * for the v0.2 plan.
 */
export const astJsHandler: PatchTypeHandler = {
  async apply(_content, patch): Promise<never> {
    throw new PatcherError(
      `ast-js patches are not implemented in v0.1 ` +
        `(patch '${patch.patch_id}' on file '${patch.file}'); ` +
        `use 'regex', 'sed', or 'shell' instead, or wait for v0.2`,
      {
        code: 'E_PATCH_TYPE_UNSUPPORTED',
        details: { type: 'ast-js', patchId: patch.patch_id, file: patch.file },
        docsUrl: 'https://docs.linuxify.dev/08-patcher/patcher-engine#ast-js',
      },
    );
  },
};
