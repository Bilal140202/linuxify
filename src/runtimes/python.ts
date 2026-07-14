/**
 * Python runtime provider.
 *
 * @module linuxify/runtimes/python
 *
 * Manages Python 3 installations inside a distro via the distro's apt. The
 * default version is whatever the distro ships (Python 3.12 on Ubuntu 24.04,
 * Python 3.11 on Debian 12); version specs in package YAMLs are interpreted
 * as minimum-version constraints satisfied by the system Python.
 *
 * For users who need a specific Python version not available via apt (e.g.
 * Python 3.13 on Ubuntu 24.04), a future revision will support `--via
 * pyenv` (pyenv builds from source, ~10 min on a mid-range phone). v1 wires
 * up the apt path only.
 *
 * ## Install layout
 *
 * Apt installs `python3`, `python3-pip`, `python3-venv`, and `python3-dev`
 * into `/usr/bin/` inside the distro rootfs:
 *
 *   ~/.linuxify/distros/<distro>/usr/bin/python3
 *   ~/.linuxify/distros/<distro>/usr/bin/pip3
 *
 * There is no side-by-side versioning in v1 — the apt install replaces the
 * previous system Python. Per-package virtualenvs (created by the package
 * installer at `~/.linuxify/packages/<active>/<name>/venv/`) provide
 * dependency isolation; the system Python is shared across all Python
 * packages in the same distro.
 *
 * ## Default version
 *
 * `defaultVersion: '3.12'` is the Ubuntu 24.04 default. On Debian 12 the
 * system Python is 3.11, so the resolved version (from `python3 --version`)
 * may differ from the spec; the state.json record captures the actual
 * installed version.
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

/** Default install timeout: 5 minutes (apt is fast). */
const PYTHON_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default exec timeout: 60 seconds. */
const PYTHON_EXEC_TIMEOUT_MS = 60 * 1000;

/** Major.minor specs this provider supports installing via apt. */
const SUPPORTED_PYTHON_VERSIONS = ['3.10', '3.11', '3.12', '3.13'] as const;

/**
 * Apt packages installed for Python. `python3-pip` provides `pip3`,
 * `python3-venv` provides `python3 -m venv`, and `python3-dev` provides the
 * headers needed to build C extensions (required by some packages like
 * `psycopg2`, `lxml`, `Pillow`).
 */
