/**
 * Arch Linux distro provider.
 *
 * @module linuxify/distros/arch
 *
 * Arch Linux ARM is the rolling-release option. The provider uses
 * `proot-distro` (alias: `archlinux`) and `pacman` for package management.
 * Arch appeals to users who want the newest versions of everything; the
 * trade-off is that `pacman -Syu` can occasionally break the system, so
 * Linuxify snapshots before every `update()` call (see
 * `docs/05-bootstrap/distro-management.md` §8).
 *
 * See `docs/05-bootstrap/distro-management.md` §2 (Arch subsection).
 */

import { ProotDistroBase } from './proot-base.js';

/**
 * Distro provider for Arch Linux. Concrete subclass of {@link ProotDistroBase};
 * all behavior is inherited, only the per-distro config is supplied here.
 */
export class ArchProvider extends ProotDistroBase {
  /** Construct the Arch provider with the v1 default config. */
  constructor() {
    super({
      name: 'arch',
      alias: 'archlinux',
      displayName: 'Arch Linux ARM',
      defaultVersion: 'rolling',
      supportedArches: ['aarch64', 'armv7l', 'x86_64'],
      minStorageMb: 1500,
      packageManager: 'pacman',
      updateCommand: 'pacman -Syu --noconfirm',
      defaultUser: 'linuxify',
      notes: 'Rolling release; snapshot before every update. May break more often than Ubuntu/Debian.',
    });
  }
}

/**
 * Singleton instance of {@link ArchProvider}, ready for registration via
 * `registerDistro(archProvider)` (performed by `src/distros/index.ts`).
 */
export const archProvider = new ArchProvider();
