/**
 * Rust runtime provider (via rustup).
 *
 * @module linuxify/runtimes/rust
 *
 * Manages the Rust toolchain inside a distro via `rustup` (the official
 * installer). rustup itself is installed via
 * `curl https://sh.rustup.rs | sh -s -- -y --default-toolchain stable`,
 * which places `cargo`, `rustc`, `rustup`, and other binaries in
 * `~/.cargo/bin/` (inside the proot session's HOME, which is
 * `/home/linuxify` under the default proot-distro login user).
 *
 * ## Install layout
 *
 *   ~/.linuxify/distros/<distro>/home/linuxify/.cargo/bin/cargo
 *   ~/.linuxify/distros/<distro>/home/linuxify/.cargo/bin/rustc
 *   ~/.linuxify/distros/<distro>/home/linuxify/.cargo/bin/rustup
 *   ~/.linuxify/distros/<distro>/home/linuxify/.rustup/toolchains/<toolchain>/...
 *
 * rustup manages side-by-side toolchains natively (stable, beta, nightly,
 * and specific versions like `1.74.0`). Linuxify's job is mostly to invoke
 * rustup correctly and to expose `cargo`, `rustc`, and `rustup` on the PATH.
 *
 * ## When is Rust required?
 *
 * Rust is rarely required at run time (Rust CLIs are typically distributed
 * as static binaries), but it is required at install time for any package
 * whose install command is `cargo install <name>`. The runtime layer ensures
 * `cargo` is on the PATH during `linuxify add` for such packages.
 *
 * ## Default version
 *
 * `defaultVersion: 'stable'`. The user can install `nightly` or a specific
 * version (e.g. `1.74.0`) via `linuxify runtimes install rust 1.74.0`.
 *
 * @packageDocumentation
 */

import { getStatePath, StateStore } from '../state/store.js';
import { RuntimeError } from '../utils/errors.js';
import { logger } from '../utils/log.js';

import {
  type DistroExecFn,
  type ExecOpts,
  type ExecResult,
  type InstallOpts,
  type InstalledRuntime,
  type RuntimeProvider,
  findInstalledRuntimes,
  getDefaultRuntimeVersion,
  markDefaultRuntime,
  removeRuntimeInstall,
  upsertRuntimeInstall,
} from './provider.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Official rustup install script URL. */
const RUSTUP_INSTALL_URL = 'https://sh.rustup.rs';

/** Path inside the distro where rustup installs binaries. */
const CARGO_BIN_DIR = '/home/linuxify/.cargo/bin';

/** Default install timeout: 10 minutes (rustup downloads ~300 MB). */
const RUST_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Default exec timeout: 5 minutes (covers slow `cargo build`). */
const RUST_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/** Toolchain specs this provider supports installing. */
const SUPPORTED_RUST_VERSIONS = ['stable', 'beta', 'nightly'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a Rust toolchain spec. Accepts `stable`, `beta`, `nightly`,
 * bare version numbers (`1.74.0`), and channel-version hybrids
 * (`stable-1.74.0`). Returns the input unchanged if it does not look like a
 * known channel — rustup will reject unknown specs with a clear error.
 *
 * @param version - Toolchain spec.
 * @returns Normalized spec.
 */
function normalizeToolchain(version: string): string {
  const v = version.trim().toLowerCase();
  if (!v) return 'stable';
  return v;
}

/**
 * Build the bash script that installs rustup + the requested toolchain.
 *
 * @param toolchain - Toolchain spec (e.g. `stable`, `1.74.0`).
 * @returns A multi-line bash script string.
 */
export function buildRustInstallScript(toolchain: string): string {
  const tc = normalizeToolchain(toolchain);
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'export RUSTUP_HOME="${HOME}/.rustup"',
    'export CARGO_HOME="${HOME}/.cargo"',
    '',
    'echo "[linuxify/rust] checking for existing rustup"',
    'if command -v rustup >/dev/null 2>&1; then',
    '  echo "[linuxify/rust] rustup already installed; installing toolchain"',
    `  rustup install ${tc}`,
    `  rustup default ${tc}`,
    'else',
    '  echo "[linuxify/rust] downloading rustup install script"',
    `  curl --proto "=https" --tlsv1.2 -sSf ${RUSTUP_INSTALL_URL} | sh -s -- -y --default-toolchain ${tc}`,
    'fi',
    '',
    'echo "[linuxify/rust] verifying install"',
    'echo "LINUXIFY_RUSTC_VERSION=$(rustc --version)"',
    'echo "LINUXIFY_CARGO_VERSION=$(cargo --version)"',
    'echo "LINUXIFY_RUSTUP_VERSION=$(rustup --version)"',
    '',
    'echo "[linuxify/rust] done"',
  ].join('\n');
}

/**
 * Parse `LINUXIFY_RUSTC_VERSION=rustc 1.74.0 (79e9716c9 2023-11-13)` markers
 * from the install script's stdout.
 *
 * @param stdout - The script's combined stdout.
 * @returns An object with `rustcVersion`, `cargoVersion`, and `rustupVersion`.
 */
