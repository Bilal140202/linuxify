#!/usr/bin/env python3
"""Add explain fields to remaining doctor checks."""
import re
import os

CHECKS_DIR = "/home/z/my-project/linuxify-docs/src/doctor/checks"

EXPLANATIONS = {
    "runtime-node": {
        "what": "Verifies that Node.js is installed inside the active distro and is version 20 or newer.",
        "why": "Most AI coding CLIs (Cline, Codex, Goose, Gemini CLI) are Node.js applications. They need Node to run. Linuxify installs Node LTS during bootstrap stage 4, but it can be removed by accident or corrupted by an update.",
        "consequence": "CLIs that depend on Node won't start. `linuxify add cline` will fail because `npm install -g cline` requires Node.",
        "fix": "linuxify runtimes install node lts",
    },
    "runtime-python": {
        "what": "Verifies that Python 3.10+ is installed inside the active distro.",
        "why": "Some CLIs (Aider, Claude Code) are Python applications. They need Python to run. Linuxify installs Python 3.12 during bootstrap stage 4.",
        "consequence": "Python-based CLIs won't start. `linuxify add aider` will fail because `pip install aider-chat` requires Python.",
        "fix": "linuxify runtimes install python 3.12",
    },
    "runtime-git": {
        "what": "Verifies that Git is installed inside the active distro.",
        "why": "Git is needed by many CLIs for repository operations (Aider reads git history, Cline can commit changes). It's installed during bootstrap stage 3 as part of the base packages.",
        "consequence": "CLIs that interact with git repositories won't work properly. Aider won't be able to track file changes.",
        "fix": "linuxify init",
    },
    "compat-platform": {
        "what": "Verifies that `process.platform` reports `linux` inside the proot environment (not `android`).",
        "why": "Many Node.js CLIs check `process.platform === 'linux'` and refuse to run on Android. Inside proot, the kernel is still Android, so `process.platform` returns `android`. Linuxify's patcher fixes this by patching the CLI's source code to accept `android` as a Linux variant.",
        "consequence": "CLIs will crash with 'Unsupported platform: android-arm64' even though they're running inside a Linux distro. This is the #1 compatibility issue Linuxify exists to solve.",
        "fix": "linuxify patch --all",
    },
    "host-storage": {
        "what": "Verifies that your device has at least 2 GB of free storage space.",
        "why": "Linuxify needs space for the Ubuntu rootfs (~300 MB), Node.js (~200 MB), Python (~150 MB), and each installed CLI (~50-500 MB). A full bootstrap uses ~1.5 GB; each package adds more.",
        "consequence": "Installs will fail mid-way with 'No space left on device'. A partial install can leave the environment in a broken state that `linuxify repair` may not fully fix.",
        "fix": "Free up space: run `linuxify gc` to clean caches, remove unused distros, or uninstall apps you no longer need.",
    },
    "host-android": {
        "what": "Verifies that you're running Android 9 (API 28) or newer.",
        "why": "Older Android versions lack kernel features that proot needs (specifically, certain seccomp and ptrace behaviors). Android 9 is the minimum Termux itself supports.",
        "consequence": "proot may segfault or hang on older Android versions. Bootstrap will fail during stage 2 (rootfs download) or stage 3 (first-boot apt install).",
        "fix": "Update your device's Android version to 9 or newer. If your device is no longer supported by the manufacturer, Linuxify cannot help.",
    },
    "host-arch": {
        "what": "Verifies that your device's CPU architecture is supported (aarch64, armv7l, or x86_64).",
        "why": "Linuxify ships pre-built binaries for the three common Android architectures. aarch64 (64-bit ARM) is the primary target. armv7l (32-bit ARM) is best-effort. x86_64 is for Chromebooks and Android-x86.",
        "consequence": "If your architecture is unsupported, downloads will fail because there is no matching rootfs or Node binary. This is rare but happens on exotic hardware.",
        "fix": "Linuxify cannot run on this architecture. File an issue with your device's CPU info so we can consider adding support.",
    },
    "network-dns": {
        "what": "Verifies that DNS resolution works (can resolve hostnames like github.com).",
        "why": "Bootstrap downloads the Ubuntu rootfs from Ubuntu's CDN, and package installs pull from npm/PyPI. All of these require working DNS. Corporate networks and some mobile carriers intercept or break DNS.",
        "consequence": "Downloads will fail with 'Could not resolve host'. Bootstrap stage 2 (rootfs download) and every `linuxify add` will fail.",
        "fix": "Check your network connection. If on a corporate network, ask IT about DNS restrictions. Try a different network (mobile data vs Wi-Fi).",
    },
    "network-github": {
        "what": "Verifies that github.com is reachable (the Linuxify registry and source code live there).",
        "why": "The Linuxify registry is a git repository on GitHub. `linuxify update` pulls from it, and `linuxify search` queries it. If GitHub is blocked, you can't discover or install packages.",
        "consequence": "`linuxify search` and `linuxify add` will fail because the registry can't be updated. Existing packages still work (they're already installed).",
        "fix": "Check if GitHub is blocked on your network. Use a VPN if necessary. For air-gapped environments, see `linuxify bundle` for offline installation.",
    },
    "network-npm": {
        "what": "Verifies that registry.npmjs.org is reachable (npm packages come from there).",
        "why": "Most Node-based CLIs (Cline, Codex, Goose) are installed via `npm install -g`. If the npm registry is unreachable, these installs fail.",
        "consequence": "`linuxify add cline` will fail at the `npm install -g cline` step. Python packages (via pip) are unaffected — they use PyPI.",
        "fix": "Check if npm registry is blocked. Try again later (npm sometimes has outages). Use `linuxify add --offline` if you have a pre-bundled package.",
    },
    "host-memory": {
        "what": "Verifies that your device has at least 1 GB of free RAM.",
        "why": "proot adds overhead to every process. Running Node.js + a CLI inside proot on a low-RAM device can cause OOM kills. 1 GB is the minimum for basic operation; 2+ GB is recommended for larger CLIs.",
        "consequence": "CLIs may crash with SIGKILL (out of memory). Bootstrap stage 3 (apt install) is particularly memory-intensive and may fail.",
        "fix": "Close other apps before running Linuxify. On devices with <4 GB RAM, avoid running multiple CLIs simultaneously.",
    },
    "distro-bootable": {
        "what": "Verifies that the active distro can actually execute commands (tries running `true` inside proot).",
        "why": "A distro can be 'installed' (rootfs present) but not 'bootable' (proot crashes when entering it). This happens after Android OS updates that change kernel behavior, or if the rootfs got corrupted.",
        "consequence": "`linuxify run`, `linuxify shell`, and `linuxify add` will all fail. The distro exists on disk but can't be entered.",
        "fix": "Reinstall the distro: `linuxify distros uninstall <name> && linuxify distros install <name>`",
    },
    "path-termux-prefix": {
        "what": "Verifies that Termux's `$PREFIX/bin` is on your PATH (where `pkg`, `proot`, and other Termux tools live).",
        "why": "Termux sets this up automatically, but it can be lost if you modify your shell rc files or use a non-default shell. Linuxify relies on Termux tools being available.",
        "consequence": "Linuxify won't be able to find `pkg`, `proot`, or other Termux tools. Bootstrap will fail at stage 1.",
        "fix": "Add `export PATH=\"$PREFIX/bin:$PATH\"` to your ~/.bashrc (or ~/.zshrc).",
    },
}

def add_explanation(filename, explanation):
    filepath = os.path.join(CHECKS_DIR, filename + ".ts")
    with open(filepath, 'r') as f:
        content = f.read()

    if "explain:" in content:
        print(f"  SKIP {filename} (already has explain)")
        return

    pattern = r'(  profile: \[[^\]]+\],\n)'
    match = re.search(pattern, content)
    if not match:
        print(f"  SKIP {filename} (no profile line found)")
        return

    explain_block = "  explain: {\n"
    explain_block += f"    what: {repr(explanation['what'])},\n"
    explain_block += f"    why: {repr(explanation['why'])},\n"
    explain_block += f"    consequence: {repr(explanation['consequence'])},\n"
    explain_block += f"    fix: {repr(explanation['fix'])},\n"
    explain_block += "  },\n"

    new_content = content[:match.end()] + explain_block + content[match.end():]
    with open(filepath, 'w') as f:
        f.write(new_content)
    print(f"  OK   {filename}")

for name, expl in EXPLANATIONS.items():
    add_explanation(name, expl)

print("Done.")
