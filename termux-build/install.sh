#!/data/data/com.termux/files/usr/bin/bash
# Linuxify Direct Installer for Termux
# Works immediately without waiting for official repo inclusion

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

# Check Termux
if [[ ! -d "/data/data/com.termux" ]]; then
    log_error "This installer is for Termux only."
    log_error "For other systems: npm install -g github:Bilal140202/linuxify"
    exit 1
fi

# Fix broken packages if needed
if ! curl --version &>/dev/null; then
    log_warn "Fixing broken packages..."
    apt update -y
    apt full-upgrade -y
fi

# Install dependencies
log_info "Installing dependencies..."
pkg update -y
pkg install -y nodejs proot proot-distro jq curl ca-certificates openssh git tar xz-utils

# Download and install
log_info "Downloading Linuxify..."
TMPDIR=$(mktemp -d)
cd "$TMPDIR"

curl -fsSL "https://github.com/Bilal140202/linuxify/archive/refs/tags/v${LINUXIFY_VERSION}.tar.gz" -o linuxify.tar.gz
tar -xzf linuxify.tar.gz
cd "linuxify-${LINUXIFY_VERSION}"

log_info "Building..."
npm ci --no-audit --no-fund
npm run build

log_info "Installing..."
mkdir -p "${TERMUX_PREFIX}/lib/linuxify"
cp -r dist package.json node_modules "${TERMUX_PREFIX}/lib/linuxify/"
ln -sf "${TERMUX_PREFIX}/lib/linuxify/dist/cli/index.js" "${TERMUX_PREFIX}/bin/linuxify"
chmod +x "${TERMUX_PREFIX}/bin/linuxify"

rm -rf "$TMPDIR"

echo ""
echo "=========================================="
log_info "Linuxify installed!"
echo "=========================================="
echo "Run: linuxify init"