const PYTHON_APT_PACKAGES: readonly string[] = [
  'python3',
  'python3-pip',
  'python3-venv',
  'python3-dev',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the major.minor version from a spec like `'3.12'`, `'3.12.3'`,
 * or `''`. Returns `'3.12'`-style or empty string for unrecognized.
 *
 * @param version - Version spec.
 * @returns Major.minor string, or `''` if the spec does not look like a Python version.
 */
function majorMinorOf(version: string): string {
  const v = version.trim();
  if (!v) return '';
  const m = /^(\d+\.\d+)/.exec(v);
  return m ? m[1] : '';
}

/**
 * Build the bash script that installs Python 3 via apt. Exported so unit
 * tests can assert on its contents.
 *
 * @param packages - Apt packages to install.
 * @returns A multi-line bash script string.
 */
export function buildPythonInstallScript(packages: readonly string[]): string {
  return [
    'set -e',
    'export DEBIAN_FRONTEND=noninteractive',
    'echo "[linuxify/python] apt update"',
    'apt-get update -qq',
    '',
    `echo "[linuxify/python] installing ${packages.join(' ')}"`,
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages.join(' ')}`,
    '',
    'echo "[linuxify/python] verifying install"',
    'echo "LINUXIFY_PYTHON_VERSION=$(python3 --version)"',
    'echo "LINUXIFY_PIP_VERSION=$(pip3 --version)"',
    '',
    'echo "[linuxify/python] cleaning apt cache"',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    '',
    'echo "[linuxify/python] done"',
  ].join('\n');
}

/**
 * Parse `LINUXIFY_PYTHON_VERSION=Python 3.12.3` markers from the install
 * script's stdout.
 *
 * @param stdout - The script's combined stdout.
 * @returns An object with `pythonVersion` and `pipVersion` strings.
 */
export function parsePythonInstallOutput(stdout: string): {
  pythonVersion: string;
  pipVersion: string;
} {
  const out = { pythonVersion: '', pipVersion: '' };
  const pyMatch = /^LINUXIFY_PYTHON_VERSION=(.+)$/m.exec(stdout);
  const pipMatch = /^LINUXIFY_PIP_VERSION=(.+)$/m.exec(stdout);
  if (pyMatch?.[1]) {
    // `python3 --version` prints "Python 3.12.3"; strip the leading "Python ".
    out.pythonVersion = pyMatch[1].replace(/^Python\s+/i, '').trim();
  }
  if (pipMatch?.[1]) {
    // `pip3 --version` prints "pip 24.0 from ... (python 3.12)"; take the first token.
    out.pipVersion = pipMatch[1].replace(/^pip\s+/i, '').split(/\s+/)[0] ?? '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// PythonRuntimeProvider
// ---------------------------------------------------------------------------

/**
 * Python runtime provider. See module-level docs for the install layout
 * and version-resolution strategy.
 */
export class PythonRuntimeProvider implements RuntimeProvider {
  readonly name = 'python';
  readonly displayName = 'Python';
  readonly defaultVersion = '3.12';
  readonly supportedVersions: readonly string[] = SUPPORTED_PYTHON_VERSIONS;

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
    return '/usr/bin/python3';
  }

  /** @inheritdoc */
  async isInstalled(version: string, distro: string): Promise<boolean> {
    const installed = await this.list(distro);
    if (installed.length === 0) return false;
    const mm = majorMinorOf(version);
    if (!mm) return installed.length > 0;
    return installed.some((r) => r.version === mm || r.version.startsWith(`${mm}.`));
  }

  /** @inheritdoc */
  async install(version: string, distro: string, opts?: InstallOpts): Promise<void> {
    const progress = opts?.onProgress ?? (() => {});
    progress(`checking if Python ${version} is already installed in ${distro}`);

    if (await this.isInstalled(version, distro)) {
      logger.info({ version, distro }, 'python already installed; skipping');
      progress(`Python ${version} already installed in ${distro}`);
      return;
    }

    const script = buildPythonInstallScript(PYTHON_APT_PACKAGES);
    progress(`installing python3 + pip + venv + dev via apt`);
    logger.info({ version, distro }, 'installing python via apt');

    const result = await this.distroExec(distro, 'bash', ['-c', script], {
      timeoutMs: PYTHON_INSTALL_TIMEOUT_MS,
      env: { DEBIAN_FRONTEND: 'noninteractive', TERM: 'dumb' },
    });

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Python ${version} install failed in ${distro} (exit ${result.exitCode})`,
        {
          code: 'INSTALL_FAILED',
          details: {
            version,
            distro,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-2000),
            stderr: result.stderr.slice(-2000),
          },
          fixCommand: `linuxify runtimes install python ${version} --distro ${distro}`,
        },
      );
    }

    const parsed = parsePythonInstallOutput(result.stdout);
    const resolvedVersion = parsed.pythonVersion || version;
    progress(`installed Python ${resolvedVersion} in ${distro}`);

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
    const mm = majorMinorOf(version);
    const match = installed.find((r) => {
      if (!mm) return true;
      return r.version === mm || r.version.startsWith(`${mm}.`);
    });

    if (!match) {
      throw new RuntimeError(`Python ${version} is not installed in ${distro}`, {
        code: 'NOT_INSTALLED',
        details: { version, distro },
      });
    }

    logger.info({ version: match.version, distro }, 'uninstalling python via apt');
    const result = await this.distroExec(
      distro,
      'apt-get',
      ['purge', '-y', 'python3', 'python3-pip', 'python3-venv', 'python3-dev'],
      { env: { DEBIAN_FRONTEND: 'noninteractive' }, timeoutMs: PYTHON_INSTALL_TIMEOUT_MS },
    );

    if (result.exitCode !== 0) {
      throw new RuntimeError(
        `Python uninstall failed in ${distro} (exit ${result.exitCode})`,
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
    const result = await this.distroExec(distro, 'python3', ['--version'], {
      timeoutMs: PYTHON_EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      logger.debug({ distro, exitCode: result.exitCode }, 'python3 not installed in distro');
      return [];
    }
    // `python3 --version` prints "Python 3.12.3" to stdout (3.4+) or stderr (3.3-).
    const raw = (result.stdout + ' ' + result.stderr).trim();
    const m = /Python\s+(\d+\.\d+(?:\.\d+)?)/.exec(raw);
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
      const mm = majorMinorOf(version);
      const candidates = findInstalledRuntimes(state, this.name, distro);
      const match = candidates.find((r) => {
        if (r.version === version) return true;
        if (!mm) return false;
        return r.version === mm || r.version.startsWith(`${mm}.`);
      });
      if (match) {
        found = markDefaultRuntime(state, this.name, distro, match.version);
      } else {
        found = markDefaultRuntime(state, this.name, distro, version);
      }
    });
    if (!found) {
      throw new RuntimeError(
        `Python ${version} is not installed in ${distro}; cannot set as default`,
        {
          code: 'NOT_INSTALLED',
          details: { version, distro },
          fixCommand: `linuxify runtimes install python ${version} --distro ${distro}`,
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
    // All Python binaries (python3, pip3) live in /usr/bin on Debian/Ubuntu.
    const binDir = '/usr/bin';
    const fullCmd = cmd.startsWith('/') ? cmd : `${binDir}/${cmd}`;
    logger.debug({ version, distro, cmd: fullCmd, args }, 'python runtime exec');
    return this.distroExec(distro, fullCmd, args, opts);
  }
}
