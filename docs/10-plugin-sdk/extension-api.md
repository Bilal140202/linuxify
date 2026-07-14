# Extension API Reference

> **Audience**: AI coding agents implementing the plugin API surface, and plugin authors who need the precise TypeScript signatures of every method, hook, and type.
>
> **Scope**: This is the TypeScript API reference for the `LinuxifyContext` object passed to every plugin. For prose-level discussion of what plugins are and how they are loaded, see [plugin-sdk.md](plugin-sdk.md). For the `DistroProvider` and `RuntimeProvider` interfaces that custom-distro and custom-runtime plugins implement, see [../05-bootstrap/distro-management.md](../05-bootstrap/distro-management.md) §1 and [../06-launcher/runtime-management.md](../06-launcher/runtime-management.md) §2 respectively. This document is reference-style: each section is a self-contained API description with TypeScript signatures, parameter tables, and a short example.

## 1. `LinuxifyContext` Interface

The `LinuxifyContext` is the single object passed to every plugin's `init()` and to every hook invocation. It is the plugin's only API surface; plugins that import Linuxify internals directly (rather than going through the context) break the version-compatibility guarantee. The context is constructed once per Linuxify process and is shared across all plugins.

```typescript
// src/plugin/context.ts
export interface LinuxifyContext {
  /** Plugin identity (name, version, manifest path). */
  readonly plugin: PluginIdentity;

  /** Structured logger; writes to both core log and per-plugin log. */
  readonly logger: Logger;

  /** Read/write access to ~/.linuxify/config.toml. */
  readonly config: Config;

  /** Read/write access to ~/.linuxify/state.json (atomic). */
  readonly state: State;

  /** Command execution (host and inside proot). */
  readonly runtime: Runtime;

  /** Distro registry. */
  readonly distros: Distros;

  /** Package registry (the local install state, not the upstream registry). */
  readonly packages: Packages;

  /** Patcher API; register custom patch types here. */
  readonly patches: Patches;

  /** Doctor API; register custom checks here. */
  readonly doctor: Doctor;

  /** CLI API; register custom subcommands and global flags here. */
  readonly cli: CLI;

  /** Re-exported utilities (no need to depend on these packages directly). */
  readonly fs: typeof import('fs/promises');
  readonly net: NetUtil;
  readonly crypto: typeof import('crypto');
  readonly yaml: { parse: (s: string) => unknown; stringify: (v: unknown) => string; };
  readonly toml: { parse: (s: string) => unknown; stringify: (v: unknown) => string; };

  /** Custom error classes plugins should throw (see §13). */
  readonly errors: typeof import('./errors');
}
```

