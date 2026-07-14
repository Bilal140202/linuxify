# Package Specification

> **Audience**: AI coding agents implementing the package parser, validator, and installer; and human contributors authoring `packages/<name>.yml` files for the Linuxify registry.
>
> **Scope**: This is the canonical specification of the package YAML format. Every field is documented with type, required/optional status, default, and constraints. Examples range from a bare-minimum YAML to a fully-annotated complex package. For how the registry stores and serves these YAMLs, see [registry-format.md](registry-format.md). For how the patcher interprets the `patches:` block, see [../08-patcher/patcher-engine.md](../08-patcher/patcher-engine.md). For how the doctor interprets the `doctor:` block, see [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md).

## 1. YAML Schema

The package YAML is validated against a JSON Schema (draft 2020-12). The schema is the single source of truth for "is this YAML a valid package definition?" — both the `linuxify package lint <file>` command and the registry's CI lint workflow use it. The schema is versioned (`schema_version: 1`); future versions will add fields without removing old ones (additive evolution), and a `linuxify package migrate <file>` command will rewrite old YAMLs to the new schema.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://linuxify.dev/schemas/package-v1.json",
  "title": "Linuxify Package Definition v1",
  "type": "object",
  "required": ["name", "version", "runtime", "package", "install"],
  "additionalProperties": false,
  "properties": {
    "name":             {"type": "string", "pattern": "^[a-z][a-z0-9-]{1,62}$"},
    "version":          {"type": "string", "pattern": "^\\d+\\.\\d+\\.\\d+(-[a-z0-9.]+)?$"},
    "description":      {"type": "string", "maxLength": 200},
    "homepage":         {"type": "string", "format": "uri"},
    "license":          {"type": "string"},
    "license_url":      {"type": "string", "format": "uri"},
    "maintainer":       {"type": "string"},
    "tags":             {"type": "array", "items": {"type": "string"}},
    "category":         {"enum": ["ai", "dev", "sec", "net", "util", "data"]},
    "runtime":          {"enum": ["node", "python", "rust", "go", "bun", "deno", "none"]},
    "runtime_min_version": {"type": "string"},
    "runtime_max_version": {"type": "string"},
    "package":          {"type": "string"},
    "launcher":         {"type": "string", "pattern": "^[a-z][a-z0-9_-]{0,62}$"},
    "package_manager":  {"type": "string"},
    "install":          {"$ref": "#/$defs/install"},
    "uninstall":        {"$ref": "#/$defs/install"},
    "patches":          {"type": "array", "items": {"$ref": "#/$defs/patch"}},
    "env":              {"type": "object", "additionalProperties": {"$ref": "#/$defs/envValue"}},
    "compat":           {"$ref": "#/$defs/compat"},
    "doctor":           {"type": "array", "items": {"$ref": "#/$defs/doctorCheck"}},
    "permissions":      {"$ref": "#/$defs/permissions"},
    "bind_mounts":      {"type": "array", "items": {"type": "string"}},
    "network":          {"type": "boolean", "default": true},
    "services":         {"type": "array", "items": {"type": "string"}},
    "notes":            {"type": "string"},
    "deprecated":       {"type": "boolean", "default": false},
    "alias_of":         {"type": "string"},
    "replaces":         {"type": "array", "items": {"type": "string"}},
    "conflicts":        {"type": "array", "items": {"type": "string"}}
  },
  "$defs": { /* …defined inline in src/registry/schema.ts… */ }
}
```

The schema is intentionally strict (`additionalProperties: false`) so that typos like `runtime_min_verison` are caught at lint time rather than silently ignored at install time. The schema is also intentionally permissive about *values* (e.g. `version` is a string, not a structured object) so that contributors do not have to learn a nested DSL to write a package YAML. The trade-off is that semantic validation (does `runtime_min_version: "20"` actually mean Node 20, or is it a typo for `"2.0"`?) is done by a second-pass validator that knows the runtime's versioning scheme.

## 2. Top-level Fields

Every top-level field is documented below. Fields marked **required** must be present in every package YAML. Fields marked **optional** have a documented default. Fields marked **conditional** are required only if some other field is present (e.g. `license_url` is conditional on `license` being a non-SPDX string).

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `name` | string | yes | — | lowercase, `^[a-z][a-z0-9-]{1,62}$`; must match the YAML filename (e.g. `cline.yml` → `name: cline`) |
| `version` | string | yes | — | semver, optionally with `-<pre-release>`; pinned at registry-submit time |
| `description` | string | yes | — | 1–200 chars; shown in `linuxify search` and `linuxify info` |
| `homepage` | URI | yes | — | upstream project URL |
| `license` | string | yes | — | SPDX identifier (`MIT`, `Apache-2.0`, `GPL-3.0-only`) or `proprietary` |
| `license_url` | URI | conditional | — | required if `license: proprietary`; points to the license text |
| `maintainer` | string | yes | — | GitHub handle or email of the Linuxify package maintainer (not the upstream maintainer) |
| `tags` | string[] | optional | `[]` | free-form; convention: lowercase, hyphenated (`ai-coding`, `terminal-tool`) |
| `category` | enum | optional | `util` | one of `ai`, `dev`, `sec`, `net`, `util`, `data` |
| `runtime` | enum | yes | — | `node`, `python`, `rust`, `go`, `bun`, `deno`, or `none` (for static binaries) |
| `runtime_min_version` | string | conditional | — | required unless `runtime: none`; semver-ish (`"20"`, `"3.12"`, `"1.74.0"`) |
| `runtime_max_version` | string | optional | — | upper bound; rarely used (only when upstream breaks on newer runtimes) |
| `package` | string | yes | — | the upstream package name (`cline` for `npm install -g cline`, `aider-chat` for `pip install aider-chat`) |
| `launcher` | string | yes | — | the binary name users type (`cline`, `aider`, `codex`); `^[a-z][a-z0-9_-]{0,62}$` |
| `package_manager` | string | optional | inferred from `runtime` | `npm`, `pip`, `cargo`, `go`, `bun`, `deno`, `custom` |
| `install` | install | yes | — | see [§3](#3-install-steps) |
| `uninstall` | install | optional | inferred from `package_manager` | reverse of `install`; if omitted, Linuxify infers (`npm uninstall -g <package>`, etc.) |
| `patches` | patch[] | optional | `[]` | see [§4](#4-patch-block) |
| `env` | map | optional | `{}` | see [§5](#5-env-block) |
| `compat` | compat | yes | — | see [§6](#6-compat-block) |
| `doctor` | doctorCheck[] | optional | `[]` | see [§7](#7-doctor-block) |
| `permissions` | permissions | optional | see [§8](#8-permissions-block) | see [§8](#8-permissions-block) |
| `bind_mounts` | string[] | optional | `["/sdcard:/workspace"]` | additional bind mounts; format `host:guest` or `host:guest:ro` |
| `network` | bool | optional | `true` | whether the package needs network at run time (false enables offline-by-default optimizations) |
| `services` | string[] | optional | `[]` | system services the package needs (e.g. `["redis"]`); Linuxify ensures they're running before `linuxify run` |
| `notes` | string | optional | — | free-form maintainer notes; shown in `linuxify info <package>` |
| `deprecated` | bool | optional | `false` | marks the entire package as deprecated; `linuxify add` warns |
| `alias_of` | string | conditional | — | if present, this YAML is an alias; no other fields except `name`, `description`, `deprecated` may be set |
| `replaces` | string[] | optional | `[]` | package names that this package supersedes; on install, Linuxify offers to uninstall them |
| `conflicts` | string[] | optional | `[]` | package names that cannot coexist with this one; install aborts if any are installed |

The `name` field has a hard 64-character limit because it is used as a directory name (`~/.linuxify/packages/<name>/`) and as a launcher filename (`$PREFIX/bin/<name>`), both of which have practical length limits on Android's filesystem. The `launcher` field has the same constraint for the same reason. The two fields can differ: a package named `gemini-cli` might have `launcher: gemini` so users type `gemini` rather than `gemini-cli`. If `launcher` is omitted, it defaults to the value of `name`.

## 3. Install Steps

The `install:` field is the heart of the package YAML. It can be either an array of shell command strings (the simple form) or an object with `steps:`, `env:`, and `cwd:` (the structured form). Both forms are valid; the simple form is sugar for the structured form with one step per array element, no extra env, and `cwd: ~`.

**Simple form** (recommended for packages with a single install command):

```yaml
install:
  - npm install -g cline
