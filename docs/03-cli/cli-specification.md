# CLI Specification

> Canonical contract for the `linuxify` command line interface. This document is the single source of truth for behavior, flags, exit codes, and output formats. An AI coding agent reading this document alone should be able to implement a conforming CLI.
>
> **Audience**: CLI implementers, AI coding agents, downstream tool integrators.
> **Version**: v1.0 (initial public release). Features tagged `[v1.1]` or `[v2]` are forward-looking.
> **Related**: [Command Reference](command-reference.md) · [UX Flows](../04-ux/ux-flows.md) · [Package Spec](../09-registry/package-spec.md)

---

## 1. Design Principles

Linuxify's CLI is designed to feel like `git`, `npm`, or `cargo` — a first-class developer tool, not a shell script glued together with hope. Every behavior in this specification derives from six principles. When in doubt about an edge case, the implementer should consult these principles before the prose.

**Verb-like and composable.** The CLI is organized as a tree of subcommands rather than a sea of unrelated flags. Each subcommand does one thing well (`add` installs, `doctor` diagnoses, `repair` fixes) and composes with the others via the shared state store at `~/.linuxify/`. Subcommands never reach into each other's internals; they communicate through files (`state.json`, `packages/<name>.json`) and well-defined exit codes. This makes the CLI scriptable, pipeline-friendly, and easy to teach: a user who learns `linuxify add` has learned the mental model for `linuxify remove`, `linuxify upgrade`, and so on.

**Idempotent by default.** Running the same command twice must produce the same result and must not corrupt state. `linuxify init` run on an already-initialized environment verifies integrity and exits 0; `linuxify add cline` on an already-installed package reports "already installed" and suggests `--force` rather than reinstalling or erroring. Idempotency is what lets users recover from interruptions (a killed `linuxify init` mid-download can simply be re-run) and what makes Linuxify safe to put in provisioning scripts. Every mutating subcommand must declare its idempotency semantics in its spec block.

**Fail loud, fail early.** Linuxify never silently swallows errors. A failed patch, a missing runtime, a full disk — all produce a non-zero exit code, a human-readable diagnostic, and a machine-readable error object (under `--json`). There are no "best effort" code paths that continue after a critical failure. The principle is that a user who runs `linuxify doctor && linuxify add cline` can trust the `&&`: if `doctor` reports a problem, `add` will not run. Quiet success is the norm; quiet failure is a bug.

**Offline-first.** The CLI assumes the network may be absent, slow, or metered. Package definitions, cached downloads, and distro rootfs tarballs live under `~/.linuxify/cache/` so that `linuxify add cline --offline` works against a warm cache. Any command that needs the network must check connectivity first and emit a structured `network_error` (exit 10) if it cannot reach its source, rather than hanging on a TCP timeout. The CLI also distinguishes "needs network" (`add`, `search`, `self-update`) from "fully local" (`list`, `info`, `env`, `doctor`) so that users on metered hotspots know what is safe to run.

**No magic.** Linuxify does not modify the user's shell rc files behind their back, does not inject environment variables globally, and does not auto-start background daemons. Every side effect — a symlink in `$PREFIX/bin/`, a line in `~/.linuxify/state.json`, a launcher script — is documented in the relevant subcommand's "Side effects" section. The one exception is `linuxify init`, which by default offers to append a single `source` line to `~/.bashrc` for PATH setup, and only after an interactive prompt (bypassable with `--yes` or `--no-shell-rc`).

**Observable.** Every run writes a structured log line, every long-running operation emits progress, and every state mutation is recorded so that `linuxify doctor` can reconstruct what happened. `--verbose` increases log verbosity; `--json` makes output machine-parseable; `--dry-run` previews what would happen without mutating state. A user should never have to guess what Linuxify did — `linuxify env`, `linuxify doctor`, and the log files together provide a complete audit trail.

---

## 2. Command Grammar

The following EBNF grammar defines the full syntactic surface of the CLI. Tokens in `{}` may appear zero or more times; `[ ]` are optional; `|` is alternation. Whitespace between tokens is not significant unless quoted.

```ebnf
program        ::= "linuxify" { global-flag } subcommand { subcommand-arg }

subcommand     ::= "init" | "install" | "use" | "add" | "remove" | "run"
                 | "shell" | "update" | "upgrade" | "doctor" | "repair"
                 | "patch" | "list" | "search" | "info" | "config"
                 | "env" | "self-update" | "completions" | "help" | "version"

subcommand-arg ::= positional | flag
positional     ::= bareword            (* not starting with "-" *)
flag           ::= "--" long-name [ "=" value | " " value ]
                 | "-" short-name [ value ]
global-flag    ::= "--help" | "-h" | "--version" | "-V" | "--verbose" | "-v"
                 | "--quiet" | "-q" | "--no-color" | "--config" path
                 | "--dry-run" | "-n" | "--yes" | "-y" | "--profile" name
                 | "--distro" name | "--json" | "--no-telemetry"
                 | "--offline" | "--debug"

bareword       ::= /[A-Za-z0-9_][A-Za-z0-9_\-\.+]*/
long-name      ::= /[a-z][a-z0-9\-]*/
short-name     ::= /[a-zA-Z]/
value          ::= bareword | quoted-string
quoted-string  ::= '"' { char } '"' | "'" { char } "'"
```

**Precedence of configuration sources** (highest to lowest):

1. Explicit CLI flags on the current invocation.
2. Environment variables prefixed `LINUXIFY_` (e.g. `LINUXIFY_DISTRO=debian`).
3. Project-local `.linuxify.toml` in the current working directory or nearest ancestor.
4. User config at `~/.linuxify/config.toml` under the active `[profile.<name>]` section.
5. User config default `[default]` section.
6. Compiled-in defaults.

This ordering means a CI script can override a user's interactive choices with `LINUXIFY_YES=1`, and a project repo can pin `distro = "ubuntu"` for reproducibility while still allowing a per-invocation `--distro alpine` override. All merges are deep (tables merge key-by-key, scalars replace), and the effective configuration can be inspected with `linuxify config --show --effective`.

