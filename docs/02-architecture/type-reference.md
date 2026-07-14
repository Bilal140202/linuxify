# TypeScript Type Reference

> **Audience**: AI coding agents implementing the Linuxify CLI and plugin authors who need the precise TypeScript signatures of every public type. This document is the canonical reference; any divergence between this document and the source code is a bug in the source.
>
> **Scope**: Every type, interface, enum, and type alias that is exported from the `linuxify` package's public API surface. Internal types (those not exported from a module's `index.ts`) are documented in their owning subsystem doc.
>
> **Related**: [Source Code Structure](./source-code-structure.md) for the module layout that owns these types · [Implementation Walkthroughs](./implementation-walkthroughs.md) for code samples that use these types · [Extension API](../10-plugin-sdk/extension-api.md) for the plugin-facing subset of these types · [CLI Specification](../03-cli/cli-specification.md) for the exit codes and output formats referenced here.

The types are grouped into 14 sections matching the assignment's structure. Each section opens with a short rationale, then presents the TypeScript definitions in code blocks (compilable as-is with `strict: true`), followed by example usage and cross-references to where the type is used elsewhere in the codebase. Where a type is defined by a prior agent's doc (e.g. `DistroProvider` in `distro-management.md` §1), this document reproduces the definition for completeness but notes the source-of-truth location.

---

## 1. Core Types

The core types are the small primitive aliases that appear in nearly every signature. They are aliased rather than used raw because the alias is the contract: a function that takes `PackageName` accepts any string syntactically, but the type name communicates the semantic constraint (`^[a-z][a-z0-9_-]{0,62}$`, per [package-spec.md §1](../09-registry/package-spec.md)). The aliases are also where future tightening (e.g. branded types) would land.

```ts
// src/types.ts

/** A semantic version string, e.g. "0.1.0", "1.2.3-beta.1". Parsed via `semver`. */
export type LinuxifyVersion = string;

/** Identifier of a built-in or plugin-registered distro: "ubuntu" | "debian" | "arch" | "alpine" | <custom>. */
export type DistroName = string;

/** Identifier of a built-in or plugin-registered runtime: "node" | "python" | "rust" | "go" | "bun" | "deno" | <custom>. */
export type RuntimeName = string;

/** A package name; matches `^[a-z][a-z0-9_-]{0,62}$` (see package-spec.md §1). */
export type PackageName = string;

/** A patch ID in the form `<package>-<NNN>`, e.g. "cline-001". Stable across reinstalls. */
export type PatchId = string;

/** A doctor check ID in dotted form, e.g. "host.storage", "runtime.node.version". */
export type CheckId = string;

/**
 * A stable Linuxify error code, following the E_<SUBSYSTEM>_<DESCRIPTION> convention
 * from system-architecture.md §9. Always a string literal (not an enum) so that
 * `grep E_PATCH_VERIFY_FAILED` finds both the throw site and the test.
 */
export type ErrorCode = `E_${string}`;

/** A Linuxify exit code, drawn from the table in cli-specification.md §6. */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 30 | 31 | 64 | 65 | 70 | 78 | 126 | 127 | 130;
```

Example usage:

```ts
import type { PackageName, PatchId } from 'linuxify';

function isPatchApplied(pkg: PackageName, id: PatchId): Promise<boolean> { /* ... */ }
```

The `ExitCode` union is exhaustive on the v1 exit-code table; if a new code is added (in v2), the union is widened and downstream code that exhaustively switches on `ExitCode` will fail to compile, forcing callers to handle the new code. This is intentional friction: exit codes are part of the public API, and adding one is a breaking change for scripts that pattern-match on them.

---

## 2. Config Types

The `Config` interface is the in-memory representation of `~/.linuxify/config.toml`, after env-var overlay and default-filling. It is parsed by Zod (`ConfigSchema` in `src/config/schema.ts`); the Zod schema is the source of truth, and the TypeScript type is inferred from it via `z.infer<typeof ConfigSchema>`.

```ts
// src/config/types.ts

/** Top-level config object. All fields optional; defaults applied by ConfigSchema. */
export interface Config {
  default: DefaultConfig;
  run: RunConfig;
  patcher: PatcherConfig;
  bootstrap: BootstrapConfig;
  distro: DistroConfig;
  runtime: RuntimeConfig;
  telemetry: TelemetryConfig;
  sync: SyncConfig;
  /** Per-plugin config, keyed by plugin name. */
  plugin: Record<string, Record<string, unknown>>;
  /** Named profiles (linuxify --profile work). */
  profile: Record<string, Partial<Config>>;
}

export interface DefaultConfig {
  distro: DistroName;
  telemetry: boolean;
  autoUpdateCheck: boolean;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  color: 'auto' | 'always' | 'never';
  shellRc: string;
  cacheTtlHours: number;
}

export interface RunConfig {
  defaultDistro: DistroName;
  bindHome: boolean;
  /** Working-directory bind mount target inside proot. */
  workspaceMount: string;
}

export interface PatcherConfig {
  preferAst: boolean;
  backup: boolean;
  /** Max parallel patch applications within a single package. */
  concurrency: number;
}

export interface BootstrapConfig {
  minFreeSpaceMb: number;
  timeoutMinutes: number;
  locale: string;
  timezone: string;
  rootfsBundlePath?: string;
  /** Mirror override for rootfs download (Stage 2). */
  rootfsMirror?: string;
}

export interface DistroConfig {
  /** Override the default distro list (e.g. add "fedora" via plugin). */
  extra: DistroName[];
  /** Per-distro mirror overrides. Keyed by distro name. */
  mirrors: Record<DistroName, string[]>;
}

export interface RuntimeConfig {
  /** Runtimes to skip during Stage 4 (e.g. ["python"] for minimal profile). */
  skip: RuntimeName[];
  /** Per-runtime config. */
  node: { version: string; registry: string };
  python: { version: string; indexUrl: string };
  rust: { toolchain: 'stable' | 'nightly' | string };
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
  /** Redaction patterns; merged with the built-in defaults. */
  redactionPatterns: string[];
}

export interface SyncConfig {
  /** v1: always false. v2: cloud sync. */
  enabled: boolean;
  endpoint?: string;
  deviceName?: string;
}
```

