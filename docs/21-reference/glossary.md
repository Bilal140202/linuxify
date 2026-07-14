# Glossary

> **Audience**: AI coding agents, new contributors, and users who hit an unfamiliar term in another Linuxify doc. This is the canonical reference for vocabulary across the Linuxify documentation set. Every term used in a Linuxify doc should be defined here; if you find a term that is not defined here, please open a PR.

## How to Use This Glossary

Terms are listed alphabetically. Each entry has a short definition (2–4 sentences) and, where relevant, a cross-link to the doc where the term is discussed in depth. When a term has multiple senses (e.g., "package" can mean a Linuxify-managed CLI *or* a generic software package), both senses are given. Terms that are external to Linuxify (e.g., `glibc`, `apt`, `STRIDE`) are defined briefly with a link to an authoritative external source where appropriate; terms that are Linuxify-specific (e.g., `compat-db`, `patch ID`, `doctor profile`) are defined in full.

---

## A

### aarch64
The 64-bit ARM instruction set architecture (also called ARM64 or ARMv8). It is the primary architecture Linuxify targets, because the vast majority of Android phones shipped since 2018 use aarch64 SoCs. Linuxify's default Ubuntu rootfs, default Node runtime build, and default patch library all assume aarch64. See [arm-considerations](../23-mobile/arm-considerations.md) for the secondary architectures (`armv7l`, `x86_64`).

### ADR
Architecture Decision Record. A short document that captures one architectural decision: the context that forced it, the options considered, the choice made, and the consequences. Linuxify's ADRs live in [../20-adrs/](../20-adrs/README.md) and follow the Michael Nygard template. See [ADR-001](../20-adrs/adr-001-use-proot-over-chroot.md) through [ADR-005](../20-adrs/adr-005-opt-in-telemetry.md) for the v1 set.

### alpha channel
A release channel that ships the bleeding-edge Linuxify build, ahead of `beta` and `stable`. Alpha builds may have known regressions and are intended for contributors and early testers. Use `linuxify config release.channel alpha` to subscribe. See [release-pipeline](../14-cicd/release-pipeline.md) for the channel cadence.

### alpine
A Linux distribution built around `musl libc` and `busybox`, designed for minimal size (~5 MB base image). Linuxify supports Alpine as a pluggable distro backend for users who want smaller footprint and faster cold-starts than Ubuntu. The trade-off is that musl libc is incompatible with glibc, so some pre-built binaries (notably certain Node native modules) fail on Alpine and require patches. See [distro-management](../05-bootstrap/distro-management.md) §3.

### Android
The mobile operating system that is Linuxify's host platform. Linuxify targets Android 9+ via Termux (from F-Droid, not the Play Store — the Play Store version of Termux is deprecated and unsupported). See [termux-internals](../23-mobile/termux-internals.md) for why the F-Droid version is required.

### apt
The Debian/Ubuntu package manager (`apt-get`, `apt-cache`). Linuxify uses `apt` *inside the proot distro* to install system-level dependencies (e.g., `build-essential`, `pkg-config`) that the managed CLIs need. Linuxify does not use `apt` on the Termux host — Termux uses `pkg` (a wrapper around `apt` with Termux-specific repos). See [bootstrap-design](../05-bootstrap/bootstrap-design.md) Stage 3.

### arch (distro)
Arch Linux, a rolling-release distribution known for being bleeding-edge and user-centric. Linuxify supports Arch as a pluggable distro backend. Arch's rolling-release nature means package versions move fast, which is good for freshness but can introduce breakage; the [compat-db](./#compat-db) records known issues per Arch version. See [distro-management](../05-bootstrap/distro-management.md) §3.

### armv7l
The 32-bit ARM instruction set (ARMv7-A, little-endian). It is a best-effort secondary architecture for Linuxify — supported where upstream binaries exist, but not all packages work and the maintainers do not commit to fixing every armv7l-specific issue. Most modern Android devices are `aarch64` (64-bit), so `armv7l` is increasingly rare in the wild. See [arm-considerations](../23-mobile/arm-considerations.md) and PRD Open Question Q10.

## B

