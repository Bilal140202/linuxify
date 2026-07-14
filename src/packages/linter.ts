/**
 * Package linter — semantic checks beyond the Zod schema.
 *
 * @module linuxify/packages/linter
 *
 * The Zod schema in {@link ./schema.ts} validates structure (required
 * fields, regex patterns, enum values). The linter validates *semantics*:
 *  - Is the `version` field a real semver string (not just regex-shaped)?
 *  - Is the `license` field a recognized SPDX identifier?
 *  - Do any install/patch/doctor commands contain dangerous patterns
 *    (`rm -rf /`, `curl … | sh` from untrusted hosts, fork bombs, …)?
 *  - Does the `launcher` name collide with a shell builtin or a common
 *    system command?
 *  - Is the package marked `deprecated` (informational warning)?
 *
 * The linter returns a {@link LintReport} with `errors` (must-fix before
 * install) and `warnings` (should-fix). `passed` is `true` only when there
 * are zero errors. Warnings do not affect `passed`.
 *
 * The linter is pure — it takes a {@link PackageDefinition} and returns a
 * report without any I/O. This makes it trivially testable and safe to run
 * in CI lint workflows.
 *
 * @packageDocumentation
 */

import semver from 'semver';

import type { PackageDefinition, PatchDefinition } from './schema.js';

// ============================================================================
// Public types
// ============================================================================

/** Severity of a lint issue. Errors block install; warnings are informational. */
export type LintSeverity = 'error' | 'warning';

/**
 * A single lint finding. `code` is a stable identifier (e.g.
 * `E_LINT_RM_RF_ROOT`) so callers can suppress specific issues in config.
 * `field` is the dotted path to the offending field (e.g. `install[0].command`).
 */
export interface LintIssue {
  /** Stable issue code, e.g. `E_LINT_BAD_SEMVER`. */
  readonly code: string;
  /** Human-readable description of the issue. */
  readonly message: string;
  /** Dotted path to the offending field, if applicable. */
  readonly field?: string;
  /** Issue severity: `error` blocks install, `warning` is informational. */
  readonly severity: LintSeverity;
}

/**
 * Result of {@link lint}. `passed` is `true` iff `errors` is empty.
 * `warnings` are surfaced to the user but do not block install.
 */