The `plugin` property identifies *which* plugin is being invoked (since the same context shape is passed to every plugin, the plugin needs a way to know "this is me"). It contains `name`, `version`, `manifestPath`, and `rootDir` (the plugin's installation directory). Plugins use `ctx.plugin.rootDir` to locate bundled assets (e.g. `path.join(ctx.plugin.rootDir, 'assets', 'default-config.toml')`).

## 2. `Logger` API

```typescript
export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;

  /** Create a child logger with extra context metadata. */
  child(meta: Record<string, unknown>): Logger;

  /** Programmatically set the minimum level. Default: 'info'. */
  setLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'): void;
}
```

The logger is structured: every log line is JSON with `timestamp`, `level`, `plugin`, `message`, and any `meta` fields the plugin passed. Logs are written to `~/.linuxify/logs/linuxify.log` (tagged with the plugin name) and to `~/.linuxify/logs/plugins/<plugin-name>.log` (untagged). Both files are rotated at 5 MB and retained for 30 days (see [../03-cli/cli-specification.md](../03-cli/cli-specification.md) §8).

Redaction is automatic. The logger inspects every `meta` object (and recursively) and redacts string values whose key matches `/^(authorization|bearer|token|secret|password|api[_-]?key|slack|github|aws)/i` with `[REDACTED]`. Strings whose value matches `/^(Bearer |ghp_|sk-|AKIA)/` are also redacted regardless of key. Plugins do not need to manually redact; if a plugin accidentally logs a secret, the logger catches it. The redaction patterns are documented in [../03-cli/cli-specification.md](../03-cli/cli-specification.md) §8.

```typescript
// Example: logging with structured metadata
ctx.logger.info('Java runtime installed', {
  version: '21.0.1-tem',
  duration_ms: 45200,
  distro: ctx.distros.getActive().name
});

// Output (in the JSON log file):
// {"timestamp":"2025-05-15T14:32:01Z","level":"info","plugin":"linuxify-plugin-java",
//  "message":"Java runtime installed","version":"21.0.1-tem","duration_ms":45200,"distro":"ubuntu"}
```

## 3. `Config` API

```typescript
export interface Config {
  /** Read a config value. Key is dot-notation, e.g. 'telemetry.enabled'. */
  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string, defaultValue: T): T;

  /** Set a config value. Atomic write; triggers watchers. */
  set(key: string, value: unknown): Promise<void>;

  /** Delete a config key. Returns true if the key existed. */
  delete(key: string): Promise<boolean>;

  /** Watch a config key for changes. Returns an unsubscribe function. */
  watch(key: string, cb: (newValue: unknown, oldValue: unknown) => void): () => void;

  /** Read the entire config as a plain object. */
  all(): Record<string, unknown>;
}
```

The config is backed by `~/.linuxify/config.toml`. Reads are cached in memory for the lifetime of the Linuxify process; writes are atomic (write-to-tmp, fsync, rename) and propagate to other Linuxify processes via a file-watcher (inotify on Linux). The `watch()` callback fires only for changes made by other processes; in-process `set()` calls do not trigger the plugin's own watchers (to avoid feedback loops).

The `key` is dot-notation regardless of the underlying TOML structure. `ctx.config.get('telemetry.enabled')` reads the `enabled` field of the `[telemetry]` table. Plugin-specific config lives under `[plugin.<plugin-name>]`, accessed as `ctx.config.get('plugin.linuxify-plugin-java.default_version')`.

```typescript
// Example: plugin reads its own config, falls back to a default
const defaultVersion = ctx.config.get('plugin.linuxify-plugin-java.default_version', '21');

// Example: plugin watches a config key for live updates
const unsubscribe = ctx.config.watch('telemetry.enabled', (newVal) => {
  ctx.logger.info('Telemetry toggled', { enabled: newVal });
});
// on shutdown:
unsubscribe();
```

## 4. `State` API

```typescript
export interface State {
  /** Read the entire state.json as a plain object. */
  get(): Record<string, unknown>;

  /** Read a single top-level key. */
  get<T = unknown>(key: string): T | undefined;

  /** Atomically merge a partial update into state.json. */
  update(partial: Record<string, unknown>): Promise<void>;

  /** Acquire an exclusive lock for multi-step state updates. */
  lock(): Promise<LockHandle>;
}

export interface LockHandle {
  release(): Promise<void>;
  /** Extend the lock's TTL (default 5s, max 30s). */
  extend(ms: number): Promise<void>;
}
```

`state.json` is the global runtime state (active distro, installed runtimes, package manifest, etc. — see [../02-architecture/system-architecture.md](../02-architecture/system-architecture.md) §4.1). Reads return a snapshot; the underlying file may change between reads. For atomic read-modify-write, use `lock()` to acquire the global `~/.linuxify/.lock` flock, then `get()`, modify, `update()`, then `release()`. The lock has a 5-second default TTL; long-running operations should call `extend()` periodically.

```typescript
// Example: atomic state update
const handle = await ctx.state.lock();
try {
  const current = ctx.state.get('my_plugin_state', { counter: 0 });
  await ctx.state.update({ my_plugin_state: { counter: current.counter + 1 } });
} finally {
  await handle.release();
}
```

## 5. `Runtime` API

```typescript
export interface Runtime {
  /** Execute a command on the host (Termux), returning the result. */
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Spawn a command on the host with streaming stdio. */
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<ChildProcess>;

  /** Execute a command inside the named distro (via proot-distro login). */
  inDistro(distro: string | 'active', cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Execute a command inside a package's prefix (its venv, its node_modules, etc.). */
  inPackage(pkg: string, cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;

  /** Register a runtime provider (custom-runtime plugins call this in init()). */
  registerProvider(name: string, provider: RuntimeProvider): void;

  /** Look up a registered runtime provider. */
  getProvider(name: string): RuntimeProvider | null;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;        // default: no timeout
  stdin?: string;            // default: empty
  captureStdout?: boolean;   // default: true
  captureStderr?: boolean;   // default: true
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;           // if killed by signal
  durationMs: number;
}
```

The `exec` method is the workhorse: it spawns a child process, captures stdout/stderr, enforces a timeout, and returns the result. It is the recommended way for plugins to run shell commands. The `spawn` method is for streaming use cases (long-running processes, processes whose stdout must be piped to the user's terminal); it returns a Node `ChildProcess` that the plugin manages itself.

`inDistro('active', ...)` is sugar for `inDistro(ctx.distros.getActive().name, ...)` — the common case of "run this in whatever distro is currently active." `inDistro('ubuntu', ...)` runs in Ubuntu even if Debian is active (useful for cross-distro doctor checks). `inPackage('cline', ...)` runs in cline's installation prefix with cline's runtime on `PATH` — useful for running `cline --version` to verify an install.

## 6. `Distros` API

```typescript
export interface Distros {
  /** List all known distros (built-in + plugin-registered). */
  list(): DistroInfo[];

  /** List only installed distros. */
  listInstalled(): DistroInfo[];

  /** Get the active distro (the one `linuxify use` last selected). */
  getActive(): DistroInfo;

  /** Get a specific distro by name; throws if not registered. */
  get(name: string): DistroInfo;

  /** Install a distro (downloads rootfs, runs first-boot). */
  install(name: string, opts?: InstallOptions): Promise<InstallResult>;

  /** Uninstall a distro (deletes its rootfs; refuses if active). */
  uninstall(name: string): Promise<UninstallResult>;

  /** Register a custom distro provider (custom-distro plugins call this in init()). */
  registerProvider(name: string, provider: DistroProvider): void;
}

export interface DistroInfo {
  name: string;              // 'ubuntu', 'debian', 'arch', 'alpine', 'fedora'
  version: string;
  installed: boolean;
  active: boolean;
  provider: 'builtin' | string;   // 'builtin' or plugin name
}
```

Custom-distro plugins call `registerProvider` in their `init()` (see [plugin-sdk.md](plugin-sdk.md) §10 for the FedorARM example). Once registered, the distro is available via `linuxify use <name>` and `ctx.distros.list()` includes it. Built-in distros are pre-registered before any plugin's `init()` runs, so plugins can safely call `ctx.distros.get('ubuntu')` in their `init()`.

## 7. `Packages` API

```typescript
export interface Packages {
  /** List installed packages. */
  list(): PackageInfo[];

  /** Get a single installed package by name; throws if not installed. */
  get(name: string): PackageInfo;

  /** Install a package from the registry (or from a local YAML with `opts.local`). */
  install(name: string, opts?: InstallOptions): Promise<InstallResult>;

  /** Uninstall a package. */
  uninstall(name: string, opts?: UninstallOptions): Promise<UninstallResult>;

  /** Search the local registry cache. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export interface PackageInfo {
  name: string;
  version: string;
  runtime: string;
  runtimeVersion: string;
  installedAt: string;       // ISO date
  patches: string[];         // applied patch IDs
}
```

The `install` method is what powers `linuxify add`; plugins that want to install packages (e.g. the team-onboarding plugin in [plugin-sdk.md](plugin-sdk.md) §9) call this. The `opts.local` field accepts a path to a YAML file, replicating `linuxify add ./my-package.yml`. The `opts.yes` field bypasses the permissions prompt (CI use).

## 8. `Patches` API

```typescript
export interface Patches {
  /** List patches declared by a package (from its YAML). */
  list(pkg: string): Patch[];

  /** Apply a specific patch to a package. */
  apply(pkg: string, patchId: string, opts?: ApplyOptions): Promise<PatchResult>;

  /** Roll back a previously-applied patch. */
  rollback(pkg: string, patchId: string): Promise<RollbackResult>;

  /** Register a custom patch type (custom-patch plugins call this in init()). */
  registerType(name: string, handler: PatchTypeHandler): void;
}

export interface PatchTypeHandler {
  /** Apply the patch to a file; return the new file contents. */
  apply(filePath: string, contents: Buffer, patch: Patch): Promise<Buffer>;

  /** Reverse the patch (for rollback). */
  reverse(filePath: string, contents: Buffer, patch: Patch): Promise<Buffer>;

  /** Verify the patch was applied correctly. */
  verify(filePath: string, contents: Buffer, patch: Patch): Promise<boolean>;
}
```

Custom patch types are how a plugin extends the patcher beyond the built-in `regex`/`ast`/`sed`/`binary` (see [../08-patcher/patcher-engine.md](../08-patcher/patcher-engine.md)). A `jvm-bytecode` patch type, for example, would register a handler that uses a JVM bytecode library to patch `.class` files. Once registered, a package YAML can declare `type: jvm-bytecode` in a patch and the patcher will dispatch to the plugin's handler.

## 9. `Doctor` API

```typescript
export interface Doctor {
  /** Register a custom doctor check (custom plugins call this in init()). */
  registerCheck(check: DoctorCheck): void;

  /** Run a single check by ID; returns the result. */
  runCheck(id: string): Promise<DoctorResult>;

  /** Run a profile (a named group of checks). Built-in: 'default', 'quick', 'full'. */
  runProfile(name: string): Promise<DoctorResult[]>;
}

export interface DoctorCheck {
  id: string;                // e.g. 'java.runtime'
  name: string;              // human-readable label
  category: 'bootstrap' | 'runtime' | 'package' | 'compat' | 'team';
  run: (ctx: LinuxifyContext) => Promise<DoctorResult>;
  fixCommand?: string;       // suggested fix
  fixSeverity?: 'safe' | 'unsafe';
}
```

A custom doctor check is an object with an `id`, a `name`, a `category`, and a `run` function that returns a `DoctorResult`. The `run` function receives the same `LinuxifyContext` that hooks receive. The check is invoked during `linuxify doctor` (or `linuxify doctor <category>` for category-scoped runs); the result is merged into the doctor output alongside built-in checks.

```typescript
// Example: registering a team-specific doctor check
ctx.doctor.registerCheck({
  id: 'team.gitconfig',
  name: '~/.gitconfig present',
  category: 'team',
  run: async (ctx) => {
    const result = await ctx.runtime.inDistro('active', 'bash', ['-c', 'test -f ~/.gitconfig && grep -q user.email ~/.gitconfig']);
    return {
      id: 'team.gitconfig',
      status: result.exitCode === 0 ? 'ok' : 'warn',
      message: result.exitCode === 0 ? 'gitconfig OK' : 'Missing ~/.gitconfig or user.email not set'
    };
  },
  fixCommand: 'git config --global user.email "engineer@myteam.com"',
  fixSeverity: 'safe'
});
```

## 10. `CLI` API

```typescript
export interface CLI {
  /** Register a custom subcommand. Returns the command name. */
  registerCommand(name: string, handler: CommandHandler, options: CommandOptions): string;

  /** Register a global flag (visible on all subcommands). Use sparingly. */
  registerFlag(name: string, spec: FlagSpec): void;
}

export type CommandHandler = (args: ParsedArgs, ctx: LinuxifyContext) => Promise<number>;

export interface CommandOptions {
  description: string;
  usage?: string;
  flags?: Record<string, FlagSpec>;
  examples?: string[];
  category?: 'setup' | 'package' | 'exec' | 'diag' | 'config' | 'plugin' | 'team';
}

export interface FlagSpec {
  type: 'boolean' | 'string' | 'number' | 'array';
  description: string;
  default?: unknown;
  alias?: string;            // short form, e.g. 'v' for --verbose
  required?: boolean;
}

export interface ParsedArgs {
  _: string[];               // positional args
  flags: Record<string, unknown>;
}
```

Custom commands are how plugins extend the Linuxify CLI surface (see [plugin-sdk.md](plugin-sdk.md) §9 for the team-onboarding example). A plugin's `init()` calls `ctx.cli.registerCommand('my-team-onboard', handler, options)`; the next `linuxify` invocation recognizes `linuxify my-team-onboard` as a valid subcommand. The command appears in `linuxify --help` under its `category`.

The `registerFlag` method is more aggressive: it adds a flag to every subcommand's parser. This is rarely needed and should be used sparingly, because it pollutes the help output of every command. The intended use case is team-wide policy flags (e.g. `--team-strict` that enables stricter doctor checks across all subcommands).

## 11. Hook Signatures

The full TypeScript signatures for every hook (referenced from [plugin-sdk.md](plugin-sdk.md) §7):

```typescript
// src/plugin/hooks.ts

import type { Package, Distro, Runtime as RuntimeInfo, Patch, DoctorResult } from './types';

export type PreInstallHook = (
  pkg: Package,
  distro: Distro,
  runtime: RuntimeInfo
) => Promise<InstallPlan | void>;

export type PostInstallHook = (
  pkg: Package,
  distro: Distro,
  runtime: RuntimeInfo,
  result: InstallResult
) => Promise<void>;

export type PrePatchHook = (
  pkg: Package,
  patchList: Patch[]
) => Promise<Patch[] | void>;

export type PostPatchHook = (
  pkg: Package,
  patchResults: PatchResult[]
) => Promise<PatchResult[] | void>;

export type PreRunHook = (
  pkg: Package,
  env: Record<string, string>,
  args: string[]
) => Promise<{ env?: Record<string, string>; args?: string[] } | void>;

export type PostRunHook = (
  pkg: Package,
  exitCode: number,
  durationMs: number
) => Promise<void>;

export type DoctorHook = (
  category: string,
  results: DoctorResult[]
) => Promise<DoctorResult[] | void>;

export type BootstrapHook = (
  stage: 'preflight' | 'fetch-rootfs' | 'first-boot' | 'install-runtimes' | 'configure' | 'verify',
  status: 'start' | 'success' | 'failure'
) => Promise<void>;

export type CommandHook = (
  args: ParsedArgs,
  ctx: LinuxifyContext
) => Promise<number | void>;

export interface InstallPlan {
  steps: InstallStep[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface InstallResult {
  success: boolean;
  stepResults: Array<{ name: string; exitCode: number; durationMs: number }>;
  patchResults: PatchResult[];
  totalDurationMs: number;
}

export interface PatchResult {
  patchId: string;
  status: 'applied' | 'skipped' | 'failed';
  message?: string;
  durationMs: number;
}
```

A hook that returns `void` or `undefined` is treated as "no mutation" — the input value is passed unchanged to the next plugin's hook. A hook that returns a value replaces the input for downstream plugins. This chain-of-responsibility semantics lets multiple plugins cooperate: plugin A's `prePatch` adds a patch, plugin B's `prePatch` reorders the list, plugin C's `prePatch` filters out patches targeting Alpine.

## 12. Types

```typescript
// src/plugin/types.ts

export interface Package {
  name: string;
  version: string;
  description: string;
  runtime: 'node' | 'python' | 'rust' | 'go' | 'bun' | 'deno' | 'none';
  runtimeMinVersion?: string;
  runtimeMaxVersion?: string;
  package: string;           // upstream package name
  launcher: string;
  install: InstallPlan;
  uninstall?: InstallPlan;
  patches: Patch[];
  env: Record<string, EnvValue>;
  compat: Compat;
  doctor: DoctorCheckSpec[]; // YAML-declared doctor checks (different from registered checks)
  permissions: Permissions;
  deprecated: boolean;
  aliasOf?: string;
  replaces: string[];
  conflicts: string[];
}

export interface Distro {
  name: string;
  version: string;
  packageManager: 'apt' | 'pacman' | 'apk' | 'dnf' | 'custom';
}

export interface Runtime {
  name: string;
  version: string;
}

export interface Patch {
  id: string;
  patchId: string;
  description: string;
  file: string;
  type: 'regex' | 'ast' | 'sed' | 'binary' | string;  // string for custom types
  find?: string;
  replace?: string;
  verify?: { command: string; expect: number };
  rollback?: { find: string; replace: string };
  condition?: PatchCondition;
}

export interface PatchCondition {
  fileExists?: boolean;
  findPresent?: boolean;
  runtimeMinVersion?: string;
  runtimeMaxVersion?: string;
  distro?: string[];
  arch?: string[];
}

export interface DoctorResult {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'missing';
  message: string;
  fixCommand?: string;
  fixSeverity?: 'safe' | 'unsafe';
  durationMs?: number;
}

export interface InstallPlan {
  steps: InstallStep[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface InstallStep {
  name?: string;
  command: string;
  expect?: number;
  retry?: number;
  onFail?: 'abort' | 'continue' | 'warn';
}

export interface RunContext {
  package: Package;
  env: Record<string, string>;
  args: string[];
  distro: Distro;
  runtime: Runtime;
  cwd: string;
}

export interface EnvValue {
  value: string;
  scope?: 'runtime' | 'run' | 'always';
  override?: 'merge' | 'replace' | 'append';
}

export interface Compat {
  minLinuxify: string;
  maxLinuxify?: string;
  testedDistros: string[];
  testedRuntimes: Array<{ runtime: string; versions: string[] }>;
  knownIssues: KnownIssue[];
  notSupported: Array<{ distro?: string; runtime?: string; version?: string; reason: string }>;
}

export interface KnownIssue {
  id: string;
  severity: 'low' | 'med' | 'high';
  description: string;
  workaround?: string;
  fixedIn?: string;
}

export interface Permissions {
  network: boolean;
  filesystem: { binds: string[] };
  services: { start: string[] };
  setuid: boolean;
}

export interface DoctorCheckSpec {
  id: string;
  name: string;
  command: string;
  expect: string | number;
  severity: 'warn' | 'fail';
  fixCommand?: string;
  fixSeverity?: 'safe' | 'unsafe';
}
```

These types are exported from the `linuxify` package and can be imported by plugins as `import type { Package, Patch } from 'linuxify'`. The types are the same ones used internally by Linuxify, so plugins and core agree on shape by construction.

## 13. Errors

Plugins should throw these custom error classes (rather than generic `Error`) so the loader can distinguish plugin errors from core errors and report them appropriately:

```typescript
// src/plugin/errors.ts

/** Base class for all plugin errors. Carries the plugin name and an error code. */
export class PluginError extends Error {
  constructor(
    message: string,
    public readonly plugin: string,
    public readonly code: string = 'E_PLUGIN_GENERIC',
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'PluginError';
  }
}

/** Thrown when a plugin's configuration is invalid (fails its configSchema). */
export class PluginConfigError extends PluginError {
  constructor(plugin: string, message: string, public readonly issues: unknown[]) {
    super(message, plugin, 'E_PLUGIN_CONFIG_INVALID');
    this.name = 'PluginConfigError';
  }
}

/** Thrown when a hook throws an unexpected error. */
export class PluginHookError extends PluginError {
  constructor(plugin: string, hook: string, cause: Error) {
    super(`Hook '${hook}' threw: ${cause.message}`, plugin, 'E_PLUGIN_HOOK_THREW', cause);
    this.name = 'PluginHookError';
  }
}
```

The loader catches all three. `PluginConfigError` is thrown during plugin initialization if the config fails schema validation; the plugin is marked failed and skipped. `PluginHookError` is thrown by the loader itself wrapping any uncaught error from a hook; the hook's effect is treated as `void` and the operation continues. `PluginError` is the base class; plugins can subclass it for their own error types.

The error codes follow the `E_PLUGIN_*` convention from [../02-architecture/system-architecture.md](../02-architecture/system-architecture.md) §9. Plugin-specific error codes should follow `E_PLUGIN_<NAME>_<DESCRIPTION>` (e.g. `E_PLUGIN_JAVA_INSTALL_FAILED`). The full error-code convention is documented in [../03-cli/cli-specification.md](../03-cli/cli-specification.md) §6.

## 14. Utilities

The `fs`, `net`, `crypto`, `yaml`, and `toml` properties on `LinuxifyContext` are re-exports of Linuxify's internal copies of these libraries. Plugins should use these re-exports rather than declaring their own dependencies on `fs-extra`, `js-yaml`, etc., for three reasons: (1) it avoids version skew (the plugin uses the same `js-yaml` version as the core, so YAML parsing behavior is identical); (2) it reduces plugin install size (no duplicated `node_modules`); (3) it ensures the plugin works in Linuxify's bundled-node environment, where some npm packages may not be installed.

```typescript
export interface NetUtil {
  /** Download a URL to a file path. Verifies sha256 if provided. */
  download(url: string, destPath: string, opts?: { sha256?: string; timeoutMs?: number }): Promise<void>;

  /** Download a URL into memory. */
  fetch(url: string, opts?: { timeoutMs?: number }): Promise<{ body: string; status: number; headers: Record<string, string> }>;
}

// fs: standard Node fs/promises, augmented with:
declare module './fs-extra' {
  export function ensureDir(path: string): Promise<void>;
  export function readJson<T = unknown>(path: string): Promise<T>;
  export function writeJson(path: string, value: unknown): Promise<void>;
  export function atomicWrite(path: string, contents: string): Promise<void>;
}

// crypto: standard Node crypto, augmented with:
declare module './crypto-extra' {
  export function verifySha256(filePath: string, expectedSha256: string): Promise<boolean>;
  export function verifyGpg(filePath: string, signaturePath: string, publicKeyPath: string): Promise<boolean>;
}

// yaml: { parse, stringify } — wraps js-yaml
// toml: { parse, stringify } — wraps @iarna/toml
```

Example usage:

```typescript
// Download a JDK tarball, verify it, extract it
const jdkUrl = `https://download.java.net/java/GA/jdk21.0.1/${version}/binaries/openjdk-21.0.1_linux-aarch64_bin.tar.gz`;
const jdkPath = path.join(ctx.plugin.rootDir, 'cache', `jdk-${version}.tar.gz`);
await ctx.net.download(jdkUrl, jdkPath, { sha256: expectedSha256 });
const ok = await ctx.crypto.verifySha256(jdkPath, expectedSha256);
if (!ok) throw new ctx.errors.PluginError('JDK sha256 mismatch', ctx.plugin.name, 'E_PLUGIN_JAVA_SHA256_MISMATCH');
await ctx.runtime.exec('tar', ['xf', jdkPath, '-C', targetDir]);
```

The `yaml.parse` and `toml.parse` functions are useful for plugins that ship their own configuration files in those formats. They use the same parsers as the Linuxify core, so a plugin's YAML config is parsed identically to a package YAML.
