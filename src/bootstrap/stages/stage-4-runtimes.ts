// src/bootstrap/stages/stage-4-runtimes.ts
//
// Stage 4 — Install runtimes (Node LTS + Python 3.12) inside the proot.
//
// Installs Node.js LTS via the NodeSource apt repository (preferred over
// `nvm` because nvm adds a shell-init cost we want to avoid, and over
// Ubuntu's bundled `nodejs` package because it's typically too old). Installs
// Python 3.12 (the Ubuntu 24.04 default) via apt. Verifies each runtime
// executes inside the proot.
//
// See docs/05-bootstrap/bootstrap-design.md §2 (Stage 4) and
// docs/06-launcher/runtime-management.md §5 for the per-distro runtime
// layout rationale.

import { logger } from '../../utils/log.js';
import { exec } from '../../utils/process.js';
import type { BootstrapContext, StageResult } from '../types.js';

/** Hard timeout for the runtime install script (15 minutes). */
const RUNTIMES_TIMEOUT_MS = 15 * 60 * 1000;

/** NodeSource setup script URL — installs the apt repo for the LTS line. */
const NODESOURCE_SETUP_URL = 'https://deb.nodesource.com/setup_lts.x';

/** Apt packages installed for Python 3.12 (Ubuntu 24.04 default version). */
const PYTHON_APT_PACKAGES: readonly string[] = [
  'python3',
  'python3-pip',
  'python3-venv',
  'python3-dev',
] as const;

/**
 * Bootstrap Stage 4: install runtimes.
 *
 * Runs a single `proot-distro login ubuntu -- bash -c '<script>'`
 * invocation that:
 *  1. Adds the NodeSource apt repository for the LTS line.
 *  2. `apt-get install -y nodejs` (pulls the latest LTS).
 *  3. `apt-get install -y python3 python3-pip python3-venv python3-dev`.
 *  4. Verifies `node --version`, `npm --version`, and `python3 --version`
 *     all execute (exit 0).
 *  5. Cleans the apt cache and npm cache to reclaim ~150 MB.
 *
 * Idempotency: every step is a no-op when the target version is already
 * installed. The NodeSource setup script is safe to re-run.
 *
 * @param ctx - Bootstrap context (reads `config.runtime.node.version` if set
 *   to pin a non-LTS Node version — left for future use in v1).
 */
export async function stage4Runtimes(ctx: BootstrapContext): Promise<StageResult> {
  const start = Date.now();

  // v1 always installs Node LTS + Python 3.12. The Config schema exposes
  // `runtime.node_default_version` and `runtime.python_default_version`
  // (defaulting to "lts" and "3.12" respectively); we surface them in logs
  // but do not yet implement version pinning — NodeSource setup_lts.x
  // always installs the current LTS.
  const nodeVersion = ctx.config.runtime?.node_default_version ?? 'lts';
  const pythonVersion = ctx.config.runtime?.python_default_version ?? '3.12';

  logger.info('stage 4: installing runtimes', { nodeVersion, pythonVersion });

  try {
    const script = buildRuntimesScript(NODESOURCE_SETUP_URL, PYTHON_APT_PACKAGES);

    const result = await exec(
      'proot-distro',
      ['login', 'ubuntu', '--', 'bash', '-c', script],
      {
        timeoutMs: RUNTIMES_TIMEOUT_MS,
        env: {
          TERM: 'dumb',
          DEBIAN_FRONTEND: 'noninteractive',
        },
      },
    );

    if (result.exitCode !== 0) {
      return fail(
        start,
        `Stage 4 runtime install failed (exit ${result.exitCode}). Try 'linuxify init --from-stage 4' to retry.`,
        {
          exitCode: result.exitCode,
          stderr: tail(result.stderr, 2000),
          stdout: tail(result.stdout, 1000),
          nodeVersion,
          pythonVersion,
        },
      );
    }

    // Parse `node --version` and `python3 --version` from the script's
    // stdout markers so we can record them in state.json later.
    const details = parseRuntimeVersions(result.stdout);

    return {
      success: true,
      durationMs: Date.now() - start,
      details: {
        ...details,
        nodeChannel: nodeVersion,
        pythonChannel: pythonVersion,
      },
    };
  } catch (e) {
    return {
      success: false,
      durationMs: Date.now() - start,
      error: `Stage 4 threw: ${(e as Error).message}`,
      details: { name: (e as Error).name, nodeVersion, pythonVersion },
    };
  }
}

/**
 * Build the bash script that installs Node LTS + Python inside the proot.
 * Exported so unit tests can assert on its contents.
 *
 * @param nodesourceUrl - NodeSource setup script URL.
 * @param pythonPackages - Apt packages to install for Python.
 * @returns A multi-line bash script string.
 */
export function buildRuntimesScript(
  nodesourceUrl: string,
  pythonPackages: readonly string[],
): string {
  return [
    'set -e',
    'echo "[stage 4] apt update"',
    'apt-get update -qq',
    '',
    'echo "[stage 4] adding NodeSource apt repository (LTS)"',
    `curl -fsSL ${nodesourceUrl} | bash -`,
    '',
    'echo "[stage 4] installing nodejs (LTS)"',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends nodejs',
    '',
    `echo "[stage 4] installing python packages: ${pythonPackages.join(' ')}"`,
    `DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pythonPackages.join(' ')}`,
    '',
    'echo "[stage 4] verifying runtimes"',
    'echo "LINUXIFY_NODE_VERSION=$(node --version)"',
    'echo "LINUXIFY_NPM_VERSION=$(npm --version)"',
    'echo "LINUXIFY_PYTHON_VERSION=$(python3 --version)"',
    '',
    'echo "[stage 4] cleaning caches"',
    'apt-get clean',
    'rm -rf /var/lib/apt/lists/*',
    'npm cache clean --force 2>/dev/null || true',
    '',
    'echo "[stage 4] done"',
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
 * Parse the `LINUXIFY_NODE_VERSION=...` / `LINUXIFY_NPM_VERSION=...` /
 * `LINUXIFY_PYTHON_VERSION=...` markers emitted by the runtimes script.
 * Returns `{}` if no markers are found (defensive — older script versions
 * may not emit them).
 */
function parseRuntimeVersions(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  const patterns: Array<[string, RegExp]> = [
    ['nodeVersion', /^LINUXIFY_NODE_VERSION=(.+)$/m],
    ['npmVersion', /^LINUXIFY_NPM_VERSION=(.+)$/m],
    ['pythonVersion', /^LINUXIFY_PYTHON_VERSION=(.+)$/m],
  ];
  for (const [key, re] of patterns) {
    const m = re.exec(stdout);
    if (m?.[1]) out[key] = m[1].trim();
  }
  return out;
}
