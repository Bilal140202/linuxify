/**
 * Public API surface for the `distros` subsystem.
 *
 * @module linuxify/distros
 *
 * Re-exports the {@link DistroProvider} interface, the registry functions,
 * the shared base class, and the four built-in distro provider singletons.
 * Importing this module also auto-registers the built-in distros (Ubuntu,
 * Debian, Arch, Alpine) with the process-global registry via the
 * {@link registerBuiltInDistros} side-effect.
 *
 * Downstream subsystems should import from here (`../distros` or
 * `linuxify/distros`) rather than reaching into individual files, so internal
 * layout changes don't ripple.
 *
 * @packageDocumentation
 */

import { logger } from '../utils/log.js';

import { alpineProvider } from './alpine.js';
import { archProvider } from './arch.js';
import { debianProvider } from './debian.js';
import { registerDistro } from './provider.js';
import { ubuntuProvider } from './ubuntu.js';

// ---------------------------------------------------------------------------
// Type + symbol re-exports
// ---------------------------------------------------------------------------

export type {
  DistroProvider,
  InstallOpts,
  ExecOpts,
  ShellOpts,
  ExecResult,
  DistroInfo,
} from './provider.js';

export {
  registerDistro,
  getDistro,
  listDistros,
  getActiveDistroName,
  _clearDistroRegistryForTests,
} from './provider.js';

export { ProotDistroBase } from './proot-base.js';
export type { ProotDistroConfig } from './proot-base.js';
export {
  composeShellCommand,
  shellQuote,
  parseRootfsPath,
  sanitizeSnapshotName,
} from './proot-base.js';

export { UbuntuProvider, ubuntuProvider } from './ubuntu.js';
export { DebianProvider, debianProvider } from './debian.js';
export { ArchProvider, archProvider } from './arch.js';
export { AlpineProvider, alpineProvider } from './alpine.js';

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

/**
 * Track whether the built-in providers have been registered in this
 * process. Re-registration is idempotent but logs a debug message on
 * subsequent calls (helps catch double-imports under bundlers that
 * duplicate modules).
 */
let builtInsRegistered = false;

/**
 * Register all built-in distro providers (Ubuntu, Debian, Arch, Alpine)
 * with the process-global registry. Called once at module import time by
 * the side-effect below; safe to call again — subsequent calls are a no-op
 * (the providers' `name` properties are stable, so re-registration just
 * overwrites the existing entry with itself).
 *
 * Plugin authors may call this explicitly if they need to ensure built-ins
 * are present before registering a custom provider that depends on one.
 */
export function registerBuiltInDistros(): void {
  if (builtInsRegistered) {
    logger.debug('distros: built-in providers already registered, skipping');
    return;
  }
  registerDistro(ubuntuProvider);
  registerDistro(debianProvider);
  registerDistro(archProvider);
  registerDistro(alpineProvider);
  builtInsRegistered = true;
  logger.debug('distros: registered built-in providers', {
    names: [ubuntuProvider.name, debianProvider.name, archProvider.name, alpineProvider.name],
  });
}

// Auto-register on import. This is the documented v1 contract: "providers
// are compiled-in for now, and a runtime plugin system can be layered on
// later without changing the interface" (ADR-006). Importing `linuxify/distros`
// is sufficient to make `getDistro('ubuntu')` work.
registerBuiltInDistros();
