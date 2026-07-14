/**
 * Node.js runtime provider.
 *
 * @module linuxify/runtimes/node
 *
 * Manages Node.js installations inside a distro via the NodeSource apt
 * repository (preferred for v20+ because Ubuntu's bundled `nodejs` package
 * is typically too old for AI CLIs that require Node ≥ 20). A future revision
 * will fall back to `nvm` for older versions or per-package version pinning;
 * v1 wires up the NodeSource path only.
 *
 * ## Install layout
 *
 * NodeSource installs `node`, `npm`, `npx`, and `corepack` into
 * `/usr/bin/` inside the distro rootfs:
 *
 *   ~/.linuxify/distros/<distro>/usr/bin/node
 *   ~/.linuxify/distros/<distro>/usr/bin/npm
 *   ~/.linuxify/distros/<distro>/usr/bin/npx
 *   ~/.linuxify/distros/<distro>/usr/bin/corepack
 *
 * There is no side-by-side versioning in v1 — the apt install replaces the
 * previous NodeSource version. The state.json record's `version` field is
 * populated from `node --version` after install so it reflects the actual
 * installed version, not the requested spec.
 *
 * ## Default version
 *
 * `defaultVersion: 'lts'` resolves to the current Node LTS line via the
 * NodeSource `setup_lts.x` script. A specific major (`'20'`, `'22'`) is
 * honored by switching to `setup_<major>.x`; an exact version (`'22.11.0'`)
 * is honored by `apt install nodejs=22.11.0-1nodesource1`.
 *
 * @packageDocumentation
 */

import { StateStore } from '../state/store.js';
import { getStatePath } from '../state/store.js';
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

/** NodeSource setup script URL template; `<major>` is substituted at install time. */
const NODESOURCE_SETUP_URL_TEMPLATE = 'https://deb.nodesource.com/setup_<major>.x';

/** NodeSource setup script URL for the LTS line. */
const NODESOURCE_LTS_SETUP_URL = 'https://deb.nodesource.com/setup_lts.x';

/** Default install timeout: 10 minutes (NodeSource + apt can be slow on first run). */
const NODE_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

/** Default exec timeout: 60 seconds (covers slow `npm install` invocations). */
const NODE_EXEC_TIMEOUT_MS = 60 * 1000;

/** Major-version specs this provider can install. */
const SUPPORTED_NODE_VERSIONS = ['lts', '20', '22', '23'] as const;

/**
 * Apt packages installed alongside Node. `nodejs` pulls in `npm` and
 * `corepack` as recommends on NodeSource; we list them explicitly so the
 * install is reproducible with `--no-install-recommends`.
 */
