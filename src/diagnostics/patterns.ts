/**
 * Built-in diagnostic patterns — hand-authored mappings from stderr patterns
 * to specific diagnoses.
 *
 * @module linuxify/diagnostics/patterns
 *
 * Each pattern is based on a real bug report from alpha testing. New patterns
 * are added as bug reports reveal common failure modes.
 */

import type { StderrPattern } from './types.js';

/**
 * The built-in pattern set.
 *
 * Patterns are checked in order — first match wins. More specific patterns
 * should come before more general ones.
 */
export const builtinPatterns: StderrPattern[] = [
  // ── Bad interpreter (Python upgrade broke a script) ────────────────
  {
    id: 'bad-interpreter',
    name: 'Broken interpreter after Python/Node upgrade',
    // The actual Termux error format is:
    //   "bash: /path/to/script: /path/to/python3.13: bad interpreter: No such file or directory"
    // The interpreter path comes BEFORE "bad interpreter", not after it.
    pattern: /(\S+):\s*bad interpreter:\s*No such file or directory/i,
    diagnose: (match, ctx) => {
      const interpreterPath = match[1];
      // Extract the interpreter name (e.g., "python3.13" from the path).
      const interpreterName = interpreterPath.split('/').pop() ?? interpreterPath;
      // Extract the package name if we can (e.g., "proot-distro" from the command).
      const pkg = ctx.packageName ?? extractPackageFromCommand(ctx.command);
      const baseInterpreter = interpreterName.replace(/\d+.*$/, ''); // "python3.13" → "python3"

      return {
        id: 'bad-interpreter.python-upgrade',
        title: `Broken interpreter — ${interpreterName} no longer exists`,
        what: `The ${pkg ?? 'script'} is installed but its shebang points to ${interpreterName}, which no longer exists on this system. The script cannot even start.`,
        why: `This happens after a Termux ${baseInterpreter} upgrade (e.g., 3.13 → 3.14). The ${pkg ?? 'package'} script still has the old interpreter path in its first line. Reinstalling the package updates the shebang to the current interpreter.`,
        evidence: match[0],
        repair: pkg ? `pkg reinstall ${pkg}` : `pkg reinstall <package-name>`,
        autoRepairable: true,
        confidence: 0.99,
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/22-operations/troubleshooting.md',
      };
    },
  },

  // ── Command not found ──────────────────────────────────────────────
  {
    id: 'command-not-found',
    name: 'Command not found — package not installed',
    pattern: /command not found[:\s]+(\S+)/i,
    diagnose: (match, _ctx) => {
      const cmd = match[1];
      return {
        id: 'command-not-found.missing-binary',
        title: `'${cmd}' is not installed`,
        what: `The command '${cmd}' was not found on your PATH. The package that provides it is not installed.`,
        why: `The binary either was never installed, was uninstalled, or its package was removed during a system update.`,
        evidence: match[0],
        repair: `pkg install ${guessPackageFromCommand(cmd)}`,
        autoRepairable: true,
        confidence: 0.85,
      };
    },
  },

  // ── Permission denied ──────────────────────────────────────────────
  {
    id: 'permission-denied',
    name: 'Permission denied — wrong file permissions',
    pattern: /permission denied/i,
    diagnose: (match, ctx) => {
      const pkg = ctx.packageName ?? extractPackageFromCommand(ctx.command);
      return {
        id: 'permission-denied.wrong-mode',
        title: 'Permission denied — executable bit missing or wrong owner',
        what: `The file exists but cannot be executed due to wrong permissions.`,
        why: `This can happen if a file was copied without preserving permissions, or if a system update changed ownership.`,
        evidence: match[0],
        repair: pkg ? `pkg reinstall ${pkg}` : 'chmod +x <file>  # or reinstall the package',
        autoRepairable: true,
        confidence: 0.7,
      };
    },
  },

  // ── No module named (Python) ───────────────────────────────────────
  {
    id: 'no-module-named',
    name: 'Missing Python module',
    pattern: /No module named[:\s]+'?(\S+?)'?$/im,
    diagnose: (match, _ctx) => {
      const mod = match[1];
      return {
        id: 'no-module-named.broken-python-package',
        title: `Python module '${mod}' is missing`,
        what: `A Python script tried to import '${mod}' but the module is not installed.`,
        why: `This happens after a Python upgrade — packages installed for the old version are not automatically available to the new one. Reinstalling the package fixes it.`,
        evidence: match[0],
        repair: `pip install ${mod}`,
        autoRepairable: true,
        confidence: 0.8,
      };
    },
  },

  // ── Segmentation fault ─────────────────────────────────────────────
  {
    id: 'segfault',
    name: 'Segmentation fault — binary corruption or ABI mismatch',
    pattern: /segmentation fault|sigsegv/i,
    diagnose: (match, ctx) => {
      const pkg = ctx.packageName ?? extractPackageFromCommand(ctx.command);
      return {
        id: 'segfault.binary-corruption',
        title: 'Segmentation fault — binary is corrupted or incompatible',
        what: `The process crashed with a segmentation fault. This usually means the binary is corrupted, was compiled for a different ABI, or has a missing shared library.`,
        why: `Common causes: incomplete download, disk corruption, architecture mismatch (e.g., x86 binary on ARM), or a broken shared library after a system update.`,
        evidence: match[0],
        repair: pkg ? `pkg reinstall ${pkg}` : 'Reinstall the affected package',
        autoRepairable: true,
        confidence: 0.6,
      };
    },
  },

  // ── No space left on device ────────────────────────────────────────
  {
    id: 'no-space',
    name: 'Disk full — no space left on device',
    pattern: /No space left on device/i,
    diagnose: (match, _ctx) => {
      return {
        id: 'no-space.disk-full',
        title: 'No space left on device',
        what: `The operation failed because your device's storage is full.`,
        why: `Linuxify needs free space for downloads and installations. A full disk can also leave partial installs that corrupt state.`,
        evidence: match[0],
        repair: 'linuxify gc  # then: pkg clean; rm -rf ~/.cache/*',
        autoRepairable: false, // User should review what to delete
        confidence: 0.95,
      };
    },
  },

  // ── Network unreachable / DNS failure ──────────────────────────────
  {
    id: 'network-unreachable',
    name: 'Network unreachable',
    pattern: /Could not resolve host|Temporary failure in name resolution|Network is unreachable/i,
    diagnose: (match, _ctx) => {
      return {
        id: 'network-unreachable.dns-or-offline',
        title: 'Network unreachable — DNS resolution failed',
        what: `The operation failed because a hostname could not be resolved. This is a network connectivity issue, not a Linuxify bug.`,
        why: `Either your device is offline, DNS is broken, or a firewall is blocking the connection. Corporate networks and some mobile carriers intercept DNS.`,
        evidence: match[0],
        repair: 'Check your network connection. Try: ping 8.8.8.8; ping github.com',
        autoRepairable: false,
        confidence: 0.9,
      };
    },
  },

  // ── EACCES (apt lock) ──────────────────────────────────────────────
  {
    id: 'apt-lock',
    name: 'apt/dpkg lock held by another process',
    pattern: /Could not get lock|Resource temporarily unavailable|another process is running/i,
    diagnose: (match, _ctx) => {
      return {
        id: 'apt-lock.held',
        title: 'Package manager is locked by another process',
        what: `Another package manager operation (apt, dpkg, pkg) is running. The lock prevents concurrent modifications.`,
        why: `This usually means a background update is running, or a previous apt/dpkg command crashed without releasing the lock.`,
        evidence: match[0],
        repair: 'Wait 30 seconds, or run: sudo rm /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock',
        autoRepairable: false, // Removing locks can be dangerous
        confidence: 0.85,
      };
    },
  },
];

