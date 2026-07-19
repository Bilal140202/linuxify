#!/data/data/com.termux/files/usr/bin/bash
# Linuxify Termux Installer — with prerequisite checks
# Usage: curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/termux-build/termux-install.sh | bash

set -e

TERMUX_PREFIX="/data/data/com.termux/files/usr"
LINUXIFY_VERSION="0.1.0-alpha.2"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

echo "🐧 Linuxify v${LINUXIFY_VERSION} Installer"
echo "=========================================="

# ── PREREQUISITE CHECKS ──────────────────────────────────────────

# 1. Check if running in Termux
if [[ -z "${TERMUX_VERSION:-}" && ! -d "/data/data/com.termux" ]]; then
    log_error "This installer is designed for Termux on Android."
    log_error "For other systems, use: npm install -g linuxify"
    exit 1
fi

# 2. Fix mirror selection
if [[ ! -f "${TERMUX_PREFIX}/etc/termux/chosen_mirrors" ]]; then
    log_warn "No mirror selected. Running termux-change-repo..."
    termux-change-repo || true
fi

# 3. Fix broken curl (ngtcp2 symbol error)
log_info "Checking package health..."
if ! curl --version &>/dev/null; then
    log_warn "curl is broken. Fixing with apt full-upgrade..."
    apt update -y
    apt full-upgrade -y
fi

# 4. Ensure curl works after fix
if ! curl --version &>/dev/null; then
    log_error "curl still broken after upgrade."
    log_error "Run manually: apt update && apt full-upgrade && pkg install curl"
    exit 1
fi

# ── INSTALL DEPENDENCIES ─────────────────────────────────────────

log_info "Installing dependencies..."
pkg update -y
pkg install -y nodejs proot proot-distro jq curl ca-certificates openssh git tar xz-utils

# ── DOWNLOAD & BUILD ───────────────────────────────────────────

log_info "Downloading Linuxify v${LINUXIFY_VERSION}..."
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

curl -fsSL "https://github.com/Bilal140202/linuxify/archive/refs/tags/v${LINUXIFY_VERSION}.tar.gz" -o linuxify.tar.gz
tar -xzf linuxify.tar.gz
cd "linuxify-${LINUXIFY_VERSION}"

log_info "Building Linuxify..."
npm ci --no-audit --no-fund
npm run build

# ── INSTALL ──────────────────────────────────────────────────────

log_info "Installing to ${TERMUX_PREFIX}..."
mkdir -p "${TERMUX_PREFIX}/lib/linuxify"
cp -r dist package.json node_modules "${TERMUX_PREFIX}/lib/linuxify/"

mkdir -p "${TERMUX_PREFIX}/bin"
ln -sf "${TERMUX_PREFIX}/lib/linuxify/dist/cli/index.js" "${TERMUX_PREFIX}/bin/linuxify"
chmod +x "${TERMUX_PREFIX}/bin/linuxify"

# Cleanup
rm -rf "$TMPDIR"

# ── DONE ───────────────────────────────────────────────────────

echo ""
echo "=========================================="
log_info "Linuxify v${LINUXIFY_VERSION} installed!"
echo "=========================================="
echo ""
echo "🚀 Quick start:"
echo "   linuxify init        # Bootstrap Ubuntu + runtimes + PATH"
echo "   linuxify add cline   # Install, patch, and shim the Cline agent"
echo "   cline                # Runs directly from the Termux shell"
echo ""
