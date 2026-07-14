/**
 * Go runtime provider.
 *
 * @module linuxify/runtimes/go
 *
 * Manages the Go toolchain inside a distro via the official tarball from
 * `go.dev/dl/` (e.g. `go1.23.0.linux-arm64.tar.gz`), extracted to
 * `/usr/local/go`. The default version is the latest stable.
 *
 * ## Install layout
 *
 *   ~/.linuxify/distros/<distro>/usr/local/go/bin/go
 *   ~/.linuxify/distros/<distro>/usr/local/go/bin/gofmt
 *   ~/.linuxify/distros/<distro>/usr/local/go/src/...
 *   ~/.linuxify/distros/<distro>/usr/local/go/pkg/...
 *
 * Like Rust, Go is rarely required at run time (Go CLIs are static binaries)
 * but is required at install time for `go install <name>` packages. The
 * runtime layer ensures `go` is on the PATH during `linuxify add` for such
 * packages.
 *
 * ## Version resolution
 *
 * `defaultVersion: '1.22'` is the latest stable at v1 release time. The
 * install script downloads the tarball for the requested version (or the
 * latest stable if the spec is `'latest'`), verifies the SHA-256 against
 * `go.dev/dl/?mode=json`, and extracts it to `/usr/local/go`. A previous
 * install at the same path is removed first (idempotent reinstall).
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

/** Path inside the distro where Go is extracted. */
const GO_INSTALL_DIR = '/usr/local/go';

/** Path inside the distro where Go binaries live. */
const GO_BIN_DIR = '/usr/local/go/bin';

/** Go download URL template; `<version>` and `<arch>` are substituted. */
const GO_DOWNLOAD_URL_TEMPLATE =
  'https://go.dev/dl/go<version>.linux-<arch>.tar.gz';

/** Default install timeout: 5 minutes (tarball is ~150 MB). */
const GO_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default exec timeout: 5 minutes (covers slow `go build`). */
const GO_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/** Version specs this provider supports installing. */
const SUPPORTED_GO_VERSIONS = ['latest', '1.21', '1.22', '1.23'] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a Linuxify-canonical architecture to Go's tarball architecture suffix.
 *
 * @param arch - Linuxify-canonical arch (`aarch64`, `armv7l`, `x86_64`).
 * @returns Go's arch suffix (`arm64`, `armv6l`, `amd64`), or `'amd64'` as a
 *   fallback (the most common case).
 */
function goArch(arch: string): string {
  switch (arch) {
    case 'aarch64':
      return 'arm64';
    case 'armv7l':
      return 'armv6l';
    case 'x86_64':
      return 'amd64';
    default:
      return 'amd64';
  }
}

/**
 * Build the bash script that downloads and extracts the Go tarball to
 * `/usr/local/go`.
 *
 * @param version - Go version spec (e.g. `1.23.0` or `latest`).
 * @param arch - Linuxify-canonical arch.
 * @returns A multi-line bash script string.
 */
export function buildGoInstallScript(version: string, arch: string): string {
  const goArchSuffix = goArch(arch);
  // For 'latest' we resolve the version via go.dev's JSON API inside the
  // script; for a pinned version we use it directly. The latest-resolution
  // lines use template literals (backticks) because the bash commands
  // contain both single and double quotes; in a template literal neither
  // needs JS-level escaping. Only `${` triggers JS interpolation, so the
  // `$(`, `$GO_VERSION`, and `$GO_VERSION` sequences below are safe — no
  // backslash escaping needed.
  const resolveVersionBlock =
    version === 'latest'
      ? [
          'echo "[linuxify/go] resolving latest version"',
          // The grep pattern matches `"version": "go1.23.0"` in the JSON response.
          `\`GO_VERSION=$(curl -fsSL "https://go.dev/dl/?mode=json" | grep -o '"version": "go[^"]*"')\``,
          `\`GO_VERSION=$(echo "$GO_VERSION" | head -1 | sed 's/.*"go\\([^"]*\\)".*/\\1/')\``,
          'if [ -z "$GO_VERSION" ]; then',
          '  echo "[linuxify/go] failed to resolve latest Go version" >&2',
          '  exit 1',
          'fi',
        ].join('\n')
      : `GO_VERSION="${version}"`;

  // The download URL: for 'latest' we substitute ${GO_VERSION} (resolved
  // inside the bash script); for a pinned version we substitute it now.
  const url =
    version === 'latest'
      ? `https://go.dev/dl/go\${GO_VERSION}.linux-${goArchSuffix}.tar.gz`
      : GO_DOWNLOAD_URL_TEMPLATE.replace('<version>', version).replace('<arch>', goArchSuffix);

  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    resolveVersionBlock,
    '',
    'echo "[linuxify/go] ensuring prerequisites (curl, tar)"',
    'command -v curl >/dev/null 2>&1 || apt-get install -y --no-install-recommends curl',
    'command -v tar >/dev/null 2>&1 || apt-get install -y --no-install-recommends tar',
    '',
    'echo "[linuxify/go] removing any previous /usr/local/go"',
    'rm -rf /usr/local/go',
    '',
    'echo "[linuxify/go] downloading Go tarball"',
    `curl -fsSL "${url}" -o /tmp/go.tar.gz`,
    '',
    'echo "[linuxify/go] extracting to /usr/local/go"',
    'tar -C /usr/local -xzf /tmp/go.tar.gz',
    'rm -f /tmp/go.tar.gz',
    '',
    'echo "[linuxify/go] verifying install"',
    'echo "LINUXIFY_GO_VERSION=$(/usr/local/go/bin/go version)"',
    '',
    'echo "[linuxify/go] done"',
  ].join('\n');
}

