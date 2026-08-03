#!/data/data/com.termux/files/usr/bin/bash
# Linuxify One-Command Installer for Termux
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
#
# Or:
#   pkg install curl && curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/install.sh | bash
#
# After install, just type:
#   linuxify
#
# That's it. Linuxify will bootstrap Ubuntu, install runtimes, and open a shell.

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${CYAN}"
echo "╔════════════════════════════════════════════════════╗"
echo "║          Linuxify Installer for Termux             ║"
echo "║     Run Linux developer tools on Android           ║"
echo "╚════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Prerequisite checks ──────────────────────────────────────────────

# Check we're in Termux
if [ -z "$PREFIX" ] || [ ! -d "/data/data/com.termux" ]; then
  echo -e "${RED}✖ This installer must be run inside Termux.${NC}"
  echo "  Install Termux from F-Droid: https://f-droid.org/packages/com.termux/"
  echo "  Do NOT use the Google Play Store version."
  exit 1
fi

# Check curl
if ! command -v curl &>/dev/null; then
  echo -e "${YELLOW}→ Installing curl…${NC}"
  pkg install -y curl
fi

# Check git
if ! command -v git &>/dev/null; then
  echo -e "${YELLOW}→ Installing git…${NC}"
  pkg install -y git
fi

# Check node
if ! command -v node &>/dev/null; then
  echo -e "${YELLOW}→ Installing Node.js…${NC}"
  pkg install -y nodejs
fi

# Check npm
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✖ npm not found. Node.js may be incomplete.${NC}"
  echo "  Try: pkg reinstall nodejs"
  exit 1
fi

# ── Update package lists ─────────────────────────────────────────────

echo -e "${YELLOW}→ Updating package lists…${NC}"
pkg update -y 2>/dev/null || true

# ── Install Linuxify ─────────────────────────────────────────────────

echo -e "${YELLOW}→ Installing Linuxify from GitHub…${NC}"

# Clone to a temp directory, build, and link
INSTALL_DIR="$HOME/.linuxify-src"
rm -rf "$INSTALL_DIR"
git clone --depth 1 https://github.com/Bilal140202/linuxify.git "$INSTALL_DIR"
cd "$INSTALL_DIR"

echo -e "${YELLOW}→ Installing dependencies…${NC}"
npm install --no-audit --no-fund 2>/dev/null

echo -e "${YELLOW}→ Building Linuxify…${NC}"
npm run build 2>/dev/null

echo -e "${YELLOW}→ Linking linuxify command…${NC}"
npm link 2>/dev/null

# ── Verify installation ──────────────────────────────────────────────

echo ""
if command -v linuxify &>/dev/null; then
  VERSION=$(linuxify --version 2>/dev/null || echo "unknown")
  echo -e "${GREEN}✓ Linuxify $VERSION installed successfully!${NC}"
else
  echo -e "${RED}✖ Installation may have failed. Trying manual link…${NC}"
  ln -sf "$INSTALL_DIR/dist/cli/index.js" "$PREFIX/bin/linuxify"
  chmod +x "$PREFIX/bin/linuxify"
  if command -v linuxify &>/dev/null; then
    echo -e "${GREEN}✓ Linuxify installed via manual link.${NC}"
  else
    echo -e "${RED}✖ Installation failed. Please try:${NC}"
    echo "  cd $INSTALL_DIR && npm install && npm run build && npm link"
    exit 1
  fi
fi

# ── Install proot and proot-distro ───────────────────────────────────

echo ""
echo -e "${YELLOW}→ Ensuring proot and proot-distro are installed…${NC}"
pkg install -y proot proot-distro 2>/dev/null || true

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║          Installation Complete!                    ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}║  You're ready to go. Just type:                    ║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${CYAN}║                    linuxify                        ║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}║  Linuxify will:                                    ║${NC}"
echo -e "${GREEN}║    ✓ Install Ubuntu (if needed)                    ║${NC}"
echo -e "${GREEN}║    ✓ Configure everything automatically            ║${NC}"
echo -e "${GREEN}║    ✓ Open an Ubuntu shell                          ║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}║  Other commands:                                   ║${NC}"
echo -e "${GREEN}║    linuxify add cline    # install an AI CLI       ║${NC}"
echo -e "${GREEN}║    linuxify doctor       # health check            ║${NC}"
echo -e "${GREEN}║    linuxify discover     # scan for existing envs  ║${NC}"
echo -e "${GREEN}║    linuxify --help       # see all commands        ║${NC}"
echo -e "${GREEN}║                                                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════╝${NC}"
echo ""
