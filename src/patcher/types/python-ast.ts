/**
 * AST-based Python patch-type handler (stub).
 *
 * @module linuxify/patcher/types/python-ast
 *
 * v0.1 ships this handler as a stub: it throws `E_PATCH_TYPE_UNSUPPORTED`
 * so the engine can surface a clear "not implemented in v0.1" error if a
 * package YAML declares `type: python-ast`. The full implementation
 * (planned for v0.2) will spawn `python3` with a small script that uses
 * the stdlib `ast` module to parse, transform, and `ast.unparse` the
 * file — see `docs/08-patcher/patcher-engine.md` §5.5 and the §16.3
 * walkthrough (patching Freebuff's hardcoded `/tmp` path).
 *
 * See {@link ./ast-js.ts} for the rationale behind shipping a stub
 * rather than omitting the type from the registry.
 */

import { PatcherError } from '../../utils/errors.js';

import type { PatchTypeHandler } from '../types.js';

/**
 * {@link PatchTypeHandler} stub for the `python-ast` patch type. Always
 * throws `E_PATCH_TYPE_UNSUPPORTED` on `apply`. See the module docstring
 * for the v0.2 plan.
 */
export const pythonAstHandler: PatchTypeHandler = {
  async apply(_content, patch): Promise<never> {
    throw new PatcherError(
      `python-ast patches are not implemented in v0.1 ` +
        `(patch '${patch.patch_id}' on file '${patch.file}'); ` +
        `use 'regex', 'sed', or 'shell' instead, or wait for v0.2`,
      {
        code: 'E_PATCH_TYPE_UNSUPPORTED',
        details: { type: 'python-ast', patchId: patch.patch_id, file: patch.file },
        docsUrl: 'https://docs.linuxify.dev/08-patcher/patcher-engine#python-ast',
      },
    );
  },
};
