# Distro Management

> **Audience**: AI coding agents implementing the pluggable distro backend, and human contributors adding or porting a distribution to Linuxify.
>
> **Scope**: This document covers the distro abstraction layer, the four built-in distros (Ubuntu, Debian, Arch, Alpine), the per-distro YAML manifest format, multi-distro support, switching, lifecycle, custom distros, snapshots, cross-distro compatibility, migration helpers, and storage cleanup. For the bootstrap pipeline that *installs* the default distro, see [bootstrap-design.md](bootstrap-design.md). For the launcher shim that *runs* commands inside a distro, see [../06-launcher/launcher-architecture.md](../06-launcher/launcher-architecture.md).

## 1. Distro Abstraction

Linuxify never calls `proot-distro` directly outside of the distro backend. Every interaction with a Linux distribution — installing it, starting it, running commands inside it, snapshotting its filesystem — goes through the `DistroProvider` interface defined in `distro/provider.ts`. This indirection is what lets Linuxify support not only the four built-in distros but also custom distros (see §7) without the rest of the codebase caring about the implementation.

The interface, in TypeScript:

```ts
export interface DistroProvider {
  readonly name: string;             // "ubuntu", "debian", "arch", "alpine", or custom
  readonly version: string;          // "24.04", "12", "rolling", "3.20"
  readonly packageManager: "apt" | "pacman" | "apk" | "dnf" | "custom";

  // Lifecycle
  install(opts: InstallOptions): Promise<InstallResult>;
  uninstall(opts: UninstallOptions): Promise<UninstallResult>;

  // Execution
  start(): Promise<void>;            // ensure the distro is "running" (no-op for proot)
  stop(): Promise<void>;             // for proot, kills any lingering processes
  exec(cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  shell(opts: ShellOptions): Promise<never>;  // interactive; never returns normally

  // Inspection
  info(): Promise<DistroInfo>;
  update(): Promise<UpdateResult>;   // apt-get upgrade, pacman -Syu, etc.

  // Backup
  snapshot(opts: SnapshotOptions): Promise<SnapshotRef>;
  restore(ref: SnapshotRef, opts: RestoreOptions): Promise<RestoreResult>;
}
```

Every method is async because every method crosses the proot boundary, which is a process spawn. The `ExecOptions` object carries the user identity (default `linuxify`), environment overrides, working directory, bind mounts, and a timeout. The `ExecResult` carries stdout, stderr, exit code, signal (if killed), and timing. There is no streaming variant on the interface itself — callers that need streaming (e.g. `linuxify run` for interactive CLIs) use `shell()` or pass a TTY file descriptor through `ExecOptions.tty`.

The provider is *stateless* in the sense that it does not hold open file descriptors or background processes between calls; all state lives on disk at `~/.linuxify/distros/<name>/` and `~/.linuxify/state.json`. This makes the provider safe to instantiate and discard per-command, which is how the CLI works.

## 2. Built-in Distros

Linuxify v1 ships with four distro backends. Each is implemented in `distro/providers/<name>.ts` and ships with a YAML manifest in `distro/manifests/<name>.yml`. The four backends share roughly 80% of their code via an `ProotDistroBase` class; the remaining 20% is the per-distro package-manager grammar and the rootfs-fetch logic.

### Ubuntu (default)

Ubuntu 24.04 LTS is the default and only fully-supported distro in v1. The rootfs is the official `ubuntu-base-24.04-base-arm64.tar.gz` from `cdimage.ubuntu.com`, ~80 MB compressed and ~300 MB extracted. Ubuntu is the default for three reasons: (1) it is the most widely-tested distro on aarch64 Android via proot, thanks to Termux's `proot-distro` shipping an Ubuntu profile out of the box; (2) the apt package universe is the largest of any Linux distro, which maximizes the chance that a CLI tool's native dependencies are installable without manual compilation; (3) the LTS release cadence (2 years) matches the expected lifetime of a Linuxify installation.

