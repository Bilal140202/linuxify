<div align="center">

# Linuxify

### Run Linux developer tools on Android.

[![npm version](https://img.shields.io/npm/v/linuxify-cli.svg)](https://www.npmjs.com/package/linuxify-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Android%20%7C%20Termux-3DDC84?logo=android&logoColor=white)](#installation)

**One command. Linuxify installs Ubuntu, Node, Python, and AI coding CLIs (Cline, Codex, Aider) on Android via Termux + proot.**

</div>

---

## Install

```bash
npm install -g linuxify-cli
```

## Use

```bash
linuxify
```

That's it. Linuxify will:
1. Install Ubuntu (if needed)
2. Install Node.js, Python, Git, curl, build-essential inside Ubuntu
3. Configure PATH + npm cache (proot rename bug fix)
4. Create the linuxify user
5. Auto-clone the package registry
6. Open an Ubuntu shell

## Install tools

```bash
linuxify add cline         # AI coding agent
linuxify add codex         # OpenAI Codex
linuxify add aider         # Aider
linuxify add wrangler      # Cloudflare Workers CLI
linuxify add kubectl      # Kubernetes CLI
linuxify add terraform     # Infrastructure as Code
linuxify add pm2           # Process manager
linuxify add playwright    # Browser automation
linuxify add docker-cli    # Docker CLI
```

Then just type the tool name — it works:
```bash
cline --version
wrangler --version
kubectl version --client
```

## Self-healing

Linuxify never trusts cached state over actual state:
- If Ubuntu is missing → reinstalls it
- If the linuxify user is missing → recreates it
- If PATH is broken → fixes it
- If npm cache has the proot rename bug → configures TMPDIR fix
- If proot-distro is broken (bad interpreter) → diagnoses and suggests `pkg reinstall`

## Commands

```bash
linuxify                   # launch (bootstrap if needed, then open shell)
linuxify doctor            # health check
linuxify doctor --explain  # explain why each check matters
linuxify repair            # apt/brew-style repair plan
linuxify fix               # AI-assisted diagnosis
linuxify report            # bug-report fingerprint
linuxify discover          # scan for existing environments
linuxify adopt ubuntu      # adopt existing Ubuntu (no reinstall)
linuxify add <package>     # install a tool
linuxify search <query>    # search registry
linuxify list              # list installed packages
linuxify --help            # see all commands
```

## Supported packages (12)

**AI:** Cline, Codex, Aider, Goose, Gemini CLI
**DevOps:** Wrangler, Docker CLI, kubectl, Terraform, PM2
**Testing:** Playwright, Git

## Requirements

- Termux from F-Droid (NOT Google Play)
- Android 9+ (API 28+)
- ~2 GB free storage
- aarch64 (recommended), armv7l, or x86_64

## License

MIT © Linuxify contributors
