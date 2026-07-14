/**
 * Unit tests for `src/runtimes/node.ts` — the NodeRuntimeProvider.
 *
 * Covers:
 *   - Metadata: name, displayName, defaultVersion, supportedVersions, pathFor.
 *   - install(): invokes distroExec with a bash script containing the
 *     NodeSource setup URL + apt install; records the install in state.json.
 *   - install() is idempotent (skips when already installed).
 *   - install() throws RuntimeError(E_RUNTIME_INSTALL_FAILED) on apt failure.
 *   - exec(): invokes distroExec with the absolute path /usr/bin/<cmd>.
 *   - list(): parses `node --version` output and cross-references state.
 *   - isInstalled(): true after install, false when not present.
 *   - setDefault(): updates state; throws when not installed.
 *   - getDefault(): reads from state.
 *   - uninstall(): invokes apt-get purge and removes the state entry.
 *   - Script builder: buildNodeInstallScript and parseNodeInstallOutput.
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

import {
  NodeRuntimeProvider,
  buildNodeInstallScript,
  parseNodeInstallOutput,
} from '../../../src/runtimes/node.js';
import type { DistroExecFn, ExecResult } from '../../../src/runtimes/provider.js';
import { StateStore } from '../../../src/state/store.js';
import { RuntimeError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A recorded distroExec call. Captures the distro, cmd, args, and opts so
 * tests can assert on what the provider asked the distro to run.
 */
interface RecordedCall {
  distro: string;
  cmd: string;
  args: readonly string[];
  opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number };
}

/**
 * Build a mock DistroExecFn that records every call and returns the canned
 * response keyed by the (cmd, args[0]) pair. If no canned response matches,
 * returns a default success with empty output.
 *
 * @param records - The array to append each call to (mutated).
 * @param responses - A map from `<cmd>:<first-arg>` to canned ExecResult.
 *   The special key `'*'` is the default fallback.
 */
function makeMockDistroExec(
  records: RecordedCall[],
  responses: Map<string, ExecResult>,
): DistroExecFn & { calls: RecordedCall[] } {
  const fn = (async (distro: string, cmd: string, args: readonly string[], opts?: Parameters<DistroExecFn>[3]) => {
    const call: RecordedCall = { distro, cmd, args, opts };
    records.push(call);
    const key = `${cmd}:${args[0] ?? ''}`;
    const resp = responses.get(key) ?? responses.get('*') ?? { stdout: '', stderr: '', exitCode: 0 };
    // Return a fresh copy so callers can't mutate the canned response.
    return { stdout: resp.stdout, stderr: resp.stderr, exitCode: resp.exitCode };
  }) as DistroExecFn & { calls: RecordedCall[] };
  fn.calls = records;
  return fn;
}

/** Default Node version output for a successful install. */
const NODE_VERSION_OUTPUT = `LINUXIFY_NODE_VERSION=v22.11.0
LINUXIFY_NPM_VERSION=10.9.0`;

