# Installation Guide

## Method 1: npm (Recommended)

```bash
# Inside Termux (from F-Droid):
pkg install nodejs
npm install -g linuxify-cli
```

Then:

```bash
linuxify
```

## Method 2: One-Line Installer

Installs Node.js, Linuxify, and proot automatically:

```bash
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
```

Then:

```bash
linuxify
```

## Method 3: Manual from Source

```bash
git clone --depth 1 https://github.com/Bilal140202/linuxify.git ~/linuxify
cd ~/linuxify
npm install
npm run build
npm link
```

## Prerequisites

- **Termux from F-Droid** (NOT Google Play — the Play Store version is deprecated)
- Android 9+ (API 28+)
- ~2 GB free storage
- aarch64 (recommended), armv7l, or x86_64

## What happens on first run?

When you type `linuxify` for the first time:

```
🔍 Checking Linuxify environment…

Linuxify is not initialized yet.

This will:
  ✓ Install Ubuntu
  ✓ Configure Linuxify
  ✓ Install runtimes (Node, Python, Git)
  ✓ Create linuxify user
  ✓ Wire up PATH

Continue? [Y/n]
```

Press Enter. Linuxify will:
1. Install proot and proot-distro (host dependencies)
2. Install Ubuntu 24.04 via `proot-distro install ubuntu`
3. Enter Ubuntu as root and run `apt install curl git build-essential nodejs npm python3`
4. Create the `linuxify` user inside Ubuntu
5. Set up `~/.linuxify/` directory structure
6. Add `~/.linuxify/bin` to your PATH
7. Open the Ubuntu shell

After the first run, `linuxify` skips bootstrap and opens the shell instantly.

## Already have Ubuntu installed?

If you already have Ubuntu via proot-distro:

```bash
linuxify discover     # scan for existing environments
linuxify adopt ubuntu # adopt without reinstalling
linuxify              # launch shell
```

## Troubleshooting

### "Linuxify must run inside Termux"

Install Termux from F-Droid: https://f-droid.org/packages/com.termux/

### "proot-distro not usable"

```bash
pkg reinstall proot-distro
```

This usually happens after a Python upgrade in Termux.

### "Bootstrap failed at stage X"

```bash
linuxify doctor --explain    # see what's wrong and why
linuxify repair              # auto-repair
linuxify                     # try again
```

## Update

```bash
npm update -g linuxify-cli
```

## Uninstall

```bash
npm uninstall -g linuxify-cli
rm -rf ~/.linuxify
proot-distro remove ubuntu  # optional: remove the Ubuntu container
```