export function parseRustInstallOutput(stdout: string): {
  rustcVersion: string;
  cargoVersion: string;
  rustupVersion: string;
} {
  const out = { rustcVersion: '', cargoVersion: '', rustupVersion: '' };
  const rustcMatch = /^LINUXIFY_RUSTC_VERSION=(.+)$/m.exec(stdout);
  const cargoMatch = /^LINUXIFY_CARGO_VERSION=(.+)$/m.exec(stdout);
  const rustupMatch = /^LINUXIFY_RUSTUP_VERSION=(.+)$/m.exec(stdout);
  if (rustcMatch?.[1]) {
    // `rustc --version` prints "rustc 1.74.0 (79e9716c9 2023-11-13)"; take the second token.
    out.rustcVersion = rustcMatch[1].split(/\s+/)[1] ?? '';
  }
  if (cargoMatch?.[1]) {
    out.cargoVersion = cargoMatch[1].split(/\s+/)[1] ?? '';
  }
  if (rustupMatch?.[1]) {
    out.rustupVersion = rustupMatch[1].split(/\s+/)[1] ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// RustRuntimeProvider
// ---------------------------------------------------------------------------

/**
 * Rust runtime provider. See module-level docs for the install layout
 * and toolchain-resolution strategy.
 */
export class RustRuntimeProvider implements RuntimeProvider {
  readonly name = 'rust';
  readonly displayName = 'Rust';
  readonly defaultVersion = 'stable';
  readonly supportedVersions: readonly string[] = SUPPORTED_RUST_VERSIONS;

  /** Lazily-created default StateStore when none was injected. */
  private storeInternal: StateStore | undefined;

  /**
   * @param distroExec - Function that runs a command inside a distro's
   *   proot session.
   * @param stateStore - Optional StateStore for state.json access.
   */
  constructor(
    private readonly distroExec: DistroExecFn,
    private readonly stateStore?: StateStore,
  ) {}

  /** Resolve the StateStore to use (injected or default). */
  private async getStore(): Promise<StateStore> {
    if (this.stateStore) return this.stateStore;
    if (!this.storeInternal) {
      this.storeInternal = new StateStore(getStatePath());
    }
    return this.storeInternal;
  }

  /** @inheritdoc */
  pathFor(_version: string, _distro: string): string {
    return CARGO_BIN_DIR;
  }

  /** @inheritdoc */
  async isInstalled(version: string, distro: string): Promise<boolean> {
    const installed = await this.list(distro);
    if (installed.length === 0) return false;
    const tc = normalizeToolchain(version);
    return installed.some((r) => r.version === tc);
  }

  /** @inheritdoc */
  async install(version: string, distro: string, opts?: InstallOpts): Promise<void> {
    const progress = opts?.onProgress ?? (() => {});
    const tc = normalizeToolchain(version);
    progress(`checking if Rust toolchain '${tc}' is already installed in ${distro}`);

    if (await this.isInstalled(tc, distro)) {
      logger.info({ version: tc, distro }, 'rust toolchain already installed; skipping');
      progress(`Rust ${tc} already installed in ${distro}`);
      return;
    }

    const script = buildRustInstallScript(tc);
    progress(`downloading rustup + toolchain '${tc}'`);
    logger.info({ version: tc, distro }, 'installing rust via rustup');

    // Use bash -c so the rustup install script's pipes work. We pass
    // HOME via env so rustup installs into /home/linuxify/.cargo (the
    // proot-distro default user's home).
    const result = await this.distroExec(distro, 'bash', ['-c', script], {
      timeoutMs: RUST_INSTALL_TIMEOUT_MS,
      env: {
        DEBIAN_FRONTEND: 'noninteractive',
        TERM: 'dumb',
        HOME: '/home/linuxify',
      },
    });

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Rust ${tc} install failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'INSTALL_FAILED',
          details: {
            version: tc,
            distro,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-2000),
            stderr: result.stderr.slice(-2000),
          },
          fixCommand: `linuxify runtimes install rust ${tc} --distro ${distro}`,
        },
      );
    }

    const parsed = parseRustInstallOutput(result.stdout);
    // For 'stable'/'beta'/'nightly' we record the channel name, not the
    // resolved semver, because rustup manages the channel-to-version mapping
    // itself (rustup update will bump stable without our involvement).
    const resolvedVersion = tc;
    progress(`installed Rust ${resolvedVersion} (rustc ${parsed.rustcVersion}) in ${distro}`);

    const store = await this.getStore();
    await store.update((state) => {
      const existing = findInstalledRuntimes(state, this.name, distro);
      const isFirst = existing.length === 0;
      upsertRuntimeInstall(state, {
        name: this.name,
        version: resolvedVersion,
        distro,
        path: this.pathFor(resolvedVersion, distro),
        installedAt: new Date().toISOString(),
        isDefault: isFirst,
      });
      if (isFirst) {
        markDefaultRuntime(state, this.name, distro, resolvedVersion);
      }
    });
  }

  /** @inheritdoc */
  async uninstall(version: string, distro: string): Promise<void> {
    const tc = normalizeToolchain(version);
    const installed = await this.list(distro);
    const match = installed.find((r) => r.version === tc);

    if (!match) {
      throw new RuntimeError(`Rust ${tc} is not installed in ${distro}`, {
        code: 'NOT_INSTALLED',
        details: { version: tc, distro },
      });
    }

    logger.info({ version: tc, distro }, 'uninstalling rust toolchain via rustup');
    const result = await this.distroExec(
      distro,
      'bash',
      ['-c', `rustup uninstall ${tc}`],
      {
        timeoutMs: RUST_INSTALL_TIMEOUT_MS,
        env: { HOME: '/home/linuxify' },
      },
    );

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Rust ${tc} uninstall failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'UNINSTALL_FAILED',
          details: { version: tc, distro, exitCode: result.exitCode, stderr: result.stderr },
        },
      );
    }

    const store = await this.getStore();
    await store.update((state) => {
      removeRuntimeInstall(state, this.name, distro, tc);
    });
  }

  /** @inheritdoc */
  async list(distro: string): Promise<InstalledRuntime[]> {
    // `rustup toolchain list` prints one toolchain per line, e.g.:
    //   stable-x86_64-unknown-linux-gnu (default)
    //   nightly-x86_64-unknown-linux-gnu
    //   1.74.0-x86_64-unknown-linux-gnu
    const result = await this.distroExec(
      distro,
      'bash',
      ['-c', 'rustup toolchain list 2>/dev/null || true'],
      { timeoutMs: RUST_EXEC_TIMEOUT_MS, env: { HOME: '/home/linuxify' } },
    );
    if (result.exitCode !== 0) {
      logger.debug({ distro, exitCode: result.exitCode }, 'rustup not installed in distro');
      return [];
    }

    const store = await this.getStore();
    const state = await store.load();

    const installed: InstalledRuntime[] = [];
    for (const line of result.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Strip the "(default)" / "(active)" suffix and the target triple.
      const m = /^([\w.-]+?)-[a-z0-9_-]+/.exec(trimmed);
      const tc = m ? m[1] : trimmed.split(/\s+/)[0] ?? '';
      if (!tc || tc === 'no') continue;
      const stateEntry = state.installed_runtimes.find(
        (r) => r.name === this.name && r.distro === distro && r.version === tc,
      );
      installed.push({
        name: this.name,
        version: tc,
        distro,
        path: this.pathFor(tc, distro),
        installedAt: stateEntry?.installed_at ?? '',
        isDefault: stateEntry?.is_default ?? trimmed.includes('(default)'),
      });
    }
    return installed;
  }

  /** @inheritdoc */
  async getDefault(distro: string): Promise<string | null> {
    const store = await this.getStore();
    const state = await store.load();
    const fromState = getDefaultRuntimeVersion(state, this.name, distro);
    if (fromState) return fromState;
    // Fall back to querying rustup for the default toolchain.
    const result = await this.distroExec(
      distro,
      'bash',
      ['-c', 'rustup default 2>/dev/null || true'],
      { env: { HOME: '/home/linuxify' } },
    );
    if (result.exitCode !== 0) return null;
    const m = /^([\w.-]+?)-[a-z0-9_-]/.exec(result.stdout.trim());
    return m ? m[1] : null;
  }

  /** @inheritdoc */
  async setDefault(version: string, distro: string): Promise<void> {
    const tc = normalizeToolchain(version);
    const store = await this.getStore();
    let found = false;
    await store.update((state) => {
      found = markDefaultRuntime(state, this.name, distro, tc);
    });
    if (!found) {
      throw new RuntimeError(
        `Rust ${tc} is not installed in ${distro}; cannot set as default`,
        {
          code: 'NOT_INSTALLED',
          details: { version: tc, distro },
          fixCommand: `linuxify runtimes install rust ${tc} --distro ${distro}`,
        },
      );
    }
    // Also tell rustup to use this toolchain as its default, so direct
    // `cargo` / `rustc` invocations pick it up.
    await this.distroExec(distro, 'bash', ['-c', `rustup default ${tc}`], {
      env: { HOME: '/home/linuxify' },
    });
  }

  /** @inheritdoc */
  async exec(
    version: string,
    distro: string,
    cmd: string,
    args: readonly string[],
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const fullCmd = cmd.startsWith('/') ? cmd : `${CARGO_BIN_DIR}/${cmd}`;
    logger.debug({ version, distro, cmd: fullCmd, args }, 'rust runtime exec');
    return this.distroExec(distro, fullCmd, args, {
      ...opts,
      env: { HOME: '/home/linuxify', ...opts?.env },
    });
  }
}