The `Config` interface is what `ctx.config.all()` returns and what `loadConfig()` resolves to. Reads via `ctx.config.get('default.distro')` return the leaf type (`string`); the dot-notation key is type-checked at runtime by Zod, not at compile time. A future v2 may introduce a type-safe `get` overload, but v1 keeps the API simple.

Example:

```ts
import { loadConfig } from 'linuxify';

const cfg = await loadConfig();
console.log(cfg.default.distro);              // "ubuntu"
console.log(cfg.bootstrap.minFreeSpaceMb);    // 2048
console.log(cfg.runtime.node.version);        // "22.11.0"
```

The Zod schema that validates the raw TOML is in `src/config/schema.ts`. The schema applies defaults (so `minFreeSpaceMb` defaults to `2048` if omitted in TOML), rejects unknown keys (`additionalProperties: false`), and emits helpful error messages on type mismatch ("`minFreeSpaceMb` must be a number, got string \"2GB\"").

---

## 3. State Types

The `State` interface mirrors `~/.linuxify/state.json`. Unlike `Config`, `State` is machine-managed: users should never hand-edit it. The shape is documented here so that plugins reading state via `ctx.state.get()` know what to expect.

```ts
// src/state/types.ts

/** Top-level state.json shape. */
export interface State {
  linuxifyVersion: LinuxifyVersion;
  activeDistro: DistroName;
  installedDistros: InstalledDistro[];
  installedRuntimes: InstalledRuntime[];
  installedPackages: InstalledPackage[];
  appliedPatches: AppliedPatch[];
  bootstrapProgress: BootstrapProgress;
  lastDoctorRun?: { timestamp: string; exitCode: number; failCount: number };
  lastUpdated: string;            // ISO timestamp of last state mutation
}

export interface InstalledDistro {
  name: DistroName;
  version: string;
  installedAt: string;            // ISO timestamp
  provider: 'builtin' | string;   // 'builtin' or plugin name
  rootfsPath: string;
  sizeBytes: number;
}

export interface InstalledRuntime {
  name: RuntimeName;
  version: string;
  distro: DistroName;             // runtimes are scoped to a distro
  path: string;                   // absolute path to runtime bin dir
  isActive: boolean;
  installedAt: string;
}

export interface InstalledPackage {
  name: PackageName;
  version: string;
  distro: DistroName;
  runtime: RuntimeName;
  runtimeVersion: string;
  installPath: string;            // absolute path inside the distro
  launcherPath: string;           // absolute path on host (e.g. $PREFIX/bin/cline)
  installedAt: string;
  patches: PatchId[];             // applied patch IDs
  state: 'install_pending' | 'installed' | 'needs_repair' | 'upgrade_pending' | 'removed';
}

export interface AppliedPatch {
  patchId: PatchId;
  package: PackageName;
  file: string;                   // absolute path to patched file
  originalSha256: string;
  patchedSha256: string;
  patchType: PatchType;
  appliedAt: string;
  linuxifyVersion: LinuxifyVersion;
}

export interface BootstrapProgress {
  currentStage: number;           // 0–8, or 8 when complete
  stageStatus: Array<{
    stage: number;
    status: 'pending' | 'in_progress' | 'done' | 'failed';
    startedAt?: string;
    completedAt?: string;
    error?: string;
  }>;
  startedAt: string;
  completedAt?: string;
}
```

The `InstalledPackage.state` field is the runtime state machine from [system-architecture.md §7](./system-architecture.md). The `appliedPatches` array on `State` is the global index; per-package patch records live in `~/.linuxify/patches/<pkg>/<n>.json` (see [patcher-engine.md §7](../08-patcher/patcher-engine.md)) and contain the full `AppliedPatch` records. The state.json's `appliedPatches` array is a denormalized summary for fast lookup without scanning the patches directory.

Example:

```ts
const state = ctx.state.get<State>();
const cline = state.installedPackages.find(p => p.name === 'cline');
if (cline && cline.state === 'needs_repair') {
  await ctx.runtime.exec('linuxify', ['repair', 'cline']);
}
```

---

## 4. Package Types

These are the types produced by parsing a package YAML file. The Zod schema (`PackageSchema` in `src/packages/schema.ts`) is the source of truth; the TypeScript types here are inferred from it. The schema enforces `additionalProperties: false`, regex patterns on identifiers, and required-vs-optional distinctions exactly as documented in [package-spec.md](../09-registry/package-spec.md).