```

**Structured form** (required when install needs more than one command, environment setup, or a specific working directory):

```yaml
install:
  steps:
    - name: download
      command: curl -fsSL https://example.com/install.sh -o /tmp/install.sh
      expect: 0
      retry: 3
      on_fail: abort
    - name: verify
      command: sha256sum -c /tmp/install.sh.sha256
      expect: 0
      on_fail: abort
    - name: install
      command: sh /tmp/install.sh --prefix ~/.local
      expect: 0
      on_fail: abort
  env:
    INSTALL_PREFIX: /home/linuxify/.local
  cwd: /tmp
```

Each step is an object with the following fields:

- **`name`** (string, optional) — human-readable label shown in install logs. Defaults to `step-N`.
- **`command`** (string, required) — the shell command to execute. Run inside the proot distro via `bash -c`. The command has access to the standard Linuxify install environment: `$HOME`, `$PATH` (including the runtime's `bin/`), `$LINUXIFY_PACKAGE_NAME`, `$LINUXIFY_PACKAGE_VERSION`, `$LINUXIFY_DISTRO`, `$LINUXIFY_ARCH`.
- **`expect`** (int, optional, default `0`) — the expected exit code. Any other exit code is a failure.
- **`retry`** (int, optional, default `0`) — number of times to retry on failure. Retries are spaced 2 seconds apart (configurable via `linuxify config install.retry_delay_ms`). Retries do not roll back partial state — if the command is non-idempotent, the package author must handle this in the command itself.
- **`on_fail`** (enum, optional, default `abort`) — `abort` (the default; the entire install fails and any partial state is rolled back via snapshot restore), `continue` (log the failure and proceed to the next step; useful for optional steps like "install man pages if mandoc is present"), or `warn` (like `continue` but the doctor will warn about the skipped step on the next `linuxify doctor`).

The `env:` map at the install-block level is merged with the package's top-level `env:` block (install-block env wins on conflict) and is exported into every step's environment. The `cwd:` field sets the working directory for every step; it defaults to the package's installation directory (`~/.linuxify/distros/<active>/home/linuxify/.local/share/linuxify/packages/<name>/`).

The `uninstall:` block has the same schema. If `uninstall:` is omitted, Linuxify infers it from `package_manager`: `npm uninstall -g <package>`, `pip uninstall -y <package>`, `cargo uninstall <package>`, etc. Inferred uninstalls are sufficient for ~80% of packages; the other ~20% (which install files outside the package manager's tracking) need an explicit `uninstall:` block.

## 4. Patch Block

The `patches:` array describes compatibility patches Linuxify applies after install. Each patch is an object; the schema is defined in [../08-patcher/patcher-engine.md](../08-patcher/patcher-engine.md) §3 and is reproduced here for completeness. Patches are applied in array order, and each patch's `verify` step (if present) must succeed before the next patch is applied.

```yaml
patches:
  - id: cline-001
    patch_id: cline-001
    description: "Treat android as linux for process.platform check"
    file: "node_modules/cline/dist/platform.js"
    type: regex
    find: "process\\.platform === 'linux'"
    replace: "['linux','android'].includes(process.platform)"
    verify:
      command: "grep -q \"['linux','android'].includes(process.platform)\" node_modules/cline/dist/platform.js"
      expect: 0
    rollback:
      # reverse of the find/replace; used by `linuxify patch --rollback cline-001`
      find: "['linux','android'].includes(process.platform)"
      replace: "process.platform === 'linux'"
    condition:
      # only apply if the file exists and contains the find pattern
      file_exists: true
      find_present: true
      runtime_min_version: "20"   # only needed for older Node; 22+ has this fix upstream
