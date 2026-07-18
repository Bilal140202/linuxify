# Linuxify — Component Diagrams

> **Document status**: v1.0 draft · **Owner**: Linuxify core team
> Related: [System Architecture](./system-architecture.md) · [PRD](../01-product/prd.md) · [Package Spec](../09-registry/package-spec.md)

This document is a tour of Linuxify through C4-model diagrams (Context, Container, Component), supplemented with a class diagram for the package schema, three sequence diagrams covering the most important flows, and a deployment diagram showing where everything lives physically. Each diagram is paired with 100–200 words of prose explaining what it shows and why it matters. Together they form a visual index into the architecture: a contributor who reads only this file should come away with a working mental model of the system.

The diagrams use [Mermaid](https://mermaid.js.in/) syntax so they render inline on GitHub and in any Markdown viewer that supports it. Where a diagram duplicates information from [system-architecture.md](./system-architecture.md), the prose here focuses on the *relationships* and *boundaries* rather than re-explaining internals.

---

## 1. C4 Level 1 — System Context

```mermaid
flowchart LR
    User([Developer<br/>on Android])
    AndroidOS[Android OS<br/>kernel + SELinux]
    Termux[Termux App<br/>F-Droid build]
    Linuxify((Linuxify<br/>CLI))
    GitHub[(GitHub<br/>linuxify/packages)]
    Internet((Internet<br/>rootfs + runtime<br/>tarballs))

    User -->|runs commands| Termux
    Termux -->|runs on| AndroidOS
    Termux -->|hosts| Linuxify
    Linuxify -->|fetches package<br/>YAMLs| GitHub
    Linuxify -->|downloads rootfs,<br/>Node, Python| Internet
    Linuxify -->|uses proot| Termux
```

This is the highest-level view of Linuxify. The **developer** (a human or, increasingly, an AI coding agent driving a Termux session) interacts only with the Termux shell; they never touch Android directly. Termux is the host application — it provides the shell, the `pkg` package manager, and the F-Droid-mandated userland that Linuxify builds on. Linuxify itself is a CLI that runs *inside* Termux (technically inside a proot Ubuntu that lives inside Termux). Two external systems are reachable from Linuxify: GitHub (the source of package YAMLs in v1, until a dedicated registry ships) and the open Internet (the source of rootfs tarballs, Node binaries, Python tarballs, and npm packages). The diagram intentionally omits the future cloud-registry and cloud-sync components; those are v1.1+ and would appear as additional external systems.

---

## 2. C4 Level 2 — Container

```mermaid
flowchart TB
    subgraph TermuxApp["Termux app"]
        Shell[Termux bash shell]
        LinuxifyCLI[Linuxify CLI Core<br/>TypeScript/Node]
        Launchers[Launchers<br/>~/.linuxify/bin/*.sh]
        Config[Config Store<br/>~/.linuxify/*.toml<br/>~/.linuxify/*.json]
        Cache[Package Cache<br/>~/.linuxify/cache/]
        Plugins[Plugins<br/>~/.linuxify/plugins/]
    end

    subgraph ProotUbuntu["proot Ubuntu userland"]
        DistroImg[Distro Image<br/>~/.linuxify/distros/ubuntu/rootfs]
        RuntimeMgr[Runtime Manager<br/>node, python, git]
        InstalledCLIs[Installed CLIs<br/>cline, aider, codex, ...]
    end

    subgraph Engines["Linuxify Engines"]
        Doctor[Doctor Engine]
        Patcher[Patcher Engine]
    end

    Shell -->|invokes| Launchers
    Launchers -->|exec into| ProotUbuntu
    Shell -->|invokes| LinuxifyCLI
    LinuxifyCLI --> Config
    LinuxifyCLI --> Cache
    LinuxifyCLI --> Plugins
    LinuxifyCLI -->|manages| DistroImg
    LinuxifyCLI -->|manages| RuntimeMgr
    LinuxifyCLI -->|manages| InstalledCLIs
    LinuxifyCLI -->|drives| Doctor
    LinuxifyCLI -->|drives| Patcher
    Doctor -->|reads| Config
    Patcher -->|writes to| InstalledCLIs
    RuntimeMgr -->|installs into| ProotUbuntu
```

At the Container level we see the major deployable units. Two physical containers exist: the **Termux app** (an Android process) and the **proot Ubuntu userland** (a directory tree emulated via proot inside Termux). The Linuxify CLI Core, Config Store, Package Cache, Plugins, and Launchers all live in the Termux layer — they are files on the Android filesystem. The Distro Image, Runtime Manager state, and Installed CLIs live inside the proot rootfs, accessed only via proot invocations. The Doctor and Patcher Engines are *logical* containers: they are TypeScript modules that run inside the CLI Core process but have distinct responsibilities and distinct I/O profiles. The arrows show that everything flows through the CLI Core — no container talks directly to another; this keeps the dependency graph a star, not a web.

---

## 3. C4 Level 3 — Component (Linuxify CLI Core)

```mermaid
flowchart TB
    subgraph CLI["Linuxify CLI Core (TypeScript)"]
        Router[Command Router<br/>arg parse + dispatch]
        Config[Config Service<br/>TOML read/write]
        Telemetry[Telemetry Service<br/>opt-in events]
        Bootstrap[Bootstrap Manager]
        Distro[Distro Manager]
        Runtime[Runtime Manager]
        Packages[Package Manager]
        DoctorC[Doctor]
        PatcherC[Patcher]
        Launcher[Launcher Generator]
        Lock[Lock Service<br/>flock wrapper]
    end

    Router --> Bootstrap
    Router --> Distro
    Router --> Runtime
    Router --> Packages
    Router --> DoctorC
    Router --> PatcherC
    Router --> Launcher
    Router --> Config
    Router --> Telemetry
    Bootstrap --> Distro
    Bootstrap --> Runtime
    Packages --> Distro
    Packages --> Runtime
    Packages --> PatcherC
    Packages --> Launcher
    Packages --> DoctorC
    DoctorC --> Distro
    DoctorC --> Runtime
    DoctorC --> Packages
    PatcherC --> Distro
    Launcher --> Distro
    Bootstrap --> Lock
    Packages --> Lock
    Distro --> Lock
```

This diagram zooms into the Linuxify CLI Core itself. The **Command Router** is the single entry point: it parses argv, loads config, applies global flags (`--yes`, `--json`, `--no-color`, `--debug`), and dispatches to one of seven subsystem commands or to the Config/Telemetry services. Each subsystem is a Component with a clear public API (see [§2 of system-architecture.md](./system-architecture.md#2-component-breakdown)). The **Config Service** and **Telemetry Service** are cross-cutting: every component may read config and emit telemetry events, but only the Config Service writes to `config.toml`. The **Lock Service** is a thin wrapper around `flock` used by every state-mutating component. Notice that the Doctor depends on most other components (because it inspects the whole system), while the Launcher depends only on Distro (because it needs to know how to invoke proot) — this asymmetry is deliberate and keeps the Launcher trivially testable.

---

## 4. Package Definition Schema (Class Diagram)

```mermaid
classDiagram
    class PackageDefinition {
        +string name
        +string version
        +string runtime
        +string runtime_min_version
        +string package
        +string launcher
        +string description
        +string homepage
        +string license
        +InstallStep[] install
        +Patch[] patches
        +Record~string,string~ env
        +Compat compat
        +DoctorCheck[] doctor
    }
    class InstallStep {
        <<union>>
        shell_command
        npm_install
        pip_install
    }
    class Patch {
        +string file
        +string find
        +string replace
        +PatchKind kind
        +bool optional
    }
    class PatchKind {
        <<enumeration>>
        regex
        ast
    }
    class Compat {
        +string min_linuxify
        +Distro[] tested_distros
        +string[] known_issues
    }
    class Distro {
        <<enumeration>>
        ubuntu
        debian
        arch
        alpine
    }
    class DoctorCheck {
        +string check
        +int min
        +string binary
        +string message
    }
    PackageDefinition --> InstallStep
    PackageDefinition --> Patch
    PackageDefinition --> Compat
    PackageDefinition --> DoctorCheck
    Patch --> PatchKind
    Compat --> Distro
```

This is the parsed object model that the Package Manager produces from a `packages/<name>.yml` file. The schema is the contract between package authors (who write YAML) and Linuxify internals (which consume the parsed object). `InstallStep` is a discriminated union: a step is either a raw shell command (run inside proot), a typed `npm install -g <pkg>`, or a typed `pip install <pkg>`; the typed forms enable richer telemetry and failure reporting. `PatchKind` is an open enumeration — plugins can add new kinds (e.g., `sed-script`). `Compat.tested_distros` lets a maintainer declare which distros they have actually verified; `linuxify add` will warn (but not block) if the active distro is untested. The full YAML-to-object mapping is specified in [package-spec.md](../09-registry/package-spec.md).

---

## 5. Sequence — `linuxify add` (Happy Path with Patch Application)

```mermaid
sequenceDiagram
    actor U as User
    participant CLI as CLI Router
    participant PM as Package Manager
    participant DM as Distro Manager
    participant RT as Runtime Manager
    participant P as Patcher
    participant L as Launcher Gen
    participant D as Doctor
    participant M as Manifest
    participant T as Telemetry

    U->>CLI: linuxify add cline
    CLI->>PM: add("cline", {})
    PM->>M: acquire lock
    PM->>PM: resolve cline.yml
    PM->>RT: verify node >= 20
    RT-->>PM: ok (v24.18)
    PM->>DM: enter(ubuntu)
    DM-->>PM: proot session
    PM->>DM: run("npm install -g cline@1.2.0")
    DM-->>PM: exit 0
    PM->>P: apply(cline, [patch1, patch2])
    P->>P: verify patch1.find matches
    P->>P: replace + verify find no longer matches
    P->>P: record reverse patch
    P->>P: verify patch2.find matches
    P->>P: replace + verify
    P->>P: record reverse patch
    P-->>PM: 2 patches applied
    PM->>L: create(cline, spec)
    L->>L: render template.sh
    L->>L: write ~/.linuxify/bin/cline + chmod +x
    L-->>PM: ok
    PM->>M: insert {name, version, patches, ts}
    PM->>D: run(cline.checks)
    D-->>PM: all ok
    PM->>T: emit install event
    PM->>M: release lock
    PM-->>CLI: success
    CLI-->>U: "Added cline v1.2.0"
```

This is the canonical happy path for `linuxify add`. Five subsystems cooperate (PM, DM, RT, P, L) plus the Doctor for post-install verification and Telemetry for the install event. Note the **patch verification loop**: before each patch the Patcher confirms the `find` pattern is still present (idempotence check), and after each patch it confirms the `find` pattern no longer matches (correctness check). If either check fails, the patch is rolled back and the install aborts. The manifest entry is written *after* the launcher exists but *before* the post-install doctor runs — this ordering means a doctor failure during install leaves the manifest in a `needs_repair` state, not an inconsistent one.

---

## 6. Sequence — `linuxify doctor` (Parallel Check Execution)

```mermaid
sequenceDiagram
    actor U as User
    participant CLI as CLI Router
    participant DE as Doctor Engine
    participant POOL as Worker Pool (≤8)
    participant M as Manifest
    participant DM as Distro Manager
    participant RT as Runtime Manager

    U->>CLI: linuxify doctor
    CLI->>DE: run({filter: all})
    DE->>M: list installed packages
    M-->>DE: [cline, aider, codex]
    DE->>DE: build check list
    par parallel environment checks
        DE->>POOL: check storage
        DE->>POOL: check termux
        DE->>POOL: check proot
        DE->>POOL: check distro
        DE->>POOL: check PATH
    end
    par parallel runtime checks
        DE->>POOL: check node (via DM)
        DE->>POOL: check python (via DM)
        DE->>POOL: check git (via DM)
    end
    POOL-->>DE: results (env)
    POOL-->>DE: results (runtime)
    par parallel per-package checks
        DE->>POOL: cline.doctor (via RT)
        DE->>POOL: aider.doctor (via RT)
        DE->>POOL: codex.doctor (via RT)
    end
    POOL-->>DE: results (packages)
    DE->>DE: aggregate + compute worst
    DE->>DE: render table or JSON
    DE-->>CLI: results + exit code
    CLI-->>U: doctor report
```

The Doctor Engine runs checks in three parallel waves, each wave scoped to a category: environment (host-side), runtime (inside proot), per-package (also inside proot). The worker pool is capped at 8 concurrent proot spawns to avoid hammering the device — proot is not free, and 10 parallel proot sessions on a mid-range phone will OOM. The waves are sequential (env → runtime → packages) so that a fundamental env failure (e.g., no proot) short-circuits and skips the more expensive runtime and package waves. Results are aggregated by worst-status, and the rendered table is independent of the execution order — the same check list always produces the same output rows in the same order, regardless of which parallel worker finished first.

---

## 7. Sequence — `linuxify repair` (Auto-Remediation Flow)

```mermaid
sequenceDiagram
    actor U as User
    participant CLI as CLI Router
    participant DE as Doctor Engine
    participant RP as Repair Planner
    participant PM as Package Manager
    participant P as Patcher
    participant L as Launcher Gen
    participant RT as Runtime Manager

    U->>CLI: linuxify repair
    CLI->>DE: run({filter: all})
    DE-->>CLI: results (2 fail, 1 warn)
    CLI->>RP: planRepair(results)
    RP->>RP: classify each fix<br/>safe vs unsafe
    RP-->>CLI: plan (3 safe, 1 unsafe)
    CLI->>CLI: apply safe fixes
    par safe fixes
        CLI->>P: re-apply missing cline patch
        CLI->>L: regenerate aider launcher
        CLI->>RT: bump node to v22
    end
    CLI->>U: prompt: apply unsafe fix<br/>"delete stale ~/.linuxify/cache"?
    U->>CLI: yes
    CLI->>CLI: apply unsafe fix
    CLI->>DE: run({filter: all})
    DE-->>CLI: results (0 fail, 0 warn)
    CLI->>CLI: render before/after diff
    CLI-->>U: "3 fixes applied, all green"
```

`linuxify repair` is `doctor` plus a remediation planner. The Doctor runs first; the Repair Planner turns each `fail`/`warn` into a fix object tagged `safe: true` (auto-applied) or `safe: false` (prompted). Safe fixes include re-applying missing patches, regenerating stale launchers, and bumping runtime versions to the latest patch release. Unsafe fixes include deleting cache directories, switching the active distro, or reinstalling a package from scratch — these need user consent because they may have side effects the user cares about (e.g., a custom file in the cache directory). After applying fixes, the Doctor runs again to confirm; the final report shows a before/after diff so the user can verify the repair had the intended effect. With `--yes`, the unsafe-fix prompt is skipped and all fixes apply, which makes `linuxify repair --yes` safe for non-interactive CI.

---

## 8. Deployment Diagram

```mermaid
flowchart TB
    subgraph AndroidDevice["Android device (aarch64)"]
        subgraph DataPartition["/data partition"]
            subgraph TermuxPrefix["$PREFIX (Termux)"]
                TuxBin[bin/, lib/, share/]
            end
            subgraph LinuxifyHome["~/.linuxify/"]
                LhBin[bin/ — launchers]
                LhDistros[distros/ — rootfs images]
                LhConfig[config.toml, state.json,<br/>manifest.json, runtimes.json]
                LhCache[cache/ — downloads]
                LhLogs[logs/ — linuxify.log]
                LhPlugins[plugins/]
                LhPatches[patches/]
            end
            subgraph UserHome["~/ (user)"]
                Bashrc[.bashrc — managed PATH block]
            end
        end
        subgraph AndroidSys["Android system"]
            Kernel[Linux kernel + SELinux]
        end
    end

    subgraph Network["Network boundary"]
        GitHub[(GitHub<br/>packages repo)]
        CDN[(CDN<br/>rootfs + runtimes)]
        Registry[(Future:<br/>linuxify registry)]
    end

    Kernel --> TermuxPrefix
    TermuxPrefix --> LinuxifyHome
    LinuxifyHome --> UserHome
    LinuxifyHome -.->|HTTPS, only at bootstrap/add/upgrade| Network
```

This deployment view makes the physical layout and the network boundary explicit. Everything Linuxify needs at runtime lives on the Android device's `/data` partition, under either Termux's `$PREFIX` (the Termux app's own files) or `~/.linuxify/` (Linuxify's own files, inside the user's Termux home). The user's `~/.bashrc` is the only file Linuxify touches *outside* `~/.linuxify/`, and only to add an idempotent managed block — that block is the entire reason the user can type `cline` and have it resolve. The dotted line to the network boundary is the **offline-first** invariant (NFR-OFF-01): the only commands that cross that line are `init` (first time), `add`/`upgrade` (when fetching a new package or version), `search` (remote), and `self-update`. Everything else — `run`, `doctor`, `repair`, `list`, `info`, `config`, `env`, `shell` — works with the device in airplane mode. This property is what makes Linuxify usable on flights, on the metro, and on metered data plans; it is also what makes it safe to recommend to users like Ana (see [PRD §3.2](../01-product/prd.md)).
