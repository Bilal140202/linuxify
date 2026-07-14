# Linuxify — Product Requirements Document

> **Document status**: v1.0 draft · **Owner**: Linuxify core team · **Last updated**: 2025
> Related: [Vision](../00-executive/vision.md) · [System Architecture](../02-architecture/system-architecture.md) · [CLI Specification](../03-cli/cli-specification.md) · [Glossary](../21-reference/glossary.md)

This PRD defines what Linuxify *is*, who it is *for*, and what it must *do* for its first stable release (`v1.0`). It is written for two audiences: human contributors who need a shared contract for scope, and AI coding agents (Cline, Codex, Claude Code, Aider) who will use this document as the ground truth when implementing features. Every requirement is concrete, testable, and traceable. If a section feels vague, treat that as a defect and file an issue against this document.

---

## 1. Overview

### 1.1 What is Linuxify?

**Linuxify** is an open-source developer toolkit that brings modern, Linux-oriented developer CLIs — `cline`, `codex`, `aider`, `goose`, `gemini-cli`, `openhands`, `freebuff`, and the long tail of npm/pip/cargo-installable tools — to Android phones and tablets, with a single command. It does so by transparently managing a Ubuntu (or other distro) `proot` container inside [Termux](https://termux.dev), installing the requested tool, applying any necessary compatibility patches for the Android/proot/aarch64 environment, and generating a native Termux launcher so the tool can be invoked as if it were any other shell command.

The brand "Linuxify" is intentionally verb-like (`linuxify install`, `linuxify add cline`, `linuxify doctor`) in the spirit of `git`, `npm`, and `cargo`. It is a first-class developer tool, not a wrapper script, not a "Termux helper," and not a one-off installer. The contract with the user is: *if a CLI runs on a normal Linux laptop, it should run on Android with `linuxify add <name>`.*

### 1.2 Who is it for?

Linuxify is for developers who, for reasons of cost, mobility, curiosity, or necessity, want to do real software work on Android hardware. That includes road-warrior engineers who travel light, students whose phone is their primary computer, contributors to the open-source AI tooling ecosystem who need to test their tools on ARM, and hobbyists building home-lab-style setups on retired phones. It is *not* for end-users who want a "Linux on Android app" with a GUI — see [§11 Out of Scope](#11-out-of-scope-v1).

### 1.3 Why now?

Three trends make this the right moment. **First**, modern Android phones are powerful: a 2024 mid-range device has 8–12 GB of RAM, an 8-core aarch64 CPU, and UFS storage faster than many laptops had a decade ago. **Second**, the AI developer-tooling explosion (`cline`, `codex`, `aider`, etc.) has produced a generation of CLIs that are Linux-native by default but assume glibc and `process.platform === "linux"` — assumptions that break on Termux's bionic libc and `process.platform === "android"`. **Third**, Termux and `proot-distro` have matured to the point where a Ubuntu 24.04 userland runs reliably inside proot, but the *glue* — picking the right distro, installing runtimes, patching tool source, generating launchers, diagnosing failures — is still manual and painful. Linuxify is that glue.

---

## 2. Goals & Non-Goals

### 2.1 v1 Goals

1. **Single-command bootstrap.** A user with Termux installed can run `linuxify init` and, in under five minutes on a mid-range phone, end up with a working Ubuntu proot, Node.js LTS, Python 3.12, git, and a configured PATH — no manual `proot-distro install` or `apt` rituals.
2. **Single-command tool install.** `linuxify add <pkg>` installs, patches, and launches a Linux developer CLI. The tool must be invokable by name from the Termux shell immediately afterward.
3. **First-class diagnostics.** `linuxify doctor` detects every common failure mode (missing proot, broken PATH, wrong Node version, unpatched `process.platform`, missing optional deps) and emits a remediation hint. `linuxify repair` applies safe auto-fixes; unsafe fixes require `--yes`.
4. **Deterministic, reproducible state.** All Linuxify state lives under `~/.linuxify/` in versioned TOML/JSON files. Deleting that directory and re-running `linuxify init` produces an equivalent environment.
5. **Offline-first after bootstrap.** Once the initial distro image and runtime tarballs are downloaded, all subsequent `add`, `run`, `doctor`, and `repair` operations work with no network.
6. **Pluggable backends.** Distro, runtime, patcher, and doctor are pluggable interfaces. Ubuntu is the default; Debian, Arch, Alpine are community-supported via the same plugin contract.
7. **Contributor-friendly package format.** Adding a new tool is a single YAML file in `packages/<name>.yml`. No TypeScript required to add support for a new CLI.

### 2.2 v1.1+ Goals (explicitly deferred)

- Central package registry with signed packages and version pinning.
- Cloud sync of installed packages and config across devices.
- GUI companion app (TUI is in scope for v1; full GUI is not).
- iOS, ChromeOS, and non-Android hosts.
- Multi-distro simultaneous installs (one active distro at a time in v1).

### 2.3 Non-Goals (explicitly never)

- Linuxify will not require root. Ever.
- Linuxify will not be a general-purpose Linux distribution. It is a *tool delivery vehicle*, not a daily-driver OS.
- Linuxify will not replace Termux; it sits on top of Termux and respects Termux conventions (`$PREFIX`, `pkg`, etc.).
- Linuxify will not ship a paid tier in any release covered by this PRD.

---

## 3. Target Users & Personas

We define three primary personas. Every functional requirement in [§5](#5-functional-requirements) must trace back to at least one persona's goal.

### 3.1 Persona: Road-Warrior Engineer Ravi

**Ravi** is a 34-year-old senior backend engineer at a Series-B fintech. He travels internationally 40% of the time and frequently works from airports, trains, and hotel lobbies where his 13" laptop is impractical but his Samsung Galaxy S24 Ultra is always with him. He has 12 GB of RAM, 512 GB of storage, and an unlimited data plan. He uses Termux daily for SSH, git, and quick scripts; he already has a patched-together Ubuntu proot setup that he re-installs every time he flashes a new ROM.

**Goals.** Ravi wants to run `cline` and `aider` against his company's repos during flights, review PRs with `gh`, and pair-program with `codex` from his phone screen and a foldable Bluetooth keyboard. He wants the install to be reproducible so he can stop maintaining his own scripts.

**Frustrations.** Every CLI update breaks his hand-patched `platform.js` files. He is tired of explaining to junior engineers how to set up their phones. He lost two hours at 30,000 feet last month because `aider` started requiring Node 20 and his proot had Node 18.

**Success criteria.** Ravi will adopt Linuxify permanently if (a) `linuxify init` takes under 5 minutes, (b) `linuxify doctor` correctly identifies his breakage before he does, and (c) `linuxify upgrade aider` works offline.

### 3.2 Persona: Student Ana

**Ana** is a 19-year-old second-year CS undergraduate in São Paulo. Her only computing device is a Motorola Moto G84 (8 GB RAM, 256 GB storage, aarch64). She has a 4 GB/month data plan and unreliable Wi-Fi on campus. She learned Linux on the university lab machines and is comfortable on the command line, but she has never heard of proot and finds Termux intimidating.

**Goals.** Ana wants to complete her data-structures assignments in Python, run `aider` to help her debug, and contribute to an open-source project (she picked a small Django REST framework package) using `git` and `gh`. She needs all of this to fit in her storage budget and to work on the bus ride home.

**Frustrations.** The Play Store version of Termux is broken (she doesn't know this); she installed it and nothing works. The first time she ran `apt install python` inside Termux proper, it failed because Termux is not Debian. She does not have the data budget to redownload a 1 GB Ubuntu image every week.

**Success criteria.** Ana will succeed if (a) the docs tell her clearly to install Termux from F-Droid, (b) `linuxify init` works in under 5 GB of downloads and 2 GB of installed size, and (c) she can run `linuxify add aider` and `aider` starts up without error.

### 3.3 Persona: OSS Contributor Mira

**Mira** is a 28-year-old maintainer of `gemini-cli`, an open-source AI coding agent with 18k GitHub stars. She develops on a Mac but she has watched her Android issue tracker fill up with "doesn't work on Termux" reports — 47 of them in the last quarter. She has an old Pixel 7 she uses for testing. She does not want to maintain Android-specific code in her main repo, but she is happy to ship a `linuxify.yml` package definition and a patch file.

**Goals.** Mira wants a single, well-documented way to declare "this CLI runs on Android via Linuxify, here are the patches" so her Termux-using users stop filing duplicate bugs. She wants CI to verify that her package definition still works after every release. She wants `linuxify doctor` to tell her users what to upgrade rather than Mira having to debug each user's setup.

**Frustrations.** Right now she answers "edit `node_modules/.../platform.js`" 20 times a week. She has no way to programmatically express "this patch is needed for Node 20+ on aarch64."

**Success criteria.** Mira will adopt Linuxify if she can author a `packages/gemini-cli.yml` in 30 minutes, run `linuxify add gemini-cli` on her Pixel, see it work, and link to a Linuxify package page from her README so her users have a one-command install path.

---

## 4. User Stories

User stories follow the canonical `As a <user>, I want <action>, so that <outcome>` form. They are grouped by theme and numbered `US-<theme>-<n>` for traceability into functional requirements.

### 4.1 Installation & Bootstrap

- **US-INST-01** — As Ravi, I want to install Linuxify with a single `pkg install linuxify` (or a `curl|sh` fallback), so that I do not need to clone a repo and compile anything.
- **US-INST-02** — As Ana, I want `linuxify init` to detect that I'm on the Play Store version of Termux and tell me to switch to F-Droid, so that I don't waste hours debugging an unsupported build.
- **US-INST-03** — As Ravi, I want `linuxify init` to be idempotent, so that running it twice does not corrupt my existing install.
- **US-INST-04** — As Ana, I want `linuxify init` to download the smallest viable Ubuntu rootfs for aarch64, so that I stay under my data budget.

### 4.2 Daily Use

- **US-DAILY-01** — As Ravi, I want to type `cline` in my Termux shell and have it run, so that using Linuxify-installed tools feels no different from using `git` or `vim`.
- **US-DAILY-02** — As Ana, I want `linuxify run <pkg>` to work even when no launcher is on PATH, so that I can recover from a broken shell config.
- **US-DAILY-03** — As Ravi, I want `linuxify shell` to drop me into the proot Ubuntu environment, so that I can `apt install` arbitrary dev tools when I need to.
- **US-DAILY-04** — As Mira, I want `linuxify env` to print every environment variable Linuxify sets, so that I can reproduce a bug report locally.
- **US-DAILY-05** — As Ana, I want `linuxify list` to show what I have installed and how much disk each package uses, so that I can manage my 256 GB budget.

### 4.3 Troubleshooting

- **US-TROUBLE-01** — As Ravi, I want `linuxify doctor` to detect that my Node is too old, so that I can fix it before `aider` crashes mid-session.
- **US-TROUBLE-02** — As Ana, I want `linuxify doctor` to flag missing storage and refuse to install new packages, so that I never silently run out of disk.
- **US-TROUBLE-03** — As Ravi, I want `linuxify repair` to re-apply patches after I run `npm update -g`, so that an upstream Node module bump does not break my CLIs.
- **US-TROUBLE-04** — As Mira, I want `linuxify doctor` to emit machine-readable JSON (`--json`), so that I can include doctor output in a bug-report template.

### 4.4 Contribution & Customization

- **US-CONTRIB-01** — As Mira, I want to author a `packages/<name>.yml` file with no TypeScript knowledge, so that adding a new CLI to Linuxify is approachable for any open-source maintainer.
- **US-CONTRIB-02** — As Ravi, I want `linuxify add ./my-local-package.yml` to install a package from a local file, so that I can test package definitions before publishing.
- **US-CONTRIB-03** — As Mira, I want to write a custom doctor check in a `.ts` plugin and have `linuxify doctor` pick it up, so that I can encode project-specific health rules.
- **US-CONTRIB-04** — As Ravi, I want `linuxify config telemetry.enabled false` to persist, so that I can opt out of telemetry permanently.

### 4.5 Advanced

- **US-ADV-01** — As Ravi, I want `linuxify use debian` to swap my active distro without losing my home directory, so that I can test packages on multiple distros.
- **US-ADV-02** — As Mira, I want `linuxify patch <pkg> --dry-run` to show what would change without applying, so that I can review patches in CI.
- **US-ADV-03** — As Ravi, I want `linuxify self-update` to atomically swap the Linuxify binary, so that a failed update never leaves me with a broken CLI.
- **US-ADV-04** — As Ana, I want `linuxify remove <pkg>` to also remove the launcher and undo PATH changes, so that uninstall is clean.

---

## 5. Functional Requirements

Each requirement has an ID, title, description, priority (`P0` = must-have for v1, `P1` = should-have for v1, `P2` = nice-to-have for v1), and acceptance criteria. IDs are stable; once assigned they do not change.

### Bootstrap & Init

- **FR-001 · Bootstrap Termux detection** — `linuxify init` must detect whether the host Termux is the F-Droid build, Play Store build, or a fork, and refuse to proceed on the Play Store build with an actionable message. **Priority**: P0. **Acceptance**: Running `linuxify init` on the Play Store Termux exits with code 3 and prints a F-Droid install URL.
- **FR-002 · Architecture detection** — `linuxify init` must detect `aarch64`, `armv7l`, and `x86_64` hosts and select the matching rootfs tarball. **Priority**: P0. **Acceptance**: On aarch64 devices, the aarch64 Ubuntu rootfs is downloaded.
- **FR-003 · Distro image download** — Linuxify must download and cache the Ubuntu 24.04 aarch64 rootfs (≤800 MB compressed) on first init. **Priority**: P0. **Acceptance**: After init, `~/.linuxify/distros/ubuntu/rootfs.tar.gz` exists and `~/.linuxify/distros/ubuntu/installed` is non-empty.
- **FR-004 · proot-distro integration** — Linuxify must use `proot-distro` as the default distro backend and expose a pluggable interface. **Priority**: P0. **Acceptance**: A custom backend implementing `DistroBackend` is registered via `~/.linuxify/config.toml` and `linuxify use` works against it.
- **FR-005 · Idempotent init** — Running `linuxify init` twice in a row must succeed both times and produce no diff in `~/.linuxify/state.json` other than `last_init` timestamp. **Priority**: P0. **Acceptance**: `diff` of state before and after second init shows only the timestamp field changed.
- **FR-006 · Runtime installation** — Linuxify must install Node.js LTS, Python 3.12, and git into the proot Ubuntu environment during init. **Priority**: P0. **Acceptance**: `linuxify run -- node --version` returns ≥ v20, `python3 --version` returns ≥ 3.12, `git --version` returns ≥ 2.40.
- **FR-007 · PATH configuration** — Linuxify must append a managed block to `~/.bashrc` (and `~/.zshrc` if present) that adds `~/.linuxify/bin` to PATH. The block must be re-entrant (idempotent). **Priority**: P0. **Acceptance**: After init, `which cline` (post-install) resolves to `~/.linuxify/bin/cline`; second init does not duplicate the block.
- **FR-008 · Bootstrap time budget** — `linuxify init` on a mid-range aarch64 device with 50 Mbps Wi-Fi must complete in under 5 minutes. **Priority**: P0. **Acceptance**: 95th-percentile init time ≤ 300s in CI matrix on Snapdragon 7-class hardware.
- **FR-009 · Bootstrap resume** — If init is interrupted (network drop, SIGINT), re-running `linuxify init` resumes from the last successful step. **Priority**: P1. **Acceptance**: Killing init mid-rootfs-download and re-running does not re-download completed chunks.

### Package Management

- **FR-010 · Add package** — `linuxify add <name>` resolves `<name>` to a YAML definition (local or registry), installs the package per its `install:` steps, applies patches, generates a launcher, and updates the manifest. **Priority**: P0. **Acceptance**: `linuxify add cline && cline --version` prints a version string.
- **FR-011 · Remove package** — `linuxify remove <name>` uninstalls the package, deletes its launcher, and removes the manifest entry. **Priority**: P0. **Acceptance**: `linuxify remove cline && which cline` returns non-zero exit.
- **FR-012 · List packages** — `linuxify list` prints installed packages with version, size, and last-updated timestamp. **Priority**: P0. **Acceptance**: Output is a stable, parseable table.
- **FR-013 · Search packages** — `linuxify search <query>` searches the local package catalog and (if online) the remote registry. **Priority**: P1. **Acceptance**: `linuxify search ai` returns at least `cline`, `aider`, `codex`, `gemini-cli`.
- **FR-014 · Package info** — `linuxify info <name>` shows metadata, dependencies, known issues, and compatibility. **Priority**: P1. **Acceptance**: Output includes name, version, runtime, tested distros, license, homepage.
- **FR-015 · Local package install** — `linuxify add ./path/to/pkg.yml` installs from a local file. **Priority**: P1. **Acceptance**: A local YAML passes the same validation as a registry YAML.
- **FR-016 · Package manifest** — Linuxify maintains `~/.linuxify/manifest.json` recording every installed package, its source URL, version, install time, and patch fingerprint. **Priority**: P0. **Acceptance**: `manifest.json` round-trips through `add`/`remove`/`upgrade`.
- **FR-017 · Upgrade single package** — `linuxify upgrade <name>` upgrades one package to the latest compatible version. **Priority**: P1. **Acceptance**: `linuxify upgrade cline` updates `cline` and re-applies patches.
- **FR-018 · Upgrade all** — `linuxify upgrade` upgrades every installed package. **Priority**: P1. **Acceptance**: Output lists per-package result; one failure does not abort others.
- **FR-019 · Dry-run mode** — `--dry-run` flag on `add`/`remove`/`upgrade`/`patch` prints planned actions without executing. **Priority**: P1. **Acceptance**: No filesystem mutations occur with `--dry-run`.
- **FR-020 · Force reinstall** — `--force` flag on `add` reinstalls even if version matches manifest. **Priority**: P2. **Acceptance**: `linuxify add cline --force` re-runs install + patch.

### Patcher

- **FR-021 · Regex patch** — Patches with `find`/`replace` strings are applied via regex. **Priority**: P0. **Acceptance**: A patch with literal `process.platform === 'linux'` find replaces the matched text in the target file.
- **FR-022 · AST patch (JS/TS)** — For JavaScript and TypeScript files, patches may use an AST-aware matcher (`kind: ast`) that survives whitespace changes. **Priority**: P1. **Acceptance**: A patch targeting a `BinaryExpression` matches after reformatting.
- **FR-023 · Patch rollback** — Each applied patch is recorded with a reverse patch; `linuxify patch --rollback <pkg>` undoes patches in reverse order. **Priority**: P1. **Acceptance**: After rollback, `diff` against pre-patch files is empty.
- **FR-024 · Patch dry-run** — `linuxify patch <pkg> --dry-run` shows diffs without applying. **Priority**: P1. **Acceptance**: No file mutations.
- **FR-025 · Patch idempotence** — Re-applying the same patch set is a no-op. **Priority**: P0. **Acceptance**: Two consecutive `linuxify patch cline` calls produce identical file state.
- **FR-026 · Patch verification** — After applying, the patcher verifies the `find` pattern no longer matches. **Priority**: P0. **Acceptance**: If a patch's `find` still matches after `replace`, the patch is marked failed.

### Doctor

- **FR-027 · Doctor checks** — `linuxify doctor` runs the built-in check set: storage, termux, proot, distro, PATH, node, npm, python, git, platform-patched, each installed package. **Priority**: P0. **Acceptance**: Default output matches the format in [§7 of the project context](../../.agent-context.md).
- **FR-028 · Parallel execution** — Independent doctor checks run in parallel. **Priority**: P1. **Acceptance**: Doctor wall-time ≤ 3s with 10 installed packages.
- **FR-029 · JSON output** — `linuxify doctor --json` emits a stable JSON schema. **Priority**: P1. **Acceptance**: Output validates against `schemas/doctor-output.json`.
- **FR-030 · Exit codes** — `doctor` exits 0 if all checks pass, 1 if any `warn`, 2 if any `fail`. **Priority**: P0. **Acceptance**: Test matrix covers each exit code.
- **FR-031 · Custom checks** — Plugins can register additional doctor checks. **Priority**: P2. **Acceptance**: A check declared in a plugin appears in `doctor` output.
- **FR-032 · Per-package doctor** — `linuxify doctor <pkg>` runs only the checks defined in that package's YAML. **Priority**: P1. **Acceptance: Output includes only that package's checks.

### Repair

- **FR-033 · Auto-repair safe fixes** — `linuxify repair` applies fixes marked `safe: true` without prompting. **Priority**: P0. **Acceptance: Re-applies missing patches, fixes PATH entries, re-links launchers.
- **FR-034 · Unsafe repair prompt** — Fixes marked `safe: false` prompt for confirmation unless `--yes` is passed. **Priority**: P0. **Acceptance: Without `--yes`, the prompt blocks; with `--yes`, the fix is applied.
- **FR-035 · Repair report** — After repair, Linuxify prints a summary of what changed and re-runs `doctor`. **Priority**: P0. **Acceptance: Report lists each fix applied with before/after status.

### Launcher

- **FR-036 · Launcher generation** — After `add`, Linuxify generates `~/.linuxify/bin/<name>` (a shell script) that execs into proot and runs the target binary. **Priority**: P0. **Acceptance: `~/.linuxify/bin/cline` exists and is executable.
- **FR-037 · Launcher env propagation** — Launchers forward `TERM`, `LANG`, `HOME`, and any `env:` entries from the package YAML. **Priority**: P0. **Acceptance: Inside the target CLI, `process.env.CLINE_PLATFORM === "linux"`.
- **FR-038 · Signal forwarding** — SIGINT, SIGTERM, SIGQUIT sent to the launcher are forwarded to the proot child. **Priority**: P0. **Acceptance: `Ctrl+C` interrupts the inner process and exits the launcher cleanly.
- **FR-039 · Stdio pass-through** — stdin, stdout, stderr are connected to the parent TTY without buffering surprises. **Priority**: P0. **Acceptance: Interactive TUI tools (e.g., `aider`) render correctly.
- **FR-040 · Launcher regeneration** — `linuxify repair --launchers` regenerates every launcher from current state. **Priority**: P1. **Acceptance: All launchers in `~/.linuxify/bin/` are rewritten.

### Distro Management

- **FR-041 · Switch distro** — `linuxify use <distro>` switches the active distro. The previously active distro's home is preserved. **Priority**: P1. **Acceptance: `linuxify use debian` then `linuxify use ubuntu` leaves both distros' `/root` intact.
- **FR-042 · List distros** — `linuxify use --list` shows installed and available distros. **Priority**: P1. **Acceptance: Output distinguishes installed vs. available.
- **FR-043 · Remove distro** — `linuxify use --remove <distro>` uninstalls a distro and frees its storage. **Priority**: P2. **Acceptance: Storage freed; active distro cannot be removed.
- **FR-044 · Custom distro** — A distro can be registered via plugin with a custom download URL and rootfs. **Priority**: P2. **Acceptance: `linuxify use mydistro` works.

### Runtime Management

- **FR-045 · Runtime install** — `linuxify runtime install <name> <version>` installs a runtime into the active distro. **Priority**: P1. **Acceptance: `linuxify runtime install node 22` makes node 22 the default.
- **FR-046 · Runtime switch** — `linuxify runtime use <name> <version>` switches the active version. **Priority**: P1. **Acceptance: `node --version` reports the selected version.
- **FR-047 · Runtime list** — `linuxify runtime list <name>` shows installed versions. **Priority**: P2. **Acceptance: Output includes version, install date, size.

### Configuration & State

- **FR-048 · Config get/set** — `linuxify config <key> [val]` reads or writes `~/.linuxify/config.toml`. **Priority**: P0. **Acceptance: `linuxify config telemetry.enabled false` persists across CLI invocations.
- **FR-049 · Config schema validation** — Invalid config values are rejected with a clear error. **Priority**: P0. **Acceptance: Setting `linuxify config bootstrap.timeout -5` is refused.
- **FR-050 · State.json** — `~/.linuxify/state.json` records active distro, runtime versions, last init, last doctor result. **Priority**: P0. **Acceptance: File is valid JSON and round-trips.
- **FR-051 · Concurrent writes** — Linuxify uses a file lock (`~/.linuxify/.lock`) to serialize state mutations. **Priority**: P0. **Acceptance: Two simultaneous `linuxify add` calls do not corrupt state.json.

### Telemetry

- **FR-052 · Opt-in telemetry** — Telemetry is off by default. First-run prompts the user. **Priority**: P1. **Acceptance: Fresh install has `telemetry.enabled = false`.
- **FR-053 · Telemetry payload** — When enabled, Linuxify sends anonymous install/error events to a self-hosted endpoint. **Priority**: P1. **Acceptance: Payload schema documented in [telemetry-privacy.md](../24-telemetry/telemetry-privacy.md).
- **FR-054 · Telemetry redaction** — PII (paths, env vars, package args) is stripped before send. **Priority**: P0. **Acceptance: Test suite asserts no PII in captured payloads.

### Self-Update

- **FR-055 · Self-update** — `linuxify self-update` downloads the latest Linuxify release and atomically swaps the binary. **Priority**: P0. **Acceptance: Mid-update SIGKILL leaves either old or new version, never a broken binary.
- **FR-056 · Update check** — `linuxify update` checks for new versions of Linuxify and installed packages without applying. **Priority**: P1. **Acceptance: Reports available updates with current and target versions.

### Internationalization & Accessibility

- **FR-057 · English v1** — All user-facing strings are in English for v1; strings are externalized to `locales/en.json` to enable future translation. **Priority**: P1. **Acceptance: No hardcoded user-facing strings in source.
- **FR-058 · Color/TTY detection** — Color output is disabled when `stdout` is not a TTY or when `NO_COLOR` is set. **Priority**: P0. **Acceptance: `linuxify doctor | cat` produces no ANSI codes.
- **FR-059 · Non-interactive mode** — `--yes` flag makes every command non-interactive. **Priority**: P0. **Acceptance: `linuxify repair --yes` does not block on prompts.

### Plugin SDK

- **FR-060 · Plugin discovery** — Linuxify discovers plugins in `~/.linuxify/plugins/` and `$PREFIX/share/linuxify/plugins/`. **Priority**: P1. **Acceptance: A plugin placed in either directory is loaded.
- **FR-061 · Plugin hooks** — Plugins can hook into `preInstall`, `postInstall`, `prePatch`, `postPatch`, `preRun`, `postRun`, `doctor`. **Priority**: P1. **Acceptance: A `postInstall` hook runs after `linuxify add`.
- **FR-062 · Plugin isolation** — A crashing plugin does not crash the core CLI; the failure is logged and the operation continues. **Priority**: P1. **Acceptance: A plugin throwing in `preRun` results in a warning, not a CLI crash.

---

## 6. Non-Functional Requirements

### 6.1 Performance

- **NFR-PERF-01** — `linuxify init` cold (no cache) completes in ≤ 5 minutes at p95 on Snapdragon 7-class hardware with 50 Mbps Wi-Fi.
- **NFR-PERF-02** — `linuxify doctor` completes in ≤ 3 seconds wall-clock with 10 installed packages.
- **NFR-PERF-03** — `linuxify add` for a Node-based CLI completes in ≤ 90 seconds after the runtime is installed.
- **NFR-PERF-04** — `linuxify run <pkg>` adds ≤ 200 ms of overhead versus a direct proot invocation.
- **NFR-PERF-05** — `linuxify list` and `linuxify config <get>` return in ≤ 100 ms.

### 6.2 Reliability

- **NFR-REL-01** — Every state-mutating command is crash-safe: a SIGKILL at any point leaves Linuxify in a state from which `linuxify repair` recovers without data loss.
- **NFR-REL-02** — No command silently corrupts `~/.linuxify/state.json` or `manifest.json`. All writes are atomic (write-to-temp then rename).
- **NFR-REL-03** — Network failures during `init` or `add` produce a non-zero exit code and a human-readable hint, never an unhandled exception.
- **NFR-REL-04** — Linuxify itself never `set -e`s a user's shell on failure; failures are contained to the CLI invocation.

### 6.3 Security

- **NFR-SEC-01** — Linuxify never runs as root and refuses to operate as root.
- **NFR-SEC-02** — Package definitions from the remote registry are signed (Ed25519); signature is verified before install. (Local packages skip verification with a warning.)
- **NFR-SEC-03** — Patched files are scanned for the presence of common malicious patterns (`eval(require(...))`, network exfil) before the patch is committed; suspicious patches prompt the user.
- **NFR-SEC-04** — Telemetry payloads contain no PII (see [telemetry-privacy.md](../24-telemetry/telemetry-privacy.md)).
- **NFR-SEC-05** — Linuxify does not store credentials in plaintext; package-defined env vars that look like secrets (`*_TOKEN`, `*_KEY`, `API_*`) are loaded from the user's environment, not persisted.

### 6.4 Accessibility

- **NFR-A11Y-01** — All output is readable in 80-column terminals and in screen readers: no information is conveyed by color alone.
- **NFR-A11Y-02** — Status icons (`✔`, `✖`) are accompanied by a text label (`OK`, `FAIL`) in the same line.
- **NFR-A11Y-03** — `--no-color` and `NO_COLOR` are honored.
- **NFR-A11Y-04** — Interactive prompts accept `y`/`n`/`yes`/`no` and arrow keys; they are not case-sensitive.

### 6.5 Internationalization

- **NFR-I18N-01** — English is the only locale in v1, but all strings flow through an `i18n()` function so that community translations can ship as plugins in v1.1.
- **NFR-I18N-02** — Dates, sizes, and durations are formatted via `Intl.DateTimeFormat`/`Intl.NumberFormat` with the user's `LANG` setting.

### 6.6 Offline-first

- **NFR-OFF-01** — After a successful `linuxify init`, every subsequent command except `search` (remote), `upgrade` (remote), and `self-update` (remote) must work with no network.
- **NFR-OFF-02** — Linuxify never blocks on a network timeout for an operation that could complete offline. Network checks are explicitly opt-in via `--check-for-updates`.

### 6.7 Storage budget

- **NFR-STOR-01** — A default `linuxify init` (Ubuntu 24.04 + Node LTS + Python 3.12 + git + build-essential) must use ≤ 2.0 GB on disk after install.
- **NFR-STOR-02** — Each additional CLI install must use ≤ 250 MB unless the package YAML declares a larger `size_estimate`.
- **NFR-STOR-03** — `linuxify doctor` warns when free storage in `~/.linuxify/` falls below 500 MB and refuses new installs below 200 MB.

---

## 7. Constraints

1. **No root.** Linuxify must never require `su` or `sudo`. Anything that would require root is out of scope.
2. **Android 9+ via Termux from F-Droid.** Play Store Termux is unsupported and explicitly rejected. Other Termux forks (e.g., on GrapheneOS) are best-effort.
3. **aarch64 is the primary target.** armv7l is best-effort; x86_64 (Android-x86, Chromebook Linux-on-Android) is best-effort.
4. **MIT license.** All source and documentation are MIT. Third-party dependencies must be MIT-compatible (no GPL contamination of the CLI core).
5. **Offline-first after first bootstrap.** The first `init` requires network; everything else should not.
6. **Termux is the only supported host shell.** Linuxify is not a standalone Android app; it requires Termux (or a compatible Termux-fork shell) to run.
7. **Single active distro in v1.** Multi-distro simultaneous installs are deferred to v1.1.
8. **Node.js inside the proot.** Linuxify's own CLI runs inside the Ubuntu proot using the Node runtime it manages. This is a deliberate bootstrapping decision (see [ADR-003](../20-adrs/adr-003-typescript-cli-core.md)) — it means Linuxify's runtime and its managed runtime are the same, eliminating a class of "works on my machine" issues.

---

## 8. Assumptions & Dependencies

### 8.1 External dependencies

- **Termux** (F-Droid build) must be installable on the host device. Linuxify does not sideload Termux.
- **Android kernel** must support the syscalls `proot` relies on (`ptrace`, `mount` namespacing via `unshare`, `/proc/self/`). Linuxify assumes Android 9+ kernels do; older kernels are best-effort.
- **`proot` and `proot-distro`** must be installable via `pkg install proot-distro`. Linuxify will install these if missing.
- **Network access** is required for the first `init` to download the rootfs and runtime tarballs. Subsequent operations are offline-capable.
- **GitHub** is the assumed source of package definitions in v1 (each `packages/*.yml` is committed to the Linuxify repo). A central registry is v1.1+.

### 8.2 Assumptions

- The user has at least 3 GB of free storage on the Android `/data` partition.
- The user's Termux has `pkg` working and a writable `$PREFIX`.
- The user's device clock is within a few hours of UTC; large clock skew breaks TLS during download.
- The user is the owner of the device and has not heavily modified Termux's `$PREFIX` layout.

### 8.3 Upstream coupling risks

- **proot upstream** could change its CLI flags or behavior in a release. Linuxify pins `proot-distro` to a known-good version.
- **Termux packaging** could change `pkg` behavior. Linuxify detects Termux version and warns on unsupported versions.
- **Node.js release cadence** — Node LTS bumps every October. Linuxify's runtime manager must support new LTS versions within 30 days of upstream release.

---

## 9. Success Metrics

### 9.1 Activation

- **M-ACT-01** — 7-day activation rate (user runs `linuxify init` within 7 days of install) ≥ 60%.
- **M-ACT-02** — 7-day "first success" rate (user runs `linuxify add <pkg>` and the tool runs successfully within 7 days of install) ≥ 50%.

### 9.2 Retention

- **M-RET-01** — 30-day retention (user runs any `linuxify` command in week 5 after install) ≥ 30%.
- **M-RET-02** — 90-day retention ≥ 15%.

### 9.3 Quality

- **M-QUAL-01** — `linuxify doctor` pass rate (all checks green) on a fresh `init` ≥ 95% in CI matrix.
- **M-QUAL-02** — Package install success rate (`add` exits 0) ≥ 98% for the top-10 packages.
- **M-QUAL-03** — Median time-to-first-success (install → first successful `run`) ≤ 8 minutes.
- **M-QUAL-04** — Crash rate (uncaught exceptions per 1k invocations) ≤ 1.

### 9.4 Ecosystem

- **M-ECO-01** — Number of packages defined in the official registry: ≥ 25 at v1 launch, ≥ 100 within 6 months.
- **M-ECO-02** — GitHub stars: ≥ 1k within 3 months, ≥ 5k within 12 months.
- **M-ECO-03** — Active contributors (≥ 1 merged PR per quarter): ≥ 10 within 6 months.
- **M-ECO-04** — Open-source AI tools linking to Linuxify from their README: ≥ 5 within 6 months.

### 9.5 Operational

- **M-OPS-01** — p95 `linuxify doctor` wall time ≤ 3s in production telemetry.
- **M-OPS-02** — p95 `linuxify init` wall time ≤ 300s in production telemetry.
- **M-OPS-03** — Mean time between releases ≤ 4 weeks.

---

## 10. Risks & Mitigations

| ID | Risk | Likelihood | Impact | Mitigation |
|----|------|-----------|--------|------------|
| **R-01** | **Termux deprecation or Play Store re-listing changes** break the F-Droid build | Medium | High | Pin to F-Droid build only; detect and refuse Play Store build; maintain a tested fork in `linuxify/termux-fork` if upstream breaks. |
| **R-02** | **Android SELinux policy changes** in a new Android version block `proot` ptrace | Medium | Critical | Track Android release notes; ship a SELinux-policy compatibility shim (best-effort, no root); document the failure mode in [troubleshooting.md](../22-operations/troubleshooting.md). |
| **R-03** | **proot syscall breakage** on new kernels (e.g., `clone3`) | Medium | High | Use `proot-distro`'s kernel-feature detection; pin to known-good proot builds; maintain a "fallback to proot-static" path. |
| **R-04** | **npm supply chain attack** via a transitive dependency of a patched CLI | Medium | Critical | After `npm install -g`, scan `node_modules` for known-bad packages via `npm audit --omit=dev`; block installs on critical advisories; encourage lockfile pinning in package YAML. |
| **R-05** | **Package maintainer abandonment** — a CLI's upstream stops releasing and breaks on new Node | High | Medium | Patches are versioned and reusable; community can fork a package YAML to point at a maintained fork; document the forking process in [contribution-guidelines.md](../16-community/contribution-guidelines.md). |
| **R-06** | **Linuxify itself becomes unmaintained** | Medium | High | Keep the codebase small and well-tested; ensure any contributor can fork and resume; keep package YAMLs in a separate repo so they survive a CLI freeze. |
| **R-07** | **Storage pressure** on low-end devices leads to install failures | High | Medium | Aggressive cache cleanup; `linuxify doctor` storage warning thresholds (see NFR-STOR-03); size estimate in every package YAML. |
| **R-08** | **User confuses Termux package manager with proot's apt** and breaks their install | High | Low | `linuxify shell` prints a banner reminding the user they are inside Ubuntu; `linuxify doctor` detects mixed-up `apt` installs in the wrong layer. |
| **R-09** | **Patch becomes stale** after upstream CLI release | High | Medium | `linuxify doctor` compares patch fingerprints against the installed CLI's hash; `upgrade` re-applies patches; CI runs `linuxify add` for every package on every upstream release. |
| **R-10** | **Telemetry privacy concerns** reduce adoption | Medium | Medium | Telemetry is opt-in, minimal, and documented in [telemetry-privacy.md](../24-telemetry/telemetry-privacy.md); a one-page privacy summary is shown at first run. |
| **R-11** | **Trademark/patent issues** with distro names ("Ubuntu") | Low | Medium | Use distro names in a descriptive, nominative-fair-use way; do not imply endorsement; document in [branding-guide.md](../17-branding/branding-guide.md). |
| **R-12** | **ARM binary incompatibility** — a CLI ships x86_64-only native modules | Medium | High | Patcher detects `process.arch === 'x64'` and either rewrites to `'arm64'` or refuses install with a clear message; package YAML can declare `arch: [arm64]` to skip x86-only packages. |

---

## 11. Out of Scope (v1)

The following are explicitly out of scope for v1. Listing them here prevents scope creep and sets expectations with contributors.

1. **Cloud sync** of installed packages, config, or state across devices. (Deferred to v2; design notes in [cloud-sync.md](../19-future/cloud-sync.md).)
2. **GUI companion app** (Android Activity or Tauri/Electron-style). Linuxify is CLI-first. A TUI dashboard is acceptable for v1.1; a full GUI is v2+.
3. **iOS support.** iOS does not allow the kind of process model Linuxify requires; out of scope indefinitely.
4. **Non-Android hosts.** Linuxify is not a Linux-on-Linux package manager; that role is filled by `brew`, `apt`, `cargo`, etc. Linuxify on a Linux laptop is a no-op.
5. **Paid tier / SaaS.** No commercial offering in any release covered by this PRD.
6. **Multi-user / multi-profile.** Linuxify assumes one user per device. Multi-profile (e.g., separate Linuxify installs per Termux session) is v1.1.
7. **Container escape / hardening.** Linuxify uses proot, which is explicitly *not* a security boundary. Sandboxing is out of scope; document this in [security-model.md](../13-security/security-model.md).
8. **Custom kernels / kernel modules.** Linuxify works with the device's stock kernel; we do not ship or recommend kernel mods.
9. **Reverse engineering of proprietary CLIs.** Package YAMLs only target open-source CLIs with permissive licenses.
10. **Auto-translation of user docs.** English-only in v1; community translations are welcome but not formally supported.

---

## 12. Open Questions

These are questions the core team needs to resolve before v1 ships. Each will become either an ADR or a documented decision in the relevant doc.

1. **Q1**: Should Linuxify ship as a single bundled binary (via `pkg`/`bun build`) or as a Node.js project installed via `npm i -g linuxify`? Bundled binary is harder to contribute to; npm install requires Node on the host (bootstrapping chicken-and-egg).
2. **Q2**: What is the minimum supported Android version in practice? Android 9 is the declared floor, but does proot actually work on Android 9 in 2025? Should we raise the floor to Android 11?
3. **Q3**: Should Linuxify maintain its own fork of proot-distro to control patch cadence, or pin to upstream and accept their release schedule?
4. **Q4**: How does Linuxify handle a package whose upstream refuses to accept patches upstream? Do we maintain a long-lived fork, or only the YAML patch file?
5. **Q5**: What is the policy for packages that require native compilation (e.g., a CLI with a Rust native module)? Do we pre-build aarch64 binaries, or compile inside proot at install time?
6. **Q6**: Should `linuxify run <pkg>` start a new proot session per invocation (slow but stateless) or reuse a long-lived proot session (fast but stateful)? What is the perf/complexity tradeoff?
7. **Q7**: What is the right telemetry endpoint — self-hosted PostHog, Plausible, or a custom minimal collector? Who pays for hosting?
8. **Q8**: How does Linuxify verify that a patch is still needed after upstream changes? A patch that's no longer needed is dead weight; a patch that's silently ineffective is a bug.
9. **Q9**: Should the package registry live in the main Linuxify repo (monorepo) or a separate `linuxify-packages` repo? Separate repo enables independent contribution cadence.
10. **Q10**: What is the support policy for armv7l? Is it tier-2 (best-effort, no CI) or tier-3 (community-maintained)?
11. **Q11**: Should Linuxify support `nix`-style declarative config (a `linuxify.toml` that fully describes desired state, applied via `linuxify apply`)? This is appealing but adds complexity.
12. **Q12**: How does Linuxify interact with Termux:Boot (autostart on device boot)? Should Linuxify register an autostart hook for background tasks?

---

## 13. Glossary

A full glossary of Linuxify-specific terms (`proot`, `proot-distro`, `Termux`, `$PREFIX`, `manifest.json`, `launcher`, `patcher`, `doctor check`, `runtime`, `distro backend`) is maintained at [docs/21-reference/glossary.md](../21-reference/glossary.md). Contributors should consult that document when a term in this PRD is unfamiliar; the glossary is the canonical source for terminology and is kept in sync with this PRD by CI.