```

The full schema of a patch object:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Stable identifier, `<package>-<NNN>` (e.g. `cline-001`). Must be unique within the package. |
| `patch_id` | string | yes | Same as `id`; redundant field kept for forward-compatibility with multi-package patches. |
| `description` | string | yes | Human-readable; shown in `linuxify info <package> --patches` and doctor output. |
| `file` | string | yes | Path to the file to patch, relative to the package's install root. Supports globs (`node_modules/**/*.js`) — the patcher applies the find/replace to every matching file. |
| `type` | enum | yes | `regex` (default), `ast` (for JS/TS; uses Babel parser), `sed` (for multi-line rewrites), `binary` (for byte-level patches). |
| `find` | string | conditional | Required for `regex`, `ast`, `sed`. The pattern to find. For `regex`, this is a JS regex string. For `ast`, this is a Babel selector. |
| `replace` | string | conditional | Required for `regex`, `ast`, `sed`. The replacement string. Backreferences (`$1`, `$2`) work for `regex`. |
| `verify` | object | optional | A command to run after the patch; if it fails, the patch is rolled back. Schema: `{command: string, expect: int}`. |
| `rollback` | object | optional | Reverse find/replace for `linuxify patch --rollback <id>`. Schema: `{find: string, replace: string}`. If omitted, rollback uses the patcher's automatic reverse (swap find and replace, which works for symmetric patches). |
| `condition` | object | optional | Boolean conditions, all of which must be true for the patch to apply. Schema: `{file_exists: bool, find_present: bool, runtime_min_version: string, runtime_max_version: string, distro: string[], arch: string[]}`. |

The `condition` field is how Linuxify handles "this patch is only needed on Alpine" or "this patch is only needed for Node < 22". The patcher evaluates the condition before applying; if the condition is false, the patch is skipped (logged as `skipped: condition false`), not failed. This lets the same YAML work across multiple distros and runtime versions without forking.

Patches reference patch IDs in `compat/compat-db.json` (see [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md) §2 `patches_required` field). A package's compat entry lists which patch IDs are required for which configurations; the doctor uses this to warn "you have cline installed but patch cline-001 was not applied, expect breakage on Android."

## 5. Env Block

The `env:` map declares environment variables that Linuxify sets when invoking the package via `linuxify run` (and, optionally, during install). The keys are environment variable names (uppercase, conventionally); the values can be either a string (the simple form) or an object (the structured form).

**Simple form**:

```yaml
env:
  CLINE_PLATFORM: linux
  FORCE_COLOR: "1"
```

**Structured form**:

```yaml
env:
  NODE_OPTIONS:
    value: "--max-old-space-size=2048"
    scope: run           # only set during `linuxify run`, not during install
    override: merge      # merge with any existing NODE_OPTIONS (space-separated)
  CLINE_PLATFORM:
    value: linux
    scope: always        # set during both install and run
    override: replace    # clobber any existing value
  PATH_APPEND:
    value: "/opt/special/bin"
    scope: run
    override: append     # append to existing PATH with `:` separator
