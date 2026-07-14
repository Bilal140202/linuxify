/**
 * Alpine distro provider.
 *
 * @module linuxify/distros/alpine
 *
 * Alpine 3.20 is the minimal-footprint option. The provider uses
 * `proot-distro` (alias: `alpine`) and `apk` for package management.
 *
 * ## musl caveats
 *
 * Alpine uses musl libc instead of glibc. Any pre-built Node native module
 * that assumes glibc (better-sqlite3, sharp, canvas, bcrypt, node-canvas)
 * will fail at `require()` time on Alpine with a confusing `not found`
 * error (the kernel's error when the dynamic linker is missing). Alpine
 * users should expect to rebuild native modules from source
 * (`apk add build-base python3` is required) or to fall back to a
 * glibc-based distro (Ubuntu/Debian/Arch).
 *
 * The default shell on Alpine is busybox `ash`, not `bash` — but Linuxify
 * installs `bash` during Stage 3 first-boot, so `proot-distro login alpine
 * --user linuxify -- bash -c '<cmd>'` works regardless.
 *
 * See `docs/05-bootstrap/distro-management.md` §2 (Alpine subsection) and
 * §9 (Cross-distro Compatibility Notes) for the full compatibility matrix.
 */

import { ProotDistroBase } from './proot-base.js';

/**
 * Distro provider for Alpine. Concrete subclass of {@link ProotDistroBase};
 * all behavior is inherited, only the per-distro config is supplied here.
 */
export class AlpineProvider extends ProotDistroBase {
  /** Construct the Alpine provider with the v1 default config. */
  constructor() {
    super({
      name: 'alpine',
      alias: 'alpine',
      displayName: 'Alpine 3.20',
      defaultVersion: '3.20',
      supportedArches: ['aarch64', 'armv7l', 'x86_64'],
      minStorageMb: 800,
      packageManager: 'apk',
      updateCommand: 'apk update && apk upgrade',
      defaultUser: 'linuxify',
      notes:
        'Minimal footprint (~80 MB extracted) but musl libc — pre-built Node native modules may fail. Rebuild from source with `apk add build-base python3` or use Ubuntu/Debian.',
    });
  }
}

/**
 * Singleton instance of {@link AlpineProvider}, ready for registration via
 * `registerDistro(alpineProvider)` (performed by `src/distros/index.ts`).
 */
export const alpineProvider = new AlpineProvider();