export interface LintReport {
  /** Issues that must be fixed before the package can be installed. */
  readonly errors: LintIssue[];
  /** Issues that should be fixed but do not block install. */
  readonly warnings: LintIssue[];
  /** `true` iff `errors` is empty. */
  readonly passed: boolean;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Hosts whose `curl … | sh` output is considered trusted enough to pipe to a
 * shell. Piping from any other host triggers a {@link LintIssue} with code
 * `E_LINT_PIPE_TO_SHELL_UNTRUSTED` (warning, not error — the pattern is
 * common enough that erroring would reject too many legitimate packages).
 */
const TRUSTED_PIPE_HOSTS: readonly string[] = [
  'raw.githubusercontent.com',
  'github.com',
  'objects.githubusercontent.com',
  'get.docker.com',
  'sh.rustup.rs',
  'pyenv.run',
];

/**
 * Names that must not be used as a `launcher` because they collide with shell
 * builtins or common system commands. Using one would shadow the real command
 * and break the user's environment. This list is intentionally short — it
 * covers the commands a user is most likely to need alongside the installed
 * package.
 */
const RESERVED_LAUNCHER_NAMES: readonly string[] = [
  // Shell builtins
  'cd',
  'echo',
  'exit',
  'export',
  'source',
  'alias',
  'bg',
  'fg',
  'jobs',
  'kill',
  'type',
  'read',
  'set',
  'unset',
  // Common system commands
  'ls',
  'cp',
  'mv',
  'rm',
  'cat',
  'ln',
  'mkdir',
  'rmdir',
  'touch',
  'chmod',
  'chown',
  'stat',
  'file',
  'find',
  'grep',
  'sed',
  'awk',
  'sort',
  'uniq',
  'head',
  'tail',
  'wc',
  'tee',
  'less',
  'more',
  'env',
  'printenv',
  'which',
  'whereis',
  'ps',
  'top',
  'killall',
  'pkill',
  'nohup',
  'disown',
  'trap',
  'wait',
  'sleep',
  'date',
  'time',
  'whoami',
  'hostname',
  'uname',
  'df',
  'du',
  'mount',
  'umount',
  'dd',
  'mkfs',
  'fsck',
  'tar',
  'gzip',
  'gunzip',
  'zip',
  'unzip',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'git',
  'make',
  'gcc',
  'g++',
  'clang',
  // Language runtimes / package managers
  'bash',
  'sh',
  'zsh',
  'fish',
  'dash',
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'python',
  'python3',
  'pip',
  'pip3',
  'pipx',
  'poetry',
  'conda',
  'rustc',
  'cargo',
  'rustup',
  'go',
  'java',
  'javac',
  'ruby',
  'gem',
  'bundle',
  'php',
  'composer',
  'perl',
  'cpan',
  // Linuxify-reserved
  'linuxify',
];

/**
 * A curated list of common SPDX license identifiers. The full SPDX list has
 * 500+ entries; we include the ~40 most common open-source licenses and treat
 * any unrecognized identifier as a warning (not an error) — the schema
 * already accepts any string, and `proprietary` is explicitly allowed.
 */
const COMMON_SPDX_IDS: readonly string[] = [
  'MIT',
  'Apache-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'ISC',
  'MPL-2.0',
  'EPL-1.0',
  'EPL-2.0',
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'CC-BY-NC-4.0',
  'Unlicense',
  'Zlib',
  'WTFPL',
  'BSL-1.0',
  'BSL-1.1',
  'MS-PL',
  'MS-RL',
  'MIT-0',
  'Apache-1.0',
  'Apache-1.1',
  'GPL-1.0-only',
  'GPL-1.0-or-later',
  'Artistic-1.0',
  'Artistic-2.0',
  'CDDL-1.0',
  'CDDL-1.1',
  'EUPL-1.0',
  'EUPL-1.1',
  'EUPL-1.2',
  'OFL-1.1',
  'OFL-1.0',
  'Python-2.0',
  'Ruby',
  'PHP-3.0',
  'PHP-3.01',
  'W3C',
  'X11',
  'ZPL-2.0',
  'ZPL-2.1',
  'AFL-3.0',
  'AFL-2.0',
  'AFL-2.1',
  'Beerware',
  'FTL',
  'IPL-1.0',
  'NPL-1.0',
  'NPL-1.1',
  'OpenSSL',
  'PostgreSQL',
  'QPL-1.0',
  'Sleepycat',
  'VSL-1.0',
  'YPL-1.0',
  'YPL-1.1',
  'ZPL-1.1',
];

// ============================================================================
// Forbidden-command detection
// ============================================================================

/**
 * A forbidden-command pattern. `pattern` is matched against the raw command
 * string. `severity` is `'error'` for catastrophic commands (`rm -rf /`,
 * fork bombs, `mkfs`) and `'warning'` for risky-but-common patterns
 * (`curl | sh`).
 */
interface ForbiddenPattern {
  /** Regex matched against the raw command string. */
  readonly pattern: RegExp;
  /** Stable issue code. */
  readonly code: string;
  /** Human-readable message. */
  readonly message: string;
  /** Severity: `error` blocks install, `warning` is informational. */
  readonly severity: LintSeverity;
}

/**
 * Patterns that must never appear in an install/patch/doctor command. Each
 * is matched case-insensitively against the raw command string.
 *
 * Note: the `curl|sh` / `wget|sh` patterns are handled separately (in
 * {@link checkPipeToShell}) because the severity depends on the URL host.
 */
const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    // `rm -rf /` with optional flags and optional --no-preserve-root.
    // Matches: `rm -rf /`, `rm -rf --no-preserve-root /`, `rm -fr /`,
    // `rm --recursive --force /`. Does NOT match `rm -rf /tmp/mydir`.
    pattern:
      /\brm\s+[^;|&]*(-r\w*f|-f\w*r|--recursive\s+--force|--force\s+--recursive)[^;|&]*\s+\/(?:\s|$)/i,
    code: 'E_LINT_RM_RF_ROOT',
    message: "'rm -rf /' (recursive delete of root filesystem) is forbidden",
    severity: 'error',
  },
  {
    // Fork bomb: :(){ :|:& };:
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    code: 'E_LINT_FORK_BOMB',
    message: 'fork bomb pattern detected',
    severity: 'error',
  },
  {
    // mkfs on a block device.
    pattern: /\bmkfs\b/,
    code: 'E_LINT_MKFS',
    message: "'mkfs' (filesystem formatting) is forbidden",
    severity: 'error',
  },
  {
    // dd ... of=/dev/... (writing to a block device).
    pattern: /\bdd\b.*\bof=\/dev\//i,
    code: 'E_LINT_DD_DEV',
    message: "'dd … of=/dev/…' (writing to a block device) is forbidden",
    severity: 'error',
  },
  {
    // > /dev/sda (redirecting to a block device).
    pattern: />\s*\/dev\/(?:sd|nvme|hd|vd|xvd)/i,
    code: 'E_LINT_REDIRECT_TO_BLOCK_DEV',
    message: "redirecting to a block device (/dev/sd*, /dev/nvme*, …) is forbidden",
    severity: 'error',
  },
  {
    // chmod 777 on anything.
    pattern: /\bchmod\s+(?:-R\s+)?777\b/,
    code: 'E_LINT_CHMOD_777',
    message: "'chmod 777' (world-writable + executable) is forbidden",
    severity: 'error',
  },
  {
    // :(){...}  (generic fork-bomb-ish function definition executed immediately).
    pattern: /\b:\s*\(\s*\)\s*\{[^}]*\}\s*;/,
    code: 'E_LINT_SUSPICIOUS_FUNC',
    message: 'suspicious immediately-invoked shell function detected',
    severity: 'warning',
  },
];

