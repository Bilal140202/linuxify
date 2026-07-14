/**
 * Public API surface for the `runtimes` module.
 *
 * @module linuxify/runtimes
 *
 * Re-exports the `RuntimeProvider` interface and helpers from `provider.ts`,
 * the four built-in provider classes (`NodeRuntimeProvider`,
 * `PythonRuntimeProvider`, `RustRuntimeProvider`, `GoRuntimeProvider`), and
 * the registry functions (`registerRuntime`, `getRuntime`, `listRuntimes`).
 *
 * Importing this module auto-registers the built-in runtimes so that
 * downstream code can call `getRuntime('node')` without first calling
 * `registerRuntime(new NodeRuntimeProvider(...))`. Tests that need a clean
 * registry can call {@link clearRuntimes} from `provider.ts`.
 *
 * @packageDocumentation
 */

import { getArch } from '../utils/process.js';

import { GoRuntimeProvider } from './go.js';
import { NodeRuntimeProvider } from './node.js';
import {
  clearRuntimes,
  createDefaultDistroExec,
  registerRuntime,
} from './provider.js';
import { PythonRuntimeProvider } from './python.js';
import { RustRuntimeProvider } from './rust.js';

// Re-exports — the runtime types and registry API.
export {
  // Interface + types
  type RuntimeProvider,
  type ExecOpts,
  type ExecResult,
  type InstallOpts,
  type InstalledRuntime,
  type DistroExecFn,
  // Registry
  registerRuntime,
  getRuntime,
  listRuntimes,
  unregisterRuntime,
  clearRuntimes,
  // Default distroExec factory
  createDefaultDistroExec,
  // State helpers (used by provider implementations and by callers that
  // want to read/inspect installed_runtimes without going through a
  // provider instance).
  findInstalledRuntimes,
  upsertRuntimeInstall,
  removeRuntimeInstall,
  markDefaultRuntime,
  getDefaultRuntimeVersion,
} from './provider.js';

// Re-export provider classes.
export { NodeRuntimeProvider, buildNodeInstallScript, parseNodeInstallOutput } from './node.js';
export {
  PythonRuntimeProvider,
  buildPythonInstallScript,
  parsePythonInstallOutput,
} from './python.js';
export { RustRuntimeProvider, buildRustInstallScript, parseRustInstallOutput } from './rust.js';
export { GoRuntimeProvider, buildGoInstallScript, parseGoInstallOutput } from './go.js';

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Whether the built-in runtimes have been registered yet. Guards against
 * double-registration when this module is imported multiple times (ESM
 * should memoize, but bundlers and test runners can re-evaluate).
 */
let BUILTINS_REGISTERED = false;

/**
 * Register all built-in runtime providers (node, python, rust, go) with the
 * module-level registry, each wired to a default {@link DistroExecFn} that
 * invokes `proot-distro login`.
 *
 * Safe to call multiple times: subsequent calls are no-ops. Tests that need
 * a clean registry should call {@link clearRuntimes} and then re-call this
 * function (or skip it and register their own stub providers).
 *
 * The `arch` argument is forwarded to the Go provider, which needs it to
 * pick the correct tarball. Defaults to the host's canonical arch via
 * `getArch()`.
 *
 * @param arch - Linuxify-canonical arch (default: `getArch()`).
 */
export function registerBuiltInRuntimes(arch: string = getArch()): void {
  if (BUILTINS_REGISTERED) return;
  const distroExec = createDefaultDistroExec();
  registerRuntime(new NodeRuntimeProvider(distroExec));
  registerRuntime(new PythonRuntimeProvider(distroExec));
  registerRuntime(new RustRuntimeProvider(distroExec));
  registerRuntime(new GoRuntimeProvider(distroExec, undefined, arch));
  BUILTINS_REGISTERED = true;
}

/**
 * Reset the auto-registration flag and clear the registry. Used by tests
 * that want to start fresh after a prior `registerBuiltInRuntimes()` call.
 *
 * @param reRegister - If `true` (default), re-register the built-in
 *   runtimes after clearing. If `false`, leave the registry empty.
 */
export function resetRuntimes(reRegister = true): void {
  clearRuntimes();
  BUILTINS_REGISTERED = false;
  if (reRegister) {
    registerBuiltInRuntimes();
  }
}

// Auto-register on first import. Downstream code that wants a different
// wiring (e.g. tests injecting a stub distroExec) should call
// `clearRuntimes()` first and then register their own providers.
registerBuiltInRuntimes();