```ts
// src/packages/types.ts

/** The parsed and validated package definition. */
export interface PackageDefinition {
  name: PackageName;
  version: string;                  // semver
  description: string;
  homepage?: string;
  license: string;                  // SPDX identifier
  maintainer?: string;
  tags?: string[];
  category?: 'ai' | 'cli' | 'dev' | 'util' | string;
  runtime: RuntimeName | 'none';
  runtimeMinVersion?: string;
  runtimeMaxVersion?: string;
  package: string;                  // upstream package name (npm/pip/cargo)
  launcher: string;
  packageManager?: 'npm' | 'pip' | 'cargo' | 'go' | 'bun' | 'none';
  install: InstallStep[];
  uninstall?: InstallStep[];
  patches: PatchDefinition[];
  env: Record<string, EnvVar>;
  compat: CompatBlock;
  doctor: DoctorCheck[];
  permissions: Permissions;
  deprecated: boolean;
  replaces: PackageName[];
  conflicts: PackageName[];
  notes?: string;
}

export interface PackageVersion {
  version: string;
  releasedAt: string;
  yanked?: boolean;
  changelog?: string;
}

export interface InstallStep {
  name?: string;
  command: string;
  expect?: number;                  // expected exit code, default 0
  retry?: number;                   // retry count, default 0
  onFail?: 'abort' | 'continue' | 'warn';
  env?: Record<string, string>;
  cwd?: string;
}

export interface PatchDefinition {
  id: string;                       // user-facing short id, e.g. "fix-platform-check"
  patchId: PatchId;                 // canonical "<pkg>-<NNN>" form, assigned by patcher
  description: string;
  file: string;                     // path relative to install root
  type: PatchType;
  find?: string;
  replace?: string;
  verify: { command: string; expect: number };
  rollback?: { find: string; replace: string };
  condition?: PatchCondition;
}

export interface EnvVar {
  value: string;
  scope?: 'runtime' | 'run' | 'always';
  override?: 'merge' | 'replace' | 'append';
}

export interface CompatBlock {
  minLinuxify: string;
  maxLinuxify?: string;
  testedDistros: DistroName[];
  testedRuntimes: Array<{ runtime: RuntimeName; versions: string[] }>;
  knownIssues: KnownIssue[];
  notSupported: Array<{ distro?: DistroName; runtime?: RuntimeName; version?: string; reason: string }>;
}

export interface KnownIssue {
  id: string;
  severity: 'low' | 'med' | 'high';
  description: string;
  workaround?: string;
  fixedIn?: string;
}

export interface DoctorCheck {
  id: CheckId;
  name: string;
  command: string;
  expect: string | number;
  severity: 'warn' | 'fail';
  fixCommand?: string;
  fixSeverity?: 'safe' | 'unsafe';
}

export interface Permissions {
  network: boolean;
  filesystem: { binds: string[] };
  services: { start: string[] };
  setuid: boolean;
}

export interface PatchCondition {
  fileExists?: boolean;
  findPresent?: boolean;
  runtimeMinVersion?: string;
  runtimeMaxVersion?: string;
  distro?: DistroName[];
  arch?: string[];
}
```

Example:

```ts
import { parsePackageYaml } from 'linuxify';

const yaml = await fs.readFile('./cline.yml', 'utf8');
const pkg: PackageDefinition = parsePackageYaml(yaml);   // throws ConfigError on schema failure
console.log(pkg.patches[0].file);                       // "node_modules/cline/dist/platform.js"
```

The `PackageDefinition` is the type plugins receive in `preInstall(pkg, ...)`. It is frozen (deeply readonly) at parse time; a plugin that wants to mutate the install plan returns a new `InstallPlan` from the hook rather than mutating `pkg.install`.

---

## 5. Distro Provider Interface

The `DistroProvider` interface is the contract every distro backend must implement. It is defined in `src/distro/provider.ts` and reproduced here from [distro-management.md §1](../05-bootstrap/distro-management.md). The interface is intentionally minimal: every method is async (because every method crosses the proot boundary), stateless (no held file descriptors), and side-effectful only through its return value (no hidden global state).

```ts
// src/distro/provider.ts

export interface DistroProvider {
  /** Distro identifier, e.g. "ubuntu", "debian", or a custom name. */
  readonly name: DistroName;
  /** Distro version, e.g. "24.04", "12", "rolling". */
  readonly version: string;
  /** Package manager grammar; drives install/update/remove commands. */
  readonly packageManager: 'apt' | 'pacman' | 'apk' | 'dnf' | 'custom';

  // Lifecycle
  install(opts: InstallOptions): Promise<InstallResult>;
  uninstall(opts: UninstallOptions): Promise<UninstallResult>;

  // Execution
  /** Ensure the distro is "running" (no-op for proot). */
  start(): Promise<void>;
  /** Kill any lingering processes (proot-specific). */
  stop(): Promise<void>;
  /** Execute a command inside the distro. */
  exec(cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  /** Open an interactive shell. Never returns normally. */
  shell(opts: ShellOptions): Promise<never>;

  // Inspection
  info(): Promise<DistroInfo>;
  /** Run the distro's package-manager upgrade. */
  update(): Promise<UpdateResult>;

  // Backup
  snapshot(opts: SnapshotOptions): Promise<SnapshotRef>;
  restore(ref: SnapshotRef, opts: RestoreOptions): Promise<RestoreResult>;
}

export interface InstallOptions {
  /** Existing rootfs tarball to install from (offline mode). */
  bundlePath?: string;
  /** Mirror override (else use manifest's rootfs_url + mirrors). */
  mirror?: string;
  /** Abort signal for cooperative cancellation. */
  signal?: AbortSignal;
}

export interface InstallResult {
  durationMs: number;
  mirrorUsed: string;
  rootfsSha256: string;
  sizeBytes: number;
}

export interface UninstallOptions {
  /** Remove the cached rootfs tarball too. */
  purge?: boolean;
  signal?: AbortSignal;
}

export interface UninstallResult {
  durationMs: number;
  freedBytes: number;
}

export interface ExecOptions {
  user?: string;                    // default: "linuxify"
  env?: Record<string, string>;
  cwd?: string;
  bindMounts?: string[];
  timeoutMs?: number;
  tty?: boolean;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;
  durationMs: number;
}

export interface ShellOptions extends ExecOptions {
  /** Shell to launch (default: /bin/bash). */
  shell?: string;
}

export interface DistroInfo {
  name: DistroName;
  version: string;
  installed: boolean;
  active: boolean;
  provider: 'builtin' | string;
  sizeBytes?: number;
}

export interface SnapshotOptions {
  /** Snapshot name; auto-generated if omitted. */
  name?: string;
  /** Compression algorithm. */
  compression?: 'zstd' | 'gzip' | 'none';
  signal?: AbortSignal;
}

export interface SnapshotRef {
  id: string;
  name: string;
  createdAt: string;
  sizeBytes: number;
  path: string;                     // path to the snapshot tarball
}

export interface RestoreOptions {
  /** Verify the snapshot's sha256 before restoring. */
  verify?: boolean;
  signal?: AbortSignal;
}

export interface RestoreResult {
  durationMs: number;
  restoredAt: string;
}

export interface UpdateResult {
  durationMs: number;
  packagesUpgraded: number;
  packagesHeld: string[];
  rebootRequired: boolean;          // always false for proot
}
```

