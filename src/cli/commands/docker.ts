/**
 * `linuxify docker` — one-command load + run any docker image.
 *
 * @module linuxify/cli/commands/docker
 *
 * Subcommands:
 *   linuxify docker init                  Prepare the docker runtime
 *   linuxify docker run <image>           Load + run any docker image
 *   linuxify docker ps                    List running containers
 *   linuxify docker stop <name>           Stop a container
 *   linuxify docker rm <name>             Remove a container
 *   linuxify docker logs <name>           View container logs
 *   linuxify docker forward <g> <h>       Add a Podroid port forward
 *   linuxify docker clean                 Stop all + remove all forwards
 *   linuxify docker doctor                Diagnose docker subsystem
 *
 * The `run` subcommand implements the one-command UX: pass just an
 * image reference (e.g. `nginx` or `lscr.io/linuxserver/calibre-web:latest`)
 * and linuxify will:
 *   1. Detect the available runtime (Podroid preferred, fall back to
 *      proot-distro Docker).
 *   2. Pre-check that the image has a manifest for the host's arch
 *      (refuses to start a 20-minute pull that's guaranteed to fail).
 *   3. Auto-allocate a free host port from the state.docker port
 *      range (default 8000–8999) and persist the assignment so the
 *      same image gets the same port across restarts.
 *   4. Pull the image if not already cached.
 *   5. `docker run -d --name <slug> --restart unless-stopped
 *      -p <host>:<guest> <image>`.
 *   6. On Podroid: `podroid-forward add <guest> <host> tcp` so the
 *      container is reachable from the Android host and the LAN.
 *   7. Print the local URL (and the public URL if Podroid forwarded).
 *
 * The user can override any of those steps with flags:
 *   --name X         Override the auto-generated slug
 *   --port H:G       Force a specific host:guest port (no auto-allocate)
 *   --port G         Auto-allocate a host port for guest port G
 *   --volume H:C:rw  Bind-mount host path H to container path C (ro/rw)
 *   --env KEY=VAL    Pass an environment variable
 *   --restart P      Override restart policy (default: unless-stopped)
 *   --runtime R      Force Podroid / docker / podman
 *   --pull           Force re-pull even if cached
 *   --extra ARGS     Extra args to pass verbatim to docker run
 *
 * @packageDocumentation
 */

import { DockerEngine } from '../../docker/index.js';
import type { RunOptions, DockerRuntime, RestartPolicy, VolumeMount, EnvVar, PortMapping } from '../../docker/index.js';
import { EXIT_CODES } from '../../utils/constants.js';
import { confirm } from '../../utils/prompt.js';
import type { CommandContext } from '../context.js';

import type { RegisterCommandFn } from './index.js';

/**
 * Build a DockerEngine bound to the command's state store.
 */
async function getEngine(ctx: CommandContext): Promise<DockerEngine> {
  return new DockerEngine(ctx.stateStore);
}

/**
 * Entry point for `linuxify docker [subcommand] [args...]`.
 *
 * Commander hands us a single subcommand string + the rest of the args
 * as a variadic array; we dispatch on the subcommand.
 */
