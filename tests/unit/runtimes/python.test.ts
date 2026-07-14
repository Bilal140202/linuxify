/**
 * Unit tests for `src/runtimes/python.ts` — the PythonRuntimeProvider.
 *
 * Covers:
 *   - Metadata: name, displayName, defaultVersion, supportedVersions, pathFor.
 *   - install(): invokes distroExec with a bash script containing apt install
 *     of python3 + pip + venv + dev; records the install in state.json.
 *   - install() is idempotent (skips when already installed).
 *   - install() throws RuntimeError(E_RUNTIME_INSTALL_FAILED) on apt failure.
 *   - exec(): invokes distroExec with the absolute path /usr/bin/<cmd>.
 *   - list(): parses `python3 --version` output and cross-references state.
 *   - isInstalled(): true after install, false when not present.
 *   - setDefault(): updates state; throws when not installed.
 *   - getDefault(): reads from state.
 *   - uninstall(): invokes apt-get purge and removes the state entry.
 *   - Script builder: buildPythonInstallScript and parsePythonInstallOutput.
 *
 * The `distroExec` function is mocked with a recorder that returns canned
 * responses; no real proot is invoked. The StateStore uses a tmpdir.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger to keep test output clean.
vi.mock('../../../src/utils/log.js', () => {
  const noop = (): void => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return { logger };
});

import type { DistroExecFn, ExecResult } from '../../../src/runtimes/provider.js';
import {
  PythonRuntimeProvider,
  buildPythonInstallScript,
  parsePythonInstallOutput,
} from '../../../src/runtimes/python.js';
import { StateStore } from '../../../src/state/store.js';
import { RuntimeError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface RecordedCall {
  distro: string;
  cmd: string;
  args: readonly string[];
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number };
}

/** Default Python install script output (markers). */
const PYTHON_INSTALL_OUTPUT = `LINUXIFY_PYTHON_VERSION=Python 3.12.3
LINUXIFY_PIP_VERSION=pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)`;

