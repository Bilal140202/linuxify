/**
 * Docker subsystem — wraps Podroid and proot-distro Docker behind a
 * single `linuxify docker` CLI surface so the user can run any docker
 * image with one command.
 *
 * @module linuxify/docker
 *
 * Architecture:
 *  - {@link DockerEngine} — main orchestrator (run/ps/stop/rm/logs/forward/clean).
 *  - {@link detectRuntime} / {@link detectPodroid} / {@link detectProotDistro} —
 *    backend detection (Podroid preferred, proot-distro fallback).
 *  - {@link PodroidClient} / {@link ProotDockerClient} — runtime-specific
 *    wrappers around the actual docker/podman CLI.
 *  - {@link allocatePort} / {@link reservePort} — host port allocation
 *    from the state.docker port range.
 *  - {@link RunOptions} / {@link RunResult} / {@link RuntimeInfo} —
 *    type surface the CLI layer uses.
 *
 * @packageDocumentation
 */

export { DockerEngine, shellQuote } from './engine.js';
export type { DockerOperation } from './engine.js';

export {
  detectRuntime,
  detectPodroid,
  detectProotDistro,
  detectRuntimeKind,
  getDockerArch,
} from './detect.js';

export { PodroidClient, PODROID_SSH_PORT, PODROID_SSH_USER, PODROID_SSH_PASSWORD } from './podroid-cli.js';
export { ProotDockerClient } from './proot-cli.js';

export { allocatePort, reservePort, isPortFree } from './port-allocator.js';
export type { PortAllocation } from './port-allocator.js';

export {
  imageToSlug,
  DEFAULT_RESTART_POLICY,
  DEFAULT_PORT_RANGE_START,
  DEFAULT_PORT_RANGE_END,
  PortMappingSchema,
} from './config.js';
export type {
  DockerRuntime,
  RestartPolicy,
  VolumeMount,
  EnvVar,
  PortMapping,
  RunOptions,
  RunResult,
  RuntimeInfo,
} from './config.js';
