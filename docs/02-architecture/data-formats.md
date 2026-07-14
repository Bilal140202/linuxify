# Data Format Specifications

> Path: `docs/02-architecture/data-formats.md`
> Audience: AI coding agents, contributors, security engineers implementing or auditing Linuxify's persistence layer.
> Related: [System Architecture](./system-architecture.md) §4 (State Management), §5 (Storage Layout) · [CLI Specification](../03-cli/cli-specification.md) §7 (Configuration Files), §8 (Logging) · [Patcher Engine](../08-patcher/patcher-engine.md) §7 (Patch Rollback) · [Bundle Format](../09-registry/bundle-format.md) · [Telemetry Event Catalog](../24-telemetry/event-catalog.md) · [Telemetry & Privacy](../24-telemetry/telemetry-privacy.md) · [Disaster Recovery](../22-operations/disaster-recovery.md).

## 1. Scope and Conventions

This document is the single source of truth for every data file Linuxify reads or writes under `~/.linuxify/` (and the project-local `.linuxify.toml`). The [System Architecture §4.1 state file table](./system-architecture.md#41-state-files) enumerates the core files at a glance; this document expands each entry into a full specification: location, format, schema, example, versioning, and migration. Implementers should treat this document as a contract — any new file written under `~/.linuxify/` must be added here in the same PR that introduces it, or the file is considered undocumented and may be deleted or rewritten by a future migration without notice.

Schemas are expressed as TypeScript interfaces (the most readable form for AI coding agents and human contributors alike). Where a runtime-validated schema is required (config parsing, telemetry ingestion, registry validation), the TypeScript interface is paired with a Zod schema; the Zod schema is authoritative when the two disagree, because Zod expresses constraints (enums, ranges, regex) that TypeScript cannot. JSON examples are valid against the schemas. TOML examples are valid against the TOML 1.0 spec. YAML examples are valid against YAML 1.2 (the same version `js-yaml` parses).

Every file has a `schema_version` field (or equivalent, e.g. `config_schema_version` for TOML) that lets a future Linuxify release detect and migrate older files. The versioning rule is: bump the major schema version on any breaking change (field removed, field semantics changed, type changed); bump the minor version only when a new optional field is added. Migrations are idempotent: running them on an already-migrated file is a no-op. If a migration cannot be performed safely (e.g. a field was removed and the data is no longer representable), Linuxify aborts with exit code 27 (`MIGRATION_FAILED`) and leaves the original file untouched beside a `.pre-migration.bak` copy.

---

## 2. `~/.linuxify/config.toml` — User Configuration

The user configuration file is the highest-authority non-flag configuration source. It is a hand-edited TOML file with a fixed set of top-level tables, each owned by one subsystem. The file is read on every CLI invocation and merged with defaults, environment variables, and CLI flags per the precedence ladder in [CLI Specification §2](../03-cli/cli-specification.md). The full schema is large; the example below shows every field, and the schema comments explain each.

```toml
# ~/.linuxify/config.toml
config_schema_version = 1
created_at = "2025-04-10T14:23:11Z"
last_modified_at = "2025-06-18T09:11:42Z"

[bootstrap]
default_distro = "ubuntu"          # one of ubuntu | debian | arch | alpine
default_arch = "aarch64"           # auto-detected if absent
bootstrap_timeout_secs = 1800      # 30 min max for any single stage
resume_on_failure = true           # re-run `linuxify init` picks up at last failed stage
fdroid_required = true             # reject Play Store Termux

[distro]
active = "ubuntu"                  # current distro (mutated by `linuxify use`)
mirrors = { ubuntu = "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/", debian = "https://deb.debian.org/debian/" }
rootfs_cache_ttl_days = 30

[runtime]
default_node = "lts"               # "lts", "latest", or a pinned semver "22.11.0"
default_python = "3.12"
extra_runtimes = []                # e.g. ["rust", "go"]
install_dir_layout = "per-distro"  # per-distro | shared

[telemetry]
enabled = false                    # opt-in only (FR-052)
endpoint = "https://telemetry.linuxify.sh/v2/events"
flush_interval_hours = 24
batch_size = 100
sample_rate = 0.1                  # for high-volume events (cli.invoked)
user_id = ""                       # populated on first opt-in; resettable

[sync]
enabled = false                    # v2 cloud sync (future)
endpoint = ""
device_name = ""

[registry]
url = "https://github.com/linuxify/registry.git"
branch = "main"
mirror = ""                        # set to use a mirror
verify_signatures = true
update_check_interval_hours = 24
index_cache_ttl_hours = 24

[logging]
level = "info"                     # error | warn | info | debug | trace
format = "text"                    # text | json
rotation_days = 7
redact_patterns = ["*_TOKEN", "*_KEY", "*_SECRET", "API_*", "Bearer *", "gh[pousr]_*"]
redact_replacement = "***REDACTED***"

[i18n]
locale = "en"                      # auto-detected from LANG if absent
fallback = "en"
load_community = true

[profiles]
# named profiles selected via --profile <name>
[profiles.work]
distro.active = "arch"
telemetry.enabled = false

[profiles.minimal]
distro.active = "alpine"
runtime.extra_runtimes = []

[experimental]
# gate experimental features; false unless the user explicitly opts in
ast_patcher = true
plugin_sandbox = false
cloud_sync_preview = false
```

The corresponding TypeScript interface (paired with Zod) captures every field and its type. The interface is intentionally explicit about optionality: required fields have no `?` and are always present in a valid file; optional fields default to the value listed in `[bootstrap]` / `[distro]` / etc. in `defaults.toml` (shipped inside the Linuxify npm package and never written to disk).

```typescript
interface LinuxifyConfig {
  config_schema_version: 1;
  created_at: string;          // ISO 8601
  last_modified_at: string;    // ISO 8601
  bootstrap: {
    default_distro: "ubuntu" | "debian" | "arch" | "alpine";
    default_arch?: "aarch64" | "armv7l" | "x86_64";
    bootstrap_timeout_secs: number;     // 60..7200
    resume_on_failure: boolean;
    fdroid_required: boolean;
  };
  distro: {
    active: string;
    mirrors: Record<string, string>;
    rootfs_cache_ttl_days: number;
  };
  runtime: {
    default_node: "lts" | "latest" | string;
    default_python: string;
    extra_runtimes: string[];
    install_dir_layout: "per-distro" | "shared";
  };
  telemetry: {
    enabled: boolean;
    endpoint: string;
    flush_interval_hours: number;
    batch_size: number;
    sample_rate: number;        // 0..1
    user_id: string;            // empty until first opt-in
  };
  sync: { enabled: boolean; endpoint: string; device_name: string };
  registry: {
    url: string;
    branch: string;
    mirror: string;
    verify_signatures: boolean;
    update_check_interval_hours: number;
    index_cache_ttl_hours: number;
  };
  logging: {
    level: "error" | "warn" | "info" | "debug" | "trace";
    format: "text" | "json";
    rotation_days: number;
    redact_patterns: string[];
    redact_replacement: string;
  };
  i18n: { locale: string; fallback: string; load_community: boolean };
  profiles: Record<string, Partial<LinuxifyConfig>>;
  experimental: Record<string, boolean>;
}
```

Precedence is layered and immutable: defaults (lowest) → `config.toml` → environment variables (`LINUXIFY_<SECTION>_<KEY>`, dots become underscores, uppercase) → CLI flags (highest). A flag like `--no-telemetry` overrides `telemetry.enabled = true` from any lower layer. The resolved config is inspectable via `linuxify config --show --effective`, which prints a merged TOML document and the provenance of every key (file / env / flag). Versioning is by `config_schema_version`; on a future bump, `linuxify init` runs a migrator that transforms the old file into the new shape and writes a `config.toml.pre-migration.bak` alongside. Migrations are scripted in `src/config/migrations/` and unit-tested against every prior schema snapshot.

---

## 3. `~/.linuxify/state.json` — Internal State

`state.json` is the live internal state, mutated by every state-changing subsystem. It is *not* a rebuildable cache (unlike `manifest.json` and `runtimes.json`); losing it requires re-running `linuxify init` with `--recover-state`, which reconstructs it from the rebuildable caches plus distro/runtime markers. The schema below captures every field. The `telemetry.user_id` field is the rotating UUID from [Telemetry & Privacy §5](../24-telemetry/telemetry-privacy.md); it is generated on first opt-in and resettable via `linuxify config reset-user-id`.

```typescript
interface LinuxifyState {
  schema_version: 1;
  linuxify_version: string;            // semver of the CLI that last wrote this
  active_distro: string;               // "ubuntu" | "debian" | ...
  installed_distros: string[];         // mirrors ~/.linuxify/distros/*/installed markers
  installed_runtimes: Array<{
    name: string;                      // "node" | "python" | ...
    version: string;
    distro: string;
    path: string;                      // absolute path inside ~/.linuxify/runtimes/
    default_for: string[] | null;      // distros that use this as default
  }>;
  installed_packages: string[];        // package names; full records in manifest.json
  applied_patches: Array<{ package: string; patch_id: string; applied_at: string }>;
  bootstrap_progress: {
    current_stage: number;             // 0..8 (see bootstrap-design.md §2)
    completed_stages: number[];
    failed_stage: number | null;
    started_at: string;
    last_updated_at: string;
  };
  last_doctor_run: {
    timestamp: string;
    pass_count: number;
    warn_count: number;
    fail_count: number;
    report_path: string;               // points into ~/.linuxify/logs/
  } | null;
  telemetry: {
    user_id: string;                   // UUIDv4; empty string if never opted in
    first_opt_in_at: string | null;
    last_flush_at: string | null;
    queued_event_count: number;
  };
  plugins: Array<{
    name: string;
    version: string;
    enabled: boolean;
    installed_at: string;
  }>;
  last_modified_at: string;
}
```

Example state file (truncated `installed_packages` for brevity):

```json
{
  "schema_version": 1,
  "linuxify_version": "0.2.0",
  "active_distro": "ubuntu",
  "installed_distros": ["ubuntu"],
  "installed_runtimes": [
    { "name": "node", "version": "22.11.0", "distro": "ubuntu", "path": "/data/data/com.termux/files/home/.linuxify/runtimes/ubuntu/node/22.11.0", "default_for": ["ubuntu"] },
    { "name": "python", "version": "3.12.3", "distro": "ubuntu", "path": "/data/data/com.termux/files/home/.linuxify/runtimes/ubuntu/python/3.12.3", "default_for": ["ubuntu"] }
  ],
  "installed_packages": ["cline", "codex"],
  "applied_patches": [
    { "package": "cline", "patch_id": "cline-001", "applied_at": "2025-04-10T14:23:14Z" },
    { "package": "cline", "patch_id": "cline-002", "applied_at": "2025-04-10T14:23:15Z" },
    { "package": "codex", "patch_id": "codex-001", "applied_at": "2025-04-11T08:01:09Z" }
  ],
  "bootstrap_progress": {
    "current_stage": 8,
    "completed_stages": [0, 1, 2, 3, 4, 5, 6, 7, 8],
    "failed_stage": null,
    "started_at": "2025-04-10T14:18:02Z",
    "last_updated_at": "2025-04-10T14:31:47Z"
  },
  "last_doctor_run": {
    "timestamp": "2025-06-18T09:12:01Z",
    "pass_count": 14, "warn_count": 1, "fail_count": 0,
    "report_path": "/data/data/com.termux/files/home/.linuxify/logs/doctor-20250618T091201Z.json"
  },
  "telemetry": {
    "user_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "first_opt_in_at": "2025-04-12T10:00:00Z",
    "last_flush_at": "2025-06-18T03:00:00Z",
    "queued_event_count": 3
  },
  "plugins": [
    { "name": "telemetry-pretty", "version": "0.1.0", "enabled": true, "installed_at": "2025-05-01T11:00:00Z" }
  ],
  "last_modified_at": "2025-06-18T09:12:01Z"
}
```

Writes are atomic per [System Architecture §4.2](./system-architecture.md#42-readwrite-model): serialize to `state.json.tmp`, `fsync`, `rename`. Before any state-mutating command runs, an `flock` is acquired on `~/.linuxify/.lock` (a zero-byte file) with a 5-second timeout; if the lock is held, Linuxify reports the holding PID and exits. Read-only commands (`list`, `info`, `doctor`, `env`) do not acquire the lock and snapshot the file at read time, accepting that a long-running `linuxify add` on another shell may have produced a slightly stale view.

---

## 4. `~/.linuxify/manifest.json` — Installed Packages Manifest

The manifest is the rebuildable "what's installed" cache. It is derived from the per-package records in `~/.linuxify/packages/<name>.json` and can be regenerated by scanning that directory; losing the manifest is recoverable, losing `state.json` is not. It exists as a separate file because `linuxify list` and `linuxify doctor` need a single fast read of all installed packages without walking a directory, and because comparing manifests across machines (for sync, disaster recovery) is the unit of migration.

```typescript
interface PackageManifest {
  schema_version: 1;
  generated_at: string;                 // ISO 8601
  linuxify_version: string;
  packages: Array<{
    name: string;
    version: string;                    // installed upstream version
    distro: string;                     // which distro hosts this install
    runtime: { name: string; version: string };
    install_date: string;               // ISO 8601
    launcher_path: string;              // ~/.linuxify/bin/<launcher>
    patches_applied: string[];          // patch_id list, e.g. ["cline-001","cline-002"]
    state: "install_pending" | "installed" | "needs_repair" | "upgrade_pending" | "removed";
  }>;
}
```

Example (two packages):

```json
{
  "schema_version": 1,
  "generated_at": "2025-06-18T09:12:00Z",
  "linuxify_version": "0.2.0",
  "packages": [
    {
      "name": "cline",
      "version": "1.2.0",
      "distro": "ubuntu",
      "runtime": { "name": "node", "version": "22.11.0" },
      "install_date": "2025-04-10T14:23:18Z",
      "launcher_path": "/data/data/com.termux/files/home/.linuxify/bin/cline",
      "patches_applied": ["cline-001", "cline-002"],
      "state": "installed"
    },
    {
      "name": "codex",
      "version": "0.20.1",
      "distro": "ubuntu",
      "runtime": { "name": "node", "version": "22.11.0" },
      "install_date": "2025-04-11T08:01:12Z",
      "launcher_path": "/data/data/com.termux/files/home/.linuxify/bin/codex",
      "patches_applied": ["codex-001"],
      "state": "installed"
    }
  ]
}
```

The `state` field mirrors the package lifecycle state machine in [System Architecture §7](./system-architecture.md#7-lifecycle). The manifest is rewritten atomically after every `linuxify add`, `linuxify remove`, `linuxify upgrade`, and after any `linuxify doctor` run that transitions a package to `needs_repair`. The rebuild path (`linuxify manifest --rebuild`) scans `~/.linuxify/packages/*.json`, reconstructs the array, validates that every entry has a corresponding launcher on disk, and writes the file; missing launchers are flagged with `state: "needs_repair"`.

---

## 5. `~/.linuxify/packages/<name>.json` — Per-Package Install Record

Each installed package has a detailed record at `~/.linuxify/packages/<name>.json`. This file is the authoritative source for `linuxify info <pkg>`, `linuxify patch <pkg> --list`, and `linuxify remove <pkg>`. The manifest (§4) is a denormalized projection of these records; the per-package record is the source of truth.

```typescript
interface PackageRecord {
  schema_version: 1;
  name: string;
  version: string;                      // installed version
  distro: string;
  runtime: { name: string; version: string; min_version: string };
  install_date: string;
  install_source: "registry" | "local-yaml" | "url";
  install_source_url?: string;
  launcher: {
    path: string;                       // ~/.linuxify/bin/<launcher>
    kind: "shell" | "direct" | "custom";
    template_hash: string;              // sha256 of the launcher template at generation time
  };
  patches: Array<{
    patch_id: string;                   // e.g. "cline-001"
    patch_kind: "regex" | "ast-js" | "ast-python" | "sed";
    file: string;                       // install-relative path
    find?: string;                      // for regex/sed
    replace?: string;
    applied_at: string;
    record_path: string;                // ~/.linuxify/patches/<pkg>/<NNN>.json
    backup_path: string;                // ~/.linuxify/patches/<pkg>/backups/<patch_id>.orig
    verified: boolean;                  // verify command exited 0 at install time
  }>;
  env_vars: Record<string, string>;     // env vars the launcher sets (secrets NOT persisted)
  doctor_checks: Array<{                // checks this package registers with doctor
    check: string;                      // e.g. "node_version", "executable"
    args: Record<string, unknown>;
  }>;
  upstream_metadata: {
    homepage: string;
    license: string;
    description: string;
  };
  linuxify_version_at_install: string;
}
```

Example (`cline.json`):

```json
{
  "schema_version": 1,
  "name": "cline",
  "version": "1.2.0",
  "distro": "ubuntu",
  "runtime": { "name": "node", "version": "22.11.0", "min_version": "20" },
  "install_date": "2025-04-10T14:23:18Z",
  "install_source": "registry",
  "launcher": {
    "path": "/data/data/com.termux/files/home/.linuxify/bin/cline",
    "kind": "shell",
    "template_hash": "9a3f...e1b2"
  },
  "patches": [
    {
      "patch_id": "cline-001",
      "patch_kind": "regex",
      "file": "node_modules/cline/dist/platform.js",
      "find": "process.platform === 'linux'",
      "replace": "['linux','android'].includes(process.platform)",
      "applied_at": "2025-04-10T14:23:14Z",
      "record_path": "/data/data/com.termux/files/home/.linuxify/patches/cline/001.json",
      "backup_path": "/data/data/com.termux/files/home/.linuxify/patches/cline/backups/cline-001.orig",
      "verified": true
    },
    {
      "patch_id": "cline-002",
      "patch_kind": "regex",
      "file": "node_modules/cline/dist/arch.js",
      "find": "process.arch === 'x64'",
      "replace": "['x64','arm64'].includes(process.arch)",
      "applied_at": "2025-04-10T14:23:15Z",
      "record_path": "/data/data/com.termux/files/home/.linuxify/patches/cline/002.json",
      "backup_path": "/data/data/com.termux/files/home/.linuxify/patches/cline/backups/cline-002.orig",
      "verified": true
    }
  ],
  "env_vars": { "CLINE_PLATFORM": "linux", "FORCE_COLOR": "1" },
  "doctor_checks": [
    { "check": "node_version", "args": { "min": 20 } },
    { "check": "executable", "args": { "binary": "cline" } }
  ],
  "upstream_metadata": {
    "homepage": "https://github.com/cline/cline",
    "license": "MIT",
    "description": "AI coding agent that runs in your terminal"
  },
  "linuxify_version_at_install": "0.2.0"
}
```

`env_vars` deliberately excludes anything matching the secret redaction patterns from `[logging].redact_patterns`; the launcher reads secrets from the user's shell at invocation time. The `template_hash` lets `linuxify doctor` detect a hand-edited launcher (a user who edited `~/.linuxify/bin/cline` directly) and offer to regenerate it.

---

## 6. `~/.linuxify/patches/<pkg>/<NNN>.json` — Per-Patch Application Record

Each applied patch is recorded in its own file, indexed by a three-digit sequence matching the patch's order in the package YAML. The `<NNN>` sequence is the per-package zero-padded index; the `patch_id` field inside the file is the canonical `<pkg>-<NNN>` form (e.g. `cline-001`) used by `linuxify patch --rollback <pkg> <patch_id>` and by conflict detection. The full record is the unit of rollback.

```typescript
interface PatchRecord {
  schema_version: 1;
  patch_id: string;                     // "<pkg>-<NNN>", e.g. "cline-001"
  package: string;
  patch_kind: "regex" | "ast-js" | "ast-python" | "sed";
  definition: {                         // verbatim copy from the package YAML
    file: string;
    find?: string;
    replace?: string;
    verify: string;
    rollback: boolean;
    patch_id: string;
  };
  applied_at: string;
  applied_to_file: string;              // absolute path inside the proot install
  original_hash: string;                // sha256 of the file before patching
  patched_hash: string;                 // sha256 of the file after patching
  rollback_path: string;                // ~/.linuxify/patches/<pkg>/backups/<patch_id>.orig
  verify_exit_code: number;             // 0 = verified
  verify_stdout: string;                // captured but redacted
  verify_stderr: string;
  verified: boolean;
  linuxify_version: string;
}
```

Example (`patches/cline/001.json`):

```json
{
  "schema_version": 1,
  "patch_id": "cline-001",
  "package": "cline",
  "patch_kind": "regex",
  "definition": {
    "file": "node_modules/cline/dist/platform.js",
    "find": "process.platform === 'linux'",
    "replace": "['linux','android'].includes(process.platform)",
    "verify": "node -e \"require('./node_modules/cline/dist/platform.js')\"",
    "rollback": true,
    "patch_id": "cline-001"
  },
  "applied_at": "2025-04-10T14:23:14Z",
  "applied_to_file": "/data/data/com.termux/files/home/.linuxify/distros/ubuntu/rootfs/usr/lib/node_modules/cline/dist/platform.js",
  "original_hash": "a1b2c3d4e5f6...",
  "patched_hash": "9f8d7c6b5a4c...",
  "rollback_path": "/data/data/com.termux/files/home/.linuxify/patches/cline/backups/cline-001.orig",
  "verify_exit_code": 0,
  "verify_stdout": "",
  "verify_stderr": "",
  "verified": true,
  "linuxify_version": "0.2.0"
}
```

The `definition` field is a verbatim copy of the patch entry from the package YAML, so a future rollback does not need the original YAML (which may have been removed from the registry by then). `original_hash` and `patched_hash` enable [patcher-engine §9 conflict detection](../08-patcher/patcher-engine.md#9-patch-conflict-detection): a new patch targeting the same file is rejected if the current hash does not match the previous patch's `patched_hash`.

---

## 7. `~/.linuxify/patches/<pkg>/backups/<patch_id>.orig` — Original File Backup

Before any patch is applied, the patcher copies the original file byte-for-byte to `backups/<patch_id>.orig`. There is no schema — the file is a raw copy of the pre-patch content. The filename uses the canonical `<patch_id>` (e.g. `cline-001.orig`) so it is unambiguous which patch owns which backup. Backups are written *before* the patched file is written, so a SIGKILL mid-patch leaves the original in place and the `.orig` backup identical to it; the patch record (§6) is written only after both the patched file and the verify command succeed, so the existence of a `<NNN>.json` record is proof that the corresponding `.orig` exists.

Backups are deleted by `linuxify remove <pkg>` (the install directory is removed entirely, including the patched files; keeping backups would be orphans). They are *not* deleted by `linuxify patch --rollback <pkg> <patch_id>` until the rollback is complete and verified. If a backup is missing when rollback is attempted, the patcher fails with `E_PATCH_BACKUP_MISSING` and instructs the user to reinstall the package — silently ignoring a missing backup would leave the install in an inconsistent state.

---

## 8. `~/.linuxify/.bootstrap/stage-N.done` and `stage-N.failed` — Stage Marker Files

Bootstrap stages (0 through 8, per [bootstrap-design.md §2](../05-bootstrap/bootstrap-design.md#2-bootstrap-stages)) emit marker files on completion or failure. The presence of `stage-N.done` indicates that stage N completed successfully; the presence of `stage-N.failed` indicates it failed. Both are small text files (not empty — they carry a one-line timestamp and, for `.failed`, the failing check), so that `ls ~/.linuxify/.bootstrap/` is sufficient to see at a glance where the bootstrap stopped.

```
# stage-2.done
2025-04-10T14:21:33Z stage=2 duration_ms=42180 mirror=https://cdimage.ubuntu.com/... sha256=9a3f...
```

```
# stage-0.failed
2025-04-10T14:18:11Z stage=0 check=fdroid error="Termux is Play Store build; install F-Droid build"
```

The `.failed` marker is removed when the stage is retried (and either `.done` or a fresh `.failed` is written). `linuxify init` with `resume_on_failure = true` reads the marker directory first and skips already-completed stages; a `linuxify init --from-scratch` removes all markers before starting. Marker files are themselves idempotent: a re-run of a completed stage writes a new `.done` (overwriting) without side effects.

---

## 9. `~/.linuxify/.bootstrap-progress.json` — Detailed Bootstrap Progress

The marker files (§8) are coarse-grained; `.bootstrap-progress.json` is the fine-grained progress record used to render the live progress bar and to recover from interruptions. It is updated at the start and end of each stage, with the current stage's sub-step recorded every few seconds.

```typescript
interface BootstrapProgress {
  schema_version: 1;
  current_stage: number;                // 0..8
  current_step: string;                 // human label, e.g. "downloading rootfs (42%)"
  completed_stages: number[];
  failed_stage: number | null;
  error: {
    code: string;                       // E_<SUBSYSTEM>_<DESCRIPTION>
    message: string;
    hint: string;
    stage: number;
    step: string;
  } | null;
  started_at: string;
  last_updated_at: string;
  stage_durations_ms: Record<number, number>;  // stage -> duration
}
```

Example:

```json
{
  "schema_version": 1,
  "current_stage": 4,
  "current_step": "installing node 22.11.0",
  "completed_stages": [0, 1, 2, 3],
  "failed_stage": null,
  "error": null,
  "started_at": "2025-04-10T14:18:02Z",
  "last_updated_at": "2025-04-10T14:24:55Z",
  "stage_durations_ms": { "0": 412, "1": 8803, "2": 42180, "3": 15302 }
}
```

On resume, Linuxify reads this file, presents a summary ("Bootstrap in progress: stage 4, started 6 minutes ago"), and continues from `current_stage`. The file is written atomically (temp + rename) on every update — the cost is small because the file is under 1 KB and updates are throttled to once per 2 seconds.

---

## 10. `~/.linuxify/logs/linuxify-YYYYMMDD.log` — Daily Log File

Daily log files follow the format chosen by `[logging].format` in config. The default is `text` for human readability; `json` is recommended for any setup that ships logs to a centralized collector. Both formats carry the same logical fields; the text format is a pretty-printed projection of the JSON fields.

**Text format** (default):

```
2025-06-18T09:12:01Z INFO  add    cline  downloading rootfs 42%
2025-06-18T09:12:48Z INFO  add    cline  patching platform.js
2025-06-18T09:12:49Z OK    add    cline  installed v1.2.0 in 4280ms
2025-06-18T09:13:02Z WARN  doctor        redis missing (optional)
```

**JSON format** (one event per line, JSONL):

```json
{"ts":"2025-06-18T09:12:01Z","level":"info","logger":"add","pkg":"cline","msg":"downloading rootfs 42%"}
{"ts":"2025-06-18T09:12:48Z","level":"info","logger":"add","pkg":"cline","msg":"patching platform.js"}
{"ts":"2025-06-18T09:12:49Z","level":"ok","logger":"add","pkg":"cline","msg":"installed v1.2.0 in 4280ms","duration_ms":4280}
{"ts":"2025-06-18T09:13:02Z","level":"warn","logger":"doctor","msg":"redis missing (optional)"}
```

The common fields are: `ts` (ISO 8601 UTC), `level` (one of `trace`, `debug`, `info`, `warn`, `error`, `ok`), `logger` (the emitting subsystem), `msg` (human-readable message), and `fields` (an arbitrary object for structured context — package name, duration, byte count, etc.). Every message is passed through the redaction filter before being written; secrets matching the configured patterns are replaced with `***REDACTED***` (see [CLI Specification §8](../03-cli/cli-specification.md#8-logging)). Rotation: a new file is opened at UTC midnight, and files older than `rotation_days` (default 7) are deleted; this differs from the older per-5MB rotation in the original architecture doc, which has been superseded by daily rotation to align with `linuxify-YYYYMMDD.log` naming and to simplify log shipping.

---

## 11. `~/.linuxify/logs/doctor-<timestamp>.json` — Doctor Run Result

Each `linuxify doctor` run writes a structured JSON report alongside the terminal output. The report is the unit of `linuxify repair` (which reads the most recent report by default) and the unit of bug-report attachments (users are asked to attach the report file rather than copy-paste terminal output, because the structured form is parseable).

```typescript
interface DoctorReport {
  schema_version: 1;
  timestamp: string;                    // matches the filename
  linuxify_version: string;
  duration_ms: number;
  summary: {
    pass: number; warn: number; fail: number; missing: number;
    overall_status: "ok" | "warn" | "fail";
  };
  checks: Array<{
    id: string;                         // stable check ID, e.g. "storage.free_space"
    category: "bootstrap" | "distro" | "runtime" | "package" | "patch" | "network" | "config";
    name: string;                       // human label
    status: "ok" | "warn" | "fail" | "missing";
    detail: string;                     // human-readable explanation
    remediation?: {                     // present when status != ok
      hint: string;
      command: string;                  // suggested fix command
      safe: boolean;                    // false = destructive, requires --yes
    };
    fields: Record<string, unknown>;    // machine-readable context (e.g. {free_gb: 12.4})
  }>;
  environment: {
    os: string; arch: string; android_version: string;
    active_distro: string;
    linuxify_home_size_mb: number;
  };
}
```

Example (truncated to two checks):

```json
{
  "schema_version": 1,
  "timestamp": "2025-06-18T091201Z",
  "linuxify_version": "0.2.0",
  "duration_ms": 1842,
  "summary": { "pass": 14, "warn": 1, "fail": 0, "missing": 1, "overall_status": "warn" },
  "checks": [
    {
      "id": "storage.free_space",
      "category": "bootstrap",
      "name": "Storage free",
      "status": "ok",
      "detail": "12.4 GB free",
      "fields": { "free_gb": 12.4, "required_gb": 2.0 }
    },
    {
      "id": "package.redis_present",
      "category": "package",
      "name": "Redis",
      "status": "missing",
      "detail": "Missing (optional, used by: aider-memory)",
      "remediation": { "hint": "Install Redis", "command": "linuxify add redis", "safe": true },
      "fields": { "optional": true, "used_by": ["aider-memory"] }
    }
  ],
  "environment": {
    "os": "Ubuntu 24.04 (proot)",
    "arch": "aarch64",
    "android_version": "14",
    "active_distro": "ubuntu",
    "linuxify_home_size_mb": 1842
  }
}
```

Reports are kept indefinitely by default (they are small); `linuxify repair --prune-doctor-logs` removes reports older than a configurable age. The `state.json` `last_doctor_run` field (§3) is updated to point at the newest report.

---

## 12. `~/.linuxify/logs/repair-<timestamp>.json` — Repair Run Audit Log

Repair runs are auditable: every fix attempted, succeeded, or failed is recorded so the user can review what changed. The audit log is the basis for the `linuxify repair --dry-run` comparison and for post-incident review.

```typescript
interface RepairLog {
  schema_version: 1;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  linuxify_version: string;
  doctor_before: string;                // path to the doctor report that motivated the repair
  doctor_after: string | null;          // path to a fresh doctor report after repair
  problems_found: number;
  fixes_attempted: number;
  fixes_succeeded: number;
  fixes_failed: number;
  fixes: Array<{
    check_id: string;
    remediation: { hint: string; command: string; safe: boolean };
    attempted: boolean;
    succeeded: boolean | null;          // null = still in progress / interrupted
    error_code: string | null;          // E_<SUBSYSTEM>_<DESCRIPTION> on failure
    error_message: string | null;
    duration_ms: number;
    side_effects: string[];             // files written / removed
  }>;
}
```

Example (one fix attempted, succeeded):

```json
{
  "schema_version": 1,
  "started_at": "2025-06-18T09:15:00Z",
  "completed_at": "2025-06-18T09:15:08Z",
  "duration_ms": 8421,
  "linuxify_version": "0.2.0",
  "doctor_before": "/data/.../logs/doctor-20250618T091201Z.json",
  "doctor_after": "/data/.../logs/doctor-20250618T091508Z.json",
  "problems_found": 1,
  "fixes_attempted": 1,
  "fixes_succeeded": 1,
  "fixes_failed": 0,
  "fixes": [
    {
      "check_id": "package.redis_present",
      "remediation": { "hint": "Install Redis", "command": "linuxify add redis", "safe": true },
      "attempted": true,
      "succeeded": true,
      "error_code": null,
      "error_message": null,
      "duration_ms": 7901,
      "side_effects": [
        "installed: redis-7.2.0",
        "launcher: ~/.linuxify/bin/redis-server"
      ]
    }
  ]
}
```

---

## 13. `~/.linuxify/logs/runs/<pkg>-<timestamp>.log` — Per-Invocation Run Log

`linuxify run <pkg>` captures the wrapped command's stdout and stderr to a per-invocation log for post-mortem debugging. This is off by default (to avoid disk bloat and to avoid capturing user data) and is enabled by `linuxify config logging.capture_runs true` or by the `--capture` flag on `run`. Captured output is redacted with the same filter as the main log.

```typescript
interface RunLog {
  schema_version: 1;
  package: string;
  distro: string;
  runtime: { name: string; version: string };
  args: string[];                       // the args passed to the wrapped tool, REDACTED
  env: Record<string, string>;          // only the env vars the launcher set; secrets REDACTED
  started_at: string;
  completed_at: string;
  duration_ms: number;
  exit_code: number;                    // the wrapped tool's exit code (propagated to caller)
  stdout: string;                       // truncated to 1 MB; full copy at <file>.stdout if larger
  stderr: string;                       // truncated to 1 MB; full copy at <file>.stderr if larger
  linuxify_version: string;
}
```

Example:

```json
{
  "schema_version": 1,
  "package": "cline",
  "distro": "ubuntu",
  "runtime": { "name": "node", "version": "22.11.0" },
  "args": ["--model", "<redacted>", "src/"],
  "env": { "CLINE_PLATFORM": "linux", "FORCE_COLOR": "1", "OPENAI_API_KEY": "<redacted>" },
  "started_at": "2025-06-18T09:20:00Z",
  "completed_at": "2025-06-18T09:20:42Z",
  "duration_ms": 42180,
  "exit_code": 0,
  "stdout": "[cline] editing src/index.ts ...\n",
  "stderr": "",
  "linuxify_version": "0.2.0"
}
```

Run logs rotate on a 7-day schedule by default; `linuxify config logging.run_log_retention_days` adjusts this. Because the args and env may contain user data (file paths, API keys, model names), the redaction filter is mandatory and cannot be disabled for run logs — even with `--capture-raw` (which does not exist).

---

## 14. `~/.linuxify/telemetry/queue.jsonl` — Telemetry Event Queue

The telemetry queue is a JSONL file (one event per line) that buffers events between client-side emission and server-side flush. The full event type catalog is in [Telemetry Event Catalog](../24-telemetry/event-catalog.md); this section specifies the envelope and the file mechanics.

```typescript
interface TelemetryEvent {
  event_id: string;                     // UUIDv7 (time-ordered)
  event_type: string;                   // "<subsystem>.<action>", e.g. "package.install_complete"
  event_schema_version: 1;
  timestamp: string;                    // ISO 8601 UTC
  linuxify_version: string;
  user_id: string;                      // the rotating UUID from state.json
  session_id: string;                   // UUIDv7 per CLI process
  os: { android_version: string; arch: string };
  channel: "stable" | "beta" | "alpha";
  fields: Record<string, unknown>;      // event-specific, redacted per §4 of event-catalog.md
}
```

Example line (formatted for readability; the on-disk form is single-line):

```json
{"event_id":"0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b","event_type":"package.install_complete","event_schema_version":1,"timestamp":"2025-06-18T09:12:49Z","linuxify_version":"0.2.0","user_id":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","session_id":"0190a3b4-0001-7e8f-9a0b-1c2d3e4f5a6b","os":{"android_version":"14","arch":"aarch64"},"channel":"stable","fields":{"package_hash":"9f8d7c6b...","duration_ms":4280,"success":true}}
```

The queue is appended to with `O_APPEND` and `fsync` on every write (events must survive a crash mid-queue). If the file exceeds 10 MB, the oldest events are dropped and a `telemetry.queue_overflow` event is recorded (so the server can detect lossy clients). Flush triggers: 24 hours since last flush, 1000 events queued, explicit `linuxify telemetry flush`, or CLI exit (best-effort, with a 2-second timeout). The flush protocol and server responses are specified in [Telemetry Event Catalog §9](../24-telemetry/event-catalog.md#9-server-response-and-retry).

---

## 15. `~/.linuxify/backups/<name>.tar.zst` — Snapshot Tarball

Snapshots are full backups of `~/.linuxify/` minus `backups/` (to avoid recursion) and `telemetry/` (to avoid leaking queued events across machines). The format is a zstd-compressed tarball (level 19, long-range mode enabled) with an internal manifest at the tarball root.

```typescript
interface SnapshotManifest {
  schema_version: 1;
  created_at: string;
  source_linuxify_version: string;
  source_host: { os: string; arch: string; android_version: string };
  contents: Array<{ path: string; size_bytes: number; sha256: string }>;
  snapshot_size_bytes: number;
  snapshot_sha256: string;              // hash of the entire tarball
  compression: "zstd";
  compression_level: number;
}
```

The tarball layout:

```
linuxify-snapshot-20250618T091500Z.tar.zst
├── manifest.json                       # SnapshotManifest above
├── config.toml
├── state.json
├── manifest.json
├── runtimes.json
├── packages/
├── patches/
├── distros/
├── runtimes/
├── logs/                               # only the current log; archived logs excluded
└── plugins/
```

Snapshots are created by `linuxify snapshots create [--name <name>]` and named `linuxify-snapshot-<timestamp>.tar.zst` by default. The snapshot is verified at creation: the SHA-256 of every member file is computed, written to `manifest.json`, and the manifest's `snapshot_sha256` is computed over the tarball (excluding the manifest itself, then patched in). Restore (`linuxify snapshots restore <name>`) verifies the manifest's `snapshot_sha256` first, then verifies each member's `sha256`, and refuses to proceed on any mismatch. Snapshot rotation and budget are governed by disaster-recovery policy; see [Disaster Recovery §7](../22-operations/disaster-recovery.md#7-snapshots).

---

## 16. `~/.linuxify/runtimes.json` — Runtime Inventory

`runtimes.json` is the rebuildable runtime inventory, parallel to `manifest.json` for packages. It exists separately from `state.json`'s `installed_runtimes` field because (a) it can be regenerated by scanning `~/.linuxify/runtimes/` on disk, and (b) it is the file the Runtime Manager owns and updates without going through the global state lock (runtimes are large and slow to install; blocking the global lock for a 90-second Node install would block every other command).

```typescript
interface RuntimeInventory {
  schema_version: 1;
  generated_at: string;
  runtimes: Array<{
    name: string;                       // "node" | "python" | "rust" | ...
    version: string;
    distro: string;
    path: string;                       // ~/.linuxify/runtimes/<distro>/<name>/<version>/
    installed_at: string;
    default_for: string[];              // distros that use this as default
    size_mb: number;
    installer: "tarball" | "apt" | "source" | "plugin";
  }>;
}
```

Example:

```json
{
  "schema_version": 1,
  "generated_at": "2025-06-18T09:12:00Z",
  "runtimes": [
    {
      "name": "node",
      "version": "22.11.0",
      "distro": "ubuntu",
      "path": "/data/.../runtimes/ubuntu/node/22.11.0",
      "installed_at": "2025-04-10T14:24:55Z",
      "default_for": ["ubuntu"],
      "size_mb": 84,
      "installer": "tarball"
    },
    {
      "name": "python",
      "version": "3.12.3",
      "distro": "ubuntu",
      "path": "/data/.../runtimes/ubuntu/python/3.12.3",
      "installed_at": "2025-04-10T14:25:33Z",
      "default_for": ["ubuntu"],
      "size_mb": 67,
      "installer": "tarball"
    }
  ]
}
```

Rebuild (`linuxify runtimes --rebuild`) scans `~/.linuxify/runtimes/<distro>/<name>/<version>/` and reconstructs the array; missing `bin/` directories are dropped. The file is rewritten atomically after every `linuxify add <runtime>` and `linuxify remove <runtime>`.

---

## 17. `~/.linuxify/distros/<name>/installed` — Distro Marker File

Each installed distro has a marker file at `distros/<name>/installed` whose presence is the canonical "this distro is installed" signal (and whose absence is the canonical "needs install" signal). The marker carries the install metadata so that `linuxify use <distro>` and `linuxify doctor` can verify the install without scanning the rootfs.

```typescript
interface DistroMarker {
  schema_version: 1;
  distro: string;                       // "ubuntu" | "debian" | ...
  installed_at: string;
  rootfs_version: string;               // e.g. "24.04"
  rootfs_sha256: string;                // hash of the original rootfs.tar.gz
  rootfs_size_mb: number;
  arch: string;                         // aarch64 | armv7l | x86_64
  source_url: string;                   // where the rootfs was downloaded from
  linuxify_version_at_install: string;
}
```

Example:

```json
{
  "schema_version": 1,
  "distro": "ubuntu",
  "installed_at": "2025-04-10T14:21:33Z",
  "rootfs_version": "24.04",
  "rootfs_sha256": "9a3f...e1b2",
  "rootfs_size_mb": 1422,
  "arch": "aarch64",
  "source_url": "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-aarch64.tar.gz",
  "linuxify_version_at_install": "0.2.0"
}
```

`linuxify remove <distro>` deletes the marker first, then the rootfs directory, so a crash mid-remove leaves a marker-less directory that `linuxify init` will treat as "needs install" rather than as a corrupt install. The marker is also what `linuxify doctor`'s `distro.rootfs_integrity` check reads to recompute the rootfs hash and compare against `rootfs_sha256`.

---

## 18. `~/.linuxify/distros/<name>/manifest.toml` — Per-Distro Manifest

The per-distro manifest is a per-distro view of installed runtimes, installed packages, and snapshot history. It is the file that `linuxify use <distro>` and `linuxify info <distro>` consult; it is denormalized from `runtimes.json` and `manifest.json` (filtered to this distro) plus a per-distro snapshot list.

```toml
# ~/.linuxify/distros/ubuntu/manifest.toml
schema_version = 1
distro = "ubuntu"
rootfs_version = "24.04"
last_updated_at = "2025-06-18T09:12:00Z"

[[runtimes]]
name = "node"
version = "22.11.0"
default = true

[[runtimes]]
name = "python"
version = "3.12.3"
default = true

[[packages]]
name = "cline"
version = "1.2.0"
installed_at = "2025-04-10T14:23:18Z"
state = "installed"

[[packages]]
name = "codex"
version = "0.20.1"
installed_at = "2025-04-11T08:01:12Z"
state = "installed"

[[snapshots]]
name = "linuxify-snapshot-20250618T091500Z"
created_at = "2025-06-18T09:15:00Z"
size_mb = 1842
```

The schema is intentionally TOML (rather than JSON) because the per-distro manifest is occasionally hand-edited by advanced users (e.g., to mark a snapshot as "keep forever" by adding `keep = true` to its entry). The denormalized view is rebuilt on every state-changing command and on `linuxify manifest --rebuild`.

---

## 19. `~/.linuxify/plugins/<name>/manifest.json` — Plugin Install Record

Each installed plugin has a manifest at `plugins/<name>/manifest.json` recording the install source, version, enabled state, and the hooks the plugin has registered. This file is the source of truth for `linuxify plugin list` and `linuxify plugin remove`; the plugin's own `plugin.json` (shipped with the plugin code) declares its capabilities, while this manifest records the *installed* state.

```typescript
interface PluginInstallRecord {
  schema_version: 1;
  name: string;
  version: string;
  description: string;
  install_source: "registry" | "url" | "path";
  install_source_url: string;
  installed_at: string;
  enabled: boolean;
  entry_point: string;                  // relative to the plugin dir
  hooks_used: string[];                 // subset of [preInstall, postInstall, prePatch, postPatch, preRun, postRun, doctor]
  permissions: string[];                // subset of [network, filesystem-read, filesystem-write, exec]
  linuxify_version_at_install: string;
}
```

Example:

```json
{
  "schema_version": 1,
  "name": "telemetry-pretty",
  "version": "0.1.0",
  "description": "Pretty-prints telemetry events as they are emitted",
  "install_source": "registry",
  "install_source_url": "https://github.com/linuxify/registry/blob/main/plugins/telemetry-pretty/",
  "installed_at": "2025-05-01T11:00:00Z",
  "enabled": true,
  "entry_point": "index.js",
  "hooks_used": ["postRun", "doctor"],
  "permissions": ["filesystem-read"],
  "linuxify_version_at_install": "0.1.5"
}
```

`linuxify plugin enable <name>` / `disable <name>` toggle the `enabled` field atomically. A plugin whose `hooks_used` references a hook that does not exist in the current Linuxify version is flagged at load time and disabled with a warning — this is the forward-compatibility escape hatch.

---

## 20. `~/.linuxify/cache/` — Caches

The cache directory holds several transient files with explicit TTLs. Caches are advisory: any cache miss is a slow path that re-fetches from the network, never an error. All caches respect `linuxify --offline` (skip cache refresh, use stale if present, error if absent).

| Path | Format | TTL | Owner | Purpose |
|------|--------|-----|-------|---------|
| `cache/doctor-network.json` | JSON | 60 s | Doctor | Network reachability probe results (ping registry + distro mirror + telemetry endpoint) |
| `cache/compat-db.json` | JSON | 1 h | Compat DB | Snapshot of the registry's `compat/compat-db.json` |
| `cache/registry-index.json` | JSON | 24 h | Registry | Search index built from `packages/*.yml` |
| `cache/runtimes/<name>/<version>/` | dir | n/a | Runtime Manager | Cached runtime tarballs; not TTL-evicted, but cleared by `linuxify cache clear --runtimes` |
| `cache/rootfs/<distro>-<arch>.tar.gz` | binary | 30 d | Bootstrap | Cached distro rootfs; reused on re-init |

The `doctor-network.json` schema:

```typescript
interface DoctorNetworkCache {
  schema_version: 1;
  checked_at: string;                   // ISO 8601
  results: Array<{
    endpoint: string;                   // "registry" | "distro-mirror" | "telemetry"
    url: string;
    reachable: boolean;
    latency_ms: number | null;
    error: string | null;
  }>;
}
```

Caches are written atomically and include a `checked_at` timestamp so a stale cache is detectable. `linuxify cache clear [<target>]` invalidates one or all caches; `linuxify cache list` shows the current state and sizes.

---

## 21. `~/.linuxify/logs/linuxify.log` — Current Active Log

The "current" log is the log file being written *right now*. With daily rotation (§10), `linuxify.log` is a symlink or a hard link to `linuxify-YYYYMMDD.log` for the current UTC day, so that `tail -f ~/.linuxify/logs/linuxify.log` always works without the user having to compute today's date. The link is recreated at UTC midnight by the next CLI invocation. The architecture-doc storage layout lists `linuxify.log` and `linuxify.log.1` (the older per-5MB-rotation scheme); that scheme is superseded by daily rotation, with `linuxify.log` as the always-current pointer and `linuxify-YYYYMMDD.log` as the dated archives. This keeps both the old `tail -f` workflow and the new date-stamped archive workflow working.

---

## 22. Project-Local `.linuxify.toml` — Per-Project Overrides

A `.linuxify.toml` file in the working directory (or the nearest ancestor — Linuxify walks up like `git` looking for `.git`) provides per-project configuration overrides. This is the reproducible-environment mechanism: a repository can ship a `.linuxify.toml` that pins the distro, runtime versions, and packages, so that `cd ~/my-project && linuxify run cline` always uses the same environment regardless of the user's global config.

The schema is a strict subset of the `config.toml` schema (§2): only `[distro]`, `[runtime]`, `[logging]`, `[i18n]`, `[profiles]`, and `[experimental]` sections are honored. `[bootstrap]`, `[telemetry]`, `[sync]`, and `[registry]` are *rejected* at parse time with `E_CONFIG_PROJECT_FILE_TOO_BROAD` — telemetry and bootstrap settings are user-wide concerns that a project file has no business overriding (a project should not be able to silently enable telemetry on a user who has it disabled globally, nor change the active distro's bootstrap mirrors).

Example `.linuxify.toml`:

```toml
# my-project/.linuxify.toml
config_schema_version = 1

[distro]
active = "ubuntu"
rootfs_cache_ttl_days = 30

[runtime]
default_node = "22.11.0"      # pin Node version for this project
default_python = "3.12"
extra_runtimes = []

[logging]
level = "debug"               # verbose for this project's CI
format = "json"
```

The precedence ladder (§2) is extended one level below `config.toml`: defaults → `config.toml` → `.linuxify.toml` (if present) → env vars → CLI flags. The project file is detected once at CLI startup by walking up from `cwd`; the discovered path is recorded in the resolved config so `linuxify config --show --effective` can attribute overrides correctly. A project file is ignored under `--no-project-config` (useful in CI to avoid surprise overrides) and under `linuxify init` (the bootstrap command must not be reconfigured by a project file).

---

## 23. Migration and Forward Compatibility

Every schema-versioned file has a migrator in `src/storage/migrations/<filename>/`. A migrator is a pure function `oldSchema -> newSchema` that is idempotent (running it on an already-migrated file is a no-op) and lossless (no data is dropped without an explicit policy). Migrators are run automatically on first read by any Linuxify command; if a migrator fails, the original file is preserved at `<filename>.pre-migration.bak`, the new file is not written, and the command aborts with exit code 27 (`MIGRATION_FAILED`).

Forward compatibility is the inverse concern: what happens when a *newer* Linuxify meets an *older* file (e.g., a user downgrades Linuxify and then re-runs)? The rule is that every schema version is read-only-compatible with the immediately prior version (a v1 reader can read a v2 file, ignoring unknown fields, and emit a warning). A reader that encounters a `schema_version` higher than its own knowledge refuses to read with `E_STORAGE_SCHEMA_TOO_NEW` and instructs the user to upgrade — silently reading a future schema is forbidden because the unknown fields may carry safety-relevant semantics (e.g., a future `patches[].unsafe` flag that an old reader would ignore).

The full version history of each file is documented in `src/storage/migrations/CHANGELOG.md` (one entry per version bump, with the rationale and the breaking change). This changelog is the canonical reference for "what changed in `state.json` between Linuxify 0.2.0 and 0.3.0" and is generated automatically from the migrator source files by a CI job.
