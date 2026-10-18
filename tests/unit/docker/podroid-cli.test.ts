/**
 * Unit tests for `src/docker/podroid-cli.ts` — `PodroidClient`.
 *
 * `PodroidClient` shells into the Podroid Alpine VM over SSH and runs
 * docker commands. We mock `utils/process.js`'s `exec` so no real SSH
 * subprocess is spawned; tests assert on the cmd/args passed to exec.
 *
 * Covers:
 *   - Constructor: defaults port to 9922, user to 'root', password to
 *     'podroid'; honors `LINUXIFY_PODROID_SSH_KEY`.
 *   - `runInVm(command, timeout)`:
 *     - Builds the right ssh args (`-o StrictHostKeyChecking=no -o
 *       UserKnownHostsFile=/dev/null -o LogLevel=ERROR -p 9922
 *       root@host command`).
 *     - With `LINUXIFY_PODROID_SSH_KEY` set, adds `-i <key>` and skips
 *       sshpass.
 *     - With sshpass on PATH, wraps with `sshpass -p <password> ssh ...`.
 *     - With sshpass NOT on PATH and no key, falls back to plain ssh
 *       (and logs a warning).
 *   - `addForward(80, 8080, 'tcp')`:
 *     - Runs `podroid-forward add 80 8080 tcp` in the VM.
 *     - Returns `{ok: true, ruleId: 'podroid-80-8080-tcp'}` on success.
 *     - Returns `{ok: false, ruleId: ''}` on non-zero exit.
 *   - `removeForward(80, 8080)` runs `podroid-forward remove 80 8080`.
 *   - `cleanForwards()` runs `podroid-forward clean`; returns 1 on
 *     success, 0 on failure.
 *   - `pullImage('nginx', 'arm64')`:
 *     - Pre-checks manifest with `docker manifest inspect nginx | grep -q
 *       '"architecture": "arm64"'`.
 *     - Returns failure when manifest check says 'missing'.
 *     - Returns success when pull exits 0.
 *   - `runContainer({image, name, ports, env, volumes, restart})`:
 *     - Builds `docker run -d --name 'name' --restart unless-stopped
 *       -p host:guest/tcp -e 'KEY=VAL' -v 'host:container:rw' image`.
 *     - Returns `{ok: true, containerId: '<12-char>'}` on success.
 *     - Returns failure on non-zero exit.
 *   - `stopAndRemove(name)`: runs `docker stop name` then `docker rm -f
 *     name`; returns true when rm exits 0.
 *   - `stop(name)` / `start(name)`: build the right commands.
 *   - `listContainers()`: parses `docker ps -a --format '{{json .}}'`
 *     JSON-per-line output; skips malformed lines.
 *   - `logs(name, 50)`: runs `docker logs --tail 50 name`.
 *   - Shell-quoting: names/env-values containing single quotes are
 *     escaped via `'\''`; embedded NUL bytes throw
 *     `E_DOCKER_SHELL_INJECTION`.
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

  // Default exec implementation — returns success with empty output.
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

  // Replace exec implementation.
  const setExecImpl = (
    fn: typeof execImpl,
  ): void => {
    execImpl = fn;
  };

  return {
    execCalls,
    exec,
    setExecImpl,
  };
});

vi.mock('../../../src/utils/process.js', () => ({
  exec: mocks.exec,
}));

import { PodroidClient } from '../../../src/docker/podroid-cli.js';
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

function makeClient(opts: { host?: string; port?: number; user?: string; password?: string; sshKey?: string } = {}): PodroidClient {
  return new PodroidClient({
    host: opts.host ?? '127.0.0.1',
    port: opts.port,
    user: opts.user,
    password: opts.password,
    sshKey: opts.sshKey,
  });
}

/** Find the captured `runInVm` call (the cmd passed to ssh). */
function sshCommandArg(): string | undefined {
  // The cmd is the last positional arg to ssh — i.e. args[args.length-1]
  // when exec was called with cmd === 'ssh' or cmd === 'sshpass'.
  // The `command` appears after `root@host` in ssh arg order.
  const call = mocks.execCalls[mocks.execCalls.length - 1];
  if (!call) return undefined;
  return call.args[call.args.length - 1];
}