---

## 3. Global Flags

Global flags may appear before *or* after the subcommand (`linuxify --json add cline` and `linuxify add cline --json` are equivalent). They are parsed by the top-level argument parser before dispatch to the subcommand handler.

| Flag | Short | Purpose |
|------|-------|---------|
| `--help` | `-h` | Print help for the subcommand (or top-level usage if no subcommand) and exit 0. |
| `--version` | `-V` | Print `linuxify <version>` and exit 0. With `--json`, emits `{"version": "...", "commit": "...", "build": "..."}`. |
| `--verbose` | `-v` | Increase log verbosity. Repeatable: `-v` = info, `-vv` = debug, `-vvv` = trace. Default is `warn`. |
| `--quiet` | `-q` | Suppress all non-error output. Overrides `--verbose`. |
| `--no-color` | — | Disable ANSI color regardless of TTY detection. |
| `--config <path>` | — | Load additional config file. May be repeated; later files override earlier. |
| `--dry-run` | `-n` | Plan and print actions without mutating state. Returns exit 0 if the plan would succeed, non-zero if it would fail. |
| `--yes` | `-y` | Answer "yes" to all interactive prompts. Required for non-interactive (CI) use. |
| `--profile <name>` | — | Select a named profile from `config.toml` (e.g. `work`, `minimal`). |
| `--distro <name>` | — | Override the active distro for this invocation only. Does not change `state.json`. |
| `--json` | — | Emit machine-readable JSON. Disables color and progress bars. See §5. |
| `--no-telemetry` | — | Disable telemetry for this invocation. Implied by `--json`. |
| `--offline` | — | Refuse any network access. Useful for metered connections and reproducible runs. |
| `--debug` | — | Enable crash-level diagnostics: stack traces, internal state dumps on error. |

`--help` and `--version` short-circuit: if either is present, no subcommand runs and no state is read. `--dry-run` is honored by every mutating subcommand (`init`, `add`, `remove`, `upgrade`, `repair`, `patch`, `self-update`); read-only subcommands ignore it.

---

## 4. Subcommand Reference

Each subcommand is specified with the same eight-field block so that an implementer can read them uniformly. Exit codes use the convention from §6; only the codes specifically emitted by the subcommand are listed.

### linuxify init

**Usage**: `linuxify init [--distro <name>] [--no-shell-rc] [--no-runtimes] [--force]`
**Purpose**: Bootstrap the Linuxify environment: install proot, fetch the distro rootfs, install default runtimes (Node.js, Python, Git), configure PATH, and write `~/.linuxify/state.json`. Idempotent — re-running on an existing environment verifies integrity and only repairs missing pieces.
**Arguments**: none.
**Flags**:
- `--distro <name>`: distro to install (default: `ubuntu`; one of `ubuntu`, `debian`, `arch`, `alpine`).
- `--no-shell-rc`: do not modify `~/.bashrc` (caller will handle PATH manually).
- `--no-runtimes`: skip runtime installation (useful when layering onto an existing proot distro).
- `--force`: reinstall even if environment appears healthy.

