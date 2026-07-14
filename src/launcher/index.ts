/**
 * Public API surface for the `launcher` module.
 *
 * @module linuxify/launcher
 *
 * Re-exports the {@link LauncherGenerator} class, the three template
 * functions, the launcher types, and a lazily-initialized singleton
 * factory bound to the Termux `$PREFIX`.
 *
 * Subsystem code should import from here (`../launcher` or
 * `linuxify/launcher`) rather than reaching into individual files, so
 * internal layout changes don't ripple.
 *
 * @example
 * ```ts
 * import {
 *   LauncherGenerator,
 *   getLauncherGenerator,
 *   type LauncherSpec,
 * } from '../launcher/index.js';
 *
 * // Use the default-bound singleton:
 * const gen = getLauncherGenerator();
 * await gen.generate({
 *   packageName: 'cline',
 *   launcherName: 'cline',
 *   distro: 'ubuntu',
 *   variant: 'standard',
 * });
 *
 * // Or construct directly (tests, custom prefix):
 * const customGen = new LauncherGenerator({ prefix: '/tmp/test-prefix' });
 * ```
 *
 * @packageDocumentation
 */

import { getTermuxPrefix } from '../utils/process.js';

import { LauncherGenerator } from './generator.js';

export { LauncherGenerator } from './generator.js';
export {
  customTemplate,
  directTemplate,
  standardTemplate,
  LAUNCHER_SHEBANG,
  LINUXIFY_HEADER_SIGNATURE,
} from './templates.js';
export type { LauncherResult, LauncherSpec, LauncherVariant } from './types.js';

/**
 * Cached singleton instance of {@link LauncherGenerator}, bound to the
 * Termux `$PREFIX` (resolved via {@link getTermuxPrefix}).
 *
 * Lazily initialized on first call so that importing the launcher module
 * does not perform any I/O or read `process.env.PREFIX`. Subsequent calls
 * return the cached instance.
 *
 * Tests that need a generator pointed at a tmpdir should construct their
 * own: `new LauncherGenerator({ prefix: tmpDir })`. The singleton is for
 * production code that wants the default Termux prefix.
 */
let _instance: LauncherGenerator | undefined;

/**
 * Get the default {@link LauncherGenerator} instance, bound to the Termux
 * `$PREFIX` (from `process.env.PREFIX` or the hardcoded
 * `/data/data/com.termux/files/usr` fallback — see {@link getTermuxPrefix}).
 *
 * The first call constructs the instance; subsequent calls return the
 * cached instance. Tests that need a generator pointed at a tmpdir should
 * construct their own with `new LauncherGenerator({ prefix: tmpDir })`
 * rather than calling this function.
 *
 * @returns The shared default {@link LauncherGenerator}.
 */
export function getLauncherGenerator(): LauncherGenerator {
  if (!_instance) {
    _instance = new LauncherGenerator({ prefix: getTermuxPrefix() });
  }
  return _instance;
}

/**
 * Reset the cached singleton. Exposed for tests that want to override
 * `process.env.PREFIX` and have {@link getLauncherGenerator} pick up the
 * new value. Production code should not call this.
 */
export function _resetLauncherGeneratorForTests(): void {
  _instance = undefined;
}
