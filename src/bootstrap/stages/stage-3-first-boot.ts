// src/bootstrap/stages/stage-3-first-boot.ts
//
// Stage 3 — First-boot inside proot.
//
// Logs into the freshly-extracted Ubuntu rootfs via `proot-distro login`,
// runs `apt update`, installs the base package set Linuxify depends on
// (build-essential, pkg-config, curl, wget, git, ca-certificates, locales,
// tzdata, sudo, gnupg), generates the configured locale, sets the timezone,
// and creates the `linuxify` user (UID 1000) that all `linuxify run`
// invocations will drop to.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 3) and
// docs/02-architecture/implementation-walkthroughs.md §4 for a code
// walkthrough of the same flow.

import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/**
 * Packages installed inside the proot during Stage 3 first-boot.
 *
 * `build-essential` + `pkg-config` are required to compile native npm/pip
 * extensions; `curl`/`wget` fetch runtime tarballs; `git` is needed by
 * package install steps that clone from GitHub; `ca-certificates` makes
 * HTTPS work inside the proot; `locales` + `tzdata` back locale/timezone
 * configuration; `sudo` lets the `linuxify` user perform privileged ops
 * inside the proot when explicitly invoked; `gnupg` is needed by apt for
 * repository signature verification.
 */
export const FIRST_BOOT_PACKAGES: readonly string[] = [
  'build-essential',
  'pkg-config',
  'curl',
  'wget',
  'git',
  'ca-certificates',
  'locales',
  'tzdata',
  'sudo',
  'gnupg',
] as const;

/** Hard timeout for the first-boot script (15 minutes — apt install is slow). */
const FIRST_BOOT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Bootstrap Stage 3: first-boot inside proot.
 *
 * Enters the freshly-extracted rootfs via `proot-distro login`, runs
 * `apt-get update`, installs the base package set, generates the configured
 * locale, sets the timezone, and creates the `linuxify` user (UID 1000).
 * The whole sequence runs as a single `bash -c '<script>'` invocation to
 * amortise the ~300 ms proot enter cost.
 *
 * Idempotency: each line of the script is either a no-op when re-run
 * (`apt-get install` of existing packages) or guarded by `|| true`
 * (`echo >> /etc/passwd` would otherwise duplicate the line on re-runs).
 * The `linuxify` user creation uses `id` to check existence before
 * appending to `/etc/passwd`.
 *
 * @param ctx - Bootstrap context (reads `config.bootstrap.locale` and
 *   `config.bootstrap.timezone`).
 */
export async function stage3FirstBoot(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  const locale = ctx.config.bootstrap.locale || 'en_US.UTF-8';
  // Default to Etc/UTC (the canonical Zoneinfo name); fall back to bare UTC
  // for callers that explicitly configure the latter.
  const timezone = ctx.config.bootstrap.timezone || 'Etc/UTC';

  try {
    const script = buildFirstBootScript(locale, timezone);

    logger.info('stage 3: proot-distro login ubuntu -- bash -c <script>');
    const result = await exec(
      'proot-distro',
      ['login', 'ubuntu', '--', 'bash', '-c', script],
      {
        timeoutMs: FIRST_BOOT_TIMEOUT_MS,
        env: {
          TERM: 'dumb',
          DEBIAN_FRONTEND: 'noninteractive',
        },
      },
    );

    if (result.exitCode !== 0) {
      return fail(
        start,
        `Stage 3 first-boot script failed (exit ${result.exitCode}). Try 'linuxify init --from-stage 3' to retry, or 'proot-distro login ubuntu -- dpkg --configure -a && apt-get -f install' to repair a partial apt install.`,
        {
          exitCode: result.exitCode,
          stderr: tail(result.stderr, 2000),
          stdout: tail(result.stdout, 1000),
          locale,
          timezone,
          packages: FIRST_BOOT_PACKAGES,
        },
      );
    }

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        locale,
        timezone,
        packages: FIRST_BOOT_PACKAGES,
        stdoutTail: tail(result.stdout, 500),
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 3 threw: ${(e as Error).message}`,
      details: { name: (e as Error).name, locale, timezone },
    };
  }
}

/**
 * Build the bash script that runs inside the proot. Kept as a separate
 * exported function so unit tests can assert on its contents without
 * spawning proot.
 *
 * @param locale - Locale to generate (e.g. "en_US.UTF-8").
 * @param timezone - Zoneinfo path component (e.g. "Etc/UTC" or "UTC").
 * @returns A multi-line bash script string.
 */
export function buildFirstBootScript(locale: string, timezone: string): string {
  // The script is heredoc-free and uses `set -e` so any failing command
  // aborts the whole script (and surfaces a non-zero exit code to exec).
  // Lines that may legitimately fail on re-run are guarded with `|| true`.
  return [
    'set -e',
    'echo "[stage 3] apt update"',
    'apt-get update -qq',
    '',
    'echo "[stage 3] installing base packages"',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \\',
    ...FIRST_BOOT_PACKAGES.map((p, i) => `  ${p}${i < FIRST_BOOT_PACKAGES.length - 1 ? ' \\' : ''}`),
    '',
    `echo "[stage 3] generating locale ${locale}"`,
    `sed -i 's/^# *${escapeForSed(locale)}/${escapeForSed(locale)}/' /etc/locale.gen || true`,
    `locale-gen ${locale} || true`,
    `update-locale LANG=${locale} || true`,
    '',
    `echo "[stage 3] setting timezone to ${timezone}"`,
    `echo '${timezone}' > /etc/timezone`,
    `ln -sf /usr/share/zoneinfo/${timezone} /etc/localtime || true`,
    `dpkg-reconfigure -f noninteractive tzdata 2>/dev/null || true`,
    '',
    'echo "[stage 3] ensuring linuxify user (uid 1000)"',
    "if ! id linuxify >/dev/null 2>&1; then",
    "  echo 'linuxify:x:1000:1000:Linuxify:/home/linuxify:/bin/bash' >> /etc/passwd",
    "  echo 'linuxify:*:19000:0:99999:7:::' >> /etc/shadow",
    "  echo 'linuxify:x:1000:' >> /etc/group",
    'fi',
    'mkdir -p /home/linuxify',
    'chown 1000:1000 /home/linuxify',
    '',
    'echo "[stage 3] cleaning apt cache"',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    '',
    'echo "[stage 3] done"',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fail(
  start: number,
  message: string,
  details: Readonly<Record<string, unknown>>,
): StageResult {
  return {
    success: false,
    durationMs: Date.now() - start,
    error: message,
    details,
  };
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `...${s.slice(-max)}`;
}

/**
 * Escape a string for use as a literal in `sed`'s `s/.../.../` command.
 * Only the characters that have meaning in a sed regex character class
 * need escaping here: `/`, `.`, `+`, `?`, `(`, `)`, `[`, `]`, `{`, `}`, `*`,
 * `\`, `^`, `$`.
 */
function escapeForSed(s: string): string {
  return s.replace(/[/.+?()[\]{}*\\^$]/g, '\\$&');
}