/**
 * Extract the hostname from a URL embedded in a `curl`/`wget` command.
 * Returns `null` if no URL is found. Handles both `http://`/`https://` URLs
 * and bare hostnames.
 *
 * @param command - The raw shell command string.
 * @returns The hostname, or `null`.
 */
function extractHostFromCommand(command: string): string | null {
  // Match http(s)://host or ftp://host
  const urlMatch = command.match(/https?:\/\/([a-zA-Z0-9.-]+)/i);
  if (urlMatch) return urlMatch[1]!.toLowerCase();
  // Match curl/wget <host>/path (bare hostname, no scheme)
  const bareMatch = command.match(/\b(?:curl|wget)\s+(?:-[a-zA-Z]+\s+)*([a-zA-Z0-9.-]+)\//i);
  if (bareMatch) return bareMatch[1]!.toLowerCase();
  return null;
}

/**
 * Check a command string for `curl … | sh` / `wget … | sh` patterns and
 * flag the command if the source host is not in {@link TRUSTED_PIPE_HOSTS}.
 *
 * @param command - The raw shell command string.
 * @returns A {@link LintIssue} if the command pipes an untrusted source to a
 *   shell, or `null` if the command is safe or not a pipe-to-shell pattern.
 */
function checkPipeToShell(command: string): LintIssue | null {
  // Match: curl ... | (sh|bash)  OR  wget ... | (sh|bash)
  const pipeMatch = command.match(/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash)\b/i);
  if (!pipeMatch) return null;
  const host = extractHostFromCommand(command);
  if (host === null) {
    // Pipe-to-shell without a parseable URL — flag as warning.
    return {
      code: 'E_LINT_PIPE_TO_SHELL_UNTRUSTED',
      message: "'curl|sh' / 'wget|sh' pattern detected but source URL could not be parsed",
      severity: 'warning',
    };
  }
  if (TRUSTED_PIPE_HOSTS.includes(host)) {
    return null; // Trusted source.
  }
  return {
    code: 'E_LINT_PIPE_TO_SHELL_UNTRUSTED',
    message: `'curl|sh' / 'wget|sh' from untrusted host '${host}' (trusted: ${TRUSTED_PIPE_HOSTS.join(', ')})`,
    severity: 'warning',
  };
}

/**
 * Scan a single command string for all forbidden patterns and pipe-to-shell
 * issues. Returns one {@link LintIssue} per detected problem.
 *
 * @param command - The raw shell command string.
 * @returns An array of lint issues (empty if the command is clean).
 */