The provider is constructed once per CLI invocation, used, and discarded. The constructor takes the distro's manifest (`DistroManifest` from `distro-manifests/<name>.yml`) and the global `Config`; the manifest is the source of truth for the distro's rootfs URL, mirror list, and package-manager grammar. Errors thrown from provider methods are `DistroError` instances with codes like `E_DISTRO_ROOTFS_MISMATCH`, `E_DISTRO_PROOT_ENTER_FAILED`, `E_DISTRO_SNAPSHOT_CORRUPT`.

---

## 6. Runtime Provider Interface

The `RuntimeProvider` interface is symmetric to `DistroProvider` but scoped to a single distro: every method implicitly targets the distro the provider was constructed for. Defined in `src/runtime/provider.ts` and reproduced from [runtime-management.md §2](../06-launcher/runtime-management.md).

```ts
// src/runtime/provider.ts

export interface RuntimeProvider {
  /** Runtime identifier: "node", "python", "rust", "go", "bun", "deno", or custom. */
  readonly name: RuntimeName;
  /** Human-readable label, e.g. "Node.js". */
  readonly displayName: string;
  /** Default version, resolved at construction time. */
  readonly defaultVersion: string;

  install(version: string, opts: RuntimeInstallOptions): Promise<RuntimeInstallResult>;
  uninstall(version: string, opts: RuntimeUninstallOptions): Promise<RuntimeUninstallResult>;

  /** List installed versions of this runtime in the active distro. */
  list(): Promise<RuntimeVersion[]>;
  /** Get the current default version. */
  default(): Promise<RuntimeVersion>;
  /** Set the default version. */
  setDefault(version: string): Promise<void>;

  /** Execute a command using a specific runtime version. */
  exec(version: string, cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  /** Absolute path to the runtime's bin dir (used by the launcher). */
  pathFor(version: string): string;

  /** Health check for a specific version. */
  healthCheck(version: string): Promise<HealthResult>;
}

export interface RuntimeVersion {
  version: string;
  path: string;
  isActive: boolean;
  installedAt: string;
}

export interface RuntimeInstallOptions {
  /** Override the distro's default install method (e.g. "pyenv" for python). */
  via?: string;
  signal?: AbortSignal;
}

export interface RuntimeInstallResult {
  version: string;
  durationMs: number;
  sizeBytes: number;
}

export interface RuntimeUninstallOptions {
  /** Force-uninstall even if packages depend on this version. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface RuntimeUninstallResult {
  durationMs: number;
  freedBytes: number;
}

export interface HealthResult {
  healthy: boolean;
  version: string;
  checks: Array<{ name: string; ok: boolean; message: string }>;
}
```

The `pathFor(version)` method is the workhorse the launcher uses: given a version, it returns the absolute path to the runtime's `bin/` directory inside the distro (e.g. `/home/linuxify/.local/share/linuxify/runtimes/node/22.11.0/bin`). The launcher prepends this to `PATH` when invoking the package binary, ensuring the right version is used. The implementation is synchronous (`pathFor` does not need to spawn a process — it just constructs the path from the runtime's install root convention).

---

## 7. Doctor Types

The doctor subsystem's types are defined in `src/doctor/types.ts`. The `DoctorResult` interface is the central type — every check produces one, every output format renders a list of them. The shape here is consistent with [doctor-engine.md §4](../07-doctor/doctor-engine.md) and [extension-api.md §12](../10-plugin-sdk/extension-api.md).

