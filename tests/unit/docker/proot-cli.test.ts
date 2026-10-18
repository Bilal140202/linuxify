/**
 * Unit tests for `src/docker/proot-cli.ts` — `ProotDockerClient`.
 *
 * `ProotDockerClient` shells into the active proot-distro via
 * `proot-distro login <distro> --user linuxify -- bash -c '<cmd>'` and
 * runs docker/podman inside. We mock `utils/process.js`'s `exec` so no
 * real proot-distro subprocess is spawned; tests assert on the cmd/args
 * passed to exec.
 *
 * Covers:
 *   - Constructor: stores distro + binary (defaults to 'docker').
 *   - `pullImage` / `runContainer`:
 *     - Same command shape as PodroidClient, but invoked via
 *       `proot-distro login <distro> --user linuxify -- bash -c '<cmd>'`.
 *     - Pre-checks manifest with `<binary> manifest inspect <image> | grep -q
 *       '"architecture": "<arch>"'`.
 *     - Returns failure when manifest check says 'missing'.
 *     - Returns success when pull exits 0.
 *     - Builds `<binary> run -d --name '<name>' --restart <policy> image`.
 *       When `binary='podman'`, uses `podman run` instead of `docker run`.
 *     - Returns failure on non-zero exit.
 *   - `stopAndRemove`, `stop`, `start`, `listContainers`, `logs` all use
 *     the same proot-distro login wrapper.
 *   - Shell-quoting: same single-quote escaping + NUL-byte rejection as
 *     PodroidClient.
 *
 * The logger is mocked to keep test output quiet.
 */

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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  // Captured exec calls: { cmd, args, opts } in invocation order.
  const execCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];

  let execImpl: (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    failed: boolean;
    timedOut: boolean;
    command: string;
  }> = async (cmd, args) => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    failed: false,
    timedOut: false,
    command: [cmd, ...args].join(' '),
  });

  const exec = vi.fn(async (cmd: string, args: string[] = [], opts: Record<string, unknown> = {}) => {
    execCalls.push({ cmd, args, opts });
    return execImpl(cmd, args, opts);
  });

  const setExecImpl = (fn: typeof execImpl): void => {
    execImpl = fn;
  };

  return { execCalls, exec, setExecImpl };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
}));

import { ProotDockerClient } from '../../../src/docker/proot-cli.js';
import type { ExecResult } from '../../../src/utils/process.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function result(opts: { exitCode?: number; stdout?: string; stderr?: string }): ExecResult {
  const exitCode = opts.exitCode ?? 0;
  return {
    exitCode,
    stdout: opts.stdout ?? '',
    stderr: opts.stderr ?? '',
    failed: exitCode !== 0,
    timedOut: false,
    command: '',
  };
}

function makeClient(distro = 'ubuntu', binary: 'docker' | 'podman' = 'docker'): ProotDockerClient {
  return new ProotDockerClient({ distro, binary });
}

/** The bash -c command string passed to proot-distro login (the last arg). */
function bashCommandArg(): string | undefined {
  const call = mocks.execCalls[mocks.execCalls.length - 1];
  if (!call) return undefined;
  return call.args[call.args.length - 1];
}

beforeEach(() => {
  mocks.execCalls.length = 0;
  mocks.exec.mockClear();
  mocks.setExecImpl(async () => result({}));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docker/proot-cli — constructor', () => {
  it('stores distro + binary (defaults to docker)', async () => {
    const client = makeClient('ubuntu');
    // Trigger an exec so we can verify the distro is propagated.
    await client.stop('nginx');
    const call = mocks.execCalls[0];
    expect(call).toBeDefined();
    expect(call.cmd).toBe('proot-distro');
    expect(call.args[0]).toBe('login');
    expect(call.args[1]).toBe('ubuntu');
    expect(call.args).toContain('--user');
    expect(call.args).toContain('linuxify');
  });

  it('honors binary=podman (uses podman subcommands)', async () => {
    const client = makeClient('ubuntu', 'podman');
    await client.stop('nginx');
    const cmd = bashCommandArg();
    expect(cmd).toContain('podman stop');
  });
});