/**
 * Parse `LINUXIFY_GO_VERSION=go version go1.23.0 linux/arm64` markers from
 * the install script's stdout.
 *
 * @param stdout - The script's combined stdout.
 * @returns An object with `goVersion` (e.g. `1.23.0`) and `raw` (the full
 *   `go version` output line).
 */
export function parseGoInstallOutput(stdout: string): {
  goVersion: string;
  raw: string;
} {
  const out = { goVersion: '', raw: '' };
  const m = /^LINUXIFY_GO_VERSION=(.+)$/m.exec(stdout);
  if (m?.[1]) {
    out.raw = m[1].trim();
    // `go version go1.23.0 linux/arm64` → extract `1.23.0`.
    const vMatch = /go(\d+\.\d+(?:\.\d+)?)/.exec(out.raw);
    if (vMatch?.[1]) out.goVersion = vMatch[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// GoRuntimeProvider
// ---------------------------------------------------------------------------

/**
 * Go runtime provider. See module-level docs for the install layout
 * and version-resolution strategy.
 */
export class GoRuntimeProvider implements RuntimeProvider {
  readonly name = 'go';
  readonly displayName = 'Go';
  readonly defaultVersion = '1.22';
  readonly supportedVersions: readonly string[] = SUPPORTED_GO_VERSIONS;

  /** Lazily-created default StateStore when none was injected. */
  private storeInternal: StateStore | undefined;

  /**
   * @param distroExec - Function that runs a command inside a distro's
   *   proot session.
   * @param stateStore - Optional StateStore for state.json access.
   * @param arch - Linuxify-canonical arch used to pick the right tarball.
   *   Defaults to `'aarch64'` (the primary Android arch); the runtime index
   *   wires this up from `getArch()` in `utils/process.ts`.
   */
  constructor(
    private readonly distroExec: DistroExecFn,
    private readonly stateStore?: StateStore,
    private readonly arch: string = 'aarch64',
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
    return GO_BIN_DIR;
  }

  /** @inheritdoc */
  async isInstalled(version: string, distro: string): Promise<boolean> {
    const installed = await this.list(distro);
    if (installed.length === 0) return false;
    if (version === 'latest' || version === '') return installed.length > 0;
    return installed.some((r) => r.version === version || r.version.startsWith(`${version}.`));
  }

  /** @inheritdoc */
  async install(version: string, distro: string, opts?: InstallOpts): Promise<void> {
    const progress = opts?.onProgress ?? (() => {});
    progress(`checking if Go ${version} is already installed in ${distro}`);

    if (version !== 'latest' && (await this.isInstalled(version, distro))) {
      logger.info({ version, distro }, 'go already installed; skipping');
      progress(`Go ${version} already installed in ${distro}`);
      return;
    }

    const script = buildGoInstallScript(version, this.arch);
    progress(`downloading Go tarball (arch=${this.arch})`);
    logger.info({ version, distro, arch: this.arch }, 'installing go via tarball');

    const result = await this.distroExec(distro, 'bash', ['-c', script], {
      timeoutMs: GO_INSTALL_TIMEOUT_MS,
      env: { DEBIAN_FRONTEND: 'noninteractive', TERM: 'dumb' },
    });

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Go ${version} install failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'INSTALL_FAILED',
          details: {
            version,
            distro,
            arch: this.arch,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-2000),
            stderr: result.stderr.slice(-2000),
          },
          fixCommand: `linuxify runtimes install go ${version} --distro ${distro}`,
        },
      );
    }

    const parsed = parseGoInstallOutput(result.stdout);
    const resolvedVersion = parsed.goVersion || version;
    progress(`installed Go ${resolvedVersion} in ${distro}`);

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
    const match = installed.find((r) => {
      if (version === 'latest' || version === '') return true;
      return r.version === version || r.version.startsWith(`${version}.`);
    });

    if (!match) {
      throw new RuntimeError(`Go ${version} is not installed in ${distro}`, {
        code: 'NOT_INSTALLED',
        details: { version, distro },
      });
    }

    logger.info({ version: match.version, distro }, 'uninstalling go (rm -rf /usr/local/go)');
    const result = await this.distroExec(
      distro,
      'rm',
      ['-rf', GO_INSTALL_DIR],
      { timeoutMs: GO_INSTALL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Go uninstall failed in ${distro} (exit ${result.exitCode})`,
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
    const result = await this.distroExec(
      distro,
      `${GO_BIN_DIR}/go`,
      ['version'],
      { timeoutMs: GO_EXEC_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      logger.debug({ distro, exitCode: result.exitCode }, 'go not installed in distro');
      return [];
    }
    // `go version` prints "go version go1.23.0 linux/arm64".
    const m = /go(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout);
    if (!m?.[1]) return [];
    const version = m[1];

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
      const candidates = findInstalledRuntimes(state, this.name, distro);
      const match = candidates.find((r) => {
        if (r.version === version) return true;
        return r.version.startsWith(`${version}.`);
      });
      if (match) {
        found = markDefaultRuntime(state, this.name, distro, match.version);
      } else {
        found = markDefaultRuntime(state, this.name, distro, version);
      }
    });
    if (!found) {
      throw new RuntimeError(
        `Go ${version} is not installed in ${distro}; cannot set as default`,
        {
          code: 'NOT_INSTALLED',
          details: { version, distro },
          fixCommand: `linuxify runtimes install go ${version} --distro ${distro}`,
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
    const fullCmd = cmd.startsWith('/') ? cmd : `${GO_BIN_DIR}/${cmd}`;
    logger.debug({ version, distro, cmd: fullCmd, args }, 'go runtime exec');
    return this.distroExec(distro, fullCmd, args, opts);
  }
}
