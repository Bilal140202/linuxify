# Installation Guide

## Method 1: Install from GitHub (Recommended)

Since the npm registry already has a different package named `linuxify`, install directly from GitHub:

```bash
npm install -g github:Bilal140202/linuxify#v0.1.0-alpha.2
```

Or clone and link:
```bash
git clone --depth 1 --branch v0.1.0-alpha.2 https://github.com/Bilal140202/linuxify.git
cd linuxify
npm ci
npm run build
npm link
```

## Method 2: Termux (Android)

```bash
# First fix any broken packages
apt update && apt full-upgrade -y

# Then install
pkg install linuxify
```

Or use the installer:
```bash
curl -fsSL https://raw.githubusercontent.com/Bilal140202/linuxify/main/termux-build/termux-install.sh | bash
```

## Method 3: Local Development

```bash
git clone https://github.com/Bilal140202/linuxify.git
cd linuxify
npm install
npm run dev
```
