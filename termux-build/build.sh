TERMUX_PKG_HOMEPAGE=https://github.com/Bilal140202/linuxify
TERMUX_PKG_DESCRIPTION="Run Linux developer tools on Android via proot"
TERMUX_PKG_LICENSE="MIT"
TERMUX_PKG_MAINTAINER="Bilal140202 <linuxify@example.com>"
TERMUX_PKG_VERSION=0.1.0-alpha.2
TERMUX_PKG_SRCURL=https://github.com/Bilal140202/linuxify/archive/refs/tags/v${TERMUX_PKG_VERSION}.tar.gz
TERMUX_PKG_SHA256=SKIP
TERMUX_PKG_DEPENDS="nodejs, proot, proot-distro, jq, curl, ca-certificates, openssh, git, tar, xz-utils"
TERMUX_PKG_BUILD_IN_SRC=true
TERMUX_PKG_PLATFORM_INDEPENDENT=true
TERMUX_PKG_BLACKLISTED_ARCHES=""

termux_step_pre_configure() {
    # Ensure node_modules are installed before build
    npm ci --no-audit --no-fund --production=false
}

termux_step_make() {
    npm run build
}

termux_step_make_install() {
    # Install to Termux prefix
    mkdir -p $TERMUX_PREFIX/lib/linuxify
    cp -r dist package.json node_modules $TERMUX_PREFIX/lib/linuxify/

    # Create bin symlink
    mkdir -p $TERMUX_PREFIX/bin
    ln -sf $TERMUX_PREFIX/lib/linuxify/dist/cli/index.js $TERMUX_PREFIX/bin/linuxify
    chmod +x $TERMUX_PREFIX/bin/linuxify
}