```ts
// src/doctor/types.ts

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'missing' | 'skip';

export type DoctorCategory =
  | 'host'
  | 'bootstrap'
  | 'distro'
  | 'runtime'
  | 'path'
  | 'package'
  | 'compat'
  | 'network'
  | 'service'
  | 'team';

export type DoctorProfile = 'default' | 'quick' | 'ci' | 'full' | string;

export interface DoctorCheck {
  id: CheckId;
  name: string;
  category: DoctorCategory;
  /** Profiles this check belongs to; defaults to ['default']. */
  profiles?: DoctorProfile[];
  /** Run function. Must not throw — return a fail result instead. */
  run: (ctx: LinuxifyContext) => Promise<DoctorResult>;
  /** Suggested fix command, shown in human output and run by `linuxify repair`. */
  fixCommand?: string;
  /** Whether the fix is safe to run automatically. */
  fixSeverity?: 'safe' | 'unsafe';
  /** Number of retries on transient failure. Default 0. */
  retries?: number;
  /** Network category checks honor --offline by setting this true. */
  requiresNetwork?: boolean;
}

export interface DoctorResult {
  id: CheckId;
  name: string;
  category: DoctorCategory;
  status: DoctorStatus;
  message: string;
  /** Structured payload, rendered under --verbose or --json. */
  detail?: Record<string, unknown>;
  fixCommand?: string;
  fixDocs?: string;
  durationMs: number;
}
```

Example — registering a custom check:

```ts
ctx.doctor.registerCheck({
  id: 'team.gitconfig',
  name: '~/.gitconfig present',
  category: 'team',
  profiles: ['default', 'team'],
  run: async (ctx) => {
    const r = await ctx.runtime.inDistro('active', 'bash', ['-c', 'test -f ~/.gitconfig']);
    return {
      id: 'team.gitconfig',
      name: '~/.gitconfig present',
      category: 'team',
      status: r.exitCode === 0 ? 'ok' : 'warn',
      message: r.exitCode === 0 ? 'gitconfig OK' : 'Missing ~/.gitconfig',
      durationMs: r.durationMs,
      fixCommand: 'git config --global user.email "you@example.com"',
      fixSeverity: 'safe',
    };
  },
});
```

The `run` function's contract is **must not throw** — a thrown exception from a check is treated as a bug in the check, and the doctor engine wraps it in a `DoctorResult` with `status: 'fail'` and `message: 'check crashed: <error>'`. This keeps a buggy check from bringing down the whole doctor run.

---

## 8. Patcher Types

The patcher types are defined in `src/patcher/types.ts`. The `PatchType` union is open-ended (`| string`) to allow plugin-registered custom types; built-in types are the literal union. See [patcher-engine.md §5](../08-patcher/patcher-engine.md) for prose on each type.

```ts
// src/patcher/types.ts

export type PatchType =
  | 'regex'
  | 'ast-js'
  | 'ast-ts'
  | 'sed'
  | 'python-ast'
  | 'shell'
  | 'binary'
  | (string & {});                  // open for plugin-registered types

export interface Patch {
  id: string;
  patchId: PatchId;
  description: string;
  file: string;
  type: PatchType;
  find?: string;
  replace?: string;
  verify: { command: string; expect: number };
  rollback?: { find: string; replace: string };
  condition?: PatchCondition;
}

export interface PatchApplication {
  patch: Patch;
  installPath: string;
  startedAt: string;
}

export interface PatchResult {
  patchId: PatchId;
  status: 'applied' | 'skipped' | 'failed';
  message?: string;
  durationMs: number;
  /** Original file SHA-256 (only present if applied). */
  originalSha256?: string;
  /** Patched file SHA-256 (only present if applied). */
  patchedSha256?: string;
}

export interface PatchConflict {
  patchId: PatchId;
  conflictingPatchId: PatchId;
  file: string;
  reason: 'overlapping_find' | 'modified_externally' | 'hash_mismatch';
  currentSha256: string;
  expectedSha256: string;
}

export interface PatchTypeHandler {
  apply(filePath: string, contents: Buffer, patch: Patch): Promise<Buffer>;
  reverse(filePath: string, contents: Buffer, patch: Patch): Promise<Buffer>;
  verify(filePath: string, contents: Buffer, patch: Patch): Promise<boolean>;
}
```

The `Patch` interface here is the runtime representation; the YAML representation (`PatchDefinition` from §4 of this doc) is parsed and converted to `Patch` by the patcher at apply time, with the canonical `patchId` (`<pkg>-<NNN>`) assigned by the engine. The `PatchTypeHandler` is the interface a plugin implements to register a custom patch type via `ctx.patches.registerType(name, handler)`.

---

## 9. Plugin Types

The plugin types are the public API surface plugins import from `linuxify`. The central type is `LinuxifyContext`, the object passed to every plugin's `init()` and every hook invocation. The shape is reproduced from [extension-api.md §1](../10-plugin-sdk/extension-api.md); the API surface is the canonical reference for plugin authors.