/**
 * Extract the package name from a command string.
 *
 * Examples:
 *   "proot-distro list" → "proot-distro"
 *   "pkg install proot-distro" → "proot-distro"
 *   "/data/data/com.termux/files/usr/bin/proot-distro list" → "proot-distro"
 */
function extractPackageFromCommand(command: string): string | undefined {
  // Try to extract the binary name from the command.
  const parts = command.trim().split(/\s+/);
  if (parts.length === 0) return undefined;
  const firstPart = parts[0] ?? '';
  // If it's a path, get the basename.
  const basename = firstPart.split('/').pop() ?? firstPart;
  // If it looks like a package name (lowercase, no extension), return it.
  if (/^[a-z][a-z0-9_-]*$/.test(basename)) {
    return basename;
  }
  return undefined;
}

/**
 * Guess the Termux package name from a command name.
 *
 * Examples:
 *   "proot" → "proot"
 *   "proot-distro" → "proot-distro"
 *   "node" → "nodejs"
 *   "python3" → "python"
 */
function guessPackageFromCommand(cmd: string): string {
  const map: Record<string, string> = {
    node: 'nodejs',
    npm: 'nodejs',
    python: 'python',
    python3: 'python',
    pip: 'python',
    pip3: 'python',
    git: 'git',
    jq: 'jq',
    curl: 'curl',
    wget: 'wget',
    tar: 'tar',
    proot: 'proot',
    'proot-distro': 'proot-distro',
  };
  return map[cmd] ?? cmd;
}
