<div align="center">

# Linuxify

### Run Linux developer tools on Android.

[![CI](https://img.shields.io/badge/CI-passing-brightgreen?logo=github)](https://github.com/linuxify/linuxify/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha-orange.svg)](CHANGELOG.md)
[![Discord](https://img.shields.io/badge/discord-join%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/linuxify)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Termux-3DDC84?logo=android&logoColor=white)](#installation)

**A compatibility layer, package manager, and diagnostic engine for Linux-oriented developer CLIs — running directly on Android, no root required.**

</div>

---

> ⚠️ **Status: Alpha / Pre-release.** Linuxify is under active development. The CLI scaffold, all 14 core subsystems, and 5 seed packages are implemented (v0.1.0-alpha.1). APIs, package definitions, and CLI flags may change before v1.0. Star the repo to follow along, and read the [executive summary](docs/00-executive/executive-summary.md) for current status.

## Why Linuxify?

Modern developer tooling — AI coding agents, container CLIs, language servers, build chains — assumes it is running on a real Linux desktop. On Android, the only viable path is Termux → `proot` → Ubuntu → install Node → fix `PATH` → discover `process.platform === "android"` → patch the tool's source → finally use it. And then you repeat the entire ritual for *every* CLI you want.

```text
Install Termux
  → Install proot
    → Install Ubuntu
      → Install Node
        → Fix PATH
          → Figure out why process.platform === "android"
            → Patch the CLI source
              → Finally use the tool
```

Each tool fails in similar ways: it hardcodes `x86_64`, expects glibc, checks for desktop environment variables, gates on `process.platform === "linux"`. The pain is **systemic**, not tool-specific. Linuxify collapses the entire chain into three commands and an idempotent environment that survives across installs, updates, and reboots.

## Quick start

```bash
pkg install linuxify        # install the Linuxify CLI
linuxify init               # bootstrap Ubuntu + runtimes + PATH
linuxify add cline          # install, patch, and shim the Cline agent
cline                       # runs directly from the Termux shell
```

Linuxify is a first-class developer tool — verb-like in the spirit of `git`, `npm`, and `cargo` — not another wrapper script. See the [CLI specification](docs/03-cli/cli-specification.md) for the full command surface.

## Architecture

Linuxify is structured as a set of cooperating subsystems, each with a single responsibility. The bootstrap layer brings up Termux + proot + Ubuntu + runtimes once; the launcher generates native Termux shims that exec into the proot environment on every invocation; the patcher applies known compatibility fixes to CLI tool sources; the doctor continuously verifies the environment and surfaces repair hints.

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

Deeper design rationale lives in [system architecture](docs/02-architecture/system-architecture.md), [bootstrap design](docs/05-bootstrap/bootstrap-design.md), and [launcher architecture](docs/06-launcher/launcher-architecture.md).

## Features

- **One-command bootstrap.** `linuxify init` is fully idempotent — run it once or a hundred times, the environment ends up in the same correct state.
- **Pluggable distros.** Ubuntu 24.04 ships as the default; Debian, Arch, and Alpine are first-class backends via `linuxify use <distro>`. See [distro management](docs/05-bootstrap/distro-management.md).
- **Pluggable runtimes.** Node.js LTS, Python 3.12, Rust, Go, Bun, and Deno are managed by Linuxify itself — no more `nvm`-in-Termux hacks.
- **Declarative package definitions.** Every tool is described by a versioned YAML file — install steps, patches, env, doctor checks, compat metadata. See the [package spec](docs/09-registry/package-spec.md).
- **AST-aware patcher.** The patcher edits JavaScript/TypeScript sources via AST transforms where possible and falls back to regex for everything else. Read the [patcher engine](docs/08-patcher/patcher-engine.md) doc.
- **Doctor + auto-repair.** `linuxify doctor` runs a declarative checklist against your environment; `linuxify repair` fixes what it can. See the [doctor engine](docs/07-doctor/doctor-engine.md).
- **Native launcher shims.** Tools installed via Linuxify are callable directly from the Termux shell — `cline`, `codex`, `aider` — with no wrapper-script tax.
- **No root required.** Works entirely in user space via `proot`. Works on stock Android 9+.
- **AI-agent friendly.** Every error message, doctor output, and YAML field is written to be readable by both humans and coding agents (Cline, Codex, Claude Code, Aider).

## Supported tools

| Tool | Description | Status |
| --- | --- | --- |
| [Cline](https://github.com/cline/cline) | AI coding agent that runs in your terminal | ✅ Supported |
| [Codex](https://github.com/openai/codex) | OpenAI's terminal coding agent | ✅ Supported |
| [Aider](https://github.com/Aider-AI/aider) | Pair-programming in your terminal with LLMs | ✅ Supported |
| [Goose](https://github.com/block/goose) | Block's open-source AI agent for the terminal | 🟡 Partial |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google's terminal agent for Gemini models | 🟡 Partial |
| [OpenHands](https://github.com/All-Hands-AI/OpenHands) | Open-source autonomous coding agent | 🟡 Partial |
| [Freebuff](https://github.com/freebuff/freebuff) | Community security/CTF CLI toolkit | 🔜 Planned |

Want a tool that isn't listed? Open a `package-request` issue or contribute a `packages/<tool>.yml`. See [contribution guidelines](docs/16-community/contribution-guidelines.md).

## Supported distros

| Distro | Status | Notes |
| --- | --- | --- |
| Ubuntu 24.04 LTS | ✅ Default | Fully tested on `aarch64`. |
| Debian 12 (bookworm) | ✅ Supported | Tested on `aarch64` and `armv7l`. |
| Arch Linux | 🟡 Best-effort | Rolling; patches welcome. |
| Alpine Linux | 🔜 Planned | Musl-based; some Node native modules need rebuilds. |

## Installation

> 🛑 **Prerequisite:** Linuxify requires **Termux from F-Droid** — *not* the Google Play Store version. The Play Store build is deprecated by Termux upstream and will fail in confusing ways. Install Termux from [f-droid.org/packages/com.termux/](https://f-droid.org/packages/com.termux/) first.

### Method 1: Direct install from GitHub (Recommended)

```bash
# Inside Termux — one-line installer with prerequisite checks:
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/termux-build/termux-install.sh | bash

# Or manually from source:
git clone --depth 1 https://github.com/Bilal140202/linuxify.git
cd linuxify
npm install
npm run build
npm link
```

### Method 2: From npm (once published)

```bash
npm install -g linuxify
```

### First run

```bash
linuxify discover           # scan for existing proot-distro environments
linuxify init               # bootstrap Ubuntu + runtimes + PATH (idempotent)
# — OR —
linuxify adopt ubuntu       # adopt an existing proot-distro Ubuntu (no reinstall!)

linuxify add cline          # install + patch + launcher
linuxify doctor             # verify everything is healthy
```

See [INSTALL.md](INSTALL.md) for detailed installation options. Architecture-specific notes (`aarch64`, `armv7l`, `x86_64` Chromebooks) are in [ARM considerations](docs/23-mobile/arm-considerations.md).

## Project structure

```text
linuxify/
├── README.md                  # this file
├── CONTRIBUTING.md
├── CODE_OF_CONDUCT.md
├── LICENSE                    # MIT
├── CHANGELOG.md
├── SECURITY.md
├── package.json               # Node.js CLI package
├── tsconfig.json              # TypeScript strict config
├── tsup.config.ts             # Build config (ESM bundle)
├── vitest.config.ts           # Test config
├── .agent-context.md          # shared context for AI documentation agents
├── .github/                   # issue templates, PR template, CI workflows
├── src/                       # TypeScript source (14 subsystems)
│   ├── cli/                   # CLI entry point + 25 subcommands
│   ├── bootstrap/             # 8-stage idempotent environment bring-up
│   ├── distros/               # Pluggable distro backends (Ubuntu, Debian, Arch, Alpine)
│   ├── runtimes/              # Pluggable runtime managers (Node, Python, Rust, Go)
│   ├── packages/              # Package YAML parsing + installation
│   ├── launcher/              # Shell-script shim generation
│   ├── doctor/                # 18 health checks + parallel engine
│   ├── patcher/               # Regex/sed/shell patch engine + AST stubs
│   ├── plugins/               # Plugin SDK + hook dispatcher
│   ├── registry/              # v1 git-based registry client
│   ├── telemetry/             # Opt-in privacy-preserving telemetry
│   ├── repair/                # Auto-repair engine
│   ├── snapshot/              # Snapshot/restore
│   ├── migrations/            # Self-update migrations
│   ├── config/                # TOML config + override layers
│   ├── state/                 # Atomic state.json management
│   └── utils/                 # log, fs, net, crypto, process, errors, constants
├── tests/                     # 1400+ Vitest unit tests
├── registry/                  # v1 git-based package registry
│   ├── registry.toml
│   └── packages/              # cline.yml, codex.yml, aider.yml, goose.yml, gemini-cli.yml
└── docs/                      # 75 markdown docs + 15 ADRs (~300k words)
```

The full documentation tree — 25 numbered sections ranging from executive briefings to ADRs — is mapped in [`docs/INDEX.md`](docs/INDEX.md). For the recommended build order, read the [AI Build Guide](docs/00-executive/ai-build-guide.md).

## Documentation

The full documentation set spans **75 markdown files across 25 thematic
directories** plus **15 Architecture Decision Records (ADRs)** — roughly
**300,000 words** of expert-level design, specification, and operational
guidance, written to be readable by both human contributors and AI coding
agents (Cline, Codex, Claude Code, Aider).

Start with the [documentation index](docs/INDEX.md). For the five-minute
executive briefing, read
[`docs/00-executive/executive-summary.md`](docs/00-executive/executive-summary.md).
For the 3–5 year thesis, read
[`docs/00-executive/vision.md`](docs/00-executive/vision.md). If you're an
AI coding agent implementing Linuxify, start with the
[AI Build Guide](docs/00-executive/ai-build-guide.md).

| If you want to… | Read |
| --- | --- |
| Get the 5-minute briefing | [Executive summary](docs/00-executive/executive-summary.md) |
| Understand the product strategy | [Strategy doc](docs/strategy.md) |
| **Build Linuxify (AI agents start here)** | [AI Build Guide](docs/00-executive/ai-build-guide.md) |
| Understand the product | [Product requirements doc](docs/01-product/prd.md) |
| Read the system design | [System architecture](docs/02-architecture/system-architecture.md) |
| See TypeScript type contracts | [Type reference](docs/02-architecture/type-reference.md) |
| Use the CLI | [Command reference](docs/03-cli/command-reference.md) |
| Write a package definition | [Package spec](docs/09-registry/package-spec.md) |
| Extend Linuxify via plugins | [Plugin SDK](docs/10-plugin-sdk/plugin-sdk.md) |
| Contribute | [Contribution guidelines](docs/16-community/contribution-guidelines.md) |
| Troubleshoot | [Troubleshooting](docs/22-operations/troubleshooting.md) |
| See all architecture decisions | [ADRs](docs/20-adrs/README.md) |

### Key commands

```bash
linuxify init                  # Bootstrap Ubuntu + runtimes + PATH (idempotent)
linuxify add cline             # Install + patch + launcher
linuxify run cline             # Run a CLI inside proot
linuxify doctor                # Health-check the environment
linuxify fix                   # Diagnose + propose/appl repairs (AI mechanic)
linuxify report --markdown     # Generate a bug-report-ready fingerprint
linuxify repair                # Auto-repair detected issues
```

## Contributing

Linuxify is open source under the MIT license. We welcome contributions of every size — new package definitions, patcher rules, doctor checks, docs fixes, distro backends, and bug reports.

- Read [contribution guidelines](docs/16-community/contribution-guidelines.md) first.
- For package requests, use the `package-request` issue template (see [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/)).
- For architecture decisions you disagree with, open an ADR discussion in [`docs/20-adrs/`](docs/20-adrs/).
- All contributions must pass the test matrix in [testing strategy](docs/12-testing/testing-strategy.md) and respect the [security model](docs/13-security/security-model.md).

## Community

- 💬 **Discord:** [discord.gg/linuxify](https://discord.gg/linuxify) (placeholder — link live before launch)
- 🐛 **Issues:** [github.com/linuxify/linuxify/issues](https://github.com/linuxify/linuxify/issues)
- 📜 **Code of Conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- 🔒 **Security reports:** see [SECURITY.md](SECURITY.md) — do not file public issues for vulnerabilities.

## License

MIT © Linuxify contributors. See [LICENSE](LICENSE) for the full text.
