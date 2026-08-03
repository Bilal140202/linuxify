<div align="center">

# Linuxify

### Run Linux developer tools on Android.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha.15-orange.svg)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Termux-3DDC84?logo=android&logoColor=white)](#installation)

**A compatibility layer, package manager, and diagnostic engine for Linux-oriented developer CLIs — running directly on Android, no root required.**

</div>

---

> ⚠️ **Status: Alpha.** Linuxify is under active development. Star the repo to follow along.

## Quick start

**One command. That's it.**

Inside Termux (from F-Droid, NOT Google Play):

```bash
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
```

Then:

```bash
linuxify
```

Linuxify will:
- ✓ Install Ubuntu (if needed)
- ✓ Configure everything automatically
- ✓ Open an Ubuntu shell

From that shell, install AI coding tools:
```bash
linuxify add cline
linuxify add codex
linuxify add aider
```

Then just type `cline`, `codex`, or `aider` — they work directly.

## What is Linuxify?

Modern developer tooling — AI coding agents, container CLIs, language servers — assumes it is running on a real Linux desktop. On Android, the only viable path is Termux → proot → Ubuntu → install Node → fix PATH → patch the tool's source. And then you repeat for *every* CLI.

Linuxify collapses the entire chain into one command.

```bash
linuxify          # set up everything, open Ubuntu shell
linuxify add cline  # install + patch + launcher
cline              # works directly
```

## Why Linuxify?

- **One command.** Type `linuxify` — it figures out what's needed and does it.
- **Self-healing.** If Ubuntu is missing, it reinstalls. If the linuxify user is missing, it recreates it. If PATH is broken, it fixes it.
- **Doctor explains.** `linuxify doctor --explain` tells you what's wrong, why it matters, and how to fix it — in plain English.
- **Repair plans.** `linuxify repair` shows a phased plan before acting, just like `apt` or `brew`.
- **Diagnostics engine.** When something fails, Linuxify diagnoses the specific error (e.g., "bad interpreter after Python upgrade") and suggests the exact repair.
- **Adopt existing environments.** Already have Ubuntu installed via proot-distro? `linuxify adopt ubuntu` — no reinstall.
- **No root required.** Works entirely in user space via proot.

## Installation

### Prerequisite

**Termux from F-Droid** — NOT Google Play. The Play Store version is deprecated.