```

The full schema of an env value:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `value` | string | yes | — | The value to set. Always a string (Linuxify does not support non-string env values). |
| `scope` | enum | optional | `always` | `runtime` (set only during install steps), `run` (set only during `linuxify run`), `always` (both). |
| `override` | enum | optional | `merge` | `merge` (concatenate with existing, separator depends on the variable: `:` for PATH-like, ` ` for OPTIONS-like), `replace` (overwrite), `append` (always append, even if existing value is empty). |

The `scope: runtime` value is useful for install-time-only env vars like `npm_config_target_platform=linux` (which tells npm to fetch linux binaries during install, even though we're on Android) that should not leak into the package's run-time environment. The `scope: run` value is useful for run-time-only env vars like `FORCE_COLOR=1` that should not affect install behavior. The default `scope: always` is what most packages want.

The `override` semantics deserve a dedicated test suite. `merge` is the safest default because it preserves any user-set value; for PATH-like variables it concatenates with `:`, for OPTIONS-like variables it concatenates with a space, and the choice is determined by a hardcoded list in `src/registry/env.ts` (PATH, LD_LIBRARY_PATH, PYTHONPATH → `:`; NODE_OPTIONS, GOPATH, BUN_INSTALL → space or special handling). `replace` is destructive and should be used sparingly. `append` is the conservative choice when the package needs its value to be present but should not clobber a user-set value. The conflict resolution policy for two packages both setting the same env var is documented in [registry-format.md](registry-format.md) §14.

## 6. Compat Block

The `compat:` block declares which Linuxify versions, distros, and runtimes this package is known to work with. It is the package-author-authored counterpart to the CI-generated `compat/compat-db.json` (see [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md)). The two are reconciled at registry-lint time: if a package YAML declares `compat.tested_distros: [ubuntu, debian]` but CI's compat-db entry for the same package shows `arch: supported`, the lint warns (the YAML is stale).

```yaml
compat:
  min_linuxify: "0.1.0"          # required; semver
  max_linuxify: null             # optional; null means no upper bound
  tested_distros:
    - ubuntu
    - debian
  tested_runtimes:
    - runtime: node
      versions: ["20", "22"]
    - runtime: python
      versions: ["3.12"]
  known_issues:
    - id: cline-001
      severity: low
      description: "Tab completion does not work in Termux's readlink"
      workaround: "Use bash, not sh"
      fixed_in: null
    - id: cline-002
      severity: high
      description: "Crashes on Alpine due to musl + native module"
      workaround: "Use Ubuntu or Debian instead"
      fixed_in: null
  not_supported:
    - distro: alpine
      reason: "musl libc incompatible with cline's native deps"
```

The full schema:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `min_linuxify` | string | yes | Minimum Linuxify CLI version that can install this package. Bumps when the YAML uses a feature not present in older CLIs. |
| `max_linuxify` | string | optional | Maximum Linuxify CLI version. Rarely set; used when a future Linuxify release removes a feature the YAML depends on. |
| `tested_distros` | string[] | yes | Distro names that the package author has personally tested on. CI tests on the superset of all distros regardless. |
| `tested_runtimes` | object[] | yes | Runtime + version combinations the author has tested. |
| `known_issues` | object[] | optional | Known bugs with stable IDs, severity, description, workaround, and `fixed_in` (the upstream version that fixes it, or `null`). |
| `not_supported` | object[] | optional | Explicit "do not install on this distro/arch/runtime" declarations. Linuxify aborts with `E_COMPAT_NOT_SUPPORTED` if the user tries. |

The `known_issues` IDs are stable and referenced from `compat/compat-db.json` (which aggregates known issues across packages). The IDs follow the `<package>-<NNN>` convention (same as patch IDs, but a separate namespace — known-issue `cline-001` and patch `cline-001` are unrelated). When a known issue is fixed upstream, the package maintainer updates `fixed_in:` rather than deleting the entry; this preserves the historical record for users on older versions.

## 7. Doctor Block

The `doctor:` array declares package-specific health checks. Each check runs every time the user invokes `linuxify doctor` (or `linuxify doctor <package>` for per-package checks). Checks are independent and run in parallel. Each check returns a status (`ok`, `warn`, `fail`, `missing`) and, on failure, a remediation hint. The full doctor engine is documented in [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md); this section documents the YAML schema.

```yaml
doctor:
  - id: cline-node-version
    name: "Node version"
    command: "node --version"
    expect: "v((20|22)\\.)"        # regex; the command's stdout must match
    severity: fail                 # what to do if expectation is not met
    fix_command: "linuxify runtimes install node 22 --default"
    fix_severity: unsafe           # 'safe' auto-applies; 'unsafe' prompts
  - id: cline-binary-present
    name: "cline binary"
    command: "which cline"
    expect: ".+"                   # non-empty stdout
    severity: fail
    fix_command: "linuxify add cline --force"
    fix_severity: unsafe
  - id: cline-patch-applied
    name: "platform patch"
    command: "grep -q \"['linux','android'].includes\" $(dirname $(readlink -f $(which cline)))/../lib/node_modules/cline/dist/platform.js"
    expect: 0                       # exit code expectation (when no regex given)
    severity: warn
    fix_command: "linuxify patch cline"
    fix_severity: safe
