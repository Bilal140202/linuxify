# Command Reference

> Example-heavy companion to the [CLI Specification](cli-specification.md). Where the spec is normative, this document is pragmatic: it shows realistic terminal sessions, common pitfalls, and the kind of FAQ answers a senior contributor would give on a help channel.
>
> **Audience**: end users, contributors, and AI coding agents who learn best from examples.
> **Related**: [CLI Specification](cli-specification.md) · [UX Flows](../04-ux/ux-flows.md) · [Troubleshooting](../22-operations/troubleshooting.md)

---

## How to Read This Document

Commands are grouped by lifecycle stage so you can read top-to-bottom and end up with a working mental model: first you **set up**, then you **manage packages**, then you **execute** them, then you **diagnose** problems, and finally you **configure** the tool itself. Each command gets a one-line summary, a detailed description, five or more worked examples with realistic output, related commands, and a short FAQ. Cross-references use the spec as the canonical source — when this document and the spec disagree, the spec wins.

Every transcript in this document was written to be plausibly real: byte counts, version numbers, and timings match what an aarch64 Termux install actually produces. They are illustrative, not authoritative — your real output will differ in the details. Where a transcript includes an error, the exit code is shown on the last line in `[exit N]` form so you can match it against the [exit code table](cli-specification.md#6-exit-code-convention).

---

## Setup Commands

### linuxify init

One-line summary: **bootstrap the Linuxify environment on a fresh Termux install.**

`linuxify init` is the command you run exactly once per device. It installs `proot-distro`, downloads a Linux root filesystem (Ubuntu 24.04 by default), installs the default runtimes (Node.js LTS, Python 3.12, Git), configures your `PATH`, and writes `~/.linuxify/state.json`. The command is idempotent, which is its most important property: if your phone dies mid-download, you re-run `linuxify init` and it picks up where it left off rather than starting over or corrupting state. Re-running on a healthy environment simply verifies integrity and exits 0. This makes `linuxify init` safe to put in a provisioning script, a dotfiles bootstrap, or a CI matrix setup.

The most common pitfall is running `init` without enough free space. A bare Ubuntu rootfs is ~320 MB; once runtimes are added, you should budget at least 2 GB free under `$HOME`. The second most common pitfall is running `init` from the Play Store version of Termux, which is unsupported — Linuxify detects this and exits with code 30 (`PROOT_UNAVAILABLE`) and a message directing you to the F-Droid build. A third pitfall, less common but nasty, is having a stale `~/.linuxify/` from an old alpha build; `--force` wipes and recreates it, but you will lose installed packages.

```bash
$ linuxify init
✔ Checking Termux environment
✔ Installing proot-distro (already present)
↓ Downloading Ubuntu 24.04 rootfs [████████░░] 78% (ETA 0:12)
✔ Verifying rootfs checksum (sha256:9f3a...)
✔ Configuring PATH in ~/.bashrc
✔ Installing Node.js LTS v20.10.0
✔ Installing Python 3.12.3
✔ Installing Git 2.49.0
Linuxify initialized. Run: linuxify add cline
```

```bash
$ linuxify init --distro alpine --no-shell-rc --yes
✔ Alpine 3.20 rootfs ready (45 MB)
✔ Runtimes: node@20, git (python skipped — not in alpine default)
Linuxify initialized (alpine). PATH export skipped; add manually:
  export PATH=$HOME/.linuxify/bin:$PATH
```

```bash
$ linuxify init
✔ Environment already initialized (Ubuntu 24.04, 3 packages installed)
Nothing to do. Run: linuxify doctor
```

```bash
$ linuxify init --dry-run
Plan:
  1. Verify proot-distro present           (skip: installed)
  2. Download Ubuntu 24.04 rootfs          (320 MB)
  3. Configure PATH in ~/.bashrc           (append 1 line)
  4. Install Node.js LTS, Python 3.12, Git (in proot)
  5. Write ~/.linuxify/state.json
Disk required: ~1.4 GB. Available: 12.4 GB. OK.
[exit 0, no changes made]
```

```bash
$ linuxify init
✖ Insufficient storage.
  Reason: Linuxify needs at least 1.5 GB free under $HOME; found 0.4 GB.
  Fix:   termux-setup-storage && mv ~/storage/downloads/* /sdcard/
         pkg clean
  Docs:  https://linuxify.dev/docs/errors/STORAGE_FULL
[exit 20]
```

**Related**: `install`, `use`, `doctor`. **FAQ**: *Do I need root?* No. *Does it modify my Android system?* No — everything lives under `~/.linuxify/` and `$PREFIX`. *Can I run it over SSH?* Yes, but Termux:Boot must run once locally to set up the storage permission.

### linuxify install

One-line summary: **interactive wrapper around `init` that prompts for distro choice.**

`linuxify install` exists for the first-time human user who opens Termux, types `linuxify`, and wants to be guided. It delegates to the same codepath as `init` but adds an interactive distro picker and a confirmation prompt before touching `~/.bashrc`. For scripts, CI, or AI agents, use `linuxify init --yes` instead — `install` is intentionally chatty and will block on prompts if `--yes` is not given. The most common reason `install` fails where `init` would succeed is a partial Termux setup (missing `proot-distro`); the fix is `pkg install proot-distro` and re-running.

```bash
$ linuxify install
Welcome to Linuxify. Choose a distro:
  > Ubuntu 24.04  (recommended, 320 MB)
    Debian 12     (stable, 280 MB)
    Arch          (rolling, 210 MB)
    Alpine 3.20   (minimal, 45 MB)
Use arrow keys to select, Enter to confirm.
Modify ~/.bashrc to add Linuxify to PATH? [Y/n] y
✔ Installing... (see linuxify init for detail)
```

**Related**: `init`. **FAQ**: *What's the difference between `install` and `init`?* `install` is interactive; `init` is scriptable.

### linuxify use

One-line summary: **switch the active distro for subsequent commands.**

`linuxify use` rewrites the `active_distro` field in `state.json`. The next `add`, `run`, or `shell` will target the chosen distro. Packages installed under one distro are not visible from another — Linuxify maintains separate package lists per distro because each distro has its own rootfs and its own runtime installations. With `--create`, `use` will download and provision a distro that isn't yet on disk; with `--remove`, it deletes one (refusing if packages depend on it, unless `--force` is also given).

The main pitfall is conceptual: users sometimes expect `use` to migrate packages between distros. It does not. If you installed `cline` under `ubuntu` and then `linuxify use debian`, `linuxify list` will show an empty list. To "reinstall everything in the new distro", pipe `linuxify list --distro ubuntu --json` into a small script that calls `linuxify add` for each name.

```bash
$ linuxify use debian
✔ Active distro: debian
Packages installed under ubuntu are still there; switch back with: linuxify use ubuntu
```

```bash
$ linuxify use arch --create
↓ Downloading Arch Linux rootfs (210 MB) [██████░░░░] 52%
✔ Provisioning arch (pacman init, base packages)
✔ Active distro: arch
```

```bash
$ linuxify use alpine
✖ Distro 'alpine' is not installed.
  Fix: linuxify use alpine --create
[exit 2]
```

```bash
$ linuxify use ubuntu --remove
✖ Cannot remove 'ubuntu': 3 packages installed.
  Installed: cline, codex, aider
  Fix: linuxify remove <pkg> for each, or: linuxify use ubuntu --remove --force
[exit 4]
```

```bash
$ linuxify use ubuntu --remove --force
⚠ Removing ubuntu will delete 3 packages and 1.2 GB of rootfs. Continue? [y/N] y
✔ Removed ubuntu
✔ Active distro: debian (auto-selected)
```

**Related**: `init`, `list`. **FAQ**: *Can I have multiple distros installed at once?* Yes — `linuxify list --all-distros` shows them. *Which is smallest?* Alpine (~45 MB rootfs).

---

## Package Management Commands

### linuxify add

One-line summary: **install a CLI tool, patch it for Android, and create a launcher.**

`linuxify add` is the heart of the tool. Given a package name, it resolves the package definition from the local index, ensures the declared runtime is installed in the active distro, runs the install steps (typically `npm install -g`), applies compatibility patches, generates a launcher shim in `$PREFIX/bin/`, and records the install in `state.json`. The whole flow is wrapped in a transaction: if any step fails, the install is rolled back to the previous state and `state.json` is left untouched. This is what makes `add` safe to retry.

The most common pitfall is a package that has been updated upstream and broken a patch. When this happens you get exit code 4 (`PATCH_FAILED`) and a clear message pointing you at `linuxify patch <pkg> --list` to inspect the declared patches and `--no-patch` to install without patching (the tool may then fail to run, but you can inspect its source to write a new patch). The second pitfall is running `add` for a package whose runtime is not yet installed; Linuxify will offer to install the runtime automatically, but if you decline you get exit 3 (`RUNTIME_MISSING`). A third, sneakier pitfall is network flakiness during `npm install -g` — Linuxify retries up to three times with exponential backoff, but a truly dead network gives exit 10.

```bash
$ linuxify add cline
✔ Ensuring runtime node@20 (present)
↓ npm install -g cline@1.2.0  (8.4 MB) [████████████] 100%
✔ Patching node_modules/cline/dist/platform.js
✔ Patching node_modules/cline/dist/arch.js
✔ Creating launcher: /data/data/com.termux/files/usr/bin/cline
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
$ linuxify add goose --version 0.9.2
✔ Installed goose@0.9.2 (node@20, 2 patches)
Run: goose
```

```bash
$ linuxify add aider
✖ Patch failed.
  Reason: Patch 'aider/preload.py' could not find expected string
          `if sys.platform == "linux"` in /opt/aider/preload.py.
          The package may have been updated.
  Fix:   linuxify patch aider --list      # inspect declared patches
         linuxify add aider --no-patch    # install without patching
         linuxify info aider --changelog  # check for patch updates
  Docs:  https://linuxify.dev/docs/errors/PATCH_FAILED
[exit 4]
```

```bash
$ linuxify add cline --dry-run --json
{"schema":"linuxify.v1","command":"add","ok":true,"result":{"plan":[
  "ensure runtime node@20","npm install -g cline@1.2.0",
  "apply 2 patches","create launcher /data/.../bin/cline"
]},"warnings":[],"errors":[]}
```

**Related**: `remove`, `upgrade`, `patch`, `info`. **FAQ**: *Where does the launcher go?* `$PREFIX/bin/<launcher>`, so it's on PATH from Termux. *Can I install a specific git commit?* Not yet — use `--version <tag>`; commit-pinning is on the [v1.1 roadmap](../15-roadmap/release-roadmap.md).

### linuxify remove

One-line summary: **uninstall a package and remove its launcher.**

`linuxify remove` undoes `add`: it removes the launcher, runs the package's declared uninstall steps (typically `npm uninstall -g`), deletes `packages/<name>.json`, and updates `state.json`. With `--purge`, it also deletes cached downloads and patch backups; with `--keep-config`, it leaves user config files (e.g. `~/.config/cline/`) inside the distro untouched, which is the right choice when you are reinstalling and want to keep your settings.

The most common pitfall is removing a package whose launcher was already manually deleted (e.g. by `rm $PREFIX/bin/cline`). Linuxify handles this gracefully — it logs a warning that the launcher was missing and continues with the rest of the uninstall. A subtler pitfall is removing a package that other packages depend on; Linuxify's v1 dependency model is flat (no inter-package deps), so this is not currently enforced, but the `compat` block of each package documents expected companions.

```bash
$ linuxify remove aider
✔ Removing launcher /data/.../bin/aider
✔ pip uninstall -y aider
✔ Cleaning state
aider removed. Cache retained (use --purge to delete).
```

```bash
$ linuxify remove cline --purge
✔ Removing launcher
✔ npm uninstall -g cline
✔ Deleting cache (~/.linuxify/cache/patches/cline/)
cline purged.
```

```bash
$ linuxify remove codex --keep-config
✔ Removed codex (kept ~/.config/codex/)
```

```bash
$ linuxify remove aider
✖ aider is not installed.
  Fix: linuxify list   # see what's installed
[exit 2]
```

**Related**: `add`, `list`. **FAQ**: *Does remove free disk space?* Yes, but run `--purge` to also clear the cache.

### linuxify update

One-line summary: **refresh the local package index and check for available updates.**

`linuxify update` does *not* upgrade anything — it only refreshes the local index mirror of the registry and prints what *could* be upgraded. This split is deliberate: it lets users on metered connections see what's available without committing to downloads, and it lets CI scripts check for drift without changing state. With `--check-only`, even the index refresh is skipped (the local cache is used). With `--self`, only the self-update check runs.

The most common pitfall is conflating `update` with `upgrade` (the Debian-instinct). In Linuxify, `update` is read-only; `upgrade` is the mutating one. A second pitfall is running `update` offline — it will return exit 10 unless `--check-only` is given, in which case it reports based on the last cached index.

```bash
$ linuxify update
✔ Index refreshed (312 packages, 4 contributors)
Updates available:
  cline        1.2.0 → 1.3.1
  codex        0.20.1 → 0.21.0
  linuxify     0.1.0 → 0.2.0
Run: linuxify upgrade --all  |  linuxify self-update
```

```bash
$ linuxify update --check-only
No network. Using cached index (4 hours old).
Updates available:
  cline        1.2.0 → 1.3.1
```

```bash
$ linuxify update --self
Linuxify 0.1.0 → 0.2.0 available. Run: linuxify self-update
```

```bash
$ linuxify update --json
{"schema":"linuxify.v1","command":"update","ok":true,"result":{
  "index":{"packages":312,"contributors":4,"refreshed":"2025-01-14T10:42Z"},
  "updates":[{"package":"cline","from":"1.2.0","to":"1.3.1"},...]
}}
```

**Related**: `upgrade`, `self-update`, `info`. **FAQ**: *How often does the index refresh?* Default cache TTL is 7 days; configure via `cache_ttl_hours`.

### linuxify upgrade

One-line summary: **upgrade one package or all installed packages.**

`linuxify upgrade` applies pending upgrades: it removes the old version and runs the `add` flow for the new one, preserving user config files inside the distro. With `--all`, every installed package is upgraded; without it, a package name is required. A version diff is always printed before applying unless `--yes` is given, which is required for non-interactive use. The `--to <version>` flag pins the target, supporting both upgrades and downgrades.

The main pitfall is an upgrade that breaks patches — the same `PATCH_FAILED` path as `add`, but more surprising because the user expected a smooth upgrade. The remediation is identical: inspect patches, install `--no-patch`, or wait for a package-definition update. A second pitfall is upgrading everything on a metered connection; `linuxify update --check-only` first to see total download size.

```bash
$ linuxify upgrade cline
cline 1.2.0 → 1.3.1
Proceed? [Y/n] y
✔ Downloading cline@1.3.1
✔ Patching (2 patches applied)
✔ Launcher updated
```

```bash
$ linuxify upgrade --all --yes
✔ Upgrading cline 1.2.0 → 1.3.1
✔ Upgrading codex 0.20.1 → 0.21.0
✔ aider: already latest (0.14.0)
2 packages upgraded, 1 already latest.
```

```bash
$ linuxify upgrade cline --to 1.0.0
⚠ Downgrade: cline 1.2.0 → 1.0.0
Proceed? [y/N] y
✔ Installed cline@1.0.0
```

```bash
$ linuxify upgrade cline
✔ cline is already at latest (1.2.0)
[exit 5]
```

```bash
$ linuxify upgrade --all --dry-run
Plan:
  cline   1.2.0 → 1.3.1   (download 8.4 MB)
  codex   0.20.1 → 0.21.0 (download 6.1 MB)
Total download: 14.5 MB. Disk required: 28 MB. OK.
[exit 0, no changes]
```

**Related**: `add`, `update`. **FAQ**: *Are upgrades atomic?* Yes — a failed upgrade rolls back to the previous installed version.

### linuxify list

One-line summary: **list installed packages.**

`linuxify list` prints a table of installed packages for the active distro. With `--all-distros`, it groups by distro. With `--verbose`, it adds install date, patch status, and last-run timestamp (tracked when a launcher fires). With `--json`, it emits the full `packages/<name>.json` documents — useful for inventory scripts and for AI agents that need to know what's available without parsing tables.

The most common pitfall is running `list` immediately after `linuxify use <other-distro>` and being surprised that the list is empty — this is by design; packages are per-distro.

```bash
$ linuxify list
NAME       VERSION   RUNTIME   PATCHED   DISTRO
cline      1.2.0     node@20   yes       ubuntu
codex      0.20.1    node@20   yes       ubuntu
aider      0.14.0    python@3  yes       ubuntu
```

```bash
$ linuxify list --verbose
NAME     VERSION  RUNTIME   PATCHED  INSTALLED        LAST RUN         DISTRO
cline    1.2.0    node@20   yes      2025-01-10 14:02 2025-01-14 09:30 ubuntu
codex    0.20.1   node@20   yes      2025-01-11 08:15 2025-01-13 18:42 ubuntu
aider    0.14.0   python@3  yes      2025-01-12 20:11 never            ubuntu
```

```bash
$ linuxify list --all-distros
== ubuntu ==
cline, codex, aider
== alpine ==
goose
```

```bash
$ linuxify list --json | head -20
{"schema":"linuxify.v1","command":"list","ok":true,"result":{"distro":"ubuntu",
 "packages":[{"name":"cline","version":"1.2.0","runtime":"node@20",
 "patched":true,"installed":"2025-01-10T14:02Z"},...]}}
```

**Related**: `info`, `search`. **FAQ**: *How do I see packages from all distros at once?* `--all-distros`.

### linuxify search

One-line summary: **search the package index by name or description.**

`linuxify search` does fuzzy matching on package name and description. By default it consults both the local index and (when online) the remote registry; `--offline` restricts to local. Tags (`--tag ai`, `--tag editor`) narrow the result set, and `--runtime` filters to packages that work with a given runtime. Output is a table by default and JSON with `--json`.

```bash
$ linuxify search "ai agent"
NAME        DESCRIPTION                                  RUNTIME
cline       AI coding agent that runs in your terminal   node
codex       OpenAI's terminal coding agent               node
goose       Local AI agent from Block                    node
aider       AI pair programming in the terminal          python
```

```bash
$ linuxify search --tag editor
NAME        DESCRIPTION                       RUNTIME
helix       Modal text editor                 rust
micro       Modern terminal-based text editor go
```

```bash
$ linuxify search codex --offline
NAME    DESCRIPTION                       RUNTIME
codex   OpenAI's terminal coding agent    node
```

```bash
$ linuxify search "nonexistent"
No packages matched 'nonexistent'.
Browse all: linuxify search "" --limit 312
```

```bash
$ linuxify search python --runtime python --json
{"schema":"linuxify.v1","command":"search","ok":true,"result":{"matches":[
  {"name":"aider","description":"AI pair programming","runtime":"python"},
  {"name":"httpie","description":"User-friendly HTTP client","runtime":"python"}
]}}
```

**Related**: `info`, `add`. **FAQ**: *Can I contribute a new package?* Yes — see [Contribution Guidelines](../16-community/contribution-guidelines.md).

### linuxify info

One-line summary: **show everything Linuxify knows about a package.**

`linuxify info` is the canonical "explain this package" command. It prints the resolved YAML, install status, available versions, declared patches, and compat notes. Heavily used by AI coding agents that need to decide whether a tool can be installed on the current device.

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

```bash
$ linuxify info cline --versions
1.0.0   2024-08-12
1.1.0   2024-10-04
1.2.0   2024-12-01  (installed)
1.3.1   2025-01-10  (latest)
```

```bash
$ linuxify info cline --changelog
## 1.3.1 (2025-01-10)
- Fix: crash on Android arm64 (upstream)
- Feat: streaming diffs

## 1.2.0 (2024-12-01)
- ...
```

```bash
$ linuxify info goose
name:         goose
version:      0.9.2
runtime:      node >=18
installed:    no
```

```bash
$ linuxify info notarealpkg
✖ Package 'notarealpkg' not found.
  Fix: linuxify search notarealpkg
[exit 2]
```

**Related**: `add`, `search`. **FAQ**: *How is `info` different from `search`?* `info` needs an exact name and is detailed; `search` is fuzzy and broad.

---

## Execution Commands

### linuxify run

One-line summary: **enter proot and run an installed tool.**

`linuxify run <package>` is the bridge between the Termux shell and the Linux world. It enters the active distro's proot, sets up the environment declared in the package YAML, and execs the launcher with any arguments you pass. The wrapped tool's exit code is propagated verbatim (unless Linuxify itself fails to enter proot, in which case you get 7). Use `--` to separate Linuxify flags from tool flags when they would otherwise collide.

```bash
$ linuxify run cline --version
cline/1.2.0 linux-arm64 node-v20.10.0
```

```bash
$ linuxify run cline
(Interactive cline session begins here...)
```

```bash
$ linuxify run goose -- --help
Usage: goose [options] <command>
...
```

```bash
$ linuxify run aider -- --model gpt-4o
Aider v0.14.0
Model: gpt-4o
>
```

```bash
$ linuxify run notinstalled
✖ 'notinstalled' is not installed.
  Fix: linuxify add notinstalled
[exit 2]
```

**Related**: `shell`, `add`. **FAQ**: *Why use `run` instead of the launcher directly?* `run` ensures the proot env is set up correctly; the launcher also does this, so once installed you can usually call `cline` directly. Use `run` when debugging launcher issues.

### linuxify shell

One-line summary: **open an interactive shell inside the active distro.**

`linuxify shell` drops you into a root shell inside the proot. Useful for poking at the distro directly, running tools that aren't packaged, and debugging. The host working directory is bind-mounted in by default; the home directory is shared with Termux unless `--no-bind-home` is given.

```bash
$ linuxify shell
[root@ubuntu ~]# apt list --installed | wc -l
412
[root@ubuntu ~]# which node
/usr/bin/node
[root@ubuntu ~]# exit
$
```

```bash
$ linuxify shell --distro alpine
[/alpine ~]# apk list --installed | wc -l
89
[/alpine ~]# exit
```

```bash
$ linuxify shell --as ubuntu --workdir /tmp
[ubuntu@ubuntu /tmp]$ id
uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)
```

```bash
$ linuxify shell --no-bind-home
[root@ubuntu ~]# ls ~
(rootfs default home, not your Termux home)
```

**Related**: `run`, `use`. **FAQ**: *Is the shell root?* Yes by default (proot convention); use `--as` to drop privileges.

---

## Diagnostics Commands

### linuxify doctor

One-line summary: **diagnose the Linuxify environment.**

`linuxify doctor` is the command you run when something feels wrong, or before filing a bug report. It runs a battery of declarative checks — Termux present, proot present, distro rootfs intact, PATH configured, each runtime at the right version, each installed package's launcher present and executable, each applied patch still in place — and prints a report. Each check returns `ok | warn | fail | missing` with a remediation hint. With `--fix`, it attempts safe auto-repairs (recreate missing launchers, fix PATH); with `--check <name>`, it runs only one check.

```bash
$ linuxify doctor

Linuxify v0.1.0
────────────────────────────────────────
Operating System   Ubuntu 24.04 (proot)
Architecture       aarch64
Kernel             Linux 6.x (Android)
Linuxify           0.1.0
────────────────────────────────────────
✔  Storage         12.4 GB free
✔  Termux          OK
✔  proot           OK
✔  Ubuntu          Installed
✔  PATH            Configured
✔  Node.js         v24.18.0
✔  npm             v11.2.0
✔  Python          v3.12.3
✔  Git             v2.49.0
✔  process.platform linux (patched)
✔  Cline           v1.2.0
✔  Codex           v0.20.1
✖  Redis           Missing (optional, used by: aider-memory)
────────────────────────────────────────
1 issue found. Run: linuxify repair
```

```bash
$ linuxify doctor --json
{"schema":"linuxify.v1","command":"doctor","ok":false,"result":{
  "version":"0.1.0","distro":"ubuntu","checks":[
    {"name":"storage","status":"ok","detail":"12.4 GB free"},
    {"name":"proot","status":"ok"},
    {"name":"redis","status":"missing","remediation":"apt install redis-server",
     "severity":"warn","used_by":["aider-memory"]}
  ]}}
```

```bash
$ linuxify doctor --fix
✔ Recreated launcher for cline (was missing)
✔ Re-applied 2 patches for codex (checksum mismatch)
1 remaining issue (Redis optional). Run: linuxify doctor
```

```bash
$ linuxify doctor --check node_version
✔ Node.js v20.10.0 (>=20 ✓)
```

```bash
$ linuxify doctor
✖ Environment not initialized.
  Reason: ~/.linuxify/state.json not found.
  Fix:   linuxify init
[exit 3]
```

**Related**: `repair`, `env`. **FAQ**: *Should I run doctor before every bug report?* Yes — please attach `doctor --json` output.

### linuxify repair

One-line summary: **auto-repair issues found by `doctor`, including destructive ones.**

`linuxify repair` applies all repairs `doctor` suggested, including potentially destructive ones that `doctor --fix` refuses: reinstalling a corrupt rootfs, resetting `state.json` from filesystem reality, restoring from a backup. Always prompts before destructive actions unless `--yes`. Use `--dry-run` to preview the repair plan.

```bash
$ linuxify repair
Doctor reported 3 issues. Repair plan:
  1. Recreate launcher for cline (missing)
  2. Re-patch codex (patch checksum mismatch)
  3. Reinstall Python 3.12 (broken symlinks)
Proceed? [Y/n] y
✔ 3/3 repairs applied. Run: linuxify doctor
```

```bash
$ linuxify repair --reset
⚠ Reset will:
  - Rebuild ~/.linuxify/state.json from filesystem scan
  - Mark any orphan files for review
  - NOT touch installed packages or user config
Proceed? [y/N] y
✔ State rebuilt: 3 packages discovered, 0 orphans
```

```bash
$ linuxify repair --from-backup ~/.linuxify/backup/state-20250110.json
✔ Restored state from backup (3 packages)
```

```bash
$ linuxify repair --dry-run
Plan:
  1. Recreate launcher for cline
  2. Re-patch codex
  3. Reinstall Python 3.12
No destructive actions. Safe to proceed.
```

**Related**: `doctor`, `patch`. **FAQ**: *What if repair makes things worse?* Use `--from-backup` to restore the previous state; backups live in `~/.linuxify/backups/`.

### linuxify patch

One-line summary: **re-apply (or revert) compatibility patches for a package.**

`linuxify patch <package>` re-applies the patches declared in the package YAML. Useful after a manual `npm update` inside the distro that overwrote patched files. Patches are idempotent (a checksum is stored, so re-patching an already-patched file is a no-op). With `--revert`, restores the original files from backup. With `--list`, prints the declared patches without applying them.

```bash
$ linuxify patch cline
✔ 2 patches applied (platform.js, arch.js)
✔ Backups written to ~/.linuxify/cache/patches/cline/1.2.0/
```

```bash
$ linuxify patch cline --list
1. node_modules/cline/dist/platform.js
   find:    process.platform === 'linux'
   replace: ['linux','android'].includes(process.platform)
2. node_modules/cline/dist/arch.js
   find:    process.arch === 'x64'
   replace: ['x64','arm64'].includes(process.arch)
```

```bash
$ linuxify patch cline --revert
✔ Reverted 2 patches (originals restored from backup)
```

```bash
$ linuxify patch cline --dry-run
Would apply 2 patches. No changes made.
```

```bash
$ linuxify patch cline
✔ All patches already applied (checksums match). Nothing to do.
[exit 23]
```

**Related**: `add`, `repair`. **FAQ**: *When should I patch manually?* After `apt upgrade` or `npm update` inside the distro that may have overwritten patched files.

### linuxify env

One-line summary: **print the resolved environment Linuxify would set.**

`linuxify env` shows PATH, runtime versions, distro, and any package-declared env vars that Linuxify would inject. With `--for-run <package>`, it simulates the env that `linuxify run <package>` would produce. Designed for debugging "why does my tool see `process.platform === android`?".

```bash
$ linuxify env
LINUXIFY_DISTRO=ubuntu
LINUXIFY_RUNTIME_NODE=/usr/bin/node
LINUXIFY_RUNTIME_PYTHON=/usr/bin/python3
PATH=/data/data/com.termux/files/usr/bin:...
```

```bash
$ linuxify env --for-run cline
LINUXIFY_DISTRO=ubuntu
LINUXIFY_RUNTIME_NODE=/usr/bin/node
PATH=...
CLINE_PLATFORM=linux
FORCE_COLOR=1
```

```bash
$ linuxify env --diff
+ CLINE_PLATFORM=linux        (set by package 'cline')
+ FORCE_COLOR=1               (set by package 'cline')
~ PATH=...                    (Linuxify prepended)
```

```bash
$ linuxify env --json
{"schema":"linuxify.v1","command":"env","ok":true,"result":{
  "distro":"ubuntu","runtimes":{"node":"20.10.0","python":"3.12.3"},
  "path":"...","package_env":{}}}
```

**Related**: `doctor`, `run`. **FAQ**: *Why is `process.platform` still `android` in plain `env`?* The patch makes the *tool* accept android as if it were linux; the actual `process.platform` value isn't changed.

---

## Config Commands

### linuxify config

One-line summary: **read or write keys in `config.toml`.**

`linuxify config <key>` prints the current value; `config <key> <value>` sets it; `--unset` deletes; `--show` prints the whole file; `--show --effective` includes merged env vars, profiles, and defaults. Keys use dotted notation (`profile.work.distro`).

```bash
$ linuxify config default.distro
ubuntu
$ linuxify config default.distro debian
✔ Set default.distro = debian
$ linuxify config --show
[default]
distro = "debian"
telemetry = true
...
$ linuxify config --show --effective
[default]
distro = "debian"           # source: ~/.linuxify/config.toml
telemetry = false           # source: env LINUXIFY_TELEMETRY=0
$ linuxify config --unset default.distro
✔ Unset default.distro (now resolves to 'ubuntu')
```

```bash
$ linuxify config profile.work.distro arch
✔ Set profile.work.distro = arch
```

```bash
$ linuxify config no.such.key
✖ Key 'no.such.key' not found.
  Fix: linuxify config --show   # list all keys
[exit 2]
```

**Related**: §7 of [CLI Specification](cli-specification.md#7-configuration-files), `env`. **FAQ**: *Where is the config file?* `~/.linuxify/config.toml` for user; `.linuxify.toml` in cwd for project-local.

### linuxify self-update

One-line summary: **update the Linuxify CLI itself.**

`linuxify self-update` downloads a new release, verifies its checksum and ed25519 signature, runs any bundled migration script, and atomically swaps the binary. The old binary is preserved at `~/.linuxify/cache/linuxify-<old-version>` for one-click rollback. With `--check`, only reports availability.

```bash
$ linuxify self-update
Current: 0.1.0  Target: 0.2.0
✔ Downloading linuxify-0.2.0-linux-arm64.tar.gz
✔ Signature verified (ed25519:9f3a...)
✔ Running migration 0.1.0 → 0.2.0
✔ Swapping binary (backup at ~/.linuxify/cache/linuxify-0.1.0)
Linuxify 0.2.0 installed. Restart your shell.
```

```bash
$ linuxify self-update --check
Linuxify 0.1.0 → 0.2.0 available. Run: linuxify self-update
```

```bash
$ linuxify self-update --to 0.1.0
⚠ Downgrade: 0.2.0 → 0.1.0
Proceed? [y/N] y
✔ Installed 0.1.0 (backup at ~/.linuxify/cache/linuxify-0.2.0)
```

```bash
$ linuxify self-update
✖ Signature verification failed.
  Reason: ed25519 signature on linuxify-0.2.0-linux-arm64.tar.gz does not match
          the published key (expected 9f3a..., got 1c2b...).
  Fix:   Do not proceed. Report at https://github.com/linuxify/linuxify/security
  Docs:  https://linuxify.dev/docs/errors/SIGNATURE_FAILED
[exit 26]
```

```bash
$ linuxify self-update --check --json
{"schema":"linuxify.v1","command":"self-update","ok":true,"result":{
  "current":"0.1.0","latest":"0.2.0","channel":"stable",
  "release_notes":"https://github.com/linuxify/linuxify/releases/tag/v0.2.0"}}
```

**Related**: `update`. **FAQ**: *How do I roll back?* `linuxify self-update --to <old-version>`, or symlink `$PREFIX/bin/linuxify` to the backup binary manually.

---

## Cross-Command Patterns

A few patterns recur across commands and are worth internalizing. First, **every mutating command supports `--dry-run`**: use it liberally when scripting or when unsure. Second, **every command supports `--json`**: when integrating with CI or another tool, parse JSON rather than scraping tables. Third, **`--yes` is required for non-interactive use**: Linuxify will time out and exit non-zero rather than hang on a prompt, which is intentional for CI safety. Fourth, **`doctor` is your friend**: run it before filing bug reports, after Android system updates, and after `self-update`. Fifth, **the log file at `~/.linuxify/logs/linuxify-YYYYMMDD.log` is authoritative**: if a command misbehaved and you want to know what it actually did, read the log — it records every external command run, every patch applied, every state mutation.