```ts
// src/plugins/context.ts

export interface LinuxifyContext {
  readonly plugin: PluginIdentity;
  readonly logger: Logger;
  readonly config: ConfigAPI;
  readonly state: StateAPI;
  readonly runtime: RuntimeAPI;
  readonly distros: DistrosAPI;
  readonly packages: PackagesAPI;
  readonly patches: PatchesAPI;
  readonly doctor: DoctorAPI;
  readonly cli: CliAPI;
  readonly fs: typeof import('fs/promises');
  readonly net: NetUtil;
  readonly crypto: typeof import('crypto');
  readonly yaml: { parse: (s: string) => unknown; stringify: (v: unknown) => string };
  readonly toml: { parse: (s: string) => unknown; stringify: (v: unknown) => string };
  readonly errors: typeof import('./errors');
}

export interface PluginIdentity {
  name: string;
  version: string;
  manifestPath: string;
  rootDir: string;
}

export interface Logger {
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
  child(meta: Record<string, unknown>): Logger;
  setLevel(level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'): void;
}

export interface ConfigAPI {
  get<T = unknown>(key: string): T | undefined;
  get<T = unknown>(key: string, defaultValue: T): T;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  watch(key: string, cb: (newValue: unknown, oldValue: unknown) => void): () => void;
  all(): Record<string, unknown>;
}

export interface StateAPI {
  get(): Record<string, unknown>;
  get<T = unknown>(key: string): T | undefined;
  update(partial: Record<string, unknown>): Promise<void>;
  lock(): Promise<LockHandle>;
}

export interface LockHandle {
  release(): Promise<void>;
  extend(ms: number): Promise<void>;
}

export interface RuntimeAPI {
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<ChildProcess>;
  inDistro(distro: string | 'active', cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  inPackage(pkg: string, cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  registerProvider(name: string, provider: RuntimeProvider): void;
  getProvider(name: string): RuntimeProvider | null;
}

export interface DistrosAPI {
  list(): DistroInfo[];
  listInstalled(): DistroInfo[];
  getActive(): DistroInfo;
  get(name: string): DistroInfo;
  install(name: string, opts?: InstallOptions): Promise<InstallResult>;
  uninstall(name: string): Promise<UninstallResult>;
  registerProvider(name: string, provider: DistroProvider): void;
}

export interface PackagesAPI {
  list(): PackageInfo[];
  get(name: string): PackageInfo;
  install(name: string, opts?: PackageInstallOptions): Promise<InstallResult>;
  uninstall(name: string, opts?: UninstallOptions): Promise<UninstallResult>;
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
}

export interface PackageInfo {
  name: string;
  version: string;
  runtime: string;
  runtimeVersion: string;
  installedAt: string;
  patches: PatchId[];
}

export interface PatchesAPI {
  list(pkg: string): Patch[];
  apply(pkg: string, patchId: string, opts?: ApplyOptions): Promise<PatchResult>;
  rollback(pkg: string, patchId: string): Promise<RollbackResult>;
  registerType(name: string, handler: PatchTypeHandler): void;
}

export interface DoctorAPI {
  registerCheck(check: DoctorCheck): void;
  runCheck(id: string): Promise<DoctorResult>;
  runProfile(name: string): Promise<DoctorResult[]>;
}

export interface CliAPI {
  registerCommand(name: string, handler: CommandHandler, options: CommandOptions): string;
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
  alias?: string;
  required?: boolean;
}

export interface ParsedArgs {
  _: string[];
  flags: Record<string, unknown>;
}
```

The plugin hook signatures are defined in `src/plugins/hooks.ts`:

```ts
// src/plugins/hooks.ts

export type PreInstallHook = (pkg: Package, distro: Distro, runtime: RuntimeInfo) => Promise<InstallPlan | void>;
export type PostInstallHook = (pkg: Package, distro: Distro, runtime: RuntimeInfo, result: InstallResult) => Promise<void>;
export type PrePatchHook = (pkg: Package, patchList: Patch[]) => Promise<Patch[] | void>;
export type PostPatchHook = (pkg: Package, patchResults: PatchResult[]) => Promise<PatchResult[] | void>;
export type PreRunHook = (pkg: Package, env: Record<string, string>, args: string[]) => Promise<{ env?: Record<string, string>; args?: string[] } | void>;
export type PostRunHook = (pkg: Package, exitCode: number, durationMs: number) => Promise<void>;
export type DoctorHook = (category: string, results: DoctorResult[]) => Promise<DoctorResult[] | void>;
export type BootstrapHook = (stage: 'preflight' | 'fetch-rootfs' | 'first-boot' | 'install-runtimes' | 'configure' | 'verify', status: 'start' | 'success' | 'failure') => Promise<void>;
export type CommandHook = (args: ParsedArgs, ctx: LinuxifyContext) => Promise<number | void>;

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  license: string;
  entry: string;                    // ESM entry, e.g. "./dist/index.js"
  hooks?: {
    preInstall?: string;            // exported function name
    postInstall?: string;
    prePatch?: string;
    postPatch?: string;
    preRun?: string;
    postRun?: string;
    doctor?: string;
    bootstrap?: string;
    command?: string;
  };
  configSchema?: object;            // JSON Schema for plugin config
  enginges?: { linuxify: string; node: string };
}
```

A hook returning `void` or `undefined` is treated as "no mutation"; a hook returning a value replaces the input for downstream plugins. This chain-of-responsibility semantics is documented in [extension-api.md §11](../10-plugin-sdk/extension-api.md) and is what allows multiple plugins to cooperate on a single install.

---

## 10. Registry Types

The registry types cover both the local cache (`~/.linuxify/cache/registry/`) and the HTTP client that talks to the upstream registry at `registry.linuxify.dev`.

```ts
// src/registry/types.ts

export interface RegistryEntry {
  name: PackageName;
  version: string;
  description: string;
  homepage: string;
  license: string;
  runtime: RuntimeName | 'none';
  /** URL to the canonical package YAML in the registry. */
  yamlUrl: string;
  /** SHA-256 of the YAML, for integrity verification. */
  sha256: string;
  /** Detached signature (OpenPGP); verified against release key. */
  signature?: string;
  /** Size of the YAML in bytes. */
  sizeBytes: number;
  uploadedAt: string;
  yanked?: boolean;
}

export interface RegistryMetadata {
  registryVersion: string;          // "v1"
  updatedAt: string;
  packageCount: number;
  /** Mirrors, tried in order if the primary is unreachable. */
  mirrors: string[];
}

export interface RegistryClient {
  /** Fetch the registry index (cached locally for cacheTtlHours). */
  fetchIndex(): Promise<RegistryEntry[]>;
  /** Fetch a single package's YAML. */
  fetchYaml(name: PackageName, version?: string): Promise<{ yaml: string; entry: RegistryEntry }>;
  /** Search the index by query string. */
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  /** Verify the registry's own signature (top-level manifest). */
  verifyRegistrySignature(): Promise<boolean>;
}

export interface SearchOptions {
  /** Filter by runtime. */
  runtime?: RuntimeName;
  /** Filter by tag. */
  tags?: string[];
  /** Maximum results. Default 50. */
  limit?: number;
  /** Include yanked packages. Default false. */
  includeYanked?: boolean;
}

export interface SearchResult {
  name: PackageName;
  version: string;
  description: string;
  runtime: RuntimeName | 'none';
  score: number;                    // 0–1, relevance
}
```