```

The full schema of a doctor check:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Stable identifier, `<package>-<check-name>`. |
| `name` | string | yes | Human-readable label shown in doctor output. |
| `command` | string | yes | Shell command run inside the proot. |
| `expect` | string | yes | Either an integer (exit code) or a regex (matched against stdout). If the value parses as an int, it's an exit-code check; otherwise it's a regex check. |
| `severity` | enum | yes | `warn` (doctor continues, warns user) or `fail` (doctor fails, suggests `linuxify repair`). |
| `fix_command` | string | optional | Command to run via `linuxify repair` to fix this issue. |
| `fix_severity` | enum | optional | `safe` (auto-applied by `linuxify repair`) or `unsafe` (requires `--yes` or interactive prompt). Defaults to `unsafe`. |

The `fix_command` is invoked via `bash -c` inside the proot. It can be any shell command, including `linuxify` subcommands (which is how `linuxify patch cline` and `linuxify add cline --force` end up as fixes). A `fix_command` that itself fails (non-zero exit) is logged but does not abort the repair; the doctor will re-run on the next invocation and re-report the issue if it persists.

## 8. Permissions Block

The `permissions:` block declares what the package needs at run time: network access, filesystem bind mounts, system services, and (in a future version) fine-grained capabilities. Linuxify prompts the user to approve these on first install; with `--yes`, the prompt is skipped and all declared permissions are granted (this is the typical CI path).

```yaml
permissions:
  network: true                    # package needs outbound network at run time
  filesystem:
    binds:
      - /sdcard:/workspace         # default bind; always granted
      - /sdcard/Projects:/projects # extra bind; requires approval
  services:
    start:
      - redis                      # package needs redis running
  setuid: false                    # always false in v1; reserved for future
```

The full schema:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `network` | bool | `true` | If `false`, `linuxify run` blocks network syscalls via proot's `--no-net` flag. Used by tools that should never touch the network (offline formatters, static analyzers). |
| `filesystem.binds` | string[] | `["/sdcard:/workspace"]` | Additional bind mounts. Each entry is `host:guest` or `host:guest:ro`. The default `/sdcard:/workspace` is always granted; additional binds require approval. |
| `services.start` | string[] | `[]` | System services to start before `linuxify run`. Linuxify ensures these are running (via the distro's init system, or by spawning them itself if the distro has no init). |
| `setuid` | bool | `false` | Always `false` in v1. Reserved for a future "trusted packages" tier that would allow setuid binaries. |

The permission model is intentionally simple in v1: a package declares what it needs, the user approves on install, and that's it. There is no per-invocation permission prompt (which would be annoying for a CLI the user runs 50 times a day) and no per-file granularity (which would be impossible to express in YAML). The future direction is documented in [../19-future/vision-extension.md](../19-future/vision-extension.md): a v2 capability model with per-invocation prompts, similar to how Android itself prompts for permissions.

The first-install prompt looks like:

```
$ linuxify add aider
Package 'aider' (v0.42.0) requests the following permissions:
  ✓ network access (default)
  ✓ bind mount: /sdcard:/workspace (default)
  + bind mount: /sdcard/Projects:/projects (additional)
  + start service: redis (additional)
Approve all? [Y/n/e(=edit)] 
```

The `e` option drops the user into an editor where they can selectively approve or deny each permission. Denied permissions are recorded in `~/.linuxify/state.json` under `permissions.<package>.denied`; the package may or may not work with denied permissions (Linuxify does not enforce, only informs).

## 9. Example: Complete Package YAML

The following is a fully-annotated `cline.yml` showing every field in use. This is the reference example; new package authors should copy it as a starting template.

```yaml
# packages/cline.yml
# ─────────────────────────────────────────────────────────────────────────────
# Identity
name: cline                          # required; matches filename
version: 1.2.0                       # required; semver; this is the Linuxify package version
description: "AI coding agent that runs in your terminal"
homepage: https://github.com/cline/cline
license: MIT                         # SPDX identifier
maintainer: ravi@linuxify.dev        # Linuxify package maintainer (not upstream)

# Categorization
tags: [ai-coding, terminal, agent]
category: ai

# Runtime requirements
runtime: node
runtime_min_version: "20"            # Node 20 LTS or newer
runtime_max_version: null            # no upper bound (tested through Node 22)

# Upstream package
package: cline                       # npm package name
launcher: cline                      # binary name users type
package_manager: npm                 # inferred from runtime:node, but explicit is clearer

# Install / Uninstall
install:
  steps:
    - name: install
      command: npm install -g cline@1.2.0
      expect: 0
      retry: 2
      on_fail: abort
  env:
    npm_config_target_platform: linux   # tell npm to fetch linux binaries
uninstall:
  - npm uninstall -g cline

# Compatibility patches (see patcher-engine.md §3)
patches:
  - id: cline-001
    description: "Treat android as linux for process.platform check"
    file: "node_modules/cline/dist/platform.js"
    type: regex
    find: "process\\.platform === 'linux'"
    replace: "['linux','android'].includes(process.platform)"
    verify:
      command: "grep -q android node_modules/cline/dist/platform.js"
      expect: 0
    condition:
      file_exists: true
      find_present: true
  - id: cline-002
    description: "Support arm64 architecture"
    file: "node_modules/cline/dist/arch.js"
    type: regex
    find: "process\\.arch === 'x64'"
    replace: "['x64','arm64'].includes(process.arch)"
    verify:
      command: "grep -q arm64 node_modules/cline/dist/arch.js"
      expect: 0