### beta channel
A release channel that ships release-candidate-quality builds, between `alpha` and `stable`. Beta builds have passed CI and are intended for users who want newer features than stable provides but do not want the breakage risk of alpha. Use `linuxify config release.channel beta` to subscribe. See [release-pipeline](../14-cicd/release-pipeline.md).

### bind mount
A mount that exposes a file or directory from one location in the filesystem tree at another location, without copying. Linuxify uses bind mounts (via `proot --bind`) to expose the user's Termux working directory (e.g., `/sdcard/MyProject`) inside the proot at a path the managed CLI expects (e.g., `/home/linuxify/MyProject`). This is how `linuxify run cline` from `/sdcard/MyProject` lets `cline` see the project files. See [launcher-architecture](../06-launcher/launcher-architecture.md) §7.

### bionic libc
The C library used by Android itself (as opposed to `glibc`, used by most Linux distributions). Termux compiles against bionic, which is why a binary built for "Linux" (glibc) cannot run directly in Termux — it needs proot+glibc. Linuxify's entire reason for existing is, in a sense, to bridge the bionic↔glibc gap. See [platform-detection](../08-patcher/platform-detection.md) §2.

### bootstrap
The one-shot environment bring-up that turns a fresh Termux install into a working Linuxify environment. Bootstrap consists of 9 stages (Stage 0 through Stage 8), each of which is idempotent and resumable. Triggered by `linuxify init`. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §2.

### bootstrap stage
One of the 9 numbered phases of `linuxify init`: Stage 0 Preflight, Stage 1 Host deps, Stage 2 Distro download, Stage 3 First-boot, Stage 4 Runtimes, Stage 5 Linuxify home, Stage 6 PATH wiring, Stage 7 Verification, Stage 8 First-run tips. Each stage writes a `~/.linuxify/.bootstrap/stage-N.done` marker on success and `stage-N.failed` on failure. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §2.

## C

### C4 model
The "Context, Containers, Components, Code" diagram hierarchy by Simon Brown, used to structure software architecture diagrams at four zoom levels. Linuxify's architecture docs use C4 L1 (system context), L2 (containers), and L3 (components) — see [component-diagrams](../02-architecture/component-diagrams.md) for all three.

### cargo
The Rust package manager and build tool. Linuxify uses `cargo` *inside the proot distro* when a managed CLI is a Rust binary that needs to be built from source (rare in v1; most Rust CLIs ship pre-built aarch64 binaries). Linuxify itself is not written in Rust — see [ADR-003](../20-adrs/adr-003-typescript-cli-core.md).

### changelog
A human-readable list of changes per release, maintained at `CHANGELOG.md` in the repo root. Linuxify follows the Keep a Changelog format. Each release (alpha, beta, stable) gets a changelog entry. See [release-pipeline](../14-cicd/release-pipeline.md) §6.