### Method 1: One-line installer (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
```

### Method 2: Manual from source

```bash
git clone --depth 1 https://github.com/Bilal140202/linuxify.git ~/linuxify
cd ~/linuxify
npm install
npm run build
npm link
```

### After install

```bash
linuxify           # bootstrap + launch shell (first run)
linuxify           # launch shell (subsequent runs — instant)
linuxify add cline # install a CLI tool
linuxify doctor    # health check
linuxify --help    # see all commands
```

## The `linuxify` command (no args)

Typing `linuxify` with no arguments is the primary entrypoint. It's a smart launcher:

| State | What happens |
|-------|-------------|
| **Not initialized** | Offers to bootstrap (install Ubuntu, runtimes, PATH) → launches shell |
| **Repairable** | Auto-repairs (missing user, missing distro) → launches shell |
| **Ready** | Launches Ubuntu shell immediately |
| **Broken** | Shows diagnosis, suggests `linuxify doctor` |

Most users only ever need one command: `linuxify`. Everything else is an implementation detail.

## Key commands

```bash
linuxify                     # launch (bootstrap if needed, then open shell)
linuxify add cline           # install + patch + launcher
linuxify add codex           # install OpenAI Codex
linuxify add aider           # install Aider
linuxify run cline           # run a CLI inside proot
linuxify shell               # open Ubuntu shell
linuxify doctor              # health check
linuxify doctor --explain    # explain why each check matters
linuxify repair              # apt/brew-style repair plan
linuxify fix                 # AI-assisted diagnosis with repair commands
linuxify report              # generate bug-report fingerprint
linuxify discover            # scan for existing environments
linuxify adopt ubuntu        # adopt existing Ubuntu (no reinstall)
linuxify list                # list installed packages
linuxify search ai           # search registry
linuxify --help              # see all commands
```

## Supported tools

| Tool | Description | Status |
| --- | --- | --- |
| [Cline](https://github.com/cline/cline) | AI coding agent | ✅ Supported |
| [Codex](https://github.com/openai/codex) | OpenAI's terminal coding agent | ✅ Supported |
| [Aider](https://github.com/Aider-AI/aider) | Pair-programming with LLMs | ✅ Supported |
| [Goose](https://github.com/block/goose) | Block's open-source AI agent | ✅ Supported |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Google's terminal agent | ✅ Supported |

## Supported distros

| Distro | Status |
| --- | --- |
| Ubuntu 24.04 LTS | ✅ Default |
| Debian 12 | ✅ Supported |
| Arch Linux | ✅ Supported |
| Alpine Linux | ✅ Supported |

## Architecture

```
linuxify/
├── src/
│   ├── cli/           # CLI router + 27 subcommands + smart launcher
│   ├── bootstrap/     # 8-stage self-healing bootstrap
│   ├── distros/       # Pluggable distro backends (Ubuntu, Debian, Arch, Alpine)
│   ├── runtimes/      # Pluggable runtimes (Node, Python, Rust, Go)
│   ├── packages/      # Package YAML parsing + installation
│   ├── launcher/      # Shell-script shim generation
│   ├── doctor/        # 19 health checks + parallel engine + explanations
│   ├── patcher/       # Regex/sed/shell patch engine
│   ├── diagnostics/   # Error pattern matching ("AI mechanic")
│   ├── diagnosis/     # Root-cause diagnosis rules
│   ├── discovery/     # Environment scanner (find existing containers)
│   ├── system/        # SystemState state machine (not-initialized/repairable/ready)
│   ├── repair/        # Auto-repair engine with phased plans
│   ├── report/        # Bug-report fingerprint generator
│   ├── registry/      # v1 git-based package registry client
│   ├── telemetry/     # Opt-in privacy-preserving telemetry
│   ├── snapshot/      # Snapshot/restore
│   ├── migrations/    # Self-update migration runner
│   ├── plugins/       # Plugin SDK + hook dispatcher
│   ├── config/        # TOML config with 5-layer override
│   ├── state/         # Atomic state.json management
│   └── utils/         # log, fs, net, crypto, process, errors, distros, prompt
├── registry/          # Package definitions (cline.yml, codex.yml, etc.)
├── docs/              # 75+ markdown docs + 16 ADRs
└── tests/             # 1434+ unit tests
```

## Self-healing

Linuxify never trusts cached state over actual state:

- **Stage 2** verifies Ubuntu exists before skipping (reinstalls if deleted)
- **Stage 3** verifies the linuxify user exists (recreates if missing)
- **Doctor** checks reality via `proot-distro list --quiet`, not stale state.json
- **Diagnostics** identifies specific errors (bad interpreter, network, disk full) and suggests targeted repairs
- **Auto-repair** fixes safe issues (missing user, missing distro) during launch

## Diagnostics engine

When a command fails, Linuxify inspects the error and produces a specific diagnosis:

```
━━━ Broken interpreter — python3.13 no longer exists ━━━
  WHAT:        proot-distro's shebang points to python3.13, which no longer exists.
  WHY:         This happens after a Termux Python upgrade (3.13 → 3.14).
  REPAIR:      pkg reinstall proot-distro
  CONFIDENCE:  99%
```

8 built-in patterns: bad-interpreter, command-not-found, permission-denied, no-module-named, segfault, no-space, network-unreachable, apt-lock.

## Project structure

See [`docs/INDEX.md`](docs/INDEX.md) for the full documentation map. For the recommended build order, read the [AI Build Guide](docs/00-executive/ai-build-guide.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/16-community/developer-setup.md](docs/16-community/developer-setup.md).

## License

MIT © Linuxify contributors. See [LICENSE](LICENSE).