# Environment variables (see §5)
env:
  CLINE_PLATFORM: linux              # simple form, scope=always, override=merge
  FORCE_COLOR: "1"
  NODE_OPTIONS:
    value: "--max-old-space-size=2048"
    scope: run
    override: merge

# Compatibility declarations (see §6)
compat:
  min_linuxify: "0.1.0"
  max_linuxify: null
  tested_distros: [ubuntu, debian]
  tested_runtimes:
    - runtime: node
      versions: ["20", "22"]
  known_issues:
    - id: cline-001
      severity: low
      description: "Tab completion does not work in sh (works in bash)"
      workaround: "Use bash as your shell"
      fixed_in: null
  not_supported:
    - distro: alpine
      reason: "musl libc incompatible with cline's native deps"

# Doctor checks (see §7)
doctor:
  - id: cline-node-version
    name: "Node version"
    command: "node --version"
    expect: "v((20|22)\\.)"
    severity: fail
    fix_command: "linuxify runtimes install node 22 --default"
    fix_severity: unsafe
  - id: cline-binary-present
    name: "cline binary"
    command: "which cline"
    expect: ".+"
    severity: fail
    fix_command: "linuxify add cline --force"
    fix_severity: unsafe
  - id: cline-patch-001
    name: "platform patch applied"
    command: "grep -q android $(dirname $(readlink -f $(which cline)))/../lib/node_modules/cline/dist/platform.js"
    expect: 0
    severity: warn
    fix_command: "linuxify patch cline"
    fix_severity: safe

# Permissions (see §8)
permissions:
  network: true
  filesystem:
    binds:
      - /sdcard:/workspace           # default; always granted
  services:
    start: []                        # cline does not need any services
  setuid: false

# Misc
bind_mounts: [/sdcard:/workspace]    # redundant with permissions.filesystem.binds but explicit
network: true                        # redundant with permissions.network but explicit
notes: "If cline crashes on startup, try linuxify patch cline to re-apply patches."
deprecated: false
replaces: []                         # this package does not supersede any other
conflicts: []                        # this package does not conflict with any other
```

## 10. Example: Simple Package

A bare-minimum YAML for a tool that needs no patches, no special env, and no custom doctor checks. This is the form most new packages start as; the contributor adds fields as they discover they need them.

```yaml
# packages/rg.yml — ripgrep
name: rg
version: 14.1.0
description: "ripgrep is a line-oriented search tool that recursively searches your current directory for a regex pattern"
homepage: https://github.com/BurntSushi/ripgrep
license: MIT
maintainer: ana@linuxify.dev
runtime: none                          # static binary, no runtime needed
package: ripgrep
launcher: rg
install:
  - curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/14.1.0/ripgrep-14.1.0-aarch64-unknown-linux-gnu.tar.gz | tar xz -C /tmp && mv /tmp/ripgrep-14.1.0-aarch64-unknown-linux-gnu/rg ~/.local/bin/
uninstall:
  - rm -f ~/.local/bin/rg
compat:
  min_linuxify: "0.1.0"
  tested_distros: [ubuntu, debian, arch, alpine]
  tested_runtimes: []
```

This YAML has 14 lines of substance. It declares the minimum: name, version, description, license, runtime (none, because ripgrep is a static binary), package, launcher, install, uninstall, and compat. There are no patches, no env, no doctor, no permissions (the defaults are fine: network is true but unused, binds is the default `/sdcard:/workspace`, services is empty). The `linuxify package lint` command will accept this YAML without warnings.

## 11. Example: Complex Package

A package that supports multiple runtimes, has conditional patches, and registers custom doctor checks. This is `aider-chat`, which can run on either Python 3.10+ or Node 20+ (the upstream project supports both via a Python core with optional Node-based features), and needs different patches on Alpine than on glibc distros.

```yaml
# packages/aider.yml
name: aider
version: 0.42.0
description: "AI pair programming in the terminal"
homepage: https://github.com/paul-gauthier/aider
license: Apache-2.0
maintainer: mira@linuxify.dev
tags: [ai-coding, terminal, agent]
category: ai

# Multi-runtime: prefer python, fall back to node
runtime: python
runtime_min_version: "3.10"
runtime_max_version: "3.13"           # aider's pyzmq dep breaks on 3.14

package: aider-chat
launcher: aider
package_manager: pip

install:
  steps:
    - name: create-venv
      command: python3 -m venv ~/.local/share/linuxify/packages/aider/venv
      on_fail: abort
    - name: install
      command: ~/.local/share/linuxify/packages/aider/venv/bin/pip install aider-chat==0.42.0
      retry: 2
      on_fail: abort
  env:
    PIP_DEFAULT_TIMEOUT: "120"

uninstall:
  - rm -rf ~/.local/share/linuxify/packages/aider/venv

patches:
  # Patch only needed on Alpine (musl)
  - id: aider-001
    description: "Pin pyzmq to <25.0 to avoid musl breakage"
    file: "venv/lib/python*/site-packages/zmq/__init__.py"
    type: regex
    find: "__zmq_version__ = .*"
    replace: "__zmq_version__ = '24.2.0-musl-patched'"
    condition:
      distro: [alpine]
      file_exists: true
  # Patch needed on armv7l only
  - id: aider-002
    description: "Force-disable torch on armv7l (no prebuilt wheels)"
    file: "venv/lib/python*/site-packages/aider/__main__.py"
    type: regex
    find: "import torch"
    replace: "# import torch  # disabled by linuxify on armv7l"
    condition:
      arch: [armv7l]
      file_exists: true

