/**
 * Debian distro provider.
 *
 * @module linuxify/distros/debian
 *
 * Debian 12 (bookworm) is the second-most-tested distro. The provider uses
 * `proot-distro` (alias: `debian`) and `apt` for package management — the
 * experience is nearly identical to Ubuntu's. The main practical difference
 * is that some packages are slightly older than Ubuntu's (e.g. `gcc` is
 * 12.2 vs Ubuntu's 13.x).
 *
 * See `docs/05-bootstrap/distro-management.md` §2 (Debian subsection).
 */

import { ProotDistroBase } from './proot-base.js';

/**
 * Distro provider for Debian. Concrete subclass of {@link ProotDistroBase};
 * all behavior is inherited, only the per-distro config is supplied here.
 */
export class DebianProvider extends ProotDistroBase {
  /** Construct the Debian provider with the v1 default config. */
  constructor() {
    super({
      name: 'debian',
      alias: 'debian',
      displayName: 'Debian 12 (bookworm)',
      defaultVersion: '12',
      supportedArches: ['aarch64', 'armv7l', 'x86_64'],
      minStorageMb: 1500,
      packageManager: 'apt',
      updateCommand: 'apt-get update && apt-get upgrade -y',
      defaultUser: 'linuxify',
      notes: 'Stricter free-software policy than Ubuntu; slightly older packages.',
    });
  }
}

/**
 * Singleton instance of {@link DebianProvider}, ready for registration via
 * `registerDistro(debianProvider)` (performed by `src/distros/index.ts`).
 */
export const debianProvider = new DebianProvider();