The registry is the v1 source of package YAMLs beyond the bundled set. The `RegistryClient` interface is implemented once in `src/registry/client.ts` with caching, retry, and signature verification; the cache lives at `~/.linuxify/cache/registry/index.json` with TTL from `config.default.cacheTtlHours`. The interface is exported so plugins can construct mock clients for testing.

---

## 11. Telemetry Types

Telemetry is opt-in (per [ADR-005](../20-adrs/adr-005-opt-in-telemetry.md)) and the types are designed so that, even when enabled, the data captured is narrowly scoped. The full privacy policy is in [telemetry-privacy.md](../24-telemetry/telemetry-privacy.md); the types here are the implementation surface.

```ts
// src/telemetry/types.ts

export type TelemetryEventType =
  | 'install_started'
  | 'install_succeeded'
  | 'install_failed'
  | 'uninstall'
  | 'patch_applied'
  | 'patch_failed'
  | 'doctor_run'
  | 'bootstrap_stage'
  | 'self_update'
  | 'crash'
  | 'cli_invocation';

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;                // ISO 8601
  linuxifyVersion: LinuxifyVersion;
  /** Anonymous, stable per-install ID (SHA-256 of install timestamp + random). */
  anonymousId: string;
  /** Distro name (no version — version is potentially identifying via "rolling"). */
  distro?: DistroName;
  runtime?: RuntimeName;
  package?: PackageName;
  /** Exit code, for crash events. */
  exitCode?: ExitCode;
  /** Error code (E_*), for failure events. */
  errorCode?: ErrorCode;
  durationMs?: number;
  /** Stage number, for bootstrap_stage events. */
  stage?: number;
  /** Any field not in this list is stripped by the redaction filter. */
  [key: string]: unknown;
}

export interface TelemetryConfig {
  enabled: boolean;
  endpoint: string;
  batchSize: number;
  flushIntervalMs: number;
  redactionPatterns: string[];
}

export interface TelemetryQueue {
  /** Enqueue an event. No-op if telemetry is disabled. */
  track(event: TelemetryEvent): void;
  /** Flush pending events. Returns the count of successfully-sent events. */
  flush(): Promise<number>;
  /** Current pending count (for diagnostics). */
  pending(): number;
  /** Disable and drop all pending events (called on opt-out). */
  drainAndDisable(): Promise<void>;
}
```

The `track()` method is synchronous and never throws; it appends to an in-memory queue and returns immediately. The flush happens on process exit (or every `flushIntervalMs` if a long-running process — though v1 has none). A `crash` event is enqueued by the top-level error handler before flush.

The redaction filter strips any field whose key matches `redactionPatterns` (default: `/(_token|_key|_secret|password|authorization|api_key|bearer|signature)/i`) and any string value matching the patterns from [§8 Logging Pattern](./source-code-structure.md). The filter is conservative: if in doubt, drop the field. The `anonymousId` is the only identifier in the payload — no IP, no hostname, no package args.

---

## 12. Error Types

All Linuxify errors extend `LinuxifyError`. The base class carries the `code`, `details`, `cause`, `fixCommand`, and `docsUrl` fields documented in [Source Code Structure §6](./source-code-structure.md). The subclasses are mostly empty — they exist so callers can `catch (e) { if (e instanceof PatcherError) ... }` and so error names are correctly tagged in logs.

```ts
// src/errors.ts

export class LinuxifyError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCode,
    public readonly details?: Record<string, unknown>,
    public readonly cause?: Error,
    public readonly fixCommand?: string,
    public readonly docsUrl?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }

  /** Render as a JSON object for --json output. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      fixCommand: this.fixCommand,
      docsUrl: this.docsUrl,
    };
  }
}

export class BootstrapError extends LinuxifyError {}
export class DistroError extends LinuxifyError {}
export class RuntimeError extends LinuxifyError {}
export class PackageError extends LinuxifyError {}
export class PatcherError extends LinuxifyError {}
export class DoctorError extends LinuxifyError {}
export class LauncherError extends LinuxifyError {}
export class PluginError extends LinuxifyError {
  constructor(
    message: string,
    public readonly plugin: string,
    code: ErrorCode = 'E_PLUGIN_GENERIC',
    cause?: Error,
  ) {
    super(message, code, { plugin }, cause);
  }
}
export class RegistryError extends LinuxifyError {}
export class ConfigError extends LinuxifyError {}
export class StateError extends LinuxifyError {}
export class TelemetryError extends LinuxifyError {}
```

Example usage:

```ts
import { PatcherError } from 'linuxify';

throw new PatcherError(
  `Patch verify failed for ${patch.patchId}`,
  'E_PATCH_VERIFY_FAILED',
  { patchId: patch.patchId, verifyCommand: patch.verify.command, exitCode: 1, stderr },
  undefined,                          // cause
  `linuxify patch --rollback ${pkg.name} ${patch.patchId}`,
  'https://docs.linuxify.dev/08-patcher/patcher-engine#verification',
);
```