The Ubuntu provider uses `apt` for package management. The default user inside the proot is `linuxify` (UID 1000). The default runtime set is `[node, python, git]`. See [bootstrap-design.md](bootstrap-design.md) §2 Stage 4 for runtime installation details.

### Debian

Debian 12 (bookworm) is the second-most-tested distro. The rootfs is the official `debian-12-generic-arm64.tar.xz` from `deb.debian.org`, ~280 MB extracted. Debian is offered for users who prefer its stricter free-software policy (no snapd, no proprietary firmware in main), or who already run Debian on their other machines and want consistency. The provider uses `apt`; the experience is nearly identical to Ubuntu's. The main practical difference is that some packages are slightly older (e.g. `gcc` is 12.2 vs Ubuntu's 13.x), which matters for users who compile native modules against a specific glibc.

### Arch

Arch Linux ARM is the rolling-release option. The rootfs is the official `ArchLinuxARM-aarch64-latest.tar.gz` from `archlinuxarm.org`, ~250 MB extracted. The provider uses `pacman`. Arch appeals to users who want the newest versions of everything (kernel-of-the-week users, developers tracking bleeding-edge Rust, etc.). The trade-off is that Arch breaks more often: a `pacman -Syu` can leave the system in an unbootable state if a package update ships with a regression, and the Arch ARM port lags behind x86_64 Arch by days to weeks. Linuxify takes a snapshot before every `update()` call on Arch (see §8), so a broken update is recoverable, but users should expect to spend more time on maintenance.

### Alpine

Alpine 3.20 is the minimal-footprint option. The rootfs is the official `alpine-minirootfs-3.20.0-aarch64.tar.gz` from `dl-cdn.alpinelinux.org`, only ~8 MB compressed and ~80 MB extracted. The provider uses `apk`. Alpine is attractive for users with very limited storage (older 16 GB phones, primarily) and for users who want a quick-to-bootstrap dev environment.

The catch is musl libc. Alpine uses musl instead of glibc, and many pre-built Node native modules (better-sqlite3, sharp, canvas, bcrypt, node-canvas) assume glibc. Linuxify documents this caveat in the package manifest: every package YAML has a `compat.tested_distros` field, and packages known to break on Alpine (e.g. `aider` with `pyzmq`) carry a `compat.known_issues` entry that the doctor surfaces. Alpine users should expect to rebuild native modules from source (`apk add build-base python3` is required) or to fall back to glibc-based distros.

The cross-distro compatibility implications are detailed in §9.

## 3. Per-distro YAML Manifest

Each built-in (and custom — see §7) distro is described by a YAML manifest. The manifest is the single source of truth for the distro's identity, where to fetch its rootfs, how to install packages, and which runtimes Linuxify should install by default. The format:

```yaml
# distro/manifests/ubuntu.yml
name: ubuntu
version: "24.04"
display_name: "Ubuntu 24.04 LTS"
rootfs_url: https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04-base-arm64.tar.gz
rootfs_sha256: 9fb7d9f4e2c9c3b1a4e0c0e8e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3
rootfs_mirrors:
  - https://mirrors.tuna.tsinghua.edu.cn/ubuntu-base/releases/24.04/release/
  - https://mirror.nju.edu.cn/ubuntu-base/releases/24.04/release/
package_manager: apt
install_command: apt-get install -y
update_command: apt-get update && apt-get upgrade -y
remove_command: apt-get remove -y
search_command: apt-cache search
default_runtimes: [node, python, git]
default_user: linuxify
default_uid: 1000
min_storage_mb: 1500
notes: "Default distro. Best compatibility. Use this unless you have a specific reason not to."
compat:
  tested_arch: [aarch64, armv7l]
  known_issues: []
```

The schema is validated at Linuxify build time by `distro/schema.ts` (a Zod schema). At runtime, the manifest is loaded by `DistroRegistry.get(name)` and is the input to the bootstrap Stage 2 (rootfs fetch) and Stage 3 (first-boot) logic. Custom distros (§7) use the same schema; the only difference is that they are loaded from `~/.linuxify/distros/<name>/manifest.yml` instead of from the bundled manifests.