env:
  AIDER_AUTO_COMMITS: "false"
  PYTHONUNBUFFERED: "1"
  VIRTUAL_ENV:
    value: "~/.local/share/linuxify/packages/aider/venv"
    scope: run
    override: replace

compat:
  min_linuxify: "0.1.0"
  tested_distros: [ubuntu, debian]
  tested_runtimes:
    - runtime: python
      versions: ["3.10", "3.11", "3.12", "3.13"]
  known_issues:
    - id: aider-001
      severity: high
      description: "Crashes on Alpine due to pyzmq/musl incompatibility"
      workaround: "Apply patch aider-001 (auto-applied on Alpine installs)"
      fixed_in: null
    - id: aider-002
      severity: med
      description: "torch features unavailable on armv7l"
      workaround: "Use aarch64 device or accept reduced functionality"
      fixed_in: null
  not_supported:
    - distro: alpine
      runtime: python
      version: "3.14"
      reason: "pyzmq does not build on Python 3.14 + musl"

doctor:
  - id: aider-venv-present
    name: "Virtual environment"
    command: "test -d ~/.local/share/linuxify/packages/aider/venv"
    expect: 0
    severity: fail
    fix_command: "linuxify add aider --force"
    fix_severity: unsafe
  - id: aider-pyzmq-version
    name: "pyzmq version (Alpine)"
    command: "~/.local/share/linuxify/packages/aider/venv/bin/pip show zmq | grep -q '24.2.0-musl-patched'"
    expect: 0
    severity: warn
    fix_command: "linuxify patch aider --id aider-001"
    fix_severity: safe
    condition:
      distro: [alpine]

permissions:
  network: true
  filesystem:
    binds:
      - /sdcard:/workspace
      - /sdcard/Projects:/projects
  services:
    start: []                         # aider does not need redis (unlike aider-memory variant)
  setuid: false

replaces: [aider-chat-legacy]         # this package supersedes the old 'aider-chat-legacy' package
conflicts: []                         # can coexist with other AI CLIs

notes: |
  Multi-runtime: this YAML targets Python. A separate 'aider-node' package targets Node.
  On Alpine, patch aider-001 is auto-applied; on armv7l, patch aider-002 disables torch.
deprecated: false
```

## 12. Validation

`linuxify package lint <file>` validates a package YAML against the schema. It reports all errors at once (not just the first), so a contributor can fix everything in one pass. The lint command is what registry CI runs on every PR; a PR whose YAML fails lint cannot merge.

```bash
$ linuxify package lint packages/cline.yml
✓ name: valid
✓ version: valid (1.2.0)
✓ description: valid
✓ runtime: valid (node)
✓ runtime_min_version: valid (20)
✓ install: valid (1 step)
✓ patches: valid (2 patches)
✓ env: valid (3 vars)
✓ compat: valid
✓ doctor: valid (3 checks)
✓ permissions: valid
✓ no conflicts with other registry packages

All checks passed.
```

On failure:

```bash
$ linuxify package lint packages/badpkg.yml
✗ name: invalid pattern (must match ^[a-z][a-z0-9-]{1,62}$)
✗ version: missing required field
✓ description: valid
✗ install.steps[1].command: missing required field
✗ patches[0].id: must match pattern ^<package>-<NNN>$
✗ env.NODE_OPTIONS.override: invalid enum value 'overwrite' (must be merge|replace|append)

6 errors found. Fix and re-run.
```

The validator is implemented in `src/registry/lint.ts` and uses `ajv` for JSON Schema validation plus a custom semantic validator that checks cross-field constraints (e.g. "if `runtime: none`, then `runtime_min_version` must be absent"). The semantic validator's rules are documented in `docs/09-registry/lint-rules.md` (a future file). The validator's exit codes follow the [cli-specification.md](../03-cli/cli-specification.md) §6 convention: 0 for valid, 1 for invalid YAML, 2 for valid YAML but failed semantic checks, 3 for valid YAML but failed cross-package conflict checks.

## 13. Migration

When the package YAML schema changes (a new `schema_version` is released), existing YAMLs need to migrate. The migration is performed by `linuxify package migrate <file>`, which rewrites the YAML in place. Migration is always additive: new fields are added with sensible defaults, old fields are preserved (deprecated fields emit a lint warning, not an error, for at least one major version before being removed).

```bash
$ linuxify package migrate packages/cline.yml
Migrating cline.yml from schema v0 to v1...
  + added 'permissions.network' (default: true)
  + added 'permissions.filesystem.binds' (default: ['/sdcard:/workspace'])
  + added 'permissions.services.start' (default: [])
  + added 'permissions.setuid' (default: false)
  ~ moved 'bind_mounts' to 'permissions.filesystem.binds' (deprecated 'bind_mounts' kept for compat)
  + added 'patches[].condition' field (default: {})