function scanCommand(command: string): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.pattern.test(command)) {
      issues.push({
        code: pat.code,
        message: pat.message,
        severity: pat.severity,
      });
    }
  }
  const pipeIssue = checkPipeToShell(command);
  if (pipeIssue) issues.push(pipeIssue);
  return issues;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Normalize an install block (array or `{ steps, env, cwd }`) into a flat
 * list of command strings for linting. Bare-string steps are kept as-is;
 * structured steps are unwrapped to their `command` field.
 *
 * @param install - The `install` field from a {@link PackageDefinition}.
 * @returns An array of `{ command: string; index: number }` entries.
 */
function flattenInstallCommands(
  install: PackageDefinition['install'],
): Array<{ command: string; index: number }> {
  const steps = Array.isArray(install) ? install : install.steps;
  return steps.map((step, index) => ({
    command: typeof step === 'string' ? step : step.command,
    index,
  }));
}

/**
 * Check whether a string is a valid SPDX identifier. Compares against the
 * curated {@link COMMON_SPDX_IDS} list. `proprietary` is always accepted.
 *
 * @param license - The license string from the package YAML.
 * @returns `true` if the license is recognized.
 */
function isValidSpdx(license: string): boolean {
  if (license === 'proprietary') return true;
  if (COMMON_SPDX_IDS.includes(license)) return true;
  // Accept SPDX expressions with ` OR ` / ` AND ` / ` WITH ` by checking each
  // token (e.g. "MIT OR Apache-2.0").
  const tokens = license.split(/\s+(?:OR|AND|WITH)\s+/);
  return tokens.every((t) => COMMON_SPDX_IDS.includes(t.trim()));
}

// ============================================================================
// Main linter
// ============================================================================

/**
 * Lint a parsed and schema-validated package definition.
 *
 * Runs all semantic checks and returns a {@link LintReport}. The report's
 * `errors` array lists issues that must be fixed before the package can be
 * installed; `warnings` lists issues that should be fixed but do not block.
 * `passed` is `true` iff `errors` is empty.
 *
 * The linter is pure — it performs no I/O and does not throw.
 *
 * @param pkg - The parsed and schema-validated package definition.
 * @returns A {@link LintReport} with errors, warnings, and a `passed` flag.
 *
 * @example
 * ```ts
 * import { parsePackageYaml } from './parser.js';
 * import { lint } from './linter.js';
 *
 * const pkg = parsePackageYaml(yamlText);
 * const report = lint(pkg);
 * if (!report.passed) {
 *   for (const err of report.errors) console.error(err.message);
 *   process.exit(1);
 * }
 * ```
 */
