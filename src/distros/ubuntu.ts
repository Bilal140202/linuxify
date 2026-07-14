/**
 * Ubuntu distro provider.
 *
 * @module linuxify/distros/ubuntu
 *
 * Ubuntu 24.04 LTS is the default distro for Linuxify v1. This provider
 * delegates to `proot-distro` (alias: `ubuntu`) for all rootfs lifecycle
 * operations. The package-manager grammar is `apt`; the default user inside
 * the proot is `linuxify` (UID 1000), matching the bootstrap Stage 3
 * first-boot script.
 *
 * See `docs/05-bootstrap/distro-management.md` §2 (Ubuntu subsection) for
 * the rationale behind the default version, rootfs URL, and runtime set.
 */

import { ProotDistroBase } from './proot-base.js';

/**
 * Distro provider for Ubuntu. Concrete subclass of {@link ProotDistroBase};
 * all behavior is inherited, only the per-distro config is supplied here.
 */
export class UbuntuProvider extends ProotDistroBase {
  /** Construct the Ubuntu provider with the v1 default config. */
  constructor() {
    super({
      name: 'ubuntu',
      alias: 'ubuntu',
      displayName: 'Ubuntu 24.04 LTS',
      defaultVersion: '24.04',
      supportedArches: ['aarch64', 'armv7l', 'x86_64'],
      minStorageMb: 1500,
      packageManager: 'apt',
      updateCommand: 'apt-get update && apt-get upgrade -y',
      defaultUser: 'linuxify',
      notes: 'Default distro. Best compatibility. Use this unless you have a specific reason not to.',
    });
  }
}

/**
 * Singleton instance of {@link UbuntuProvider}, ready for registration via
 * `registerDistro(ubuntuProvider)` (performed by `src/distros/index.ts`).
 */
export const ubuntuProvider = new UbuntuProvider();