export async function runDocker(
  opts: Record<string, unknown>,
  ctx: CommandContext,
  subcommand: string | undefined,
  ...args: string[]
): Promise<number> {
  const out = ctx.output;

  if (!subcommand) {
    printHelp(out);
    return EXIT_CODES.OK;
  }

  const engine = await getEngine(ctx);

  switch (subcommand) {
    case 'init': {
      const runtime = opts.runtime as DockerRuntime | undefined;
      out.info('Initializing docker subsystem…');
      const result = await engine.init(runtime);
      if (result.success) {
        out.success(result.message);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.ENV_NOT_READY;
    }

    case 'run': {
      const image = args[0];
      if (!image) {
        out.error('Usage: linuxify docker run <image> [options]');
        out.info('  Example: linuxify docker run nginx');
        out.info('           linuxify docker run lscr.io/linuxserver/calibre-web:latest');
        return EXIT_CODES.GENERIC_ERROR;
      }

      const cleanOpts = parseRunOptions(opts, image);

      out.info(`Loading + running '${image}'…`);
      const result = await engine.run(cleanOpts);
      if (result.success) {
        out.success(result.message);
        out.info(`  URL: ${result.url}`);
        if (result.publicUrl) {
          out.info(`  Public: ${result.publicUrl}`);
        }
        out.info(`  Runtime: ${result.runtime}`);
        out.info(`  Container: ${result.name} (id: ${result.containerId})`);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'ps': {
      const containers = await engine.ps();
      if (containers.length === 0) {
        out.info('No linuxify-managed containers. Run: linuxify docker run <image>');
        return EXIT_CODES.OK;
      }
      out.info('');
      out.info('Containers:');
      for (const c of containers) {
        const icon = c.status === 'running' ? '✔' : c.status === 'stopped' ? '○' : '✖';
        out.info(`  ${icon} ${c.name.padEnd(20)} ${c.image.padEnd(40)} ${c.host_port}→${c.guest_port}  ${c.status}  [${c.runtime}]`);
      }
      return EXIT_CODES.OK;
    }

    case 'stop': {
      const name = args[0];
      if (!name) {
        out.error('Usage: linuxify docker stop <name>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const result = await engine.stop(name);
      if (result.success) {
        out.success(result.message);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'rm': {
      const name = args[0];
      if (!name) {
        out.error('Usage: linuxify docker rm <name>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const proceed = await confirm(`Remove '${name}'? This stops and deletes the container.`, false);
      if (!proceed) {
        out.info('Cancelled.');
        return EXIT_CODES.OK;
      }
      const result = await engine.rm(name);
      if (result.success) {
        out.success(result.message);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'logs': {
      const name = args[0];
      if (!name) {
        out.error('Usage: linuxify docker logs <name>');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const lines = typeof opts.lines === 'number' ? opts.lines : 50;
      const result = await engine.logs(name, lines);
      if (result.success) {
        out.info(result.message);
        out.info(result.logs);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'forward': {
      const guest = Number(args[0]);
      const host = Number(args[1]);
      if (!guest || !host) {
        out.error('Usage: linuxify docker forward <guest-port> <host-port>');
        out.info('  Note: forwarding is only needed on Podroid (the no-root backend).');
        return EXIT_CODES.GENERIC_ERROR;
      }
      const protocol = (opts.protocol === 'udp' ? 'udp' : 'tcp') as 'tcp' | 'udp';
      const result = await engine.forward(guest, host, protocol);
      if (result.success) {
        out.success(result.message);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'clean': {
      const proceed = await confirm('Stop ALL linuxify-managed containers and remove ALL port forwards?', false);
      if (!proceed) {
        out.info('Cancelled.');
        return EXIT_CODES.OK;
      }
      const result = await engine.clean();
      if (result.success) {
        out.success(result.message);
        return EXIT_CODES.OK;
      }
      out.error(result.message);
      return EXIT_CODES.STEP_FAILED;
    }

    case 'doctor': {
      const result = await engine.doctor();
      out.info('');
      out.info(`Docker: ${result.initialized ? '✔ Initialized' : '✖ Not initialized'}`);
      out.info(`Runtime: ${result.runtime.available ? `✔ ${result.runtime.kind}` : `✖ ${result.runtime.kind} (unavailable)`}`);
      if (result.runtime.version) {
        out.info(`  Version: ${result.runtime.version}`);
      }
      if (result.runtime.endpoint) {
        out.info(`  Endpoint: ${result.runtime.endpoint}`);
      }
      out.info(`Containers: ${result.containerCount}`);
      if (result.issues.length > 0) {
        out.info('');
        out.info('Issues:');
        for (const issue of result.issues) {
          out.info(`  ⚠ ${issue}`);
        }
      }
      return result.issues.length > 0 ? EXIT_CODES.ENV_NOT_READY : EXIT_CODES.OK;
    }

    case 'config': {
      // Parse flags into a patch object. If no flags are supplied, just
      // print the current config (read-only).
      //
      // Commander quirk: kebab-case option names like `--wake-lock` are
      // stored on the opts object in camelCase form (`opts.wakeLock`),
      // NOT in kebab-case. We use bracket access with the camelCase
      // key to retrieve each.
      const patch: {
        wakeLockEnabled?: boolean;
        portRangeStart?: number;
        portRangeEnd?: number;
        defaultRuntime?: DockerRuntime | null;
      } = {};

      if (typeof opts.wakeLock === 'string') {
        const v = opts.wakeLock;
        if (v === 'on' || v === 'true' || v === '1') {
          patch.wakeLockEnabled = true;
        } else if (v === 'off' || v === 'false' || v === '0') {
          patch.wakeLockEnabled = false;
        } else {
          out.error(`--wake-lock must be on|off; got '${v}'`);
          return EXIT_CODES.GENERIC_ERROR;
        }
      }

      if (typeof opts.portRange === 'string') {
        // Accept "START-END" (e.g. "9000-9999") or "START:END".
        const m = /^(\d+)[-:](\d+)$/.exec(opts.portRange.trim());
        if (!m) {
          out.error(`--port-range must be START-END (e.g. 9000-9999); got '${opts.portRange}'`);
          return EXIT_CODES.GENERIC_ERROR;
        }
        patch.portRangeStart = Number(m[1]);
        patch.portRangeEnd = Number(m[2]);
      }

      if (typeof opts.defaultRuntime === 'string') {
        const v = opts.defaultRuntime;
        if (v === 'podroid' || v === 'docker' || v === 'podman') {
          patch.defaultRuntime = v as DockerRuntime;
        } else if (v === 'auto' || v === 'null') {
          patch.defaultRuntime = null;
        } else {
          out.error(`--default-runtime must be podroid|docker|podman|auto; got '${v}'`);
          return EXIT_CODES.GENERIC_ERROR;
        }
      }

      if (opts.reset === true) {
        // Reset everything to defaults.
        const { DEFAULT_DOCKER_STATE } = await import('../../state/index.js');
        patch.wakeLockEnabled = DEFAULT_DOCKER_STATE.wake_lock_enabled;
        patch.portRangeStart = DEFAULT_DOCKER_STATE.port_range_start;
        patch.portRangeEnd = DEFAULT_DOCKER_STATE.port_range_end;
        patch.defaultRuntime = DEFAULT_DOCKER_STATE.default_runtime;
      }

      const hasChanges = Object.keys(patch).length > 0;
      if (!hasChanges) {
        // No flags — display current config.
        const cfg = await engine.getConfig();
        out.info('');
        out.info('Docker configuration:');
        out.info(`  Initialized:        ${cfg.initialized ? '✔ yes' : '✖ no'}${cfg.initializedAt ? ` (at ${cfg.initializedAt})` : ''}`);
        out.info(`  Default runtime:    ${cfg.defaultRuntime ?? '(auto-detect)'}`);
        out.info(`  Port range:         ${cfg.portRangeStart}-${cfg.portRangeEnd} (next hint: ${cfg.nextPortHint})`);
        out.info(`  Wake lock:          ${cfg.wakeLockEnabled ? '✔ on' : '✖ off'}`);
        out.info(`  Container count:    ${cfg.containerCount}`);
        out.info('');
        out.info('To change a setting, pass one of:');
        out.info('  --wake-lock on|off');
        out.info('  --port-range START-END  (e.g. --port-range 9000-9999)');
        out.info('  --default-runtime podroid|docker|podman|auto');
        out.info('  --reset                  (restore defaults)');
        return EXIT_CODES.OK;
      }

      try {
        const result = await engine.setConfig(patch);
        out.success(result.message);
        const u = result.updated;
        out.info(`  Default runtime: ${u.defaultRuntime ?? '(auto)'}`);
        out.info(`  Port range:      ${u.portRangeStart}-${u.portRangeEnd}`);
        out.info(`  Wake lock:       ${u.wakeLockEnabled ? 'on' : 'off'}`);
        return EXIT_CODES.OK;
      } catch (err) {
        const e = err as { code?: string; message: string };
        out.error(`Failed to update config: ${e.message}`);
        return EXIT_CODES.GENERIC_ERROR;
      }
    }

    default:
      out.error(`Unknown docker subcommand: ${subcommand}`);
      printHelp(out);
      return EXIT_CODES.GENERIC_ERROR;
  }
}

/**
 * Parse commander options into a {@link RunOptions} object.
 *
 * Flags handled:
 *   --name X
 *   --port H:G   or --port G   (repeatable)
 *   --volume H:C:rw  (repeatable)
 *   --env KEY=VAL   (repeatable)
 *   --restart P
 *   --runtime R
 *   --pull
 *   --extra "args string"
 */
function parseRunOptions(opts: Record<string, unknown>, image: string): RunOptions {
  const result: RunOptions = { image };

  if (typeof opts.name === 'string' && opts.name.length > 0) {
    result.name = opts.name;
  }

  // --port can be specified multiple times → commander collects into array.
  const portStrs = toArray(opts.port);
  if (portStrs.length > 0) {
    result.ports = portStrs.map(parsePort).filter((p): p is PortMapping => p !== null);
  }

  // --volume can be specified multiple times.
  const volStrs = toArray(opts.volume);
  if (volStrs.length > 0) {
    result.volumes = volStrs.map(parseVolume).filter((v): v is VolumeMount => v !== null);
  }

  // --env can be specified multiple times.
  const envStrs = toArray(opts.env);
  if (envStrs.length > 0) {
    result.env = envStrs.map(parseEnv).filter((e): e is EnvVar => e !== null);
  }

  if (typeof opts.restart === 'string') {
    const valid: RestartPolicy[] = ['no', 'unless-stopped', 'always', 'on-failure'];
    if (valid.includes(opts.restart as RestartPolicy)) {
      result.restart = opts.restart as RestartPolicy;
    }
  }

  if (typeof opts.runtime === 'string') {
    const valid: DockerRuntime[] = ['podroid', 'docker', 'podman'];
    if (valid.includes(opts.runtime as DockerRuntime)) {
      result.runtime = opts.runtime as DockerRuntime;
    }
  }

  if (opts.pull === true) {
    result.pull = true;
  }

  if (typeof opts.extra === 'string' && opts.extra.length > 0) {
    result.extraArgs = opts.extra.split(/\s+/).filter((s) => s.length > 0);
  }

  return result;
}

/**
 * Parse a `--port` flag value into a PortMapping.
 *
 * Accepted forms:
 *   "80"           → { guestPort: 80 }             (auto-allocate host)
 *   "8080:80"      → { hostPort: 8080, guestPort: 80 }
 *   "8080:80/tcp"  → { hostPort: 8080, guestPort: 80 } (protocol ignored by PortMapping)
 */
function parsePort(s: string): PortMapping | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Strip optional /tcp or /udp suffix.
  const noProto = trimmed.replace(/\/(tcp|udp)$/i, '');
  const parts = noProto.split(':');
  if (parts.length === 1) {
    const guest = Number(parts[0]);
    if (!Number.isInteger(guest) || guest < 1 || guest > 65535) return null;
    return { guestPort: guest };
  }
  if (parts.length === 2) {
    const host = Number(parts[0]);
    const guest = Number(parts[1]);
    if (!Number.isInteger(host) || host < 1024 || host > 65535) return null;
    if (!Number.isInteger(guest) || guest < 1 || guest > 65535) return null;
    return { hostPort: host, guestPort: guest };
  }
  return null;
}

/**
 * Parse a `--volume` flag value into a VolumeMount.
 *
 * Accepted forms:
 *   "/host/path:/container/path"        → mode defaults to 'rw'
 *   "/host/path:/container/path:ro"     → read-only
 *   "/host/path:/container/path:rw"     → read-write (explicit)
 */
function parseVolume(s: string): VolumeMount | null {
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const [hostPath, containerPath, modeRaw] = parts;
  if (!hostPath || !containerPath) return null;
  const mode: 'ro' | 'rw' = modeRaw === 'ro' ? 'ro' : 'rw';
  return { hostPath, containerPath, mode };
}

/**
 * Parse a `--env` flag value into an EnvVar.
 *
 * Accepted form: "KEY=VALUE" (the value may contain '=' characters).
 */
function parseEnv(s: string): EnvVar | null {
  const eqIdx = s.indexOf('=');
  if (eqIdx < 0) return null;
  const key = s.slice(0, eqIdx);
  const value = s.slice(eqIdx + 1);
  if (!key) return null;
  return { key, value };
}

/**
 * Coerce a possibly-singleton option value into an array of strings.
 * Commander passes single-occurrence string options as a string and
 * repeatable options (with `.option('--x <val>', ..., 'append')`) as
 * an array. This helper normalizes both into an array.
 */
function toArray(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v as string[];
  if (typeof v === 'string') return [v];
  return [];
}

/**
 * Print the docker subcommand help.
 */
function printHelp(out: CommandContext['output']): void {
  out.info('Linuxify Docker — one-command load + run any docker image');
  out.info('');
  out.info('Commands:');
  out.info('  linuxify docker init                      Prepare the docker runtime');
  out.info('  linuxify docker run <image> [options]     Load + run any docker image');
  out.info('  linuxify docker ps                         List running containers');
  out.info('  linuxify docker stop <name>                Stop a container');
  out.info('  linuxify docker rm <name>                  Remove a container');
  out.info('  linuxify docker logs <name> [--lines N]    View container logs');
  out.info('  linuxify docker forward <g> <h>            Add a Podroid port forward');
  out.info('  linuxify docker clean                      Stop all + remove all forwards');
  out.info('  linuxify docker config [options]           Show / set docker config');
  out.info('  linuxify docker doctor                     Diagnose docker subsystem');
  out.info('');
  out.info('Run options (for `docker run`):');
  out.info('  --name <name>                Container name (auto-slug if omitted)');
  out.info('  --port <[H:]G[/proto]>       Port mapping (repeatable; default 80)');
  out.info('  --volume <H:C[:ro|rw]>       Volume mount (repeatable)');
  out.info('  --env <KEY=VAL>               Environment variable (repeatable)');
  out.info('  --restart <policy>            no|unless-stopped|always|on-failure');
  out.info('  --runtime <backend>           podroid|docker|podman (auto-detect)');
  out.info('  --pull                         Force re-pull even if cached');
  out.info('  --extra "<args>"              Extra args verbatim to docker run');
  out.info('');
  out.info('Examples:');
  out.info('  linuxify docker run nginx');
  out.info('  linuxify docker run freshrss/freshrss --port 80:80');
  out.info('  linuxify docker run lscr.io/linuxserver/calibre-web:latest \\');
  out.info('    --volume ~/Downloads/calibre-library:/books:ro');
  out.info('  linuxify docker run iib0011/omni-tools:latest --port 8080:80');
}

/**
 * Registration helper called by `registerAllCommands`.
 *
 * Commander quirk: `--port`, `--volume`, `--env` are repeatable
 * (`'append'` action), so each occurrence is pushed to an array.
 */
export const registerDockerCommand: RegisterCommandFn = (program, getCtx, setExit): void => {
  const cmd = program
    .command('docker [subcommand] [args...]')
    .description('Docker subsystem — one-command load + run any docker image.')
    .allowUnknownOption(true)
    .option('--name <name>', 'Container name (auto-slug if omitted)')
    .option('--port <[H:]G[/proto]>', 'Port mapping (repeatable)', 'append')
    .option('--volume <H:C[:ro|rw]>', 'Volume mount (repeatable)', 'append')
    .option('--env <KEY=VAL>', 'Environment variable (repeatable)', 'append')
    .option('--restart <policy>', 'Restart policy (no|unless-stopped|always|on-failure)')
    .option('--runtime <backend>', 'Force runtime for `docker run` (podroid|docker|podman)')
    .option('--pull', 'Force re-pull even if cached')
    .option('--extra <args>', 'Extra args verbatim to docker run')
    .option('--lines <n>', 'Number of log lines (for `docker logs`)', Number)
    .option('--protocol <proto>', 'Protocol for `docker forward` (tcp|udp)')
    // `docker config` flags:
    .option('--wake-lock <on|off>', 'Enable/disable the wake lock (for `docker config`)')
    .option('--port-range <START-END>', 'Set the auto-allocated port range (for `docker config`)')
    .option('--default-runtime <backend>', 'Force default runtime: podroid|docker|podman|auto (for `docker config`)')
    .option('--reset', 'Reset all docker config to defaults (for `docker config`)');

  cmd.action(async (subcommand: string | undefined, args: string[], opts: Record<string, unknown>) => {
    const ctx = await getCtx();
    const sub = subcommand;
    const rest = Array.isArray(args) ? args : [];
    const code = await runDocker(opts ?? {}, ctx, sub, ...rest);
    setExit(code);
  });
};
