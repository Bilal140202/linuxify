/**
 * Docker subsystem — configuration types and option schemas.
 *
 * @module linuxify/docker/config
 *
 * The docker subsystem wraps two underlying runtimes (Podroid and
 * proot-distro Docker) behind a single `linuxify docker` CLI surface. The
 * `RunOptions` shape is what `linuxify docker run <image>` accepts; the
 * `RuntimeInfo` shape is what the detector produces so the engine knows
 * which backend to talk to.
 *
 * Design choices documented here:
 *  - `--restart unless-stopped` is the default. Android background-process
 *    killing is the #1 operational killer of long-running containers; the
 *    `--restart` flag combined with a wake lock is the survival mechanism.
 *  - `--port` is optional. When omitted, the engine allocates a free host
 *    port from the state.docker port range (default 8000–8999) and
 *    persists the assignment so the same image re-uses the same port
 *    across restarts (stable URL, easier bookmarking).
 *  - `--volume` accepts host paths under `~/Downloads/` as the canonical
 *    Android shared-storage bind-mount target. Podroid shares Android's
 *    `Downloads/` folder with the Alpine guest, so paths under that
 *    folder are reachable from both sides.
 */

import { z } from 'zod';

/**
 * The docker runtime that backed a particular container or that the
 * engine should target for a particular run. Mirrors
 * `state.docker.default_runtime` in `state/schema.ts`.
 */
export type DockerRuntime = 'podroid' | 'docker' | 'podman';

/**
 * Restart policy to pass through to the underlying container runtime.
 * Mirrors docker's own enum.
 */
export type RestartPolicy = 'no' | 'unless-stopped' | 'always' | 'on-failure';

/**
 * Volume mount spec accepted by `linuxify docker run --volume`.
 *
 * The host path is resolved relative to the user's home inside the
 * runtime's filesystem (Android home for Podroid; the proot-distro
 * `$HOME` for proot-distro docker). The container path is an absolute
 * path inside the image. `mode` is read-only or read-write.
 */
export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  mode: 'ro' | 'rw';
}

/**
 * Environment variable to pass through to the container. The CLI parses
 * `--env KEY=VALUE` strings into this shape.
 */
export interface EnvVar {
  key: string;
  value: string;
}

/**
 * Schema for a single port-mapping spec (`--port H:G` or `--port G`).
 *
 * If only the guest port is supplied, the engine auto-allocates a host
 * port from the configured range. Both ports must be in the
 * non-privileged range (>= 1024) to avoid the Android root requirement.
 */
export const PortMappingSchema = z.object({
  hostPort: z.number().int().min(1024).max(65535).optional(),
  guestPort: z.number().int().min(1).max(65535),
});
export type PortMapping = z.infer<typeof PortMappingSchema>;

/**
 * Options accepted by {@link DockerEngine.run}. All fields are populated
 * by the CLI command from its flags; the engine itself never reads
 * `process.argv`.
 */
export interface RunOptions {
  /** Image reference, e.g. `nginx`, `lscr.io/linuxserver/calibre-web:latest`. */
  image: string;
  /** Optional container name (auto-generated slug if omitted). */
  name?: string;
  /** Optional port mapping(s); defaults to a single 80→auto-host-port. */
  ports?: PortMapping[];
  /** Optional volume mounts; defaults to none. */
  volumes?: VolumeMount[];
  /** Optional environment variables; defaults to none. */
  env?: EnvVar[];
  /** Restart policy; defaults to `unless-stopped` (matches research rec). */
  restart?: RestartPolicy;
  /** Force-pull the image even if it's already cached locally. */
  pull?: boolean;
  /** Detach (default true; the only mode the engine supports). */
  detach?: boolean;
  /** Override the auto-detected runtime. */
  runtime?: DockerRuntime;
  /** Extra args to pass through verbatim to the underlying runtime. */
  extraArgs?: string[];
}

/**
 * Result of a `docker run` invocation. Returned to the CLI for printing.
 */
export interface RunResult {
  /** Whether the container actually started. */
  success: boolean;
  /** The name the engine registered the container under. */
  name: string;
  /** The container ID assigned by the runtime (may be empty on failure). */
  containerId: string;
  /** The host port the engine bound (or attempted to bind). */
  hostPort: number;
  /** The guest port inside the container. */
  guestPort: number;
  /** The runtime that backed this run. */
  runtime: DockerRuntime;
  /** Local URL where the user can reach the exposed service. */
  url: string;
  /** Public URL if a forward was set up, else null. */
  publicUrl: string | null;
  /** Human-readable message for the user. */
  message: string;
}

/**
 * Information about a detected docker runtime. Produced by
 * `detectRuntime()` and consumed by the engine to decide which CLI to
 * shell out to.
 */
export interface RuntimeInfo {
  /** The runtime kind. */
  kind: DockerRuntime;
  /** Whether the runtime is currently available (binary present + daemon up). */
  available: boolean;
  /** Version string from the runtime (e.g. "Docker 29.5.3" or "podman 5.0.0"). */
  version: string | null;
  /** For Podroid: the phone IP + SSH port (9922). For proot-distro: the distro name. */
  endpoint: string;
  /** Optional path to the CLI binary (for diagnostics). */
  binaryPath: string | null;
  /** Why `available` is false (when false). */
  unavailableReason?: string;
}

/**
 * Default port range for auto-allocation. Matches the constants in
 * `state/schema.ts` `DEFAULT_DOCKER_STATE`. Exported here so the docker
 * engine doesn't reach into state-schema internals.
 */
export const DEFAULT_PORT_RANGE_START = 8000;
export const DEFAULT_PORT_RANGE_END = 8999;

/**
 * Default restart policy applied to every `linuxify docker run` unless
 * the user overrides with `--restart`. Matches the recommendation from
 * the howtogeek research: `--restart unless-stopped` combined with a
 * wake lock is the survival mechanism against Android background-process
 * killing.
 */
export const DEFAULT_RESTART_POLICY: RestartPolicy = 'unless-stopped';

/**
 * Auto-generate a slug from an image reference to use as the container
 * name when the user doesn't supply one.
 *
 * Examples:
 *   - `nginx` → `nginx`
 *   - `lscr.io/linuxserver/calibre-web:latest` → `calibre-web`
 *   - `iib0011/omni-tools:latest` → `omni-tools`
 *   - `freshrss/freshrss:edge` → `freshrss`
 *
 * The slug strips registry prefix and tag, picks the last path component,
 * and de-duplicates on collision by appending `-2`, `-3`, etc. (handled
 * by the engine when it sees an existing container with the same slug).
 */
export function imageToSlug(image: string): string {
  // Strip registry prefix: `lscr.io/linuxserver/calibre-web:latest`
  // → `linuxserver/calibre-web:latest`
  const noRegistry = image.includes('/')
    && image.split('/')[0]!.includes('.')
    ? image.split('/').slice(1).join('/')
    : image;
  // Strip tag: `linuxserver/calibre-web:latest` → `linuxserver/calibre-web`
  const noTag = noRegistry.split(':')[0]!;
  // Pick the last path component: `linuxserver/calibre-web` → `calibre-web`
  const last = noTag.split('/').pop() ?? noTag;
  // Sanitize: keep only lowercase letters, digits, and hyphens.
  return last.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'container';
}