describe('docker/proot-cli — pullImage', () => {
  it('pre-checks manifest with <binary> manifest inspect and returns failure on missing', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('manifest inspect')) {
        return result({ exitCode: 0, stdout: 'missing\n' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no manifest for arch 'arm64'");
  });

  it('returns success when manifest check passes and docker pull exits 0', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('manifest inspect')) {
        return result({ exitCode: 0, stdout: 'ok\n' });
      }
      if (typeof last === 'string' && last.includes('docker pull')) {
        return result({ exitCode: 0, stdout: 'pulled\n' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Pulled');
  });

  it('uses podman when binary=podman', async () => {
    const client = makeClient('ubuntu', 'podman');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('manifest inspect')) {
        return result({ exitCode: 0, stdout: 'ok\n' });
      }
      if (typeof last === 'string' && last.includes('podman pull')) {
        return result({ exitCode: 0, stdout: 'pulled\n' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(true);
    // Verify the manifest inspect command used podman, not docker.
    const manifestCall = mocks.execCalls.find((c) => {
      const last = c.args[c.args.length - 1] as string | undefined;
      return typeof last === 'string' && last.includes('manifest inspect');
    });
    expect(manifestCall).toBeDefined();
    expect(manifestCall!.args[manifestCall!.args.length - 1]).toContain('podman manifest inspect');
  });
});

describe('docker/proot-cli — runContainer', () => {
  it('builds docker run -d --name ... --restart ... image with ports/env/volumes', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker run')) {
        return result({ exitCode: 0, stdout: 'a'.repeat(64) + '\n' });
      }
      return result({});
    });
    const r = await client.runContainer({
      image: 'nginx',
      name: 'nginx',
      ports: [{ host: 8000, guest: 80 }],
      env: [{ key: 'FOO', value: 'bar' }],
      volumes: [{ hostPath: '/host', containerPath: '/data', mode: 'rw' }],
      restart: 'unless-stopped',
    });
    expect(r.ok).toBe(true);
    expect(r.containerId).toHaveLength(12);
    const cmd = bashCommandArg();
    expect(cmd).toContain('docker run -d');
    expect(cmd).toContain("--name 'nginx'");
    expect(cmd).toContain('--restart unless-stopped');
    expect(cmd).toContain('-p 8000:80/tcp');
    expect(cmd).toContain("-e 'FOO=bar'");
    expect(cmd).toContain("-v '/host:/data:rw'");
    expect(cmd).toContain("'nginx'");
  });

  it('returns failure on non-zero exit', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker run')) {
        return result({ exitCode: 1, stdout: 'name taken' });
      }
      return result({});
    });
    const r = await client.runContainer({
      image: 'nginx', name: 'nginx', ports: [], env: [], volumes: [], restart: 'no',
    });
    expect(r.ok).toBe(false);
    expect(r.containerId).toBe('');
  });

  it('uses podman run when binary=podman', async () => {
    const client = makeClient('ubuntu', 'podman');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('podman run')) {
        return result({ exitCode: 0, stdout: 'a'.repeat(64) + '\n' });
      }
      return result({});
    });
    const r = await client.runContainer({
      image: 'nginx', name: 'nginx', ports: [], env: [], volumes: [], restart: 'no',
    });
    expect(r.ok).toBe(true);
    expect(bashCommandArg()).toContain('podman run');
  });

  it('throws E_DOCKER_SHELL_INJECTION when an arg contains a NUL byte', async () => {
    const client = makeClient('ubuntu');
    await expect(
      client.runContainer({
        image: 'nginx\0evil', name: 'x', ports: [], env: [], volumes: [], restart: 'no',
      }),
    ).rejects.toThrow(/E_DOCKER_SHELL_INJECTION/);
  });
});

describe('docker/proot-cli — stop / start / stopAndRemove', () => {
  it('stop(name) runs docker stop <name> via proot-distro login', async () => {
    const client = makeClient('ubuntu');
    const ok = await client.stop('nginx');
    expect(ok).toBe(true);
    const call = mocks.execCalls[0];
    expect(call.cmd).toBe('proot-distro');
    expect(call.args[0]).toBe('login');
    expect(bashCommandArg()).toContain('docker stop');
    expect(bashCommandArg()).toContain("'nginx'");
  });

  it('start(name) runs docker start <name>', async () => {
    const client = makeClient('ubuntu');
    const ok = await client.start('nginx');
    expect(ok).toBe(true);
    expect(bashCommandArg()).toContain('docker start');
  });

  it('stopAndRemove runs docker stop then docker rm -f; returns true when rm exits 0', async () => {
    const client = makeClient('ubuntu');
    const ok = await client.stopAndRemove('nginx');
    expect(ok).toBe(true);
    expect(mocks.execCalls).toHaveLength(2);
    expect(bashCommandArg.call(null)).toContain('docker rm -f'); // last call
  });

  it('stopAndRemove returns false when rm exits non-zero', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker rm')) {
        return result({ exitCode: 1 });
      }
      return result({ exitCode: 0 });
    });
    const ok = await client.stopAndRemove('nginx');
    expect(ok).toBe(false);
  });
});

describe('docker/proot-cli — listContainers', () => {
  it('parses JSON-per-line output and skips malformed lines', async () => {
    const client = makeClient('ubuntu');
    const lines = [
      JSON.stringify({ ID: 'abc', Names: 'nginx', Image: 'nginx', Status: 'Up 1 second', Ports: '' }),
      '{not json',
      JSON.stringify({ ID: 'def', Names: 'redis', Image: 'redis', Status: 'Exited', Ports: '' }),
    ].join('\n');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker ps')) {
        return result({ exitCode: 0, stdout: lines });
      }
      return result({});
    });
    const list = await client.listContainers();
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('nginx');
    expect(list[1]!.name).toBe('redis');
  });

  it('returns empty array when docker ps exits non-zero', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker ps')) {
        return result({ exitCode: 1 });
      }
      return result({});
    });
    const list = await client.listContainers();
    expect(list).toEqual([]);
  });
});

describe('docker/proot-cli — logs', () => {
  it('runs docker logs --tail <lines> <name> and returns stdout', async () => {
    const client = makeClient('ubuntu');
    mocks.setExecImpl(async (cmd, args) => {
      const last = args[args.length - 1] as string | undefined;
      if (typeof last === 'string' && last.includes('docker logs')) {
        return result({ exitCode: 0, stdout: 'log line\n' });
      }
      return result({});
    });
    const out = await client.logs('nginx', 50);
    expect(out).toBe('log line\n');
    expect(bashCommandArg()).toContain('docker logs --tail 50');
  });
});