beforeEach(() => {
  mocks.execCalls.length = 0;
  mocks.exec.mockClear();
  mocks.setExecImpl(async (cmd, args) => result({}));
  delete process.env.LINUXIFY_PODROID_SSH_KEY;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docker/podroid-cli — constructor defaults', () => {
  it('defaults port to 9922, user to root, password to podroid', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    // Trigger an exec so we can inspect the ssh args.
    mocks.setExecImpl(async (cmd, args) => {
      // `which sshpass` → not found (exit 1) so sshpass is not used.
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({});
    });
    await client.runInVm('echo hi');
    const sshCall = mocks.execCalls.find((c) => c.cmd === 'ssh');
    expect(sshCall).toBeDefined();
    // Args should include '-p', '9922', 'root@10.0.0.2', 'echo hi'.
    expect(sshCall!.args).toContain('-p');
    expect(sshCall!.args).toContain('9922');
    expect(sshCall!.args).toContain('root@10.0.0.2');
    expect(sshCall!.args).toContain('echo hi');
  });
});

describe('docker/podroid-cli — runInVm', () => {
  it('builds ssh args with the documented options', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({});
    });
    await client.runInVm('echo hi', 30_000);
    const sshCall = mocks.execCalls.find((c) => c.cmd === 'ssh');
    expect(sshCall).toBeDefined();
    // Documented options:
    expect(sshCall!.args).toContain('StrictHostKeyChecking=no');
    expect(sshCall!.args).toContain('UserKnownHostsFile=/dev/null');
    expect(sshCall!.args).toContain('LogLevel=ERROR');
    // ConnectTimeout = ceil(30000/1000) = 30.
    expect(sshCall!.args).toContain('ConnectTimeout=30');
  });

  it('adds -i <key> and skips sshpass when LINUXIFY_PODROID_SSH_KEY is set', async () => {
    process.env.LINUXIFY_PODROID_SSH_KEY = '/tmp/key';
    const client = makeClient({ host: '10.0.0.2' });
    await client.runInVm('echo hi');
    // No `which sshpass` call (since key path is taken before).
    const whichCall = mocks.execCalls.find((c) => c.cmd === 'which' && c.args[0] === 'sshpass');
    expect(whichCall).toBeUndefined();
    const sshCall = mocks.execCalls.find((c) => c.cmd === 'ssh');
    expect(sshCall).toBeDefined();
    // The key should appear as -i <key>.
    const keyIdx = sshCall!.args.indexOf('-i');
    expect(keyIdx).toBeGreaterThanOrEqual(0);
    expect(sshCall!.args[keyIdx + 1]).toBe('/tmp/key');
    // And there should be NO sshpass invocation.
    const sshpassCall = mocks.execCalls.find((c) => c.cmd === 'sshpass');
    expect(sshpassCall).toBeUndefined();
  });

  it('wraps with sshpass -p <password> ssh ... when sshpass is on PATH', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') {
        return result({ exitCode: 0, stdout: '/usr/bin/sshpass\n' });
      }
      return result({});
    });
    const client = makeClient({ host: '10.0.0.2', password: 'secret' });
    await client.runInVm('echo hi');
    const sshpassCall = mocks.execCalls.find((c) => c.cmd === 'sshpass');
    expect(sshpassCall).toBeDefined();
    expect(sshpassCall!.args[0]).toBe('-p');
    expect(sshpassCall!.args[1]).toBe('secret');
    expect(sshpassCall!.args[2]).toBe('ssh');
  });

  it('falls back to plain ssh when sshpass is NOT on PATH and no key set', async () => {
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({});
    });
    const client = makeClient({ host: '10.0.0.2' });
    await client.runInVm('echo hi');
    const sshCall = mocks.execCalls.find((c) => c.cmd === 'ssh');
    expect(sshCall).toBeDefined();
    const sshpassCall = mocks.execCalls.find((c) => c.cmd === 'sshpass');
    expect(sshpassCall).toBeUndefined();
  });
});