const NODE_APT_PACKAGES: readonly string[] = ['nodejs'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a version spec to a NodeSource setup URL.
 *
 *   - `'lts'`              → `setup_lts.x`
 *   - `'20'`, `'22'`, …    → `setup_20.x`, `setup_22.x`, …
 *   - `'22.11.0'`          → `setup_22.x` (major only; exact version pinned via apt)
 *   - `'latest'`           → `setup_lts.x` (alias)
 *
 * @param version - Version spec.
 * @returns NodeSource setup URL.
 */
function nodesourceSetupUrl(version: string): string {
  const v = version.trim().toLowerCase();
  if (v === 'lts' || v === 'latest' || v === '') return NODESOURCE_LTS_SETUP_URL;
  const majorMatch = /^v?(\d+)/.exec(v);
  if (!majorMatch) {
    // Unrecognized spec — fall back to LTS rather than throwing. The install
    // command will surface the actual installed version, so the caller can
    // detect a mismatch.
    logger.warn({ version }, 'unrecognized Node version spec; falling back to LTS');
    return NODESOURCE_LTS_SETUP_URL;
  }
  return NODESOURCE_SETUP_URL_TEMPLATE.replace('<major>', majorMatch[1]);
}

/**
 * Extract the major version from a spec like `'22'`, `'22.11.0'`, `'v22.11.0'`,
 * or `'lts'`. Returns `'lts'` for the LTS alias and empty string for unknown.
 *
 * @param version - Version spec.
 * @returns Major version string, or `'lts'`.
 */
function majorOf(version: string): string {
  const v = version.trim().toLowerCase();
  if (v === 'lts' || v === 'latest' || v === '') return 'lts';
  const m = /^v?(\d+)/.exec(v);
  return m ? m[1] : '';
}

/**
 * Build the bash script that adds the NodeSource apt repository and installs
 * Node.js. Exported so unit tests can assert on its contents.
 *
 * @param setupUrl - NodeSource setup script URL.
 * @param packages - Apt packages to install (typically `['nodejs']`).
 * @param versionPin - If non-empty, the exact version pin for `apt install`
 *   (e.g. `22.11.0-1nodesource1`). When set, the script installs
 *   `nodejs=<versionPin>` instead of `nodejs`.
 * @returns A multi-line bash script string.
 */
export function buildNodeInstallScript(
  setupUrl: string,
  packages: readonly string[],
  versionPin?: string,
): string {
  const pkgSpec = versionPin
    ? packages.map((p) => (p === 'nodejs' ? `nodejs=${versionPin}` : p)).join(' ')
    : packages.join(' ');
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'echo "[linuxify/node] apt update"',
    'apt-get update -qq',
    '',
    'echo "[linuxify/node] adding NodeSource apt repository"',
    `curl -fsSL ${setupUrl} | bash -`,
    '',
    'echo "[linuxify/node] installing nodejs"',
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgSpec}`,
    '',
    'echo "[linuxify/node] verifying install"',
    'echo "LINUXIFY_NODE_VERSION=$(node --version)"',
    'echo "LINUXIFY_NPM_VERSION=$(npm --version)"',
    '',
    'echo "[linuxify/node] cleaning apt cache"',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    '',
    'echo "[linuxify/node] done"',
  ].join('\n');
}

/**
 * Parse `LINUXIFY_NODE_VERSION=v22.11.0` and `LINUXIFY_NPM_VERSION=10.9.0`
 * markers from the install script's stdout.
 *
 * @param stdout - The script's combined stdout.
 * @returns An object with `nodeVersion` and `npmVersion` strings, or empty
 *   strings if the markers were not found.
 */
export function parseNodeInstallOutput(stdout: string): {
  nodeVersion: string;
  npmVersion: string;
} {
  const out = { nodeVersion: '', npmVersion: '' };
  const nodeMatch = /^LINUXIFY_NODE_VERSION=(.+)$/m.exec(stdout);
  const npmMatch = /^LINUXIFY_NPM_VERSION=(.+)$/m.exec(stdout);
  if (nodeMatch?.[1]) out.nodeVersion = nodeMatch[1].trim();
  if (npmMatch?.[1]) out.npmVersion = npmMatch[1].trim();
  return out;
}

// ---------------------------------------------------------------------------
// NodeRuntimeProvider
// ---------------------------------------------------------------------------

/**
 * Node.js runtime provider. See module-level docs for the install layout
 * and version-resolution strategy.
 */
export class NodeRuntimeProvider implements RuntimeProvider {
  readonly name = 'node';
  readonly displayName = 'Node.js';
  readonly defaultVersion = 'lts';
  readonly supportedVersions: readonly string[] = SUPPORTED_NODE_VERSIONS;

  /** Lazily-created default StateStore when none was injected. */
  private storeInternal: StateStore | undefined;

  /**
   * @param distroExec - Function that runs a command inside a distro's
   *   proot session. Injected so tests can stub it; production wiring is
   *   `createDefaultDistroExec()` from `runtimes/index.ts`.
   * @param stateStore - Optional StateStore for state.json access. If
   *   omitted, a default store pointed at `getStatePath()` is created
   *   lazily on first use.
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
    return '/usr/bin/node';
  }

  /** @inheritdoc */
  async isInstalled(version: string, distro: string): Promise<boolean> {
    const installed = await this.list(distro);
    if (installed.length === 0) return false;
    const major = majorOf(version);
    if (major === 'lts' || major === '') return installed.length > 0;
    // Match by major version prefix (e.g. '22' matches 'v22.11.0' and '22.11.0').
    return installed.some((r) => {
      const v = r.version.replace(/^v/, '');
      return v === major || v.startsWith(`${major}.`);
    });
  }

  /** @inheritdoc */
  async install(version: string, distro: string, opts?: InstallOpts): Promise<void> {
    const progress = opts?.onProgress ?? (() => {});
    progress(`checking if Node ${version} is already installed in ${distro}`);

    if (await this.isInstalled(version, distro)) {
      logger.info({ version, distro }, 'node already installed; skipping');
      progress(`Node ${version} already installed in ${distro}`);
      return;
    }

    const setupUrl = nodesourceSetupUrl(version);
    const major = majorOf(version);
    // Pin exact version via apt when the spec contains a full semver.
    const versionPin = /^\d+\.\d+\.\d+/.test(version.trim()) ? version.trim() : undefined;
    const script = buildNodeInstallScript(setupUrl, NODE_APT_PACKAGES, versionPin);

    progress(`adding NodeSource apt repository (major=${major || 'lts'})`);
    logger.info({ version, distro, setupUrl }, 'installing node via NodeSource');

    const result = await this.distroExec(distro, 'bash', ['-c', script], {
      timeoutMs: NODE_INSTALL_TIMEOUT_MS,
      env: { DEBIAN_FRONTEND: 'noninteractive', TERM: 'dumb' },
    });

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Node ${version} install failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'INSTALL_FAILED',
          details: {
            version,
            distro,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-2000),
            stderr: result.stderr.slice(-2000),
          },
          fixCommand: `linuxify runtimes install node ${version} --distro ${distro}`,
        },
      );
    }

    const parsed = parseNodeInstallOutput(result.stdout);
    const resolvedVersion = parsed.nodeVersion.replace(/^v/, '') || version;
    progress(`installed Node ${resolvedVersion} in ${distro}`);

    // Record the install in state.json. If this is the first Node install in
    // this distro, mark it as default.
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
    const installed = await this.list(distro);
    const major = majorOf(version);
    const match = installed.find((r) => {
      const v = r.version.replace(/^v/, '');
      return major === 'lts' || major === ''
        ? true
        : v === major || v.startsWith(`${major}.`);
    });

    if (!match) {
      throw new RuntimeError(`Node ${version} is not installed in ${distro}`, {
        code: 'NOT_INSTALLED',
        details: { version, distro },
      });
    }

    logger.info({ version: match.version, distro }, 'uninstalling node via apt');
    const result = await this.distroExec(
      distro,
      'apt-get',
      ['purge', '-y', 'nodejs'],
      { env: { DEBIAN_FRONTEND: 'noninteractive' }, timeoutMs: NODE_INSTALL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Node uninstall failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'UNINSTALL_FAILED',
          details: { version: match.version, distro, exitCode: result.exitCode, stderr: result.stderr },
        },
      );
    }

    const store = await this.getStore();
    await store.update((state) => {
      removeRuntimeInstall(state, this.name, distro, match.version);
    });
  }

  /** @inheritdoc */
  async list(distro: string): Promise<InstalledRuntime[]> {
    // Query the distro for the actually-installed node version. We use
    // `node --version` rather than `dpkg-query` because the binary may be
    // present via a non-apt path (e.g. a future nvm fallback).
    const result = await this.distroExec(distro, 'node', ['--version'], {
      timeoutMs: NODE_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      logger.debug({ distro, exitCode: result.exitCode }, 'node not installed in distro');
      return [];
    }
    const version = result.stdout.trim().replace(/^v/, '');
    if (!version) return [];

    // Cross-reference with state.json for the installed_at timestamp and
    // is_default flag. If state is missing the entry, return with defaults.
    const store = await this.getStore();
    const state = await store.load();
    const stateEntry = state.installed_runtimes.find(
      (r) => r.name === this.name && r.distro === distro && r.version === version,
    );

    return [
      {
        name: this.name,
        version,
        distro,
        path: this.pathFor(version, distro),
        installedAt: stateEntry?.installed_at ?? '',
        isDefault: stateEntry?.is_default ?? false,
      },
    ];
  }

  /** @inheritdoc */
  async getDefault(distro: string): Promise<string | null> {
    const store = await this.getStore();
    const state = await store.load();
    return getDefaultRuntimeVersion(state, this.name, distro);
  }

  /** @inheritdoc */
  async setDefault(version: string, distro: string): Promise<void> {
    const store = await this.getStore();
    let found = false;
    await store.update((state) => {
      // Match by exact version OR by major-version prefix, so the user can
      // run `linuxify runtimes default node 22` to set the default to the
      // installed 22.x.
      const major = majorOf(version);
      const candidates = findInstalledRuntimes(state, this.name, distro);
      const match = candidates.find((r) => {
        if (r.version === version) return true;
        const v = r.version.replace(/^v/, '');
        return major !== 'lts' && major !== '' && (v === major || v.startsWith(`${major}.`));
      });
      if (match) {
        found = markDefaultRuntime(state, this.name, distro, match.version);
      } else {
        // Try exact-version match as a fallback (covers the case where the
        // caller passed the resolved version like '22.11.0').
        found = markDefaultRuntime(state, this.name, distro, version);
      }
    });
    if (!found) {
      throw new RuntimeError(
        `Node ${version} is not installed in ${distro}; cannot set as default`,
        {
          code: 'NOT_INSTALLED',
          details: { version, distro },
          fixCommand: `linuxify runtimes install node ${version} --distro ${distro}`,
        },
      );
    }
  }

  /** @inheritdoc */
  async exec(
    version: string,
    distro: string,
    cmd: string,
    args: readonly string[],
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    // Resolve cmd to an absolute path inside the distro. All Node binaries
    // (node, npm, npx, corepack) live in /usr/bin under NodeSource.
    const binDir = '/usr/bin';
    const fullCmd = cmd.startsWith('/') ? cmd : `${binDir}/${cmd}`;
    logger.debug({ version, distro, cmd: fullCmd, args }, 'node runtime exec');
    return this.distroExec(distro, fullCmd, args, opts);
  }
}