A few fields deserve explanation:

- `rootfs_sha256` is mandatory. Linuxify refuses to install a distro whose rootfs hash cannot be verified. For rolling distros (Arch), the hash field is updated weekly by the Linuxify release process; users on `linuxify self-update` get the new hash.
- `rootfs_mirrors` is a fallback list. The first URL is always tried first; subsequent URLs are tried in order on failure or hash mismatch. The `mirror` key in `config.toml` overrides this list with a single preferred URL.
- `default_runtimes` is what Stage 4 of bootstrap installs. The user can override this in `config.toml`'s `[bootstrap] runtimes = [...]` list.
- `min_storage_mb` is checked by Stage 0 preflight. If the device has less free space than this, bootstrap aborts before downloading anything.

## 4. Multi-distro Support

Linuxify does not force a single distro. Users can install multiple distros side-by-side at `~/.linuxify/distros/<name>/`, and Linuxify tracks which one is "active" via the `active_distro` field in `~/.linuxify/state.json`. Each distro has its own rootfs, its own installed packages, and its own runtime installations.

```
~/.linuxify/
├── distros/
│   ├── ubuntu/              # active
│   ├── debian/
│   └── arch/
├── runtimes/
│   ├── ubuntu/              # per-distro runtime installs
│   │   ├── node/22.11.0/
│   │   └── python/3.12.3/
│   ├── debian/
│   │   └── node/22.11.0/
│   └── arch/
│       └── node/22.13.0/    # Arch has newer Node
├── packages/                # per-distro package installs
│   ├── ubuntu/
│   │   ├── cline.json
│   │   └── codex.json
│   └── debian/
│       └── cline.json
└── state.json               # tracks active_distro, installed distros, etc.
```

The commands that interact with multi-distro support are:

- `linuxify distros list` — prints a table of installed distros with versions, sizes, and last-used timestamps. Marks the active one with `*`.
- `linuxify distros install <name>` — installs a distro without switching to it. Useful for setting up a side-by-side migration.
- `linuxify use <name>` — switches the active distro (see §5).
- `linuxify distros uninstall <name>` — removes a distro. Refuses if the distro is active; the user must switch first.
- `linuxify distros info <name>` — prints the manifest for a distro plus live stats (size, package count, runtime count).

Per-distro runtime installations are independent. Installing Node 22 in Ubuntu does not install it in Debian. This is intentional: runtime binaries are linked against the distro's libc, and mixing them across distros would cause exactly the kind of ABI mismatch that the per-distro layout is designed to prevent. The storage cost is real but bounded: a runtime is ~80 MB and most users install at most two distros, so the worst case is ~160 MB of duplicated Node binaries — acceptable for the correctness guarantee it buys.

## 5. Switching Distros

`linuxify use <name>` switches the active distro. The mechanics are simple: it updates `state.json`'s `active_distro` field and re-runs Stage 6 of bootstrap (PATH wiring) so that the `~/.linuxify/bin` symlinks point at the new distro's runtimes. It does not touch `~/.linuxify/packages/`.

The critical caveat — which Linuxify prints as a warning every time the user switches — is that **packages are not migrated**. If the user has `cline` installed in Ubuntu and switches to Debian, `cline` will not be available in Debian until they run `linuxify add cline` again (this time targeting Debian). The user is warned explicitly:

```
$ linuxify use debian
Switching active distro: ubuntu -> debian
⚠  Packages installed in 'ubuntu' are NOT available in 'debian'.
   Installed in ubuntu: cline, codex, aider
   To migrate, run: linuxify migrate ubuntu debian
   To install fresh, run: linuxify add cline
```

The reason for this asymmetry is that packages are not portable across distros. A Node module installed via npm in Ubuntu is linked against Ubuntu's glibc; running it in Alpine would fail at `require('better-sqlite3')` time. Even across glibc distros (Ubuntu ↔ Debian), npm's global install path differs slightly, and reinstalling is faster and safer than cross-linking. The migration helper (§10) does its best to automate reinstallation, but it is explicitly best-effort.

