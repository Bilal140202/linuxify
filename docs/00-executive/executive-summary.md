# Executive Summary

> A 1,200-to-1,800 word briefing for stakeholders, potential contributors, and AI coding agents who need to understand Linuxify in five minutes. Read this before reading the [vision document](vision.md) or the [system architecture](../02-architecture/system-architecture.md).

## The problem

The most exciting developer tooling of the last two years — AI coding agents like Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, and Freebuff — is built for Linux desktops and macOS. It assumes `process.platform === "linux"`, glibc, an x86_64 host, and the presence of desktop environment variables. None of these hold on Android, even though Android is now the most-shipped general-purpose operating system on Earth and the only computer in the pockets of several billion people.

Today, a developer who wants to run Cline on Android has to perform a nine-step ritual: install Termux, install `proot`, install Ubuntu, install Node, fix `PATH`, discover that `process.platform === "android"` (not `"linux"`), patch the Cline source, and only then begin to use the tool. The next tool — say, Codex — requires the same ritual repeated from scratch. Each tool fails in *similar* ways (`process.arch === "x64"` checks, glibc detection, hardcoded `x86_64` paths) and each requires its own bespoke patch. The pain is **systemic**, not tool-specific.

The cost is not just time. It is opportunity. A road-warrior engineer with an Android phone cannot pair-program with an AI agent during a flight. A student in a developing economy whose only computer is a used Android phone cannot run modern dev tooling at all. The Android developer platform — vast, capable, ubiquitous — is locked out of the AI coding revolution by a thousand small incompatibilities that nobody has yet packaged into a single fix.

## The solution

**Linuxify** is an open-source compatibility layer, package manager, and diagnostic engine that collapses the entire ritual into three commands:

```bash
pkg install linuxify        # install the CLI
linuxify init               # bootstrap Ubuntu + runtimes + PATH (idempotent)
linuxify add cline          # install + patch + launcher
cline                       # runs directly from the Termux shell
```

Linuxify is *not* "another Termux script." It is a first-class developer tool, verb-like in the spirit of `git`, `npm`, and `cargo`. It is composed of eight cooperating subsystems:

```text
linuxify/
├── bootstrap/      # One-shot environment bring-up (Termux + proot + Ubuntu + runtimes)
├── distro/         # Pluggable distro backends: ubuntu, debian, arch, alpine
├── runtime/        # Pluggable runtime managers: node, python, rust, go, bun, deno
├── packages/       # Tool definitions: cline.yml, codex.yml, aider.yml, etc.
├── doctor/         # Health checks, environment diagnostics, auto-repair
├── patcher/        # Detect platform-specific code in CLI tools and apply known fixes
├── launcher/       # Generate native Termux shims that enter proot + run the tool
└── registry/       # (Future) central package registry, versioning, signing
```

Each tool is described by a versioned YAML file — install steps, patches, env, doctor checks, compat metadata. The patcher applies known fixes (AST-aware for JS/TS, regex fallback otherwise) so that `process.platform === "linux"` checks, `process.arch === "x64"` checks, and similar gates are rewritten to admit Android. The doctor runs a declarative checklist against the environment and surfaces repair hints. The launcher generates native Termux shims so that installed tools — `cline`, `codex`, `aider` — are callable directly from the shell, with no wrapper-script tax.

## The market gap

There is no incumbent solving this problem. The existing Android-on-Linux tools — `proot-distro`, UserLAnd, Andronix — all stop at "give you a Linux environment." None of them take responsibility for what happens *after* you have a Linux environment: installing AI agents, patching them for ARM/Android, generating launchers, diagnosing failures, and keeping everything updated. They are distro installers; Linuxify is a developer-tool package manager that *uses* a distro installer as one of its pluggable backends.

The gap is even sharper when you look at the AI coding ecosystem specifically. Each new agent (Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, Freebuff) ships with desktop-only assumptions. Each requires a fresh round of "how do I make this run on Android" forum threads, GitHub issues, and patch experiments. Linuxify turns that round into a single YAML contribution — `packages/<tool>.yml` — that benefits every Linuxify user forever after.

## Architecture in one paragraph

Linuxify is structured as a layered system. The **bootstrap** layer brings up Termux + proot + Ubuntu + runtimes exactly once and idempotently. The **distro** and **runtime** layers are pluggable backends (Ubuntu/Debian/Arch/Alpine on one axis; Node/Python/Rust/Go/Bun/Deno on the other). The **packages** layer holds declarative YAML tool definitions. The **patcher** layer applies known compatibility fixes to tool sources. The **launcher** layer generates native Termux shims that exec into the proot environment on every invocation. The **doctor** layer continuously verifies the environment and can auto-repair common failures. The (future) **registry** layer will provide a central, signed, versioned source of package definitions. Full design lives in [`02-architecture/system-architecture.md`](../02-architecture/system-architecture.md).