Migration complete. 1 file updated.
```

The deprecation policy for old fields is: (1) the field is marked `deprecated` in the schema and emits a lint warning; (2) after one major Linuxify version (approximately 6 months), the field emits a lint error; (3) after two major versions, the field is removed from the schema and YAMLs containing it fail lint. This gives package authors a generous window to migrate.

The `schema_version` field itself is implicit: a v1 YAML has no `schema_version` field (v1 is the default); a v2 YAML has `schema_version: 2`. The validator infers the schema version from the field's presence and value. A YAML with an unknown `schema_version` fails lint with `E_PACKAGE_UNKNOWN_SCHEMA_VERSION` and the user is told to upgrade Linuxify.

## 14. Authors' FAQ

**Q: How do I install a specific npm version of a CLI?**
A: Pin it in the install command: `npm install -g cline@1.2.0`. The `version:` field at the top of the YAML is the Linuxify package version (used for upgrades and compat), not the npm version. The npm version is whatever you put in the install command. If you want to support multiple npm versions, declare multiple entries in the `versions:` array (see [registry-format.md](registry-format.md) §4).

**Q: How do I depend on another Linuxify package?**
A: You don't, directly. Linuxify v1 does not support inter-package dependencies (each package is installed into its own prefix and is self-contained). If your package needs `redis` running, declare it in `permissions.services.start: [redis]` — Linuxify will ensure redis is running before your package is invoked, but redis itself is installed via the distro's package manager (apt, apk), not via another Linuxify package. Inter-package dependencies are a v2 feature tracked in [../19-future/package-registry-future.md](../19-future/package-registry-future.md).

**Q: How do I ship a binary asset (e.g. a pre-built executable)?**
A: Don't ship it in the registry — the registry only holds YAML. Instead, declare an install step that downloads the binary from upstream at install time: `curl -fsSL https://example.com/binary-v1.0.0-aarch64.tar.gz | tar xz -C ~/.local/bin/`. Always include a sha256 verification step. If upstream does not provide a sha256, you can compute one yourself and host it in a Gist, but this is fragile — prefer upstream-provided checksums. For proprietary binaries, the same pattern works; the binary is never redistributed by Linuxify.

**Q: How do I handle proprietary licenses?**
A: Set `license: proprietary` and `license_url` to a URL where the user can read the license. On install, Linuxify prints the license URL and asks the user to confirm they have read and accept it (this prompt is skipped with `--yes`). Linuxify does not itself enforce license terms; the prompt is informational. If you are the licensor and want Linuxify to enforce a per-machine license, that is out of scope for v1 — file a feature request.

**Q: How do I mark a package as experimental?**
A: Set `tags: [experimental]` (or any tag that includes the word "experimental"). `linuxify search` will still find it but will mark it with an `(experimental)` annotation. Additionally, set `notes: "Experimental. API may change. Not for production use."` and the note will appear in `linuxify info <package>`. There is no formal "experimental" field in v1; the convention is tag-based. A formal `stability` field is planned for v1.1.

**Q: My package's install command needs to know the active distro. How?**
A: The `$LINUXIFY_DISTRO` environment variable is set to the active distro's name (`ubuntu`, `debian`, `arch`, `alpine`) during every install step. `$LINUXIFY_ARCH` is set to `aarch64`, `armv7l`, or `x86_64`. `$LINUXIFY_PACKAGE_NAME` and `$LINUXIFY_PACKAGE_VERSION` are set to the YAML's `name` and `version`. Use these to write distro-arch-aware install commands: `if [ "$LINUXIFY_DISTRO" = "alpine" ]; then apk add ...; else apt-get install -y ...; fi`.

**Q: My package needs a database migration on upgrade. How?**
A: Linuxify does not run migrations automatically. Declare the migration as a doctor check: `command: "my-cli migrate --check"`, `expect: 0`, `severity: warn`, `fix_command: "my-cli migrate --apply"`. The user will be prompted to apply the migration on the next `linuxify doctor`. If the migration is critical (data loss if skipped), set `severity: fail` instead of `warn`.

**Q: How do I test my YAML locally before submitting?**
A: `linuxify add ./my-package.yml --local`. This installs the package using your local YAML (not the registry's), applies the patches, and runs the doctor checks. Once it works locally, copy the YAML to your fork of `linuxify/registry` and open a PR. See [../04-ux/ux-flows.md](../04-ux/ux-flows.md) Flow 7 for the full submission walkthrough.

**Q: How do I rename a package?**
A: Open a PR that (1) adds the new `packages/<new-name>.yml` with `replaces: [<old-name>]`, (2) modifies `packages/<old-name>.yml` to set `deprecated: true` and `notes: "Renamed to <new-name>. Run: linuxify remove <old-name> && linuxify add <new-name>"`. Do not delete the old YAML — leave it as a deprecated stub so existing installs continue to receive security updates. After 6 months of deprecation, the old YAML can be yanked entirely.

**Q: Can a YAML have zero patches?**
A: Yes, and most do. The `patches:` field is optional and defaults to `[]`. A package with no patches is the common case for tools that already work on Android without modification (static binaries, pure-Python tools, tools that already check `process.platform === 'android'`). The patcher subsystem is invoked only when `patches:` is non-empty.