/** Default `node --version` output. */
const NODE_BIN_VERSION_OUTPUT = 'v22.11.0';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runtimes/node — NodeRuntimeProvider', () => {
  let tmpDir: string;
  let statePath: string;
  let store: StateStore;
  let originalLinuxifyHome: string | undefined;
  let records: RecordedCall[];
  let responses: Map<string, ExecResult>;
  let distroExec: DistroExecFn & { calls: RecordedCall[] };
  let provider: NodeRuntimeProvider;

  beforeEach(() => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    // Use a fresh tmpdir per test so state.json is clean.
    tmpDir = mkdtempSync(join(tmpdir(), 'linuxify-node-test-'));
    process.env.LINUXIFY_HOME = tmpDir;
    statePath = join(tmpDir, 'state.json');
    store = new StateStore(statePath);

    records = [];
    responses = new Map<string, ExecResult>();
    distroExec = makeMockDistroExec(records, responses);
    provider = new NodeRuntimeProvider(distroExec, store);
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
      expect(provider.name).toBe('node');
      expect(provider.displayName).toBe('Node.js');
      expect(provider.defaultVersion).toBe('lts');
      expect(provider.supportedVersions).toContain('lts');
      expect(provider.supportedVersions).toContain('22');
    });

    it('pathFor returns /usr/bin/node regardless of version', () => {
      expect(provider.pathFor('22', 'ubuntu')).toBe('/usr/bin/node');
      expect(provider.pathFor('lts', 'debian')).toBe('/usr/bin/node');
    });
  });

  // -------------------------------------------------------------------------
  // install()
  // -------------------------------------------------------------------------

  describe('install()', () => {
    it('invokes distroExec with a bash script containing NodeSource setup + apt install', async () => {
      // The probe (`node --version`) returns "not installed" so install proceeds.
      responses.set('node:--version', {
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('lts', 'ubuntu');

      // Two distroExec calls: (1) the `node --version` probe, (2) the bash script.
      const bashCall = records.find((r) => r.cmd === 'bash');
      expect(bashCall).toBeDefined();
      expect(bashCall!.distro).toBe('ubuntu');
      expect(bashCall!.args[0]).toBe('-c');
      const script = bashCall!.args[1] as string;
      expect(script).toContain('deb.nodesource.com/setup_lts.x');
      expect(script).toContain('apt-get install -y --no-install-recommends nodejs');
      expect(script).toContain('LINUXIFY_NODE_VERSION=$(node --version)');
    });

    it('uses the major-version setup URL for a major spec like "22"', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('22', 'ubuntu');

      const bashCall = records.find((r) => r.cmd === 'bash')!;
      const script = bashCall.args[1] as string;
      expect(script).toContain('deb.nodesource.com/setup_22.x');
    });

    it('pins the exact apt version when a full semver is requested', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('22.11.0', 'ubuntu');

      const bashCall = records.find((r) => r.cmd === 'bash')!;
      const script = bashCall.args[1] as string;
      // When a full semver is requested, the apt install pins via `nodejs=<ver>`.
      // The setup URL still uses the major version.
      expect(script).toContain('deb.nodesource.com/setup_22.x');
      expect(script).toContain('nodejs=22.11.0');
    });

    it('passes the DEBIAN_FRONTEND and TERM env vars', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('lts', 'ubuntu');

      const bashCall = records.find((r) => r.cmd === 'bash')!;
      const opts = bashCall.opts;
      expect(opts?.env?.DEBIAN_FRONTEND).toBe('noninteractive');
      expect(opts?.env?.TERM).toBe('dumb');
    });

    it('records the install in state.json with the resolved version', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('lts', 'ubuntu');

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(1);
      const entry = state.installed_runtimes[0]!;
      expect(entry.name).toBe('node');
      expect(entry.version).toBe('22.11.0'); // resolved from `node --version`
      expect(entry.distro).toBe('ubuntu');
      expect(entry.path).toBe('/usr/bin/node');
      expect(entry.is_default).toBe(true); // first install is the default
      expect(entry.installed_at).toBeTruthy();
    });

    it('is idempotent (skips when already installed)', async () => {
      // Simulate: first probe returns non-zero (not installed), install
      // succeeds; second probe returns success (installed).
      let probeCount = 0;
      const hybrid: DistroExecFn = async (distro, cmd, args, opts) => {
        records.push({ distro, cmd, args, opts });
        if (cmd === 'node' && args[0] === '--version') {
          probeCount++;
          if (probeCount === 1) {
            return { stdout: '', stderr: 'not found', exitCode: 127 };
          }
          return { stdout: NODE_BIN_VERSION_OUTPUT, stderr: '', exitCode: 0 };
        }
        return { stdout: NODE_VERSION_OUTPUT, stderr: '', exitCode: 0 };
      };
      const p = new NodeRuntimeProvider(hybrid, store);

      // First install: probe says not installed, then bash script runs.
      await p.install('22', 'ubuntu');

      // Second install: probe says installed, install() short-circuits.
      await p.install('22', 'ubuntu');

      // The bash install script should have run only once. The probe
      // (`node --version`) runs twice (once per install call), but the
      // bash script runs only on the first call.
      const bashCalls = records.filter((r) => r.cmd === 'bash').length;
      expect(bashCalls).toBe(1);
      // The probe runs twice.
      const probeCalls = records.filter(
        (r) => r.cmd === 'node' && r.args[0] === '--version',
      ).length;
      expect(probeCalls).toBe(2);
    });

    it('throws RuntimeError(E_RUNTIME_INSTALL_FAILED) when the script exits non-zero', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: '',
        stderr: 'E: Unable to locate package nodejs',
        exitCode: 100,
      });

      await expect(provider.install('lts', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.install('lts', 'ubuntu');
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
      // Pre-populate state with an existing node install.
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'node',
          version: '20.18.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });

      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      responses.set('bash:-c', {
        stdout: NODE_VERSION_OUTPUT,
        stderr: '',
        exitCode: 0,
      });

      await provider.install('22', 'ubuntu');

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(2);
      const newEntry = state.installed_runtimes.find((r) => r.version === '22.11.0')!;
      expect(newEntry.is_default).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // exec()
  // -------------------------------------------------------------------------

  describe('exec()', () => {
    it('invokes distroExec with /usr/bin/<cmd> as the binary', async () => {
      responses.set('*', { stdout: 'v22.11.0', stderr: '', exitCode: 0 });

      const result = await provider.exec('22', 'ubuntu', 'node', ['--version']);

      expect(records).toHaveLength(1);
      expect(records[0]!.cmd).toBe('/usr/bin/node');
      expect(records[0]!.args).toEqual(['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('v22.11.0');
    });

    it('resolves npm to /usr/bin/npm', async () => {
      responses.set('*', { stdout: '10.9.0', stderr: '', exitCode: 0 });

      await provider.exec('22', 'ubuntu', 'npm', ['--version']);

      expect(records[0]!.cmd).toBe('/usr/bin/npm');
    });

    it('passes through an absolute cmd path unchanged', async () => {
      responses.set('*', { stdout: '', stderr: '', exitCode: 0 });

      await provider.exec('22', 'ubuntu', '/custom/path/node', ['-v']);

      expect(records[0]!.cmd).toBe('/custom/path/node');
    });

    it('forwards opts (env, timeoutMs) to distroExec', async () => {
      responses.set('*', { stdout: '', stderr: '', exitCode: 0 });

      await provider.exec('22', 'ubuntu', 'node', ['-e', 'console.log(1)'], {
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
    it('returns a single entry when node --version succeeds', async () => {
      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');

      expect(installed).toHaveLength(1);
      expect(installed[0]!.name).toBe('node');
      expect(installed[0]!.version).toBe('22.11.0');
      expect(installed[0]!.path).toBe('/usr/bin/node');
    });

    it('returns an empty array when node --version fails', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'command not found',
        exitCode: 127,
      });

      const installed = await provider.list('ubuntu');
      expect(installed).toEqual([]);
    });

    it('strips the leading v from the version string', async () => {
      responses.set('node:--version', {
        stdout: 'v22.11.0\n',
        stderr: '',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');
      expect(installed[0]!.version).toBe('22.11.0');
    });

    it('cross-references state.json for installed_at and is_default', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'node',
          version: '22.11.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });

      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });

      const installed = await provider.list('ubuntu');
      expect(installed[0]!.installedAt).toBe('2025-01-01T00:00:00.000Z');
      expect(installed[0]!.isDefault).toBe(true);
    });
  });

  describe('isInstalled()', () => {
    it('returns false when no node is installed', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      expect(await provider.isInstalled('22', 'ubuntu')).toBe(false);
    });

    it('returns true when a matching major version is installed', async () => {
      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });
      expect(await provider.isInstalled('22', 'ubuntu')).toBe(true);
    });

    it('returns true for the "lts" spec when any version is installed', async () => {
      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });
      expect(await provider.isInstalled('lts', 'ubuntu')).toBe(true);
    });

    it('returns false when a different major is installed', async () => {
      responses.set('node:--version', {
        stdout: 'v20.18.0',
        stderr: '',
        exitCode: 0,
      });
      expect(await provider.isInstalled('22', 'ubuntu')).toBe(false);
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
          name: 'node',
          version: '22.11.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      expect(await provider.getDefault('ubuntu')).toBe('22.11.0');
    });
  });

  describe('setDefault()', () => {
    beforeEach(async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'node',
          version: '22.11.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: false,
        });
        state.installed_runtimes.push({
          name: 'node',
          version: '20.18.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-02T00:00:00.000Z',
          is_default: true,
        });
      });
    });

    it('sets is_default=true on the matching version and clears the previous default', async () => {
      await provider.setDefault('22.11.0', 'ubuntu');

      const state = await store.load();
      const v22 = state.installed_runtimes.find((r) => r.version === '22.11.0')!;
      const v20 = state.installed_runtimes.find((r) => r.version === '20.18.0')!;
      expect(v22.is_default).toBe(true);
      expect(v20.is_default).toBe(false);
    });

    it('accepts a major-version spec and resolves it to the installed full version', async () => {
      await provider.setDefault('22', 'ubuntu');

      const state = await store.load();
      const v22 = state.installed_runtimes.find((r) => r.version === '22.11.0')!;
      expect(v22.is_default).toBe(true);
    });

    it('throws RuntimeError(E_RUNTIME_NOT_INSTALLED) when the version is not installed', async () => {
      await expect(provider.setDefault('18', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.setDefault('18', 'ubuntu');
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
    it('invokes apt-get purge nodejs and removes the state entry', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'node',
          version: '22.11.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });
      responses.set('apt-get:purge', { stdout: '', stderr: '', exitCode: 0 });

      await provider.uninstall('22', 'ubuntu');

      const purgeCall = records.find((r) => r.cmd === 'apt-get');
      expect(purgeCall).toBeDefined();
      expect(purgeCall!.args).toEqual(['purge', '-y', 'nodejs']);

      const state = await store.load();
      expect(state.installed_runtimes).toHaveLength(0);
    });

    it('throws RuntimeError(E_RUNTIME_NOT_INSTALLED) when the version is not present', async () => {
      responses.set('node:--version', {
        stdout: '',
        stderr: 'not found',
        exitCode: 127,
      });
      await expect(provider.uninstall('22', 'ubuntu')).rejects.toThrow(RuntimeError);
    });

    it('throws RuntimeError(E_RUNTIME_UNINSTALL_FAILED) when apt purge fails', async () => {
      await store.update((state) => {
        state.installed_runtimes.push({
          name: 'node',
          version: '22.11.0',
          distro: 'ubuntu',
          path: '/usr/bin/node',
          installed_at: '2025-01-01T00:00:00.000Z',
          is_default: true,
        });
      });
      responses.set('node:--version', {
        stdout: 'v22.11.0',
        stderr: '',
        exitCode: 0,
      });
      responses.set('apt-get:purge', {
        stdout: '',
        stderr: 'E: Could not open lock file',
        exitCode: 100,
      });

      await expect(provider.uninstall('22', 'ubuntu')).rejects.toThrow(RuntimeError);
      try {
        await provider.uninstall('22', 'ubuntu');
      } catch (e) {
        const err = e as RuntimeError;
        expect(err.code).toBe('E_RUNTIME_UNINSTALL_FAILED');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// buildNodeInstallScript / parseNodeInstallOutput (pure-function tests)
// ---------------------------------------------------------------------------

describe('runtimes/node — buildNodeInstallScript', () => {
  it('includes the NodeSource setup URL', () => {
    const script = buildNodeInstallScript('https://deb.nodesource.com/setup_lts.x', ['nodejs']);
    expect(script).toContain('deb.nodesource.com/setup_lts.x');
  });

  it('includes apt-get install with the listed packages', () => {
    const script = buildNodeInstallScript('https://example.com/setup.x', ['nodejs']);
    expect(script).toContain('apt-get install -y --no-install-recommends nodejs');
  });

  it('emits LINUXIFY_NODE_VERSION marker', () => {
    const script = buildNodeInstallScript('https://example.com/setup.x', ['nodejs']);
    expect(script).toContain('LINUXIFY_NODE_VERSION=$(node --version)');
    expect(script).toContain('LINUXIFY_NPM_VERSION=$(npm --version)');
  });

  it('pins the exact version when versionPin is provided', () => {
    const script = buildNodeInstallScript(
      'https://deb.nodesource.com/setup_22.x',
      ['nodejs'],
      '22.11.0-1nodesource1',
    );
    expect(script).toContain('nodejs=22.11.0-1nodesource1');
  });

  it('cleans the apt cache', () => {
    const script = buildNodeInstallScript('https://example.com/setup.x', ['nodejs']);
    expect(script).toContain('apt-get clean');
    expect(script).toContain('rm -rf /var/lib/apt/lists/*');
  });
});

describe('runtimes/node — parseNodeInstallOutput', () => {
  it('extracts node and npm versions from the install output', () => {
    const out = parseNodeInstallOutput(
      'LINUXIFY_NODE_VERSION=v22.11.0\nLINUXIFY_NPM_VERSION=10.9.0',
    );
    expect(out.nodeVersion).toBe('v22.11.0');
    expect(out.npmVersion).toBe('10.9.0');
  });

  it('returns empty strings when markers are missing', () => {
    const out = parseNodeInstallOutput('some unrelated output');
    expect(out.nodeVersion).toBe('');
    expect(out.npmVersion).toBe('');
  });
});