## Current status

Linuxify is **alpha / pre-release** as of v0.1.0. The design documented in this repository is complete enough for an AI coding agent or human contributor to begin implementation, but no production-ready code has shipped yet. What exists today:

- A complete documentation set (this repo) covering executive briefing, product, architecture, CLI spec, every subsystem, ADRs, and forward-looking vision.
- A target repository layout (see [`README.md`](../../README.md) §Project structure) and a target command surface (see [`03-cli/cli-specification.md`](../03-cli/cli-specification.md)).
- A package definition format (see [`09-registry/package-spec.md`](../09-registry/package-spec.md)) ready for community contributions.
- A CI/CD design ([`14-cicd/cicd-design.md`](../14-cicd/cicd-design.md)) and a release roadmap ([`15-roadmap/release-roadmap.md`](../15-roadmap/release-roadmap.md)).

What does not yet exist: the TypeScript CLI core, the patcher engine, the doctor engine, the launcher generator, the bootstrap implementation, the distro/runtime plugins, and the package registry. These are the v1 milestones.

## What is needed to ship v1

To ship v1, Linuxify needs:

1. **CLI core** (TypeScript + Node.js, runs inside its own proot Ubuntu using its own Node runtime — see [ADR-003](../20-adrs/adr-003-typescript-cli-core.md)) implementing the command surface in [`03-cli/cli-specification.md`](../03-cli/cli-specification.md).
2. **Bootstrap implementation** that takes a clean Termux install to a working Ubuntu-proot-with-runtimes state, idempotently, across `aarch64`, `armv7l`, and `x86_64`.
3. **Distro and runtime plugins** for at least Ubuntu + Debian and Node + Python, the v1 baseline.
4. **Patcher engine** with AST-aware JS/TS transforms and regex fallback, plus a starter library of patches for the seven launch tools (Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, Freebuff).
5. **Doctor engine** with the declarative check catalogue from [`07-doctor/diagnostics.md`](../07-doctor/diagnostics.md).
6. **Launcher generator** producing shims that survive Termux restarts and PATH re-orderings.
7. **CI/CD** matrix across distro × arch × Android version, plus a release pipeline that publishes to F-Droid and a curl-install endpoint.
8. **Package definitions** for the seven launch tools, community-reviewable and schema-validated.

## Competitive landscape

| Approach | What it does | What it does *not* do | Why Linuxify wins |
| --- | --- | --- | --- |
| **Raw Termux** | Provides a Linux-like shell and `pkg` manager. | No proot, no Ubuntu, no glibc, no compatibility patches. | Linuxify layers on Termux, adding the entire compatibility stack. |
| **`proot-distro`** | Installs a Linux distro inside Termux via proot. | No runtime management, no AI-agent installers, no patcher, no doctor, no launchers. | Linuxify treats `proot-distro` as one pluggable distro backend; everything above it is the value. |
| **UserLAnd** | GUI-driven app to install Linux distros on Android. | Closed-ish workflow, GUI-first, no developer-tool focus, no patcher. | Linuxify is CLI-first, declarative, AI-agent-friendly, and explicitly targets developer CLIs. |
| **Andronix** | Sells scripts that install Linux distros via Termux. | Same gap as UserLAnd; no tool-level compatibility work. | Linuxify is open source, MIT-licensed, and takes responsibility for the tools *after* the distro is installed. |
| **Manual proot + scripts** | Whatever you cobble together. | Not idempotent, not shareable, not diagnostic, breaks on update. | Linuxify is declarative, versioned, shareable, and self-diagnosing. |

## Why Linuxify wins

Linuxify wins because it is the only candidate that takes responsibility for the *whole* vertical — from Termux to runtime to tool to patch to launcher to doctor — under a single declarative, versioned, AI-agent-friendly interface. Every alternative solves one layer and leaves the rest as an exercise for the user. Linuxify's bet is that the value lies at the integration boundary, not in any single layer, and that a community-maintained YAML package registry (the [package spec](../09-registry/package-spec.md)) will compound that value across every new AI agent that ships.

The closest analogy is `brew` for macOS: Homebrew is not valuable because it can install things (apt and yum could already do that). It is valuable because it owns the developer-tool installation story end-to-end, with a contribution model that scales. Linuxify intends to do the same for Android and, eventually, for any platform where desktop CLIs need a compatibility layer to run.

For the longer thesis — including the expansion to macOS-only tools via QEMU, the plugin ecosystem, and the mobile-first developer platform bet — read [`vision.md`](vision.md).