### CI/CD
Continuous Integration / Continuous Deployment. Linuxify uses GitHub Actions for CI (running [Vitest](#vitest) tests on every PR) and CD (publishing to npm, Termux pkg, and GitHub Releases on tag). See [cicd-design](../14-cicd/cicd-design.md).

### CLI
Command-Line Interface. In Linuxify docs, "the CLI" usually refers to the `linuxify` command itself; "a managed CLI" or "a tool" refers to a user-installed CLI like `cline` or `codex`. See [cli-specification](../03-cli/cli-specification.md).

### Cline
An AI coding agent that runs in the terminal. Cline is one of the primary tools Linuxify is designed to support; the [project context](../../.agent-context.md) §6 uses `cline.yml` as its example package definition. See [package-spec](../09-registry/package-spec.md) §9 for the full annotated `cline.yml`.

### Codex
Another AI coding agent CLI supported by Linuxify. Codex is the example used in [patcher-engine](../08-patcher/patcher-engine.md) §16 for an AST-based architecture-detection patch. See the `codex.yml` package definition in the registry.

### compat-db
The compatibility database — a JSON file at `~/.linuxify/registry/compat/compat-db.json` that records, for each (package, distro, arch, runtime) tuple, whether the combination is known-good, known-broken, or untested. Consulted by `linuxify add` to warn the user before installing a combination that is known to fail. See [compatibility-database](../11-compat-db/compatibility-database.md).

### config.toml
The human-edited configuration file at `~/.linuxify/config.toml`, in TOML format. Stores user preferences: active distro, release channel, telemetry opt-in, default profile, run defaults, patcher settings. Distinct from `state.json` (machine-managed, never hand-edited). See [cli-specification](../03-cli/cli-specification.md) §7.

### contribution
A change submitted to the Linuxify project — a new package definition, a patch, a bug fix, a doc improvement. Contributions are made via PRs and must pass CI and maintainer review. Contributors sign off on their commits per the [DCO](#dco). See [contribution-guidelines](../16-community/contribution-guidelines.md).

## D

### DCO
Developer Certificate of Origin. A lightweight sign-off (adding `Signed-off-by: Name <email>` to a commit) asserting that the contributor has the right to submit the code under the project's license. Linuxify requires DCO sign-off on every commit. See [contribution-guidelines](../16-community/contribution-guidelines.md) §3.

### Debian
A Linux distribution and the upstream of Ubuntu. Linuxify supports Debian as a pluggable distro backend, useful for users who want Ubuntu's package ecosystem but a slower release cadence. See [distro-management](../05-bootstrap/distro-management.md) §3.

### dependency
A piece of software that another piece of software needs to function. In Linuxify, dependencies come in three flavors: host dependencies (Termux packages like `proot`), distro dependencies (apt packages inside the proot like `build-essential`), and package dependencies (other Linuxify-managed CLIs that a CLI requires — deferred to v2, see [package-spec](../09-registry/package-spec.md) §14).

### distro
Short for "Linux distribution" — a packaged userland (Ubuntu, Debian, Arch, Alpine) that Linuxify installs *inside* proot. The user picks one active distro at a time via `linuxify use <distro>`. See [distro-management](../05-bootstrap/distro-management.md).

### distro provider
A TypeScript module implementing the `DistroProvider` interface (defined in `src/distro/provider.ts`), which knows how to install, uninstall, start, stop, exec into, snapshot, and restore a specific distro backend. v1 ships one provider (`proot-distro`); the interface is pluggable so v2 can add chroot or QEMU providers. See [distro-management](../05-bootstrap/distro-management.md) §1.

### doctor
The `linuxify doctor` subcommand and the subsystem that implements it. Doctor runs a catalog of health checks (host, bootstrap, distro, runtime, PATH, packages, compat, network, services) and reports each as `ok`, `warn`, `fail`, or `missing`. Doctor is read-only — it never mutates state. Mutations are done by `linuxify repair`. See [doctor-engine](../07-doctor/doctor-engine.md).

### doctor check
One unit of the doctor's check catalog. Each check has a stable ID (e.g., `node_version`, `executable`), a command to run, an expected result, a severity (`ok`/`warn`/`fail`/`missing`), and an optional `fix_command`. Package definitions can declare their own checks in the `doctor:` block. See [doctor-engine](../07-doctor/doctor-engine.md) §3.

### doctor profile
A named preset of doctor check configurations. The `default` profile runs every check; the `ci` profile elevates `warn` to `fail` (so CI fails on warnings); the `quick` profile runs only the critical subset. Selected via `--profile <name>` or `linuxify config doctor.profile <name>`. See [doctor-engine](../07-doctor/doctor-engine.md) §7.

## E

### E_<SUBSYSTEM>_<DESCRIPTION>
The error-code prefix convention used in Linuxify's structured logs and JSON error output. Examples: `E_BOOTSTRAP_FDROID_REQUIRED`, `E_PATCH_VERIFY_FAILED`, `E_PLUGIN_UNDECLARED_HOOK`, `E_REGISTRY_PATCH_MATCHER_CONFLICT`. Greppable in `~/.linuxify/logs/linuxify.log` via `grep "E_"`. See [system-architecture](../02-architecture/system-architecture.md) §9 and [diagnostics](../07-doctor/diagnostics.md) §4.

## F

### F-Droid
The free-software Android app repository from which Linuxify users must install Termux. The Google Play Store version of Termux is deprecated and lacks the permissions Linuxify needs; F-Droid's build is signed correctly and receives updates. See [termux-internals](../23-mobile/termux-internals.md) §1.

### FR (functional requirement)
A numbered requirement in the [PRD](../01-product/prd.md) §5, of the form `FR-NNN`. Linuxify v1 has 62 FRs (FR-001 through FR-062), each with a priority (P0/P1/P2) and acceptance criteria. Every feature in Linuxify should trace to at least one FR. See [prd](../01-product/prd.md).

## G

### glibc
The GNU C Library, used by virtually all mainstream Linux distributions (Ubuntu, Debian, Arch, Alpine uses musl instead). Binaries built against glibc do not run on Android's bionic libc, which is why Linuxify wraps them in a proot Ubuntu (which has glibc). See [platform-detection](../08-patcher/platform-detection.md) §2.

### GitHub Actions
GitHub's CI/CD platform. Linuxify uses GitHub Actions workflows (in `.github/workflows/`) for: PR CI (lint, unit tests, integration tests), nightly compat matrix runs, release publishing (npm, Termux pkg, GitHub Releases with `.sig` signatures). See [cicd-design](../14-cicd/cicd-design.md).

## H

### Homebrew
The macOS/Linux package manager (`brew`). Not directly relevant to Linuxify (which runs on Android), but referenced in [vision](../00-executive/vision.md) as the analog Linuxify aspires to be for Android — "the `brew` of Linux dev tools on phones."

## I

### i18n
Internationalization. Linuxify's user-facing messages are routed through an `i18n()` function with a message catalog, so that future translations can be added without code changes. v1 ships English only; the framework is in place for v1.1+. See [cli-specification](../03-cli/cli-specification.md) §9.

### init
The `linuxify init` subcommand — triggers the 9-stage bootstrap pipeline that turns a fresh Termux install into a working Linuxify environment. Idempotent: re-running skips stages that already have `.done` markers. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §2.

### install
In Linuxify docs, "install" can mean: (1) installing Linuxify itself (`pkg install linuxify` or `npm install -g linuxify`); (2) installing a distro (`linuxify use --create ubuntu`); (3) installing a managed CLI tool (`linuxify add cline`). The `linuxify install` subcommand is an alias for `linuxify init` in interactive mode. See [cli-specification](../03-cli/cli-specification.md) §4.

## L

### launcher
The small shell-script shim that Linuxify places at `$PREFIX/bin/<name>` so that typing `<name>` in a Termux shell invokes `linuxify run <name>`. Generated at `linuxify add` time; regenerated on distro/runtime/patch changes. Three variants: Standard (shell script), Direct (bare symlink, opt-in), Custom (user-supplied script). See [launcher-architecture](../06-launcher/launcher-architecture.md) and [ADR-004](../20-adrs/adr-004-shell-launchers-over-symlinks.md).

### Linuxify
The open-source project. Always capitalized when referring to the project. See [README](../../README.md).

### linuxify (CLI)
The command-line tool. Always lowercase when referring to the command. Invoked as `linuxify <subcommand> [flags] [args]`. See [cli-specification](../03-cli/cli-specification.md).

### lockfile
A pinned-dependency manifest (`package-lock.json` for npm) that records exact versions of every transitive dependency. Linuxify's own lockfile is committed to the repo so that CI and contributors reproduce the same dependency tree. See [security-model](../13-security/security-model.md) §8.

## M

### manifest
In Linuxify, "manifest" usually refers to `~/.linuxify/manifest.json` — the machine-managed record of which packages are installed, at which versions, with which patch fingerprints. Distinct from `state.json` (broader system state) and `config.toml` (user preferences). The `linuxify export` command emits a portable manifest suitable for backup. See [system-architecture](../02-architecture/system-architecture.md) §4.

### MCP
Model Context Protocol — an open standard for connecting AI assistants to external tools and data sources. Several of the CLIs Linuxify manages (notably Cline and Codex) use MCP to connect to filesystem, git, and other tools. Linuxify does not implement MCP itself; it ensures the MCP servers the managed CLIs expect are available inside the proot. See the upstream MCP spec at modelcontextprotocol.io.

### migration
A one-time data transformation applied during a version upgrade — e.g., reformatting `state.json` from v0.1 schema to v0.2 schema. Migrations are bundled with the new Linuxify release and run automatically by `linuxify self-update`. Each migration is atomic and reversible; if a migration fails, the previous version's binary is restored. See [cli-specification](../03-cli/cli-specification.md) `self-update` and [disaster-recovery](../22-operations/disaster-recovery.md) §8.

### mirror
A replicated copy of a remote resource, used for redundancy or geographic locality. Linuxify supports distro rootfs mirrors (the Ubuntu rootfs is fetched from `cdimage.ubuntu.com` or a mirror if configured) and registry mirrors (a v2 feature; see [package-registry-future](../19-future/package-registry-future.md)).

### multi-distro
The ability to have more than one distro installed simultaneously and switch between them via `linuxify use <distro>`. Each distro lives in its own `~/.linuxify/distros/<name>/` directory. Only one is "active" at a time (the one `linuxify run` enters). See [distro-management](../05-bootstrap/distro-management.md) §4.

## N

### npm
The Node.js package manager. Linuxify uses `npm` *inside the proot distro* to install managed CLIs that are npm packages (Cline, Codex, Aider's JS components). Linuxify itself is also distributed via npm (`npm install -g linuxify`). See [ADR-003](../20-adrs/adr-003-typescript-cli-core.md).

### nvm
Node Version Manager — a tool for installing and switching between multiple Node.js versions on a single system. Linuxify does not use `nvm` directly (it has its own runtime management via the RuntimeProvider interface), but the conceptual model is similar. See [runtime-management](../06-launcher/runtime-management.md).

## O

### OpenHands
An open-source AI software engineering agent CLI supported by Linuxify. See the `openhands.yml` package definition in the registry.

### opt-in telemetry
The telemetry model Linuxify uses: no data is collected until the user explicitly enables it via `linuxify config telemetry true` or answers "yes" to the first-run prompt. The default is off. See [ADR-005](../20-adrs/adr-005-opt-in-telemetry.md) and [telemetry-privacy](../24-telemetry/telemetry-privacy.md).

## P

### package
In Linuxify, "package" usually means a managed CLI tool (e.g., `cline` is a package) defined by a YAML file in the registry. Distinct from a Termux `pkg` (host-level) or an apt package (inside the distro). See [package-spec](../09-registry/package-spec.md).

### package definition
The YAML file (e.g., `cline.yml`) that declares how to install, patch, configure, and verify a managed CLI. The schema is specified in [package-spec](../09-registry/package-spec.md) §1. Sometimes called a "package spec" or "manifest entry."

### package manager
A tool that installs, upgrades, and removes software packages. Linuxify interacts with three: `pkg` (Termux host), `apt` (inside the proot distro), and `npm` (for Node-based managed CLIs). Linuxify itself is a fourth package manager — for managed CLI tools — layered on top of the others.

### package spec
The schema and semantics of a package definition. See [package-spec](../09-registry/package-spec.md). Sometimes used interchangeably with "package definition."

### patch
A source-code transformation applied to a managed CLI after installation to fix an Android-specific incompatibility. Examples: rewriting `process.platform === 'linux'` to `['linux','android'].includes(process.platform)`, or `process.arch === 'x64'` to `['x64','arm64'].includes(process.arch)`. Patches are defined in the package YAML's `patches:` block and applied by the patcher subsystem. See [patcher-engine](../08-patcher/patcher-engine.md).

### patch ID
A stable identifier for a patch, of the form `<pkg>-<NNN>` where `<NNN>` is a zero-padded three-digit sequence. Example: `cline-001`, `cline-002`, `codex-001`. Used in patch records, rollback commands (`linuxify patch --rollback cline cline-001`), and error messages (`E_PATCH_VERIFY_FAILED patch_id=cline-001`). See [patcher-engine](../08-patcher/patcher-engine.md) §3.

### patch type
The mechanism by which a patch is applied: `regex` (find/replace via JS regex), `ast-js` (AST-aware via acorn/babel for JavaScript), `ast-ts` (AST-aware via ts-morph for TypeScript), `sed` (shell out to sed), `python-ast` (Python's ast module), `shell` (arbitrary shell command, heavily restricted). See [patcher-engine](../08-patcher/patcher-engine.md) §5.

### persona
A named composite user representing a segment of Linuxify's target audience. Six personas are defined: Ravi (road-warrior engineer), Ana (student first-time contributor), Mira (OSS maintainer in disaster recovery), Devon (power user exploring distros), Priya (user on metered hotspot), Kenji (upstream maintainer of obscure tool). See [user-journeys](../04-ux/user-journeys.md).

### pkg
Termux's package manager — a thin wrapper around `apt` with Termux-specific repositories. Used on the Termux host to install `proot`, `linuxify` itself, and other host-level dependencies. Not the same as `apt` inside the proot. See [termux-internals](../23-mobile/termux-internals.md).

### plugin
A Node package with the `linuxify-plugin` keyword that extends Linuxify core with custom distros, runtimes, commands, doctor checks, patch types, or lifecycle hooks. Plugins run with full user privileges in v1 (same trust model as npm install scripts); v2 will add sandboxing. See [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) and [security-model](../13-security/security-model.md) §6.

### plugin manifest
The `linuxify.plugin.json` file at the root of a plugin package, declaring the plugin's name, version, Linuxify compatibility range, provided capabilities (distros, runtimes, commands, hooks), and config schema. See [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) §3.

### plugin SDK
The TypeScript API surface Linuxify exposes to plugin authors: the `LinuxifyContext` object, the hook signatures (preInstall, postInstall, prePatch, postPatch, preRun, postRun, doctor, bootstrap, command), and the DistroProvider/RuntimeProvider interfaces. See [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) §7.

### proot
A ptrace-based syscall translator that fakes `chroot` without requiring root, by intercepting filesystem-related syscalls and redirecting them. Linuxify's chosen mechanism for running a Linux userland inside Termux. See [ADR-001](../20-adrs/adr-001-use-proot-over-chroot.md) and [security-model](../13-security/security-model.md) §15 (proot is NOT a security boundary).

### proot-distro
A wrapper around `proot` that handles rootfs download, unpack, and lifecycle management. The default and primary distro backend in Linuxify v1. See [distro-management](../05-bootstrap/distro-management.md).

### PR
Pull Request — the unit of contribution to Linuxify. PRs must pass CI (lint, unit tests, integration tests), pass review by at least one maintainer (two for changes to security-sensitive areas), and have DCO sign-off on every commit. See [contribution-guidelines](../16-community/contribution-guidelines.md).

### pty
Pseudo-terminal — a device that behaves like a terminal but is backed by a process pair rather than hardware. Linuxify allocates a pty when entering proot so that the managed CLI sees a real TTY (needed for tools like `vim`, `less`, and any CLI that detects TTY for color). See [launcher-architecture](../06-launcher/launcher-architecture.md) §9.

## R

### registry
The central (currently git-based) repository of package definitions, patches, and compat-db entries. Cloned to `~/.linuxify/registry/` on first run and updated by `linuxify update`. Signed with maintainer GPG keys; see [security-model](../13-security/security-model.md) §7. Future: HTTP registry (see [package-registry-future](../19-future/package-registry-future.md)).

### release channel
A subscription tier for Linuxify releases: `stable` (default, most-tested), `beta` (release candidates), `alpha` (bleeding edge). Selected via `linuxify config release.channel <name>`. See [release-pipeline](../14-cicd/release-pipeline.md).

### repair
The `linuxify repair` subcommand — the mutating counterpart to read-only `doctor`. Walks the most recent doctor results and, for each `fail` or `missing` with a `fix_command`, executes the fix (with user confirmation unless `--yes`). Each executed fix is logged to `~/.linuxify/logs/repair-<timestamp>.json`. Idempotent. See [doctor-engine](../07-doctor/doctor-engine.md) §6.

### rootfs
Root filesystem — the file tree of a Linux distribution, packaged as a tarball. Linuxify downloads a distro rootfs (e.g., Ubuntu 24.04 aarch64 minimal) in bootstrap Stage 2, unpacks it into `~/.linuxify/distros/<name>/` in Stage 3, and enters it via proot thereafter. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) Stage 2.

### runtime
A language runtime that a managed CLI depends on — Node.js, Python, Rust, Go, Bun, Deno. Linuxify installs runtimes *inside the proot distro* (not on the Termux host) so that ABI mismatches are impossible. Managed by the `RuntimeProvider` interface. See [runtime-management](../06-launcher/runtime-management.md).

### runtime provider
A TypeScript module implementing the `RuntimeProvider` interface (in `src/runtime/provider.ts`), which knows how to install, list, switch, and remove versions of a specific runtime (e.g., Node, Python) inside the proot distro. v1 ships providers for node, python, rust, go, bun, deno. See [runtime-management](../06-launcher/runtime-management.md) §2.

## S

### schema
A formal definition of the structure of a data file. Linuxify uses JSON Schema (draft 2020-12) for package definitions ([package-spec](../09-registry/package-spec.md) §1), the compat-db, and plugin manifests; TOML's implicit schema for `config.toml`; and an internal TypeScript type for `state.json`. All schemas are versioned.

### semver
Semantic Versioning — the `MAJOR.MINOR.PATCH` version-numbering convention. Linuxify follows semver for its own releases, for package definitions (via `schema_version`), for plugins (via the `linuxify` semver range in the plugin manifest), and expects managed CLIs to follow it. See [package-spec](../09-registry/package-spec.md) §12.

### snapshot
A point-in-time tarball of a distro's rootfs, stored under `~/.linuxify/backups/`. Used for fast rollback and disaster recovery. Auto-snapshots are taken before risky operations (`add`, `upgrade`, `patch`, `init --force`); manual snapshots are user-named. See [disaster-recovery](../22-operations/disaster-recovery.md) §3 and §10.

### stable channel
The default release channel, shipping the most-tested Linuxify builds. Stable releases have passed alpha, beta, and full CI. This is what most users run. See [release-pipeline](../14-cicd/release-pipeline.md).

### state.json
The machine-managed state file at `~/.linuxify/state.json`, recording: active distro, installed packages, runtime versions, patch fingerprints, last-bootstrap timestamp, plugin list. Never hand-edited; mutated only by Linuxify commands. Distinct from `config.toml` (human-edited preferences). See [system-architecture](../02-architecture/system-architecture.md) §4.

### STRIDE
Microsoft's threat-modeling framework — Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege. Linuxify's [threat-analysis](../13-security/threat-analysis.md) enumerates threats per STRIDE category. See [security-model](../13-security/security-model.md) §1.

### subgraph
A subset of a larger graph. In Linuxify, used in the context of the dependency graph (the subset of packages reachable from a given root) and the compat graph (the subset of (package, distro, arch, runtime) tuples that are known-good). See [compatibility-database](../11-compat-db/compatibility-database.md).

### subgraph plugin
A plugin that contributes a named subgraph to the compat-db or dependency graph — e.g., a "data-science" subgraph plugin that bundles Python, numpy, pandas, jupyter, and their known-good compat entries as a single installable unit. Future work; see [vision-extension](../19-future/vision-extension.md).

### symlink
A symbolic link — a filesystem entry that points to another path. Linuxify uses symlinks for the `linuxify` command itself (in `$PREFIX/bin/linuxify`) and for the Direct launcher variant. The Standard launcher is a shell script, not a symlink. See [ADR-004](../20-adrs/adr-004-shell-launchers-over-symlinks.md).

## T

### Tag (test)
A label applied to a [Vitest](#vitest) test to categorize it for selective execution — e.g., `@unit`, `@integration`, `@slow`, `@android-only`. Linuxify's CI runs `@unit` and `@integration` on every PR, `@slow` nightly, and `@android-only` on a physical-device farm. See [testing-strategy](../12-testing/testing-strategy.md) §3.

### Termux
The Android terminal emulator and Linux environment app that Linuxify runs on top of. Must be installed from F-Droid (not the Play Store). Provides `pkg`, `bash`, and the host filesystem Linuxify manages. See [termux-internals](../23-mobile/termux-internals.md).

### Termux:API
A companion Termux app that exposes Android system features (camera, SMS, location, notifications) to Termux shell scripts via `termux-*` commands. Linuxify does not require Termux:API, but some managed CLIs may use it. See [termux-internals](../23-mobile/termux-internals.md).

### Termux:Boot
A companion Termux app that runs scripts on device boot. Linuxify users can use it to auto-start long-running CLIs (e.g., a background aider-memory server) on boot. Optional. See [termux-internals](../23-mobile/termux-internals.md).

### TTY
Teletype — a terminal device. A CLI that detects a TTY (via `isatty()`) typically enables color and interactive prompts; a CLI run without a TTY (e.g., in CI) typically disables them. Linuxify allocates a pty so managed CLIs see a TTY. See [launcher-architecture](../06-launcher/launcher-architecture.md) §9.

## U

### Ubuntu
The default Linux distribution Linuxify installs (24.04 LTS, aarch64 minimal). Chosen for broad package availability, glibc, and familiarity. Other distros (Debian, Arch, Alpine) are pluggable alternatives. See [distro-management](../05-bootstrap/distro-management.md) §3.

### update
The `linuxify update` subcommand — refreshes the local registry clone (pulls new package definitions, patches, compat-db entries) without upgrading installed packages. Distinct from `upgrade` (which actually upgrades installed packages) and `self-update` (which upgrades Linuxify itself). See [cli-specification](../03-cli/cli-specification.md) §4.

### upgrade
The `linuxify upgrade [<pkg>]` subcommand — upgrades a specific package or all installed packages to the latest version recorded in the registry. May re-apply patches. Distinct from `update` (refreshes registry metadata) and `self-update` (upgrades Linuxify itself). See [cli-specification](../03-cli/cli-specification.md) §4.

### UserLAnd
An Android app that installs a Linux distro via proot or chroot, with a GUI front-end. A partial competitor to Linuxify; differs in that it targets GUI desktop use, while Linuxify targets CLI-first developer tools. See [executive-summary](../00-executive/executive-summary.md) §6 for the competitive landscape.

## V

### v1
The first major version of Linuxify — the initial release that ships the 7 subsystems (bootstrap, distro, runtime, packages, doctor, patcher, launcher), supports Ubuntu/Debian/Arch/Alpine, and targets Android 9+ aarch64. Currently in alpha. See [release-roadmap](../15-roadmap/release-roadmap.md).

### v2
The second major version — future work. Anticipated to add: cloud sync, HTTP package registry, plugin sandboxing (worker_threads/seccomp/landlock), package signing (re-verify upstream sigs), capability-based plugins. See [vision-extension](../19-future/vision-extension.md) and [cloud-sync](../19-future/cloud-sync.md).

### verify
The act of checking that a patch was applied correctly — either by re-running the `find` pattern and confirming it no longer matches (proving the patch took effect) or by running an explicit `verify:` command in the patch YAML. Mandatory per the patch schema. Failure raises `E_PATCH_VERIFY_FAILED`. See [patcher-engine](../08-patcher/patcher-engine.md) §6.

### vitest
The test framework Linuxify uses for unit and integration tests — chosen for native ESM, native TypeScript, Jest-compatible ergonomics, and first-class snapshot/property testing. See [testing-strategy](../12-testing/testing-strategy.md) §3.

## W

### workflow
A GitHub Actions workflow file (in `.github/workflows/`) defining a CI/CD pipeline. Linuxify's workflows include `ci.yml` (PR checks), `nightly.yml` (compat matrix), `release.yml` (publishing), and `security.yml` (dependency scanning). See [cicd-design](../14-cicd/cicd-design.md).

## X

### x86_64
The 64-bit x86 instruction set (also called AMD64 or Intel 64). A secondary architecture for Linuxify — relevant for Chromebooks running Android, Android-x86, and emulators. Most Android devices are `aarch64`, so `x86_64` is a smaller test surface. See [arm-considerations](../23-mobile/arm-considerations.md).

## Y

### YAML
YAML Ain't Markup Language — the human-readable data serialization format Linuxify uses for package definitions. Chosen over JSON and TOML per [ADR-002](../20-adrs/adr-002-yaml-package-definitions.md). See [package-spec](../09-registry/package-spec.md) §1.

### yank
To remove a package or patch from the registry in response to a security issue or critical bug. A yanked package is marked `withdrawn: true` in the registry, which causes all clients to refuse to install or update it; existing installs remain but `linuxify doctor` warns. See [security-model](../13-security/security-model.md) §13 and [disaster-recovery](../22-operations/disaster-recovery.md) §9.

## Z

### zram
A Linux kernel module that creates a compressed block device in RAM, used as swap. Android uses zram heavily to extend limited phone RAM. Linuxify does not configure zram (it is a kernel-level feature outside user-space control), but its presence affects available memory for proot workloads. See [arm-considerations](../23-mobile/arm-considerations.md).