## 6. Distro Lifecycle

Each distro goes through a well-defined lifecycle. The state machine below shows the legal transitions:

```mermaid
stateDiagram-v2
    [*] --> NotInstalled
    NotInstalled --> Installing: linuxify distros install <name>
    Installing --> Installed: success
    Installing --> NotInstalled: failure (cleanup)
    Installed --> Active: linuxify use <name>
    Active --> Installed: linuxify use <other>
    Installed --> Updating: linuxify upgrade (per-distro)
    Active --> Updating: linuxify upgrade (per-distro)
    Updating --> Installed: success
    Updating --> Active: success (if was active)
    Updating --> SnapshotRestoring: failure (auto-rollback)
    Installed --> Snapshotted: linuxify snapshot
    Active --> Snapshotted: linuxify snapshot
    Snapshotted --> Installed: (continue using)
    Snapshotted --> SnapshotRestoring: linuxify restore <ref>
    SnapshotRestoring --> Installed: success
    SnapshotRestoring --> Active: success (if was active)
    Installed --> Uninstalling: linuxify distros uninstall <name>
    Uninstalling --> NotInstalled: success
    NotInstalled --> [*]
```

Key invariants enforced by the provider:

- A distro in the `Installing` or `Uninstalling` state cannot be operated on by any other command. The state is tracked in `state.json` and protected by a file lock.
- A distro in the `Updating` state automatically snapshots before the update begins. If the update fails, the provider auto-restores the snapshot. This is the only auto-restore path; all other restores are explicit.
- The `Active` state is mutually exclusive: exactly one distro is active at any time. Switching is atomic (the `active_distro` field is updated only after the new distro's Stage 6 PATH wiring succeeds).
- The `Uninstalling` state is refused if the distro is `Active`. The user must first `linuxify use <other>`.

## 7. Custom Distros

A custom distro is any distro not in the built-in list. The most common custom distros in practice are:

- **Fedora** (via the Fedora ARM port) for users who want dnf.
- **Kali Linux** (Kali Rolling ARM) for security researchers.
- **NixOS** (experimental) for users who want declarative package management.
- **Custom minimal rootfs** built by the user with `debootstrap` or `alpine-make-rootfs`.

A custom distro is registered by dropping a YAML manifest at `~/.linuxify/distros/<name>/manifest.yml` and running `linuxify distros install <name>`. The manifest schema is identical to the built-in one (§3), with one additional field:

```yaml
name: fedora
version: "40"
display_name: "Fedora 40 (aarch64)"
rootfs_url: https://download.fedoraproject.org/pub/fedora/linux/releases/40/Container/aarch64/images/Fedora-Container-Base-40-1.10.aarch64.tar.xz
rootfs_sha256: ...
package_manager: dnf
install_command: dnf install -y
update_command: dnf upgrade -y
default_runtimes: [node, python, git]
default_user: linuxify
default_uid: 1000
min_storage_mb: 1800
notes: "Custom distro. Install with: linuxify distros install fedora"
trust: user-confirmed     # required for custom distros
```

The `trust: user-confirmed` field is mandatory for custom distros. When the user runs `linuxify distros install fedora` for the first time, Linuxify prints a trust prompt:

```
$ linuxify distros install fedora
You are about to install a custom distro:
  Name:           fedora
  Version:        40
  Rootfs URL:     https://download.fedoraproject.org/...
  Rootfs SHA-256: 9fb7d9f4...
  Package manager: dnf

Custom distros are not audited by Linuxify. A malicious rootfs could
contain anything. Verify the URL and hash yourself before proceeding.

Type 'yes' to continue: 
```

This explicit opt-in is the trust model. Linuxify does notarize built-in distros' manifests with the release key (verified at load time); custom distros are entirely the user's responsibility. The schema validation still runs (so a malformed manifest is rejected), but the trust decision is the user's.

## 8. Distro Snapshots

A snapshot is a tarball of the entire distro rootfs at a point in time, plus a small metadata sidecar. Snapshots are created with `linuxify snapshot [name]` (default name is a timestamp) and stored at `~/.linuxify/snapshots/<distro>/<name>/`:

```
~/.linuxify/snapshots/
└── ubuntu/
    ├── 2025-07-14T10-43-00/
    │   ├── rootfs.tar.gz       # ~300 MB for Ubuntu
    │   ├── meta.json           # { distro, version, created_at, size, parent }
    │   └── manifest.yml        # the distro manifest at snapshot time
    └── pre-cline-install/
        ├── rootfs.tar.gz
        └── meta.json
```

Snapshots are created with `tar` running inside a `proot-distro login` invocation, which produces a faithful copy of the filesystem including all symlinks, device nodes (proot fakes these), and ownership. The tarball is gzip-compressed; rsync-style delta snapshots are a v2 goal.

Restoring a snapshot is `linuxify restore <name>`:

```sh
$ linuxify restore pre-cline-install
This will replace the current 'ubuntu' rootfs with the snapshot.
Any packages installed since 2025-07-14T10:43:00 will be lost.
Type 'yes' to continue: yes
Stopping any running proot processes...
Backing up current rootfs to a temporary snapshot (auto-rollback)...
Extracting snapshot to ~/.linuxify/distros/ubuntu/...
Updating state.json...
Done. Active distro: ubuntu (snapshot: pre-cline-install, 2025-07-14T10:43:00)
```

Use cases for snapshots:

- **Pre-experiment checkpoint**: before installing an unfamiliar package that might pull conflicting dependencies, snapshot. If the install breaks the distro, restore.
- **Disaster recovery**: if a `pacman -Syu` on Arch breaks the system, restore the pre-update snapshot.
- **Reproducible environments**: a user can snapshot a working environment and share the tarball with a collaborator, who restores it on their own device. (Collaborator must trust the snapshot author — same trust model as custom distros.)
- **CI hermeticity**: the test harness snapshots a known-good distro and restores it between test runs, achieving test isolation without re-bootstrapping.

## 9. Cross-distro Compatibility Notes

The four built-in distros are not interchangeable. The compatibility matrix below summarizes the major axes; package authors should consult this when filling out a package YAML's `compat.tested_distros` and `compat.known_issues` fields.

| Concern | Ubuntu / Debian | Arch | Alpine |
|---|---|---|---|
| libc | glibc 2.39 / 2.36 | glibc 2.40 | musl 1.2.5 |
| Default shell | bash 5.x | bash 5.x | busybox ash |
| ARM hard-float ABI | arm64 (aarch64) | arm64 (aarch64) | arm64 (aarch64) |
| `/lib64/ld-linux-aarch64.so.1` | present | present | **absent** (musl uses `/lib/ld-musl-aarch64.so.1`) |
| FHS compliance | full | full | partial (no `/usr/share/doc` by default) |
| `process.platform === "linux"` | true | true | true |
| Node native modules (better-sqlite3, sharp, canvas) | work | work | **fail** unless rebuilt from source |
| Binary-only CLIs built against glibc (e.g. some GitHub Releases) | work | work | **fail** |
| Default `apt`/`pacman`/`apk` cache size | ~150 MB | ~80 MB | ~30 MB |

The headline issue is glibc-vs-musl. Any CLI shipped as a pre-built binary against glibc will refuse to run on Alpine with `not found` (the kernel's confusing error when the dynamic linker is missing). Linuxify's launcher (see [../06-launcher/launcher-architecture.md](../06-launcher/launcher-architecture.md) §3) does not currently detect this; the user sees the kernel error and must diagnose it themselves. The doctor's `binary_compat` check (see [../07-doctor/diagnostics.md](../07-doctor/diagnostics.md)) does detect it post-install and suggests `linuxify use ubuntu` as a workaround.

The ARM hard-float ABI is consistent across all four (they all target `arm64`/`aarch64` with VFP), so a binary built for `aarch64-linux-gnu` works on Ubuntu, Debian, and Arch. It does not work on Alpine without a glibc-compat layer, which Linuxify does not install by default.

Pure-JavaScript CLIs (Cline, Codex, Aider in pure-Python mode) work on all four distros. The compatibility database tracks known per-distro issues and is documented in [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md).

## 10. Migration Helpers

`linuxify migrate <from> <to>` is the best-effort migration helper. It does not literally copy packages from one distro to another (that does not work — see §5); instead, it reads the source distro's installed-package list and re-runs the equivalent `linuxify add` commands in the target distro.

```sh
$ linuxify migrate ubuntu debian
Reading package list from ubuntu...
Found 3 packages: cline, codex, aider
Switching active distro to debian (temporarily for migration)...
Installing cline in debian...      ✓
Installing codex in debian...      ✓
Installing aider in debian...      ✗ (known issue: pyzmq needs rebuild)
  aider is marked as known-incompatible with debian in v1.
  Skipping. Install manually if needed: linuxify add aider --force
Restoring active distro to ubuntu.
Migration complete: 2/3 packages migrated.
```

Limitations, which the helper prints explicitly:

- It does not migrate user data (npm global config, `~/.npmrc`, `~/.gitconfig`, etc.). The user must copy these manually.
- It does not migrate runtime versions. If the user had Node 22.11.0 in Ubuntu and Debian's apt has Node 22.13.0, the migration installs the new version.
- It does not migrate packages that the package YAML marks as incompatible with the target distro (`compat.tested_distros` does not include the target).
- It does not delete packages from the source distro. The user can `linuxify distros uninstall ubuntu` after confirming everything works in Debian.

The helper is intentionally conservative. It is a convenience for the common case (user tries Debian, decides to switch), not a guarantee. For complex migrations, users are better off documenting their installed packages and reinstalling them by hand.

## 11. Storage Cleanup

Over time, `~/.linuxify/` accumulates cruft: old snapshots, apt caches, retired distros, leftover runtime versions. `linuxify distros prune` reclaims space by removing:

- **Unused distros**: distros in `state.json` that the user has marked as `retired` via `linuxify distros retire <name>`. (Retiring is a soft uninstall: the distro is hidden from `linuxify distros list` but the rootfs is kept until `prune` runs.)
- **Package manager caches**: `apt-get clean` inside every distro, `pacman -Sc` on Arch, `apk cache clean` on Alpine. Reclaims 30–200 MB per distro.
- **Old snapshots**: snapshots older than the configured retention (default 30 days, configurable in `config.toml`'s `[storage] snapshot_retention_days`). The user can pin a snapshot with `linuxify snapshot pin <name>` to exempt it from pruning.
- **Orphaned runtime versions**: runtime versions not referenced by any installed package and not set as the default. Linuxify lists them with `linuxify runtimes list --orphans` and prompts for confirmation before removing.

`linuxify distros prune --dry-run` shows what would be removed without actually removing it. The output is a table with the path, size, and reason for removal. After confirmation, the prune runs and prints a summary:

```
$ linuxify distros prune
Pruning:
  ✔ ~/.linuxify/distros/arch/var/cache/pacman/pkg/*         (140 MB, pacman cache)
  ✔ ~/.linuxify/distros/ubuntu/var/cache/apt/archives/*.deb (90 MB, apt cache)
  ✔ ~/.linuxify/snapshots/ubuntu/2025-06-01T08-00-00/       (310 MB, > 30 days old)
  ✔ ~/.linuxify/runtimes/ubuntu/node/20.18.0/               (90 MB, orphaned runtime)
Total reclaimed: 630 MB
```

Prune never removes the active distro, never removes the active runtime, and never removes pinned snapshots. It is safe to run as often as the user likes; a `cron`-equivalent entry can be added via `linuxify config storage.auto_prune true` (checked once a day by the CLI on any invocation).