describe('docker/podroid-cli — addForward', () => {
  it('runs podroid-forward add 80 8080 tcp and returns the synthetic ruleId on success', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    const r = await client.addForward(80, 8080, 'tcp');
    expect(r.ok).toBe(true);
    expect(r.ruleId).toBe('podroid-80-8080-tcp');
    // Verify the command string passed to ssh.
    const cmd = sshCommandArg();
    expect(cmd).toContain('podroid-forward add 80 8080 tcp');
  });

  it('returns ok=false with empty ruleId on non-zero exit', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      // The podroid-forward add call returns non-zero.
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('podroid-forward add'))) {
        return result({ exitCode: 1, stderr: 'rule exists' });
      }
      return result({});
    });
    const r = await client.addForward(80, 8080, 'tcp');
    expect(r.ok).toBe(false);
    expect(r.ruleId).toBe('');
    expect(r.message).toContain('podroid-forward add failed');
  });
});

describe('docker/podroid-cli — removeForward', () => {
  it('runs podroid-forward remove <g> <h> and returns true on success', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    const ok = await client.removeForward(80, 8080);
    expect(ok).toBe(true);
    expect(sshCommandArg()).toContain('podroid-forward remove 80 8080');
  });

  it('returns false on non-zero exit', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('podroid-forward remove'))) {
        return result({ exitCode: 1 });
      }
      return result({});
    });
    const ok = await client.removeForward(80, 8080);
    expect(ok).toBe(false);
  });
});

describe('docker/podroid-cli — cleanForwards', () => {
  it('runs podroid-forward clean and returns 1 on success', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    const n = await client.cleanForwards();
    expect(n).toBe(1);
    expect(sshCommandArg()).toContain('podroid-forward clean');
  });

  it('returns 0 on failure', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('podroid-forward clean'))) {
        return result({ exitCode: 1 });
      }
      return result({});
    });
    const n = await client.cleanForwards();
    expect(n).toBe(0);
  });
});

describe('docker/podroid-cli — pullImage', () => {
  it('returns failure when manifest check says missing', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      // The manifest inspect path greps for arch; we return "missing".
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('manifest inspect'))) {
        return result({ exitCode: 0, stdout: 'missing\n' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(false);
    expect(r.message).toContain("no manifest for arch 'arm64'");
  });

  it('returns success when manifest check says ok and docker pull exits 0', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('manifest inspect'))) {
        return result({ exitCode: 0, stdout: 'ok\n' });
      }
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker pull'))) {
        return result({ exitCode: 0, stdout: 'pulled\n' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Pulled');
  });

  it('returns failure when docker pull exits non-zero', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('manifest inspect'))) {
        return result({ exitCode: 0, stdout: 'ok\n' });
      }
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker pull'))) {
        return result({ exitCode: 1, stdout: 'network error' });
      }
      return result({});
    });
    const r = await client.pullImage('nginx', 'arm64');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('docker pull');
  });
});

describe('docker/podroid-cli — runContainer', () => {
  it('builds docker run -d --name ... --restart ... image with ports/env/volumes', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker run'))) {
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
    const cmd = sshCommandArg();
    expect(cmd).toContain("docker run -d");
    expect(cmd).toContain("--name 'nginx'");
    expect(cmd).toContain("--restart unless-stopped");
    expect(cmd).toContain("-p 8000:80/tcp");
    expect(cmd).toContain("-e 'FOO=bar'");
    expect(cmd).toContain("-v '/host:/data:rw'");
    expect(cmd).toContain("'nginx'");
  });

  it('returns failure on non-zero exit', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker run'))) {
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

  it('escapes single quotes in container names', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker run'))) {
        return result({ exitCode: 0, stdout: 'a'.repeat(64) + '\n' });
      }
      return result({});
    });
    await client.runContainer({
      image: 'nginx', name: "foo'bar", ports: [], env: [], volumes: [], restart: 'no',
    });
    const cmd = sshCommandArg();
    // shellQuote("foo'bar") === "'foo'\\''bar'"
    expect(cmd).toContain("'foo'\\''bar'");
  });

  it('throws E_DOCKER_SHELL_INJECTION when an arg contains a NUL byte', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    await expect(
      client.runContainer({
        image: 'nginx\0evil', name: 'x', ports: [], env: [], volumes: [], restart: 'no',
      }),
    ).rejects.toThrow(/E_DOCKER_SHELL_INJECTION/);
  });
});