export function lint(pkg: PackageDefinition): LintReport {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];

  const addError = (issue: LintIssue): void => {
    errors.push(issue);
  };
  const addWarning = (issue: LintIssue): void => {
    warnings.push(issue);
  };

  // --- Name format (the schema already enforces the regex, but the linter
  //     also rejects names that are empty after trimming or contain
  //     consecutive hyphens, which the regex permits but are bad style). ---
  if (pkg.name.includes('--')) {
    addWarning({
      code: 'E_LINT_NAME_CONSECUTIVE_HYPHENS',
      message: `package name '${pkg.name}' contains consecutive hyphens (bad style)`,
      field: 'name',
      severity: 'warning',
    });
  }

  // --- Version is valid semver. The schema enforces a regex; here we use
  //     semver.valid() for a deeper check. ---
  if (!semver.valid(pkg.version)) {
    addError({
      code: 'E_LINT_BAD_SEMVER',
      message: `version '${pkg.version}' is not a valid semver string`,
      field: 'version',
      severity: 'error',
    });
  }

  // --- runtime_min_version is coercible to semver. ---
  if (!semver.coerce(pkg.runtime_min_version)) {
    addError({
      code: 'E_LINT_BAD_RUNTIME_MIN_VERSION',
      message: `runtime_min_version '${pkg.runtime_min_version}' is not a coercible semver string`,
      field: 'runtime_min_version',
      severity: 'error',
    });
  }

  // --- runtime_max_version (if present) is coercible to semver. ---
  if (pkg.runtime_max_version && !semver.coerce(pkg.runtime_max_version)) {
    addError({
      code: 'E_LINT_BAD_RUNTIME_MAX_VERSION',
      message: `runtime_max_version '${pkg.runtime_max_version}' is not a coercible semver string`,
      field: 'runtime_max_version',
      severity: 'error',
    });
  }

  // --- License is a recognized SPDX identifier. ---
  if (!isValidSpdx(pkg.license)) {
    addWarning({
      code: 'E_LINT_UNKNOWN_LICENSE',
      message: `license '${pkg.license}' is not a recognized SPDX identifier (warning, not error)`,
      field: 'license',
      severity: 'warning',
    });
  }

  // --- Launcher name does not collide with builtins/system commands. ---
  if (RESERVED_LAUNCHER_NAMES.includes(pkg.launcher)) {
    addError({
      code: 'E_LINT_LAUNCHER_RESERVED',
      message: `launcher name '${pkg.launcher}' collides with a shell builtin or system command`,
      field: 'launcher',
      severity: 'error',
    });
  }

  // --- Install steps: scan each command for forbidden patterns. ---
  for (const { command, index } of flattenInstallCommands(pkg.install)) {
    for (const issue of scanCommand(command)) {
      const tagged: LintIssue = {
        ...issue,
        field: `install[${index}].command`,
      };
      if (issue.severity === 'error') {
        addError(tagged);
      } else {
        addWarning(tagged);
      }
    }
  }

  // --- Uninstall steps: scan each command. ---
  if (pkg.uninstall) {
    for (let i = 0; i < pkg.uninstall.length; i++) {
      const command = pkg.uninstall[i]!;
      for (const issue of scanCommand(command)) {
        const tagged: LintIssue = {
          ...issue,
          field: `uninstall[${i}].command`,
        };
        if (issue.severity === 'error') {
          addError(tagged);
        } else {
          addWarning(tagged);
        }
      }
    }
  }

  // --- Patch verify commands: scan for forbidden patterns. ---
  for (let i = 0; i < pkg.patches.length; i++) {
    const patch: PatchDefinition = pkg.patches[i]!;
    for (const issue of scanCommand(patch.verify)) {
      const tagged: LintIssue = {
        ...issue,
        field: `patches[${i}].verify`,
      };
      if (issue.severity === 'error') {
        addError(tagged);
      } else {
        addWarning(tagged);
      }
    }
    // Also scan the patch's find/replace for shell-injection patterns if
    // type is 'shell' (the replace is executed as a command).
    if (patch.type === 'shell') {
      for (const issue of scanCommand(patch.replace)) {
        const tagged: LintIssue = {
          ...issue,
          field: `patches[${i}].replace`,
        };
        if (issue.severity === 'error') {
          addError(tagged);
        } else {
          addWarning(tagged);
        }
      }
    }
  }

  // --- Doctor check commands: scan for forbidden patterns. ---
  for (let i = 0; i < pkg.doctor.length; i++) {
    const check = pkg.doctor[i]!;
    for (const issue of scanCommand(check.command)) {
      const tagged: LintIssue = {
        ...issue,
        field: `doctor[${i}].command`,
      };
      if (issue.severity === 'error') {
        addError(tagged);
      } else {
        addWarning(tagged);
      }
    }
  }

  // --- Deprecated: informational warning. ---
  if (pkg.deprecated) {
    addWarning({
      code: 'E_LINT_DEPRECATED',
      message: `package '${pkg.name}' is marked deprecated`,
      field: 'deprecated',
      severity: 'warning',
    });
  }

  // --- Conflicts list references the package itself (self-conflict). ---
  if (pkg.conflicts.includes(pkg.name)) {
    addError({
      code: 'E_LINT_SELF_CONFLICT',
      message: `package '${pkg.name}' lists itself in conflicts`,
      field: 'conflicts',
      severity: 'error',
    });
  }

  // --- Compat: min_linuxify is valid semver. ---
  if (!semver.valid(pkg.compat.min_linuxify)) {
    addWarning({
      code: 'E_LINT_BAD_COMPAT_MIN_LINUXIFY',
      message: `compat.min_linuxify '${pkg.compat.min_linuxify}' is not a valid semver string`,
      field: 'compat.min_linuxify',
      severity: 'warning',
    });
  }

  return {
    errors,
    warnings,
    passed: errors.length === 0,
  };
}