The `PluginError` subclass adds a `plugin` field so the loader can attribute errors to the offending plugin; the constructor automatically injects `{ plugin }` into `details`. Other subclasses follow the same pattern as needed (e.g. `PatcherError` could add `patchId` in a future revision, but the current pattern of putting it in `details` works and avoids constructor sprawl).

---

## 13. CLI Types

The CLI types are internal to the `cli/` module but documented here because plugin authors writing custom subcommands need to know the `CommandHandler` shape and the `ParsedArgs` structure. The `CommandContext` is the in-process equivalent of `LinuxifyContext`, available to all built-in subcommands.

```ts
// src/cli/types.ts

export interface Command {
  name: string;
  description: string;
  usage?: string;
  flags: Record<string, Flag>;
  examples?: string[];
  category: 'setup' | 'package' | 'exec' | 'diag' | 'config' | 'plugin' | 'team';
  handler: (ctx: CommandContext) => Promise<ExitCode>;
  /** Subcommands, if any. */
  subcommands?: Command[];
}

export interface Flag {
  type: 'boolean' | 'string' | 'number' | 'array';
  description: string;
  default?: unknown;
  alias?: string;
  required?: boolean;
  /** For string/array flags: validate against this regex. */
  pattern?: string;
  /** For string/array flags: only these values are accepted. */
  choices?: string[];
}

export interface Option {
  name: string;
  value: unknown;
  source: 'flag' | 'env' | 'config' | 'default';
}

export interface ParsedArgs {
  /** Positional arguments (after flag parsing). */
  _: string[];
  /** Parsed flags, keyed by long name. */
  flags: Record<string, unknown>;
  /** The resolved option with provenance (flag > env > config > default). */
  resolved: Record<string, Option>;
  /** The subcommand path, e.g. ["distros", "install"]. */
  commandPath: string[];
}

export interface CommandContext {
  args: ParsedArgs;
  ctx: LinuxifyContext;
  /** Abort signal tied to SIGINT/SIGTERM. */
  signal: AbortSignal;
  /** Stdout writer; respects --quiet and --json. */
  stdout: OutputWriter;
  /** Stderr writer; always verbose. */
  stderr: OutputWriter;
}

export interface OutputWriter {
  write(s: string): void;
  writeln(s: string): void;
  /** Whether the writer is a TTY (controls color, progress bars). */
  isTTY: boolean;
}
```

The `CommandContext` wraps `LinuxifyContext` and adds the parsed args, signal, and output writers. Built-in subcommands receive this; plugins receive `LinuxifyContext` (without the wrapping) because plugins should not depend on CLI internals like `OutputWriter` — they should use `ctx.logger` for output and return their exit code from the handler.

---

## 14. Output Types

The output types cover the four formats every command may produce: human (default), JSON (`--json`), markdown (`--markdown`), and the legacy plain format. All four share a common envelope so that downstream tooling can switch formats without parsing changes.

```ts
// src/cli/output.ts

export type OutputFormat = 'human' | 'json' | 'markdown' | 'plain';

export interface JsonOutput {
  /** Schema identifier, e.g. "linuxify.doctor.v1". */
  schema: string;
  linuxifyVersion: LinuxifyVersion;
  timestamp: string;
  command: string;
  /** The command-specific payload. */
  result: unknown;
  /** Present only on error. */
  error?: { code: ErrorCode; message: string; details?: Record<string, unknown> };
}

export interface MarkdownOutput {
  /** Title line, e.g. "# Linuxify Doctor Report". */
  title: string;
  /** Body, in CommonMark. */
  body: string;
  /** Footer with version, timestamp, and "generated by linuxify" line. */
  footer: string;
}

export interface HumanOutput {
  /** Render to a string. Color is applied if the writer is a TTY. */
  render(opts: { color: boolean; width: number }): string;
}

/** Common envelope for command results. */
export interface CommandResult<T> {
  exitCode: ExitCode;
  format: OutputFormat;
  payload: T;
}
```

Example — a doctor result rendered as JSON:

```json
{
  "schema": "linuxify.doctor.v1",
  "linuxifyVersion": "0.1.0",
  "timestamp": "2025-05-15T14:32:11Z",
  "command": "doctor",
  "result": {
    "profile": "default",
    "checks": [
      { "id": "host.storage", "status": "ok", "message": "12.4 GB free", "durationMs": 4 },
      { "id": "runtime.node.version", "status": "ok", "message": "v22.11.0", "durationMs": 18 }
    ],
    "summary": { "ok": 14, "warn": 0, "fail": 0, "missing": 1, "skip": 0 }
  }
}
```

The schema identifier (`linuxify.doctor.v1`, `linuxify.install.v1`, etc.) is versioned independently of the Linuxify CLI version. A schema bump (to `v2`) is a breaking change for consumers; the CLI supports both `v1` and `v2` output for one release cycle, with `--output-schema=v1` falling back. This is the same compatibility strategy npm uses for `package-lock.json` schema versions.

The `HumanOutput` interface is a render-function pattern rather than a data structure because human output is intrinsically view-dependent (terminal width, color capability, progress-bar support). The `MarkdownOutput` is a data structure because markdown is a stable format that should round-trip through editors and CI logs without re-rendering. The `JsonOutput` is the canonical machine-readable form; the `schema` field is what `jq '.schema'` queries to dispatch on.