describe('docker/podroid-cli — stop / start / stopAndRemove', () => {
  it('stop(name) runs docker stop <name>', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({});
    });
    const ok = await client.stop('nginx');
    expect(ok).toBe(true);
    expect(sshCommandArg()).toContain('docker stop');
    expect(sshCommandArg()).toContain("'nginx'");
  });

  it('start(name) runs docker start <name>', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({});
    });
    const ok = await client.start('nginx');
    expect(ok).toBe(true);
    expect(sshCommandArg()).toContain('docker start');
  });

  it('stopAndRemove runs docker stop then docker rm -f; returns true when rm exits 0', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      return result({ exitCode: 0 });
    });
    const ok = await client.stopAndRemove('nginx');
    expect(ok).toBe(true);
    // Two ssh calls: stop, then rm -f.
    const cmdCalls = mocks.execCalls.filter((c) => c.cmd === 'ssh');
    expect(cmdCalls.length).toBe(2);
    expect(cmdCalls[0]!.args[cmdCalls[0]!.args.length - 1]).toContain('docker stop');
    expect(cmdCalls[1]!.args[cmdCalls[1]!.args.length - 1]).toContain('docker rm -f');
  });

  it('stopAndRemove returns false when rm exits non-zero', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker rm'))) {
        return result({ exitCode: 1 });
      }
      return result({ exitCode: 0 });
    });
    const ok = await client.stopAndRemove('nginx');
    expect(ok).toBe(false);
  });
});

describe('docker/podroid-cli — listContainers', () => {
  it('parses JSON-per-line output and skips malformed lines', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    const lines = [
      JSON.stringify({ ID: 'abc123', Names: 'nginx', Image: 'nginx', Status: 'Up 2 seconds', Ports: '0.0.0.0:8000->80/tcp' }),
      '{not json',
      JSON.stringify({ ID: 'def456', Names: 'redis', Image: 'redis', Status: 'Exited (0) 1 minute ago', Ports: '' }),
    ].join('\n');
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker ps'))) {
        return result({ exitCode: 0, stdout: lines });
      }
      return result({});
    });
    const list = await client.listContainers();
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('nginx');
    expect(list[0]!.status).toContain('Up');
    expect(list[1]!.name).toBe('redis');
    expect(list[1]!.status).toContain('Exited');
  });

  it('returns empty array when docker ps exits non-zero', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker ps'))) {
        return result({ exitCode: 1 });
      }
      return result({});
    });
    const list = await client.listContainers();
    expect(list).toEqual([]);
  });
});

describe('docker/podroid-cli — logs', () => {
  it('runs docker logs --tail <lines> <name> and returns stdout', async () => {
    const client = makeClient({ host: '10.0.0.2' });
    mocks.setExecImpl(async (cmd, args) => {
      if (cmd === 'which' && args[0] === 'sshpass') return result({ exitCode: 1 });
      if (cmd === 'ssh' && args.some((a) => typeof a === 'string' && a.includes('docker logs'))) {
        return result({ exitCode: 0, stdout: 'line1\nline2\n' });
      }
      return result({});
    });
    const out = await client.logs('nginx', 50);
    expect(out).toBe('line1\nline2\n');
    const cmd = sshCommandArg();
    expect(cmd).toContain('docker logs --tail 50');
    expect(cmd).toContain("'nginx'");
  });
});