**Exit codes**: 0 success, 1 generic error, 3 runtime missing, 10 network error, 20 storage full, 30 proot unavailable, 31 rootfs download corrupt.
**Side effects**: creates `~/.linuxify/{cache,packages,logs,state.json,config.toml}`; downloads distro rootfs into `~/.linuxify/distros/<name>/`; optionally appends a single `source` line to `~/.bashrc`.
**Examples**:
```bash
$ linuxify init
✔ Checking Termux environment
✔ Installing proot-distro
↓ Downloading Ubuntu 24.04 rootfs (42%) [ETA 0:42]
✔ Configuring PATH in ~/.bashrc
✔ Installing Node.js LTS, Python 3.12, Git
Linuxify initialized. Run: linuxify add cline
```
```bash
$ linuxify init --distro alpine --no-shell-rc --yes
✔ Alpine 3.20 rootfs ready
✔ Runtimes: node@20, python@3.12, git
Linuxify initialized (alpine). PATH export skipped.
```
**Environment variables**: `LINUXIFY_DISTRO`, `LINUXIFY_INIT_NO_SHELL_RC=1`, `LINUXIFY_INIT_FORCE=1`.
**See also**: [`install`](#linuxify-install), [`use`](#linuxify-use), [`doctor`](#linuxify-doctor), [Bootstrap Design](../05-bootstrap/bootstrap-design.md).

### linuxify install

**Usage**: `linuxify install [--distro <name>]`
**Purpose**: Interactive alias for `init`. Prompts the user to choose a distro, confirm shell-rc modification, and select which runtimes to install. Intended for first-time human users; scripts should call `init` with `--yes` instead. Delegates entirely to the `init` codepath.
**Arguments**: none.
**Flags**: same as `init` plus `--non-interactive` (which converts this back into `init --yes`).
**Exit codes**: same as `init`.
**Side effects**: same as `init`.
**Examples**:
```bash
$ linuxify install
Welcome to Linuxify. Choose a distro:
  > Ubuntu 24.04  (recommended, 320 MB)
    Debian 12     (stable, 280 MB)
    Arch          (rolling, 210 MB)
    Alpine 3.20   (minimal, 45 MB)
Modify ~/.bashrc to add Linuxify to PATH? [Y/n]
```
**Environment variables**: same as `init`.
**See also**: [`init`](#linuxify-init).

### linuxify use

**Usage**: `linuxify use <distro> [--create] [--remove]`
**Purpose**: Switch the active distro recorded in `state.json`. The next `add`/`run`/`shell` will target this distro. With `--create`, downloads and provisions the distro if it is not yet present. With `--remove`, deletes a distro from disk (refuses if any installed packages depend on it unless `--force` is also given).
**Arguments**: `<distro>` — one of the supported distro names.
**Flags**: `--create`, `--remove`, `--force` (with `--remove`).
**Exit codes**: 0 success, 1 generic error, 2 distro not found (use `--create`), 4 distro in use by packages, 10 network error, 20 storage full.
**Side effects**: rewrites `state.json#active_distro`; with `--create`, downloads rootfs; with `--remove`, deletes `~/.linuxify/distros/<name>/`.
**Examples**:
```bash
$ linuxify use debian
✔ Active distro: debian
Packages installed under ubuntu are still there; switch back with: linuxify use ubuntu
```
**Environment variables**: `LINUXIFY_DISTRO` (read-only override via `--distro` is preferred).
**See also**: [`init`](#linuxify-init), [`list`](#linuxify-list), [Distro Management](../05-bootstrap/distro-management.md).

### linuxify add

**Usage**: `linuxify add <package> [--version <v>] [--runtime <name>] [--no-patch] [--force] [--ignore-compat]`
**Purpose**: Install a CLI tool into the active distro: resolve the package definition, ensure the runtime is present, run the install steps, apply compatibility patches, generate a launcher shim in `$PREFIX/bin/`, and record the install in `packages/<name>.json` and `state.json`.
**Arguments**: `<package>` — package name (matches `packages/<name>.yml`) or a fully qualified registry ref `@scope/name@version` (registry support is `[v2]`).
**Flags**:
- `--version <v>`: pin a specific version (default: latest).
- `--runtime <name>`: override the runtime declared by the package (rarely needed; useful for testing).
- `--no-patch`: install without applying patches. The tool may fail to run; intended for debugging and for contributing new patches.
- `--force`: reinstall over an existing install, overwriting the launcher.
- `--ignore-compat`: bypass `compat.min_linuxify` check. May produce a broken install.

**Exit codes**: 0 success, 1 generic error, 2 package not found, 3 runtime missing, 4 patch failed, 5 already installed (use `--force`), 10 network error, 20 storage full, 21 incompatible version, 22 patch definition invalid.
**Side effects**: writes `~/.linuxify/packages/<name>.json`; appends to `state.json#installed[]`; creates `$PREFIX/bin/<launcher>` (symlink to `~/.linuxify/launcher.sh`); writes patch backup under `~/.linuxify/cache/patches/<name>/<version>/`.
**Examples**:
```bash
$ linuxify add cline
✔ Ensuring runtime node@20
↓ npm install -g cline@1.2.0  (8.4 MB)
✔ Patching node_modules/cline/dist/platform.js
✔ Patching node_modules/cline/dist/arch.js
✔ Creating launcher: ~/../usr/bin/cline
Cline v1.2.0 installed. Run: cline
```
```bash
$ linuxify add cline
✖ cline is already installed (v1.2.0).
  To reinstall: linuxify add cline --force
  To upgrade:   linuxify upgrade cline
[exit 5]
```
```bash
$ linuxify add codex --version 0.20.1 --no-patch
✔ Installed codex@0.20.1 (patches skipped)
⚠ Tool may not work without patches. Run: linuxify patch codex
```
**Environment variables**: `LINUXIFY_ADD_VERSION`, `LINUXIFY_ADD_NO_PATCH=1`, `LINUXIFY_ADD_FORCE=1`, `LINUXIFY_RUNTIME_NODE`, `LINUXIFY_RUNTIME_PYTHON`.
**See also**: [`remove`](#linuxify-remove), [`upgrade`](#linuxify-upgrade), [`patch`](#linuxify-patch), [Package Spec](../09-registry/package-spec.md), [Patcher Engine](../08-patcher/patcher-engine.md).

### linuxify remove

**Usage**: `linuxify remove <package> [--purge] [--keep-config]`
**Purpose**: Uninstall a package: remove the launcher, run the package's declared uninstall steps, delete `packages/<name>.json`, and update `state.json`. With `--purge`, also delete cached downloads and patch backups. With `--keep-config`, leaves user config files inside the distro untouched (e.g. `~/.config/<tool>/`).
**Arguments**: `<package>` — installed package name.
**Flags**: `--purge`, `--keep-config`.
**Exit codes**: 0 success, 1 generic error, 2 package not installed, 6 uninstall step failed (partial removal; rerun with `--force`), 20 storage error.
**Side effects**: deletes `$PREFIX/bin/<launcher>`; runs uninstall steps; removes `packages/<name>.json`; updates `state.json`.
**Examples**:
```bash
$ linuxify remove aider
✔ Removing launcher
✔ npm uninstall -g aider
✔ Cleaning state
aider removed. Cache retained (use --purge to delete).
```
**Environment variables**: `LINUXIFY_REMOVE_PURGE=1`, `LINUXIFY_REMOVE_KEEP_CONFIG=1`.
**See also**: [`add`](#linuxify-add), [`list`](#linuxify-list).

### linuxify run

**Usage**: `linuxify run <package> [args...] [--]`
**Purpose**: Enter the active distro's proot and execute the package's launcher with the given arguments. The `--` separator forces all following tokens to be passed through verbatim, which is necessary when the wrapped tool accepts its own flags that collide with Linuxify's.
**Arguments**: `<package>` then arbitrary args forwarded to the tool.
**Flags**: none beyond globals. Use `--` to separate Linuxify flags from tool flags.
**Exit codes**: 0 success, 1 generic error, 2 package not installed, 3 runtime missing, 7 proot enter failed, 8 launcher missing (rerun `linuxify patch <pkg>`), *otherwise the wrapped tool's own exit code is propagated.*
**Side effects**: none (read-only entrypoint). The wrapped tool may have its own side effects.
**Examples**:
```bash
$ linuxify run cline --version
cline/1.2.0 linux-arm64 node-v20.10.0
```
```bash
$ linuxify run goose -- --help
Usage: goose [options] <command>
...
```
**Environment variables**: `LINUXIFY_RUN_DISTRO` (override distro for this run only), plus all env vars declared in the package YAML's `env:` block.
**See also**: [`shell`](#linuxify-shell), [`add`](#linuxify-add), [Launcher Architecture](../06-launcher/launcher-architecture.md).

### linuxify shell

**Usage**: `linuxify shell [--distro <name>] [--as <user>] [--workdir <path>]`
**Purpose**: Open an interactive shell inside the active distro's proot. Useful for poking at the distro directly, running tools that were not packaged, and debugging. Default user is `root` (proot convention); use `--as <user>` to drop privileges. The working directory defaults to the host CWD bind-mounted into the proot.
**Arguments**: none.
**Flags**: `--distro <name>`, `--as <user>`, `--workdir <path>`, `--no-bind-home` (do not bind-mount host home).
**Exit codes**: 0 shell exited cleanly, otherwise the shell's exit code.
**Side effects**: none beyond what the user does inside the shell.
**Examples**:
```bash
$ linuxify shell
[root@ubuntu ~]# apt list --installed | wc -l
412
[root@ubuntu ~]# exit
$
```
**Environment variables**: `LINUXIFY_SHELL_DISTRO`, `LINUXIFY_SHELL_AS`, `LINUXIFY_SHELL_WORKDIR`.
**See also**: [`run`](#linuxify-run), [`use`](#linuxify-use).

### linuxify update

**Usage**: `linuxify update [--check-only] [--packages] [--self]`
**Purpose**: Refresh the local index of available packages and check for available updates. By default refreshes both the package index and the self-update check. With `--check-only`, prints what *would* be updated without applying anything. With `--packages` only checks packages; with `--self` only checks Linuxify itself. Does not perform upgrades — use [`upgrade`](#linuxify-upgrade) or [`self-update`](#linuxify-self-update) for that.
**Arguments**: none.
**Flags**: `--check-only`, `--packages`, `--self`.
**Exit codes**: 0 up to date, 0 updates available (with informative output), 1 generic error, 10 network error.
**Side effects**: writes `~/.linuxify/cache/index.json` (the registry mirror).
**Examples**:
```bash
$ linuxify update
✔ Index refreshed (312 packages, 4 contributors)
Updates available:
  cline        1.2.0 → 1.3.1
  codex        0.20.1 → 0.21.0
  linuxify     0.1.0 → 0.2.0
Run: linuxify upgrade --all  |  linuxify self-update
```
**Environment variables**: `LINUXIFY_UPDATE_CHECK_ONLY=1`.
**See also**: [`upgrade`](#linuxify-upgrade), [`self-update`](#linuxify-self-update), [`info`](#linuxify-info).

### linuxify upgrade

**Usage**: `linuxify upgrade [<package>] [--all] [--dry-run] [--no-patch]`
**Purpose**: Upgrade one package (or all installed packages with `--all`) to the latest version recorded in the local index. Re-runs install + patch + launcher regeneration. Preserves user config files inside the distro. Always prints a diff of versions before applying unless `--yes` is given.
**Arguments**: `<package>` optional; required unless `--all`.
**Flags**: `--all`, `--dry-run`, `--no-patch`, `--to <version>` (pin target).
**Exit codes**: 0 success, 1 generic error, 2 package not installed, 4 patch failed, 5 already latest, 10 network error, 20 storage full.
**Side effects**: same as `add` plus removes the previous version's install.
**Examples**:
```bash
$ linuxify upgrade cline
cline 1.2.0 → 1.3.1
Proceed? [Y/n] y
✔ Downloading cline@1.3.1
✔ Patching (2 patches applied)
✔ Launcher updated
```
**Environment variables**: `LINUXIFY_UPGRADE_ALL=1`, `LINUXIFY_UPGRADE_TO`.
**See also**: [`add`](#linuxify-add), [`update`](#linuxify-update).

### linuxify doctor

**Usage**: `linuxify doctor [--fix] [--check <name>] [--json]`
**Purpose**: Run all health checks and print a report. Checks are declarative and each returns `ok | warn | fail | missing` plus a remediation hint. With `--fix`, attempts safe auto-repairs (rerun `patch`, recreate launcher, fix PATH); unsafe repairs require explicit `linuxify repair`. With `--check <name>`, runs only the named check.
**Arguments**: none.
**Flags**: `--fix`, `--check <name>`, `--json`.
**Exit codes**: 0 all checks ok, 1 one or more warnings, 2 one or more failures, 3 environment not initialized.
**Side effects**: with `--fix`, may rewrite launchers, PATH, patch files. Always writes a report to `~/.linuxify/logs/doctor-<timestamp>.json`.
**Examples**: see [context §7](../../.agent-context.md#7-doctor-output-example) and [Command Reference](command-reference.md#linuxify-doctor).
**Environment variables**: `LINUXIFY_DOCTOR_FIX=1`, `LINUXIFY_DOCTOR_CHECK`.
**See also**: [`repair`](#linuxify-repair), [`env`](#linuxify-env), [Doctor Engine](../07-doctor/doctor-engine.md).

### linuxify repair

**Usage**: `linuxify repair [--package <name>] [--dry-run] [--reset]`
**Purpose**: Apply all auto-repairs suggested by `doctor`, including potentially destructive ones (reinstall a corrupt distro rootfs, reset state.json). With `--package`, only repairs that package. With `--reset`, wipes `state.json` and re-derives it from the filesystem (last-resort recovery; user must confirm unless `--yes`). Always prompts before any destructive action unless `--yes`.
**Arguments**: none.
**Flags**: `--package <name>`, `--dry-run`, `--reset`, `--from-backup <path>` (restore from a known-good backup).
**Exit codes**: 0 success, 1 generic error, 4 repair step failed, 9 backup corrupt / not found, 20 storage full.
**Side effects**: many — re-downloads rootfs, re-applies patches, regenerates launchers, may rewrite `state.json`.
**Examples**:
```bash
$ linuxify repair
Doctor reported 3 issues. Repair plan:
  1. Recreate launcher for cline (missing)
  2. Re-patch codex (patch checksum mismatch)
  3. Reinstall Python 3.12 (broken symlinks)
Proceed? [Y/n] y
✔ 3/3 repairs applied. Run: linuxify doctor
```
**Environment variables**: `LINUXIFY_REPAIR_RESET=1`, `LINUXIFY_RESEARCH_FROM_BACKUP`.
**See also**: [`doctor`](#linuxify-doctor), [`patch`](#linuxify-patch), [Disaster Recovery](../22-operations/disaster-recovery.md).

### linuxify patch

**Usage**: `linuxify patch <package> [--revert] [--list] [--dry-run]`
**Purpose**: Re-apply (or with `--revert`, undo) the compatibility patches declared in the package's YAML. Useful after a manual `npm update` inside the distro that overwrote patched files. With `--list`, prints the patch definitions without applying them. Patches are AST-aware for JS/TS and regex-based for everything else; a checksum is stored so re-patching an already-patched file is a no-op.
**Arguments**: `<package>` — installed package name.
**Flags**: `--revert`, `--list`, `--dry-run`.
**Exit codes**: 0 success, 1 generic error, 2 package not installed, 4 patch failed (find string not present), 22 patch definition invalid, 23 patch already applied (with `--revert`, nothing to revert).
**Side effects**: modifies files inside the distro; writes patch backups under `~/.linuxify/cache/patches/<name>/`.
**Examples**:
```bash
$ linuxify patch cline
✔ 2 patches applied (platform.js, arch.js)
✔ Backups written to ~/.linuxify/cache/patches/cline/1.2.0/
```
**Environment variables**: `LINUXIFY_PATCH_REVERT=1`.
**See also**: [`add`](#linuxify-add), [`repair`](#linuxify-repair), [Patcher Engine](../08-patcher/patcher-engine.md).

### linuxify list

**Usage**: `linuxify list [--distro <name>] [--json] [--verbose]`
**Purpose**: Print installed packages for the active (or `--distro`) distro. Default output is a table; `--json` emits the `packages/<name>.json` documents; `--verbose` adds install date, patch status, and last-run timestamp.
**Arguments**: none.
**Flags**: `--distro <name>`, `--json`, `--verbose`, `--all-distros`.
**Exit codes**: 0 success, 3 environment not initialized.
**Side effects**: none (read-only).
**Examples**:
```bash
$ linuxify list
NAME       VERSION   RUNTIME   PATCHED   DISTRO
cline      1.2.0     node@20   yes       ubuntu
codex      0.20.1    node@20   yes       ubuntu
aider      0.14.0    python@3  yes       ubuntu
```
**Environment variables**: none beyond globals.
**See also**: [`info`](#linuxify-info), [`search`](#linuxify-search), [`use`](#linuxify-use).

### linuxify search

**Usage**: `linuxify search <query> [--tag <t>] [--runtime <r>] [--limit <n>]`
**Purpose**: Search the local package index (and the remote registry when online) for packages matching `<query>`. Matching is fuzzy on name and description; tags narrow by category (e.g. `ai`, `editor`, `vcs`).
**Arguments**: `<query>` — free text.
**Flags**: `--tag <t>` (repeatable), `--runtime <r>`, `--limit <n>` (default 20), `--offline` (search local index only).
**Exit codes**: 0 success (even with no matches), 1 generic error, 10 network error (with `--offline` suppressed).
**Side effects**: none.
**Examples**:
```bash
$ linuxify search "ai agent"
NAME        DESCRIPTION                                  RUNTIME
cline       AI coding agent that runs in your terminal   node
codex       OpenAI's terminal coding agent               node
goose       Local AI agent from Block                    node
aider       AI pair programming in the terminal          python
```
**Environment variables**: `LINUXIFY_SEARCH_LIMIT`.
**See also**: [`info`](#linuxify-info), [`add`](#linuxify-add).

### linuxify info

**Usage**: `linuxify info <package> [--json]`
**Purpose**: Print the resolved package definition (YAML or JSON) plus install status, available versions, declared patches, and compat notes. This is the canonical "tell me everything about this package" command and is heavily used by AI coding agents to decide whether a tool can be installed.
**Arguments**: `<package>`.
**Flags**: `--json`, `--versions` (list all known versions), `--changelog` (print recent changelog).
**Exit codes**: 0 success, 2 package not found.
**Side effects**: none.
**Examples**:
```bash
$ linuxify info cline
name:         cline
version:      1.2.0 (latest: 1.3.1)
runtime:      node >=20
homepage:     https://github.com/cline/cline
license:      MIT
installed:    yes (ubuntu)
patches:      2 (platform.js, arch.js)
compat:
  min_linuxify: 0.1.0
  tested_distros: [ubuntu, debian]
  known_issues: []
```
**Environment variables**: none beyond globals.
**See also**: [`add`](#linuxify-add), [`search`](#linuxify-search), [Package Spec](../09-registry/package-spec.md).

### linuxify config

**Usage**: `linuxify config <key> [value] | --show | --unset <key>`
**Purpose**: Read or write keys in `~/.linuxify/config.toml`. Without a value, prints the current value; with a value, sets it. `--show` prints the entire effective config (after merging profiles, env vars, and project-local files); `--show --effective` includes compiled defaults. `--unset` deletes a key.
**Arguments**: `<key>` uses dotted notation (`profile.work.distro`).
**Flags**: `--show`, `--unset`, `--effective`, `--global` (force write to user config even when a project-local file exists).
**Exit codes**: 0 success, 2 key not found (on read/unset), 24 invalid value, 25 file parse error.
**Side effects**: rewrites `~/.linuxify/config.toml` or `.linuxify.toml`.
**Examples**:
```bash
$ linuxify config default.distro
ubuntu
$ linuxify config default.distro debian
✔ Set default.distro = debian
$ linuxify config --show --effective
[default]
distro = "debian"
telemetry = true
...
```
**Environment variables**: `LINUXIFY_CONFIG_PATH` (override config file location).
**See also**: §7 of this document, [`env`](#linuxify-env).

### linuxify env

**Usage**: `linuxify env [--json] [--for-run <package>]`
**Purpose**: Print the resolved environment that Linuxify would set when running a tool: PATH, runtime versions, distro, and any package-declared env vars. With `--for-run <package>`, simulates the env that `linuxify run <package>` would produce. Designed for debugging "why does my tool see `process.platform === android`?".
**Arguments**: none.
**Flags**: `--json`, `--for-run <package>`, `--diff` (compare to current shell env).
**Exit codes**: 0 success, 3 environment not initialized, 2 package not installed (with `--for-run`).
**Side effects**: none.
**Examples**:
```bash
$ linuxify env --for-run cline
LINUXIFY_DISTRO=ubuntu
LINUXIFY_RUNTIME_NODE=/usr/bin/node
PATH=/data/data/com.termux/files/usr/bin:...
CLINE_PLATFORM=linux
FORCE_COLOR=1
```
**Environment variables**: none (this command reads them, it does not consume them).
**See also**: [`doctor`](#linuxify-doctor), [`run`](#linuxify-run).

### linuxify self-update

**Usage**: `linuxify self-update [--check] [--to <version>]`
**Purpose**: Update the Linuxify CLI itself. Downloads the new release, verifies its checksum and signature, runs any bundled migration script, and atomically swaps the binary. The old binary is kept under `~/.linuxify/cache/linuxify-<old-version>` so a rollback is one symlink away. With `--check`, only reports availability.
**Arguments**: none.
**Flags**: `--check`, `--to <version>` (downgrade or pin), `--prerelease`, `--force`.
**Exit codes**: 0 success, 0 up to date (with `--check`), 1 generic error, 10 network error, 26 signature verification failed, 27 migration failed (rolled back).
**Side effects**: replaces `$PREFIX/bin/linuxify`; writes `~/.linuxify/migrations/<from>-<to>.log`; updates `state.json#linuxify_version`.
**Examples**:
```bash
$ linuxify self-update
Current: 0.1.0  Target: 0.2.0
✔ Downloading linuxify-0.2.0-linux-arm64.tar.gz
✔ Signature verified (ed25519:9f3a...)
✔ Running migration 0.1.0 → 0.2.0
✔ Swapping binary (backup at ~/.linuxify/cache/linuxify-0.1.0)
Linuxify 0.2.0 installed. Restart your shell.
```
**Environment variables**: `LINUXIFY_SELF_UPDATE_TO`, `LINUXIFY_SELF_UPDATE_CHANNEL=stable|prerelease`.
**See also**: [`update`](#linuxify-update), [Release Pipeline](../14-cicd/release-pipeline.md).

### linuxify completions

**Usage**: `linuxify completions <shell>`
**Purpose**: Emit a shell completion script for bash, zsh, or fish. The script is installed by the user (or by `linuxify init --completions`) into the appropriate completions directory. Completions cover subcommands, global flags, distro names, installed package names, and runtime names.
**Arguments**: `<shell>` — one of `bash`, `zsh`, `fish`.
**Flags**: `--install` (write to the standard location and print instructions).
**Exit codes**: 0 success, 2 unsupported shell.
**Side effects**: with `--install`, writes to `~/.bashrc.d/linuxify.sh`, `~/.zsh/completions/_linuxify`, or `~/.config/fish/completions/linuxify.fish`.
**Examples**:
```bash
$ linuxify completions zsh --install
✔ Installed to ~/.zsh/completions/_linuxify
Add this to ~/.zshrc: fpath+=(~/.zsh/completions); autoload -Uz compinit && compinit
```
**Environment variables**: `LINUXIFY_COMPLETIONS_SHELL`.
**See also**: §11 of this document.

### linuxify help / linuxify version

**Usage**: `linuxify help [<subcommand>]` · `linuxify version`
**Purpose**: `help` prints top-level usage or a subcommand's help. `version` prints `linuxify <version>` plus build metadata. Both are also reachable via `--help` / `--version` global flags.
**Exit codes**: 0 success, 2 unknown subcommand (for `help`).
**Examples**:
```bash
$ linuxify version
linuxify 0.2.0 (linux-arm64, commit 9f3a7c1, built 2025-01-14)
$ linuxify help add
... (same as linuxify add --help)
```

---

## 5. Output Formats

Linuxify supports four output modes, selected by global flags. The CLI never silently changes format mid-stream — once a mode is selected for an invocation, every line conforms to that mode.

**Human (default).** Colored text, Unicode glyphs (`✔ ✖ ⚠ ↓`), aligned tables, and progress bars when attached to a TTY. Designed for a 80-column Termux terminal. Colors follow the convention: green for success, red for error, yellow for warning, cyan for progress, dim for secondary info. Section headers are bold.

**JSON (`--json`).** Every command emits a single JSON document on stdout (multiple documents, one per line, are also valid via `--jsonl`). The schema is stable and versioned:

```json
{
  "schema": "linuxify.v1",
  "command": "add",
  "ok": true,
  "result": {
    "package": "cline",
    "version": "1.2.0",
    "distro": "ubuntu",
    "patches_applied": ["platform.js", "arch.js"],
    "launcher": "/data/data/com.termux/files/usr/bin/cline"
  },
  "warnings": [],
  "errors": [],
  "duration_ms": 4280,
  "log_path": "~/.linuxify/logs/linuxify-20250114.log"
}
```

On error:

```json
{
  "schema": "linuxify.v1",
  "command": "add",
  "ok": false,
  "result": null,
  "warnings": [],
  "errors": [
    {
      "code": "PATCH_FAILED",
      "message": "Patch 'platform.js' could not find expected string.",
      "file": "node_modules/cline/dist/platform.js",
      "remediation": "The package may have been updated. Run: linuxify patch cline --list",
      "doc_url": "https://linuxify.dev/docs/errors/PATCH_FAILED"
    }
  ],
  "duration_ms": 980
}
```

Every error object MUST include `code`, `message`, and `remediation`; `doc_url` is strongly recommended. Error codes are stable across releases; messages are not (do not string-match on them).

**Plain (`--no-color`).** Same content as human mode but with no ANSI escapes and ASCII-only glyphs (`[ok]`, `[x]`, `[!]`, `[v]`). Suitable for piping into `less`, logging to a file, or pasting into a bug report.

**Verbose (`-v`, `-vv`, `-vvv`).** Adds detail at each level: `-v` prints every external command run (`npm install -g cline`); `-vv` prints the resolved config and env; `-vvv` prints internal state transitions and patcher AST dumps. Verbose mode is orthogonal to JSON mode (`--json -vv` is valid and useful for debugging integrations).

---

## 6. Exit Code Convention

Linuxify follows the spirit of `ls`/`grep`/`curl`: small exit codes are stable and semantic, larger codes are subcommand-specific. Codes ≥64 follow the `sysexits.h` convention where applicable.

| Code | Name | Meaning |
|------|------|---------|
| 0 | `OK` | Success. |
| 1 | `GENERIC_ERROR` | Failure not covered by a more specific code. |
| 2 | `NOT_FOUND` | Package, distro, file, or config key not found. |
| 3 | `ENV_NOT_READY` | Environment not initialized; run `linuxify init`. |
| 4 | `STEP_FAILED` | An install/patch/repair step failed. |
| 5 | `ALREADY_INSTALLED` | Package already installed; use `--force`. |
| 6 | `UNINSTALL_FAILED` | Uninstall step failed; partial removal. |
| 7 | `PROOT_ENTER_FAILED` | Could not enter proot. Usually a Termux/Android issue. |
| 8 | `LAUNCHER_MISSING` | Launcher shim absent; rerun `linuxify patch <pkg>`. |
| 9 | `BACKUP_CORRUPT` | Backup file missing or failed checksum. |
| 10 | `NETWORK_ERROR` | Network unreachable or registry returned an error. |
| 20 | `STORAGE_FULL` | Insufficient disk space in `~/.linuxify/`. |
| 21 | `VERSION_INCOMPAT` | Package requires a newer Linuxify. |
| 22 | `PATCH_INVALID` | Patch definition is malformed. |
| 23 | `PATCH_ALREADY_APPLIED` | Idempotent re-patch; with `--revert`, nothing to undo. |
| 24 | `CONFIG_INVALID_VALUE` | Config key value failed schema validation. |
| 25 | `CONFIG_PARSE_ERROR` | TOML parse error in a config file. |
| 26 | `SIGNATURE_FAILED` | Self-update signature verification failed. |
| 27 | `MIGRATION_FAILED` | Self-update migration rolled back. |
| 28 | `TELEMETRY_DISABLED` | Informational; emitted to stderr only. |
| 30 | `PROOT_UNAVAILABLE` | proot binary missing; install with `pkg install proot`. |
| 31 | `ROOTFS_CORRUPT` | Distro rootfs failed integrity check; rerun `linuxify use --create`. |
| 64 | `USAGE` (`sysexits`) | Bad command-line usage. |
| 65 | `DATA_ERR` | Internal data corruption. |
| 70 | `INTERNAL_ERR` | Internal software error (please file a bug). |
| 78 | `CONFIG_ERR` | Configuration problem (sysexits). |
| 126 | `NOT_EXECUTABLE` | Launcher exists but is not executable. |
| 127 | `COMMAND_NOT_FOUND` | Subcommand does not exist. |
| 130 | `INTERRUPTED` | Ctrl-C / SIGINT. |

Exit codes 9–31 are Linuxify-specific and stable for v1. Codes ≥64 are reserved for `sysexits.h` alignment. Wrapped-tool exit codes (from `linuxify run`) are propagated verbatim as long as they are <125.

---

## 7. Configuration Files

Linuxify reads TOML configuration from up to four locations, merged in the precedence order given in §2. The canonical user file is `~/.linuxify/config.toml`:

```toml
[default]
distro = "ubuntu"            # default active distro
telemetry = true             # anonymous usage stats; disable with --no-telemetry
auto_update_check = true     # background check for new versions
log_level = "warn"           # error | warn | info | debug | trace
color = "auto"               # auto | always | never
shell_rc = "~/.bashrc"       # which rc file init may modify
cache_ttl_hours = 168        # registry index cache lifetime

[profile.work]
distro = "arch"
telemetry = false

[profile.minimal]
distro = "alpine"
no_runtimes = ["python"]     # don't auto-install python

[run]
default_distro = "ubuntu"    # distro used when --distro not given
bind_home = true             # bind-mount host $HOME into proot

[patcher]
prefer_ast = true            # use AST patcher for JS/TS when possible
backup = true                # write patch backups
```

A project-local `.linuxify.toml` in the working directory (or nearest ancestor) follows the same schema and is intended for reproducible per-project setup. Common uses: pin a distro for CI, pin package versions, disable telemetry on shared infrastructure.

**Env var precedence.** Any config key `a.b.c` can be overridden by `LINUXIFY_A_B_C` (uppercase, dots become underscores). Booleans accept `1`/`0`/`true`/`false`. Lists accept colon-separated values on Unix. Env vars always win over file values, and explicit CLI flags always win over env vars. Use `linuxify config --show --effective` to inspect the resolved configuration at any time.

---

## 8. Logging

Every Linuxify invocation appends to a daily log file at `~/.linuxify/logs/linuxify-YYYYMMDD.log`. Logs are plain text with a stable prefix format:

```
2025-01-14T10:42:13Z INFO  add    cline  downloading rootfs 42%
2025-01-14T10:42:48Z INFO  add    cline  patching platform.js
2025-01-14T10:42:49Z OK    add    cline  installed v1.2.0 in 4280ms
```

**Rotation.** Logs rotate daily and are kept for 30 days. A `logs/archive/` subdirectory holds gzipped logs older than 7 days. The `linuxify repair --reset-logs` action truncates everything (with confirmation).

**Verbosity.** The file log always captures `info` and above; `--verbose` increases *both* terminal and file verbosity (so `-vv` writes `debug` lines to the file even though they don't appear on a non-verbose terminal). `--quiet` does not affect the file log — operators should always be able to investigate after the fact.

**Secrets.** The logger runs every message through a redaction filter that masks values matching common secret patterns: `Authorization` headers, `Bearer` tokens, `xox[baprs]-` (Slack), `gh[pousr]_` (GitHub), `AKIA…` (AWS), and any env var whose name contains `TOKEN`, `SECRET`, `PASSWORD`, or `KEY`. Masked values appear as `***REDACTED***`. Package-defined env vars that look sensitive are also masked.

**Doctor reports.** `linuxify doctor` writes a structured JSON report to `~/.linuxify/logs/doctor-<timestamp>.json` in addition to its terminal output, so a user can `linuxify repair` against an old report or attach it to a bug report.

---

## 9. Internationalization

All user-facing strings — help text, progress messages, error messages — live in a single message catalog keyed by stable identifiers (`add.success`, `doctor.fail.proot_missing`). The default language is English (`en`); community translations are welcomed via pull request against `locales/<lang>.po`. Locale detection follows the user's `LANG` / `LC_ALL` / `LC_MESSAGES` environment variables with a graceful fallback to English. If a translation key is missing, English is used; if English is missing (impossible in a release build), the bare key is printed.

Importantly, **error codes and JSON field names are never translated**. A user running with `LANG=pt_BR.UTF-8` still sees `"code": "PATCH_FAILED"` in JSON output; only the human-readable `message` and `remediation` fields are localized. This keeps machine parsing stable across locales. Contributors adding translations should run `linuxify i18n --check` (a maintainer tool) to verify completeness against the catalog.

---

## 10. Color & TTY

Color output is enabled by default when stdout is a TTY and `NO_COLOR` is not set (per the `no-color.org` standard). It can be forced on with `FORCE_COLOR=1` (or `--color always`) and forced off with `--no-color` or `NO_COLOR=1`. The default color palette assumes a dark terminal; users on light themes can set `config.toml` `theme = "light"` to swap to a higher-contrast palette (darker text, brighter accents).

Linuxify detects terminal width via `ioctl(TIOCGWINSZ)` and re-wraps tables and progress bars accordingly. When width is unavailable (piped output), it assumes 80 columns and disables dynamic elements. Truecolor (24-bit) escape sequences are used when the terminal advertises support (`COLORTERM=truecolor`); otherwise the 256-color palette is used; otherwise the basic 8-color palette. No user action is required — degradation is automatic.

---

## 11. Tab Completion

`linuxify completions <shell>` generates a completion script for bash, zsh, or fish. The script knows about:

- All subcommands and their aliases (`install` ↔ `init`).
- Global flags and per-subcommand flags.
- Distro names (`ubuntu`, `debian`, `arch`, `alpine`).
- Installed package names (for `remove`, `run`, `upgrade`, `info`, `patch`).
- Available package names from the local index (for `add`, `search`, `info`).
- Runtime names (`node`, `python`, `rust`, `go`, `bun`, `deno`).
- Config keys (for `config`).

Install with `linuxify completions zsh --install` (writes to the standard location) or by piping the script into the appropriate rc file. After installation, `linuxify add <TAB>` offers fuzzy-matched package names; `linuxify run <TAB>` offers only installed packages. The completion scripts are versioned alongside the CLI so they always match the installed command surface.

---

## 12. Interactive Prompts

Linuxify is interactive by default for actions that are ambiguous or destructive, and non-interactive when `--yes` is given (this is required for CI and for AI agents). Prompts follow these rules:

- **Default to safe.** When a prompt offers `[Y/n]`, the default is `n` unless the action is idempotent and reversible (in which case it's `Y`). The default is shown capitalized.
- **Single key when possible.** Yes/no prompts accept `y`, `n`, or Enter (for the default) and do not require Enter on TTYs that support raw mode.
- **Fuzzy search.** When a prompt asks the user to pick from a long list (distros, packages, versions), it presents an interactive fuzzy-search UI unless `--no-fuzzy` is set. Typing filters; arrow keys select; Enter confirms.
- **Bypass.** `--yes` answers yes to all prompts. `--no` (rare) answers no to all and is useful for dry-run-like behavior in scripts. `LINUXIFY_YES=1` is the env equivalent.
- **Timeout.** For CI safety, prompts time out after 60 seconds with the safe default and a warning, rather than hanging forever.

---

## 13. Error Messages

Every error message follows a four-part structure: (a) what went wrong, (b) why, (c) a suggested fix command, (d) a documentation link. This structure is enforced by the error-emission helper; no code path may print a bare error string.

Example human-format error:

```
✖ Failed to install cline.
  Reason: Patch 'platform.js' could not find the expected string
          `process.platform === 'linux'` in
          node_modules/cline/dist/platform.js.
          The package may have been updated since this patch was written.
  Fix:   linuxify patch cline --list      # see declared patches
         linuxify add cline --no-patch    # install without patching (may not run)
         linuxify info cline --changelog  # check for patch updates
  Docs:  https://linuxify.dev/docs/errors/PATCH_FAILED
[exit 4]
```

The JSON equivalent (under `--json`) carries the same four parts as structured fields, with the additional `code` (stable identifier) and `details` (machine-readable context). Error messages are written in plain language — they avoid internal jargon ("the patcher AST visitor returned E_NOT_FOUND") and instead describe what the user can observe and act on. When an error has multiple plausible fixes, all are listed, ordered by likelihood. When an error is likely caused by a known upstream bug, the message links to the tracking issue.

---

## Conformance Checklist for Implementers

A CLI implementation conforms to this specification if and only if:

1. Every subcommand in §4 is present, accepts its declared flags, and emits the declared exit codes.
2. Global flags in §3 are accepted before or after the subcommand and behave as described.
3. `--json` output validates against the schema in §5 for every subcommand.
4. The exit code table in §6 is honored exactly.
5. Config files are loaded and merged per §2 and §7.
6. Logs are written per §8 with secret redaction enabled.
7. No subcommand silently swallows an error; all failures emit a four-part message per §13.

Implementers who find an underspecified edge case should file a documentation issue rather than guessing; this spec is intended to be exhaustive enough to remove ambiguity.
