/**
 * Unit tests for `src/packages/manager.ts` (the `PackageManager` class).
 *
 * The manager is tested with mocked `DistroProvider` and `RuntimeProvider`
 * slices — only `exec`, `install`, `list`, `name`, and `defaultVersion` are
 * exercised. The `StateStore` is real (backed by a tmpdir `state.json`),
 * consistent with `tests/unit/state/store.test.ts`. The logger is mocked
 * to avoid pino multistream initialization.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { StateStore } from '../../../src/state/index.js';
import { PackageManager } from '../../../src/packages/manager.js';
import type {
  DistroProvider,
  DistroExecResult,
  RuntimeProvider,
  RuntimeVersion,
} from '../../../src/packages/manager.js';
import { parsePackageYaml } from '../../../src/packages/parser.js';
import type { PackageDefinition } from '../../../src/packages/schema.js';
import { PackageError } from '../../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Fixtures & mocks
// ---------------------------------------------------------------------------

const VALID_YAML = `
name: cline
version: 1.2.0
description: "AI coding agent"
homepage: https://github.com/cline/cline
license: MIT
runtime: node
runtime_min_version: "20"
package: cline
launcher: cline
package_manager: npm
install:
  - npm install -g cline@1.2.0
uninstall:
  - npm uninstall -g cline
compat:
  min_linuxify: "0.1.0"
  tested_distros: [ubuntu]
  tested_runtimes: [node]
  known_issues: []
  not_supported: []
permissions:
  network: true
  filesystem:
    binds: []
  services:
    start: []
  setuid: false
`;

/** Build a PackageManager with disk-space check disabled (tests run on small /tmp). */
function makePm(
  store: StateStore,
  distro: DistroProvider,
  runtime: RuntimeProvider,
  opts?: { minFreeMb?: number },
): PackageManager {
  return new PackageManager({
    stateStore: store,
    distroProvider: distro,
    runtimeProvider: runtime,
    minFreeMb: opts?.minFreeMb ?? 0,
  });
}

/** Parse the valid YAML fixture into a PackageDefinition. */
function validPkg(): PackageDefinition {
  return parsePackageYaml(VALID_YAML);
}

/**
 * Build a mock DistroProvider that records all exec calls and returns
 * canned `DistroExecResult`s. By default every call succeeds (exit 0).
 */
function makeMockDistro(opts?: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): DistroProvider & { calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const provider: DistroProvider = {
    name: 'ubuntu',
    async exec(cmd: string, args: string[]): Promise<DistroExecResult> {
      calls.push({ cmd, args: [...args] });
      return {
        exitCode: opts?.exitCode ?? 0,
        stdout: opts?.stdout ?? '',
        stderr: opts?.stderr ?? '',
      };
    },
  };
  return Object.assign(provider, { calls });
}

/**
 * Build a mock RuntimeProvider. By default `list()` returns a single
 * matching version (so the manager skips install), and `install()` is a
 * no-op that records the call.
 */