/** Default `python3 --version` output. */
const PYTHON_BIN_VERSION_OUTPUT = 'Python 3.12.3';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtimes/python — PythonRuntimeProvider', () => {
  let tmpDir: string;
  let statePath: string;
  let store: StateStore;
  let originalLinuxifyHome: string | undefined;
  let records: RecordedCall[];
  let responses: Map<string, ExecResult>;
  let provider: PythonRuntimeProvider;

  beforeEach(() => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    tmpDir = mkdtempSync(join(tmpdir(), 'linuxify-py-test-'));
    process.env.LINUXIFY_HOME = tmpDir;
    statePath = join(tmpDir, 'state.json');
    store = new StateStore(statePath);

    records = [];
    responses = new Map<string, ExecResult>();
    provider = new PythonRuntimeProvider(
      async (distro, cmd, args, opts) => {
        records.push({ distro, cmd, args, opts });
        const key = `${cmd}:${args[0] ?? ''}`;
        const resp =
          responses.get(key) ?? responses.get('*') ?? { stdout: '', stderr: '', exitCode: 0 };
        return { stdout: resp.stdout, stderr: resp.stderr, exitCode: resp.exitCode };
      },
      store,
    );
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) delete process.env.LINUXIFY_HOME;
    else process.env.LINUXIFY_HOME = originalLinuxifyHome;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Metadata
  // -------------------------------------------------------------------------

  describe('metadata', () => {
    it('exposes name, displayName, defaultVersion, supportedVersions', () => {
      expect(provider.name).toBe('python');
      expect(provider.displayName).toBe('Python');
      expect(provider.defaultVersion).toBe('3.12');
      expect(provider.supportedVersions).toContain('3.10');
      expect(provider.supportedVersions).toContain('3.12');
      expect(provider.supportedVersions).toContain('3.13');
    });

    it('pathFor returns /usr/bin/python3 regardless of version', () => {
      expect(provider.pathFor('3.12', 'ubuntu')).toBe('/usr/bin/python3');
      expect(provider.pathFor('3.11', 'debian')).toBe('/usr/bin/python3');
    });
  });

  // -------------------------------------------------------------------------
  // install()
  // -------------------------------------------------------------------------

  describe('install()', () => {
    it('invokes distroExec with a bash script containing apt install python3 + pip + venv + dev', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: PYTHON_INSTALL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('3.12', 'ubuntu');

      // Two distroExec calls: (1) the `python3 --version` probe, (2) the bash script.
      const bashCall = records.find((r) => r.cmd === 'bash');
      expect(bashCall).toBeDefined();
      expect(bashCall!.distro).toBe('ubuntu');
      expect(bashCall!.args[0]).toBe('-c');
      const script = bashCall!.args[1] as string;
      expect(script).toContain('apt-get install -y --no-install-recommends python3 python3-pip python3-venv python3-dev');
      expect(script).toContain('LINUXIFY_PYTHON_VERSION=$(python3 --version)');
    });

    it('passes the DEBIAN_FRONTEND and TERM env vars', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: PYTHON_INSTALL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('3.12', 'ubuntu');

      const bashCall = records.find((r) => r.cmd === 'bash')!;
      const opts = bashCall.opts;
      expect(opts?.env?.DEBIAN_FRONTEND).toBe('noninteractive');
      expect(opts?.env?.TERM).toBe('dumb');
    });

    it('records the install in state.json with the resolved version', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: PYTHON_INSTALL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('3.12', 'ubuntu');

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(1);
      const entry = state.installed_runtimes[0]!;
      expect(entry.name).toBe('python');
      expect(entry.version).toBe('3.12.3'); // resolved from `python3 --version`
      expect(entry.distro).toBe('ubuntu');
      expect(entry.path).toBe('/usr/bin/python3');
      expect(entry.is_default).toBe(true); // first install is the default
      expect(entry.installed_at).toBeTruthy();
    });

    it('is idempotent (skips when already installed)', async () => {
      let probeCount = 0;
      const hybrid: DistroExecFn = async (distro, cmd, args, opts) => {
        records.push({ distro, cmd, args, opts });
        if (cmd === 'python3' && args[0] === '--version') {
          probeCount++;
          if (probeCount === 1) {
            return { stdout: '', stderr: 'not found', exitCode: 127 };
          }
          return { stdout: PYTHON_BIN_VERSION_OUTPUT, stderr: '', exitCode: 0 };
        }
        return { stdout: PYTHON_INSTALL_OUTPUT, stderr: '', exitCode: 0 };
      };
      const p = new PythonRuntimeProvider(hybrid, store);

      await p.install('3.12', 'ubuntu');
      await p.install('3.12', 'ubuntu');

      // The bash install script runs only once; the probe runs twice.
      const bashCalls = records.filter((r) => r.cmd === 'bash').length;
      expect(bashCalls).toBe(1);
      const probeCalls = records.filter(
        (r) => r.cmd === 'python3' && r.args[0] === '--version',
      ).length;
      expect(probeCalls).toBe(2);
    });

    it('throws RuntimeError(E_RUNTIME_INSTALL_FAILED) when the script exits non-zero', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: '',
        stderr: 'E: Unable to locate package python3',
        exitCode: 100,
      });

      await expect(provider.install('3.12', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.install('3.12', 'ubuntu');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_INSTALL_FAILED');
        expect(err.details).toMatchObject({
          distro: 'ubuntu',
          exitCode: 100,
        });
      }
    });

    it('marks the second install of the same runtime name as non-default', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.11.2',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });

      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: PYTHON_INSTALL_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('3.12', 'ubuntu');

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(2);
      const newEntry = state.installed_runtimes.find((r) => r.version === '3.12.3')!;
      expect(newEntry.is_default).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // exec()
  // -------------------------------------------------------------------------

  describe('exec()', () => {
    it('invokes distroExec with /usr/bin/<cmd> as the binary', async () => {
      responses.set('*', { stdout: 'Python 3.12.3', stderr: '', exitCode: 0 });

      const result = await provider.exec('3.12', 'ubuntu', 'python3', ['--version']);

      expect(records).toHaveLength(1);
      expect(records[0]!.cmd).toBe('/usr/bin/python3');
      expect(records[0]!.args).toEqual(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('Python 3.12.3');
    });

    it('resolves pip3 to /usr/bin/pip3', async () => {
      responses.set('*', { stdout: 'pip 24.0', stderr: '', exitCode: 0 });

      await provider.exec('3.12', 'ubuntu', 'pip3', ['--version']);

      expect(records[0]!.cmd).toBe('/usr/bin/pip3');
    });

    it('passes through an absolute cmd path unchanged', async () => {
      responses.set('*', { stdout: '', stderr: '', exitCode: 0 });

      await provider.exec('3.12', 'ubuntu', '/custom/python3', ['-c', 'print(1)']);

      expect(records[0]!.cmd).toBe('/custom/python3');
    });

    it('forwards opts (env, timeoutMs) to distroExec', async () => {
      responses.set('*', { stdout: '', stderr: '', exitCode: 0 });

      await provider.exec('3.12', 'ubuntu', 'python3', ['-c', 'print(1)'], {
        env: { MY_VAR: 'value' },
        timeoutMs: 5000,
      });

      expect(records[0]!.opts?.env?.MY_VAR).toBe('value');
      expect(records[0]!.opts?.timeoutMs).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // list() / isInstalled()
  // -------------------------------------------------------------------------

  describe('list()', () => {
    it('returns a single entry when python3 --version succeeds', async () => {
      responses.set('python3:--version', {
        stdout: 'Python 3.12.3',
        stderr: '',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');

      expect(installed).toHaveLength(1);
      expect(installed[0]!.name).toBe('python');
      expect(installed[0]!.version).toBe('3.12.3');
      expect(installed[0]!.path).toBe('/usr/bin/python3');
    });

    it('parses the version from stderr when python3 --version writes there (Python 3.3-)', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'Python 3.12.3',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');
      expect(installed).toHaveLength(1);
      expect(installed[0]!.version).toBe('3.12.3');
    });

    it('returns an empty array when python3 --version fails', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
      });

      const installed = await provider.list('ubuntu');
      expect(installed).toEqual([]);
    });

    it('cross-references state.json for installed_at and is_default', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.12.3',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });

      responses.set('python3:--version', {
        stdout: 'Python 3.12.3',
        stderr: '',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');
      expect(installed[0]!.installedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(installed[0]!.isDefault).toBe(true);
    });
  });

  describe('isInstalled()', () => {
    it('returns false when no python3 is installed', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      expect(await provider.isInstalled('3.12', 'ubuntu')).toBe(false);
    });

    it('returns true when a matching major.minor version is installed', async () => {
      responses.set('python3:--version', {
        stdout: 'Python 3.12.3',
        stderr: '',
        exitCode: 0,
      });
      expect(await provider.isInstalled('3.12', 'ubuntu')).toBe(true);
    });

    it('returns false when a different major.minor is installed', async () => {
      responses.set('python3:--version', {
        stdout: 'Python 3.11.2',
        stderr: '',
        exitCode: 0,
      });
      expect(await provider.isInstalled('3.12', 'ubuntu')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getDefault() / setDefault()
  // -------------------------------------------------------------------------

  describe('getDefault()', () => {
    it('returns null when no default is set', async () => {
      expect(await provider.getDefault('ubuntu')).toBeNull();
    });

    it('returns the default version from state.json', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.12.3',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      expect(await provider.getDefault('ubuntu')).toBe('3.12.3');
    });
  });

  describe('setDefault()', () => {
    beforeEach(async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.12.3',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: false,
        });
        state.installed_runtimes.push({
          name: 'python',
          version: '3.11.2',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-02T00:00:00.000Z',
          is_default: true,
        });
      });
    });

    it('sets is_default=true on the matching version and clears the previous default', async () => {
      await provider.setDefault('3.12.3', 'ubuntu');

      const state = await store.load();
      const v312 = state.installed_runtimes.find((r) => r.version === '3.12.3')!;
      const v311 = state.installed_runtimes.find((r) => r.version === '3.11.2')!;
      expect(v312.is_default).toBe(true);
      expect(v311.is_default).toBe(false);
    });

    it('accepts a major.minor spec and resolves it to the installed full version', async () => {
      await provider.setDefault('3.12', 'ubuntu');

      const state = await store.load();
      const v312 = state.installed_runtimes.find((r) => r.version === '3.12.3')!;
      expect(v312.is_default).toBe(true);
    });

    it('throws RuntimeError(E_RUNTIME_NOT_INSTALLED) when the version is not installed', async () => {
      await expect(provider.setDefault('2.7', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.setDefault('2.7', 'ubuntu');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_NOT_INSTALLED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // uninstall()
  // -------------------------------------------------------------------------

  describe('uninstall()', () => {
    it('invokes apt-get purge and removes the state entry', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.12.3',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      responses.set('python3:--version', {
        stdout: 'Python 3.12.3',
        stderr: '',
        exitCode: 0,
      });
      responses.set('apt-get:purge', { stdout: '', stderr: '', exitCode: 0 });

      await provider.uninstall('3.12', 'ubuntu');

      const purgeCall = records.find((r) => r.cmd === 'apt-get');
      expect(purgeCall).toBeDefined();
      expect(purgeCall!.args).toEqual([
        'purge',
        '-y',
        'python3',
        'python3-pip',
        'python3-venv',
        'python3-dev',
      ]);

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(0);
    });

    it('throws RuntimeError(E_RUNTIME_NOT_INSTALLED) when the version is not present', async () => {
      responses.set('python3:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      await expect(provider.uninstall('3.12', 'ubuntu')).rejects.toThrow(RuntimeError);
    });

    it('throws RuntimeError(E_RUNTIME_UNINSTALL_FAILED) when apt purge fails', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'python',
          version: '3.12.3',
          distro: 'ubuntu',
          path: '/usr/bin/python3',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      responses.set('python3:--version', {
        stdout: 'Python 3.12.3',
        stderr: '',
        exitCode: 0,
      });
      responses.set('apt-get:purge', {
        stdout: '',
        stderr: 'E: Could not open lock file',
        exitCode: 100,
      });

      await expect(provider.uninstall('3.12', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.uninstall('3.12', 'ubuntu');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_UNINSTALL_FAILED');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// buildPythonInstallScript / parsePythonInstallOutput (pure-function tests)
// ---------------------------------------------------------------------------

describe('runtimes/python — buildPythonInstallScript', () => {
  it('includes apt-get install with the listed packages', () => {
    const script = buildPythonInstallScript(['python3', 'python3-pip', 'python3-venv', 'python3-dev']);
    expect(script).toContain(
      'apt-get install -y --no-install-recommends python3 python3-pip python3-venv python3-dev',
    );
  });

  it('emits LINUXIFY_PYTHON_VERSION marker', () => {
    const script = buildPythonInstallScript(['python3']);
    expect(script).toContain('LINUXIFY_PYTHON_VERSION=$(python3 --version)');
    expect(script).toContain('LINUXIFY_PIP_VERSION=$(pip3 --version)');
  });

  it('cleans the apt cache', () => {
    const script = buildPythonInstallScript(['python3']);
    expect(script).toContain('apt-get clean');
    expect(script).toContain('rm -rf /var/lib/apt/lists/*');
  });
});

describe('runtimes/python — parsePythonInstallOutput', () => {
  it('extracts python and pip versions from the install output', () => {
    const out = parsePythonInstallOutput(
      'LINUXIFY_PYTHON_VERSION=Python 3.12.3\nLINUXIFY_PIP_VERSION=pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.12)',
    );
    expect(out.pythonVersion).toBe('3.12.3');
    expect(out.pipVersion).toBe('24.0');
  });

  it('returns empty strings when markers are missing', () => {
    const out = parsePythonInstallOutput('some unrelated output');
    expect(out.pythonVersion).toBe('');
    expect(out.pipVersion).toBe('');
  });
});
