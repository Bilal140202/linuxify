# Installation Guide

## One-Command Install (Recommended)

Inside Termux (from F-Droid):

```bash
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
```

Then just type:

```bash
linuxify
```

That's it. Linuxify will:
1. Install Ubuntu (if needed)
2. Install Node.js, Python, Git inside Ubuntu
3. Configure PATH
4. Create the linuxify user
5. Open an Ubuntu shell

## Manual Install

```bash
git clone --depth 1 https://github.com/Bilal140202/linuxify.git ~/linuxify
cd ~/linuxify
npm install
npm run build
npm link
```

Then:

```bash
linuxify
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
1. Run `pkg install proot proot-distro` (host dependencies)
2. Run `proot-distro install ubuntu` (download + extract Ubuntu 24.04)
3. Run `apt install` inside Ubuntu (build-essential, Node, Python, Git)
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

### "No active distro"

```bash
linuxify discover            # see what's installed
linuxify adopt ubuntu        # adopt existing Ubuntu
# OR
linuxify init                # install fresh
```

## Uninstall

```bash
npm unlink -g linuxify
rm -rf ~/.linuxify ~/linuxify ~/.linuxify-src
proot-distro remove ubuntu  # optional: remove the Ubuntu container
```