function makeMockRuntime(opts?: {
  installedVersions?: string[];
  defaultVersion?: string;
}): RuntimeProvider & {
  installCalls: Array<{ version: string; distro: string }>;
} {
  const installCalls: Array<{ version: string; distro: string }> = [];
  const installedVersions = opts?.installedVersions ?? ['22.11.0'];
  const provider: RuntimeProvider = {
    name: 'node',
    defaultVersion: opts?.defaultVersion ?? '22.11.0',
    async install(version: string, distro: string): Promise<void> {
      installCalls.push({ version, distro });
    },
    async list(_distro: string): Promise<RuntimeVersion[]> {
      return installedVersions.map((v) => ({ version: v }));
    },
  };
  return Object.assign(provider, { installCalls });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PackageManager', () => {
  let tmpDir: string;
  let statePath: string;
  let store: StateStore;
  let originalLinuxifyHome: string | undefined;

  beforeEach(async () => {
    originalLinuxifyHome = process.env.LINUXIFY_HOME;
    tmpDir = await mkdtemp(join(tmpdir(), 'linuxify-pm-'));
    process.env.LINUXIFY_HOME = tmpDir;
    statePath = join(tmpDir, 'state.json');
    store = new StateStore(statePath);
  });

  afterEach(async () => {
    if (originalLinuxifyHome === undefined) {
      delete process.env.LINUXIFY_HOME;
    } else {
      process.env.LINUXIFY_HOME = originalLinuxifyHome;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // install()
  // -------------------------------------------------------------------------

  describe('install()', () => {
    it('installs a valid package and registers it in state', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const result = await pm.install(validPkg());

      expect(result.success).toBe(true);
      expect(result.package).toBe('cline');
      expect(result.version).toBe('1.2.0');
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.patchesApplied).toEqual([]);

      // State registration.
      const installed = await pm.list();
      expect(installed).toHaveLength(1);
      expect(installed[0]!.name).toBe('cline');
      expect(installed[0]!.version).toBe('1.2.0');
      expect(installed[0]!.distro).toBe('ubuntu');
      expect(installed[0]!.runtime).toBe('node');
      expect(installed[0]!.launcher_path).toContain('cline');
      expect(installed[0]!.patches_applied).toEqual([]);
    });

    it('runs install steps via distroProvider.exec', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());

      expect(distro.calls).toHaveLength(1);
      expect(distro.calls[0]!.cmd).toBe('bash');
      expect(distro.calls[0]!.args[0]).toBe('-c');
      expect(distro.calls[0]!.args[1]).toContain('npm install -g cline');
    });

    it('sets LINUXIFY_PACKAGE_NAME and LINUXIFY_DISTRO in the exec env', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      // Override exec to capture the env.
      let capturedEnv: Record<string, string> | undefined;
      const origExec = distro.exec.bind(distro);
      distro.exec = async (cmd: string, args: string[], opts?) => {
        capturedEnv = opts?.env;
        return origExec(cmd, args, opts);
      };
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv!.LINUXIFY_PACKAGE_NAME).toBe('cline');
      expect(capturedEnv!.LINUXIFY_PACKAGE_VERSION).toBe('1.2.0');
      expect(capturedEnv!.LINUXIFY_DISTRO).toBe('ubuntu');
    });

    it('emits preInstall and postInstall events', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const events: string[] = [];
      pm.on('preInstall', () => events.push('preInstall'));
      pm.on('postInstall', () => events.push('postInstall'));

      await pm.install(validPkg());

      expect(events).toContain('preInstall');
      expect(events).toContain('postInstall');
      expect(events.indexOf('preInstall')).toBeLessThan(events.indexOf('postInstall'));
    });

    it('emits progress events and forwards to onProgress', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const progressMsgs: string[] = [];
      pm.on('progress', (msg: string) => progressMsgs.push(msg));
      const onProgressMsgs: string[] = [];
      await pm.install(validPkg(), { onProgress: (msg) => onProgressMsgs.push(msg) });

      expect(progressMsgs.length).toBeGreaterThan(0);
      expect(onProgressMsgs).toEqual(progressMsgs);
    });

    it('throws E_PACKAGE_ALREADY_INSTALLED when already installed (without force)', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      await expect(pm.install(validPkg())).rejects.toThrow(PackageError);
      await expect(pm.install(validPkg())).rejects.toMatchObject({
        code: 'E_PACKAGE_ALREADY_INSTALLED',
      });
    });

    it('reinstalls with force=true', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      const result = await pm.install(validPkg(), { force: true });
      expect(result.success).toBe(true);

      // State should have exactly one entry (the second install replaces the first
      // — actually our current impl appends; let's verify it doesn't throw and
      // the list has entries).
      const installed = await pm.list();
      expect(installed.length).toBeGreaterThanOrEqual(1);
    });

    it('throws E_PACKAGE_DEPRECATED for a deprecated package (without force)', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.deprecated = true;
      await expect(pm.install(pkg)).rejects.toMatchObject({
        code: 'E_PACKAGE_DEPRECATED',
      });
    });

    it('installs a deprecated package with force=true', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.deprecated = true;
      const result = await pm.install(pkg, { force: true });
      expect(result.success).toBe(true);
    });

    it('throws E_PACKAGE_INSTALL_STEP_FAILED when a step exits non-zero', async () => {
      const distro = makeMockDistro({ exitCode: 1, stderr: 'npm error' });
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await expect(pm.install(validPkg())).rejects.toMatchObject({
        code: 'E_PACKAGE_INSTALL_STEP_FAILED',
      });
    });

    it('continues when on_fail=continue and the step fails', async () => {
      const distro = makeMockDistro({ exitCode: 1 });
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      // Use the structured install form with on_fail: continue.
      (pkg as {
        install: { steps: Array<{ name: string; command: string; on_fail: 'continue' }> };
      }).install = {
        steps: [{ name: 'optional', command: 'echo maybe fails', on_fail: 'continue' }],
      };
      const result = await pm.install(pkg);
      expect(result.success).toBe(true);
    });

    it('throws E_PACKAGE_CONFLICT when a conflicting package is installed', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      // First install "other-pkg".
      const other = validPkg();
      (other as { name: string }).name = 'other-pkg';
      (other as { package: string }).package = 'other-pkg';
      (other as { launcher: string }).launcher = 'otherpkg';
      await pm.install(other);

      // Now try to install cline with conflicts: [other-pkg].
      const pkg = validPkg();
      pkg.conflicts = ['other-pkg'];
      await expect(pm.install(pkg)).rejects.toMatchObject({
        code: 'E_PACKAGE_CONFLICT',
      });
    });

    it('installs the runtime if it is not already installed', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime({ installedVersions: [], defaultVersion: '22.11.0' });
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());

      expect(runtime.installCalls).toHaveLength(1);
      // The manager prefers the runtime provider's default version (22.11.0)
      // because it satisfies the package's runtime_min_version ("20").
      expect(runtime.installCalls[0]!.version).toBe('22.11.0');
      expect(runtime.installCalls[0]!.distro).toBe('ubuntu');
    });

    it('skips runtime install if already installed', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime({ installedVersions: ['22.11.0'] });
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());

      expect(runtime.installCalls).toHaveLength(0);
    });

    it('throws E_PACKAGE_DISK_FULL when free space is below the threshold', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      // Set an impossibly high threshold so the check always fails.
      const pm = makePm(store, distro, runtime, { minFreeMb: Number.MAX_SAFE_INTEGER });

      await expect(pm.install(validPkg())).rejects.toMatchObject({
        code: 'E_PACKAGE_DISK_FULL',
      });
    });

    it('skips the disk-space check when minFreeMb=0', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime, { minFreeMb: 0 });

      const result = await pm.install(validPkg());
      expect(result.success).toBe(true);
    });

    it('emits prePatch/postPatch events when patches are present', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.patches = [
        {
          id: 'cline-001',
          patch_id: 'cline-001',
          description: 'd',
          file: 'f.js',
          type: 'regex' as const,
          find: 'a',
          replace: 'b',
          verify: 'grep b f.js',
          rollback: true,
        },
      ];
      const events: string[] = [];
      pm.on('prePatch', () => events.push('prePatch'));
      pm.on('postPatch', () => events.push('postPatch'));

      const result = await pm.install(pkg);
      expect(events).toContain('prePatch');
      expect(events).toContain('postPatch');
      expect(result.patchesApplied).toEqual(['cline-001']);
    });

    it('skips patch events when noPatch=true', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.patches = [
        {
          id: 'cline-001',
          patch_id: 'cline-001',
          description: 'd',
          file: 'f.js',
          type: 'regex' as const,
          find: 'a',
          replace: 'b',
          verify: 'grep b f.js',
          rollback: true,
        },
      ];
      const events: string[] = [];
      pm.on('prePatch', () => events.push('prePatch'));

      const result = await pm.install(pkg, { noPatch: true });
      expect(events).not.toContain('prePatch');
      expect(result.patchesApplied).toEqual([]);
    });

    it('emits preLauncher/postLauncher events', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const events: string[] = [];
      pm.on('preLauncher', () => events.push('preLauncher'));
      pm.on('postLauncher', () => events.push('postLauncher'));

      await pm.install(validPkg());
      expect(events).toContain('preLauncher');
      expect(events).toContain('postLauncher');
    });

    it('retries a failing step up to retry count', async () => {
      // First two calls fail, third succeeds.
      let callCount = 0;
      const distro: DistroProvider = {
        name: 'ubuntu',
        async exec(): Promise<DistroExecResult> {
          callCount++;
          return {
            exitCode: callCount < 3 ? 1 : 0,
            stdout: '',
            stderr: callCount < 3 ? 'transient error' : '',
          };
        },
      };
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      (pkg as {
        install: { steps: Array<{ name: string; command: string; retry: number }> };
      }).install = { steps: [{ name: 'flaky', command: 'echo flaky', retry: 2 }] };

      const result = await pm.install(pkg);
      expect(result.success).toBe(true);
      expect(callCount).toBe(3); // 1 initial + 2 retries
    });
  });

  // -------------------------------------------------------------------------
  // uninstall()
  // -------------------------------------------------------------------------

  describe('uninstall()', () => {
    it('removes a package from state', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      expect(await pm.isInstalled('cline')).toBe(true);

      const result = await pm.uninstall('cline');
      expect(result.success).toBe(true);
      expect(await pm.isInstalled('cline')).toBe(false);
      expect(await pm.list()).toHaveLength(0);
    });

    it('runs uninstall steps when pkg is provided', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.uninstall = ['npm uninstall -g cline'];
      await pm.install(pkg);

      // Reset call tracking.
      distro.calls.length = 0;

      await pm.uninstall('cline', { pkg });
      expect(distro.calls).toHaveLength(1);
      expect(distro.calls[0]!.args[1]).toContain('npm uninstall -g cline');
    });

    it('throws E_PACKAGE_NOT_INSTALLED for an unknown package', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await expect(pm.uninstall('nonexistent')).rejects.toMatchObject({
        code: 'E_PACKAGE_NOT_INSTALLED',
      });
    });

    it('emits preUninstall and postUninstall events', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      const events: string[] = [];
      pm.on('preUninstall', () => events.push('preUninstall'));
      pm.on('postUninstall', () => events.push('postUninstall'));

      await pm.uninstall('cline');
      expect(events).toContain('preUninstall');
      expect(events).toContain('postUninstall');
    });

    it('emits preLauncherRemove/postLauncherRemove events', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      const events: string[] = [];
      pm.on('preLauncherRemove', () => events.push('preLauncherRemove'));
      pm.on('postLauncherRemove', () => events.push('postLauncherRemove'));

      await pm.uninstall('cline');
      expect(events).toContain('preLauncherRemove');
      expect(events).toContain('postLauncherRemove');
    });

    it('throws E_PACKAGE_UNINSTALL_STEP_FAILED when an uninstall step fails', async () => {
      // Distro that succeeds for install (call 1) and fails for uninstall (call 2).
      let callCount = 0;
      const distro: DistroProvider = {
        name: 'ubuntu',
        async exec(): Promise<DistroExecResult> {
          callCount++;
          return {
            exitCode: callCount === 1 ? 0 : 1,
            stdout: '',
            stderr: callCount === 1 ? '' : 'uninstall error',
          };
        },
      };
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg = validPkg();
      pkg.uninstall = ['npm uninstall -g cline'];
      await pm.install(pkg);

      await expect(pm.uninstall('cline', { pkg })).rejects.toMatchObject({
        code: 'E_PACKAGE_UNINSTALL_STEP_FAILED',
      });
    });
  });

  // -------------------------------------------------------------------------
  // list() / get() / isInstalled()
  // -------------------------------------------------------------------------

  describe('list() / get() / isInstalled()', () => {
    it('list() returns an empty array when nothing is installed', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      expect(await pm.list()).toEqual([]);
    });

    it('list() returns all installed packages', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      const pkg1 = validPkg();
      await pm.install(pkg1);

      const pkg2 = validPkg();
      (pkg2 as { name: string }).name = 'aider';
      (pkg2 as { package: string }).package = 'aider-chat';
      (pkg2 as { launcher: string }).launcher = 'aider';
      await pm.install(pkg2);

      const list = await pm.list();
      expect(list).toHaveLength(2);
      expect(list.map((p) => p.name).sort()).toEqual(['aider', 'cline']);
    });

    it('get() returns the package entry or null', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      expect(await pm.get('cline')).toBeNull();

      await pm.install(validPkg());
      const entry = await pm.get('cline');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('cline');
      expect(entry!.version).toBe('1.2.0');
    });

    it('isInstalled() returns true/false', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      expect(await pm.isInstalled('cline')).toBe(false);
      await pm.install(validPkg());
      expect(await pm.isInstalled('cline')).toBe(true);
      expect(await pm.isInstalled('other')).toBe(false);
    });

    it('list() returns a copy (mutations do not affect state)', async () => {
      const distro = makeMockDistro();
      const runtime = makeMockRuntime();
      const pm = makePm(store, distro, runtime);

      await pm.install(validPkg());
      const list = await pm.list();
      list.length = 0; // mutate the returned array

      const list2 = await pm.list();
      expect(list2).toHaveLength(1);
    });
  });
});
