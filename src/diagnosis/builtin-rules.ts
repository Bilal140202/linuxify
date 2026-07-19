/**
 * Built-in diagnosis rules — hand-authored mappings from doctor check IDs to
 * diagnoses. These cover the most common failure modes users hit.
 *
 * @module linuxify/diagnosis/builtin-rules
 *
 * Each rule is short, focused, and self-contained. New rules are added as
 * bug reports reveal common failure patterns. See `docs/07-doctor/diagnostics.md`
 * for the issue catalog these rules address.
 */

import type { Diagnosis, DiagnosisRule, RepairPlan } from './engine.js';
import type { DoctorResult } from '../doctor/types.js';
import type { Report } from '../report/index.js';

/**
 * Helper to build a repair plan.
 */
function plan(opts: {
  summary: string;
  description: string;
  steps: RepairPlan['steps'];
  risk: RepairPlan['risk'];
  fixes: string[];
  doesNotFix?: string[];
  requiresNetwork?: boolean;
}): RepairPlan {
  return {
    summary: opts.summary,
    description: opts.description,
    steps: opts.steps,
    risk: opts.risk,
    fixes: opts.fixes,
    doesNotFix: opts.doesNotFix ?? [],
    requiresNetwork: opts.requiresNetwork ?? false,
    estimatedDurationSeconds: opts.steps.reduce((s, st) => s + st.estimatedSeconds, 0),
  };
}

/**
 * The built-in rule set. Registered at module load.
 */
export const builtinRules: DiagnosisRule[] = [
  // ── host.termux ─────────────────────────────────────────────────────
  {
    checkId: 'host.termux',
    name: 'Termux installation check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail' && result.status !== 'missing') return null;
      return {
        id: 'host.termux.not_fdroid',
        title: 'Termux is missing or from the wrong source',
        what:
          'Linuxify requires Termux from F-Droid. The Google Play Store version of Termux is deprecated and will fail in confusing ways (no `exec()`, stale packages, broken proot).',
        why:
          'Either Termux is not installed at all, or the installed version is the Play Store build. Play Store Termux hasn\'t been updated since 2020 and is missing security patches and proot compatibility fixes.',
        evidence: [
          {
            checkId: 'host.termux',
            checkName: result.name,
            status: result.status,
            message: result.message,
            interpretation: 'Termux binary not found or version too old',
          },
        ],
        repair: plan({
          summary: 'Install Termux from F-Droid',
          description:
            'Uninstall any existing Termux, then install the F-Droid version from the official F-Droid catalog or the F-Droid APK directly. Do NOT use Google Play.',
          steps: [
            {
              description: 'Uninstall existing Termux (if any)',
              command: 'pm uninstall com.termux',
              modifiesState: false,
              estimatedSeconds: 5,
            },
            {
              description:
                'Install F-Droid from https://f-droid.org, then install Termux from F-Droid',
              command: '',
              modifiesState: false,
              estimatedSeconds: 120,
            },
            {
              description: 'Re-run Linuxify init after Termux is installed',
              command: 'linuxify init',
              modifiesState: true,
              estimatedSeconds: 300,
            },
          ],
          risk: 'moderate',
          fixes: ['Termux will be installed from the correct source'],
          doesNotFix: ['Existing Termux data is lost (back up first!)'],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/23-mobile/termux-internals.md',
        confidence: 0.95,
      };
    },
  },

  // ── bootstrap.completed ────────────────────────────────────────────
  {
    checkId: 'bootstrap.completed',
    name: 'Bootstrap completion check',
    async diagnose(result: DoctorResult, envReport?: Report): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;

      // Read stage info from the doctor result's detail field (populated by
      // the bootstrap.completed check from marker files on disk).
      // This ensures fix and doctor report the SAME stage count.
      const detail = result.detail as {
        done?: number[];
        failed?: number[];
        missing?: number[];
        nextStage?: number;
        nextStageName?: string;
      } | undefined;

      const stagesDone = detail?.done ?? envReport?.install.bootstrapStagesDone ?? [];
      const stagesFailed = detail?.failed ?? envReport?.install.bootstrapStagesFailed ?? [];
      const nextStage = detail?.nextStage ?? stagesDone.length;
      const nextStageName = detail?.nextStageName ?? `stage ${nextStage}`;

      return {
        id: 'bootstrap.incomplete',
        title: `Bootstrap is incomplete (${stagesDone.length}/9 stages)`,
        what: `Linuxify's bootstrap process didn't finish. Stage ${nextStage} (${nextStageName}) is the next one that needs to run. Without a complete bootstrap, no packages can be installed or run.`,
        why: stagesFailed.length > 0
          ? `Stage ${stagesFailed[0]} previously failed. The most common causes are: broken proot-distro (Python upgrade), network errors during rootfs download, out-of-storage, or a Termux/proot version mismatch. Check if proot-distro is working first.`
          : 'Bootstrap was started but never finished — likely the process was interrupted (closed Termux, phone rebooted, etc.).',
        evidence: [
          {
            checkId: 'bootstrap.completed',
            checkName: result.name,
            status: result.status,
            message: result.message,
            interpretation: `${stagesDone.length}/9 stages complete, next: stage ${nextStage} (${nextStageName})`,
          },
        ],
        repair: plan({
          summary: `Resume bootstrap from stage ${nextStage}`,
          description: `Linuxify's bootstrap is idempotent — re-running \`linuxify init\` picks up where it left off. If a specific stage keeps failing, check if proot-distro is working (\`proot-distro list\`) before retrying.`,
          steps: [
            {
              description: 'Resume bootstrap',
              command: `linuxify init`,
              modifiesState: true,
              estimatedSeconds: 180,
            },
          ],
          risk: 'safe',
          fixes: ['Completes the bootstrap process', 'Enables package installation'],
          doesNotFix: ['Does not fix the underlying cause if a stage keeps failing'],
          requiresNetwork: true,
        }),
        alternatives: [
          plan({
            summary: 'Force a full re-bootstrap',
            description:
              'If resuming keeps failing, force a complete re-run. This removes stage markers but preserves your config.',
            steps: [
              {
                description: 'Force re-bootstrap',
                command: 'linuxify init --force',
                modifiesState: true,
                estimatedSeconds: 600,
              },
            ],
            risk: 'moderate',
            fixes: ['Clean re-bootstrap'],
            doesNotFix: ['Does not preserve partial state'],
            requiresNetwork: true,
          }),
        ],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/05-bootstrap/bootstrap-design.md',
        confidence: 0.9,
      };
    },
  },

  // ── distro.installed ───────────────────────────────────────────────
  {
    checkId: 'distro.installed',
    name: 'Active distro installation check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;
      return {
        id: 'distro.not_installed',
        title: 'No active distro is installed',
        what: 'Linuxify has no active Linux distribution (Ubuntu, Debian, etc.) to run packages in. Every package install and run requires a distro.',
        why: 'Either bootstrap never completed, or the active distro was manually removed. The state.json points to a distro that no longer has a rootfs on disk.',
        evidence: [
          {
            checkId: 'distro.installed',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Install the default distro (Ubuntu)',
          description: 'Run linuxify init to install Ubuntu 24.04, or linuxify distros install <name> for a different distro.',
          steps: [
            {
              description: 'Install Ubuntu distro',
              command: 'linuxify distros install ubuntu',
              modifiesState: true,
              estimatedSeconds: 180,
            },
            {
              description: 'Set as active',
              command: 'linuxify use ubuntu',
              modifiesState: true,
              estimatedSeconds: 5,
            },
          ],
          risk: 'safe',
          fixes: ['Provides a distro for package installation'],
          doesNotFix: ['Does not reinstall previously-installed packages'],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/05-bootstrap/distro-management.md',
        confidence: 0.9,
      };
    },
  },

  // ── path.linuxify_bin ──────────────────────────────────────────────
  {
    checkId: 'path.linuxify_bin',
    name: 'Linuxify bin on PATH',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;
      return {
        id: 'path.linuxify_bin.missing',
        title: 'Linuxify bin directory is not on PATH',
        what: 'The `~/.linuxify/bin` directory (where Linuxify installs launcher shims) is not on your shell PATH. Commands like `cline` and `codex` won\'t be found even though they\'re installed.',
        why: 'PATH wiring is part of bootstrap stage 6. Either bootstrap didn\'t complete, or your shell rc files were reset (e.g., Termux app data cleared, new shell installed).',
        evidence: [
          {
            checkId: 'path.linuxify_bin',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Repair PATH wiring',
          description: 'Re-runs bootstrap stage 6, which adds ~/.linuxify/bin to PATH in ~/.bashrc, ~/.zshrc, and ~/.profile. Safe and idempotent.',
          steps: [
            {
              description: 'Repair PATH',
              command: 'linuxify repair paths',
              modifiesState: true,
              estimatedSeconds: 5,
            },
            {
              description: 'Reload your shell (or open a new Termux session)',
              command: 'source ~/.bashrc',
              modifiesState: false,
              estimatedSeconds: 1,
            },
          ],
          risk: 'safe',
          fixes: ['Launcher commands will be found on PATH'],
          doesNotFix: ['Does not install any new packages'],
          requiresNetwork: false,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/22-operations/troubleshooting.md',
        confidence: 0.95,
      };
    },
  },

  // ── path.proot ──────────────────────────────────────────────────────
  {
    checkId: 'path.proot',
    name: 'proot availability check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;
      return {
        id: 'path.proot.missing',
        title: 'proot is not installed',
        what: 'proot and/or proot-distro is not on PATH. Linuxify uses proot to run a real Linux distro inside Termux without root.',
        why: 'proot is installed as part of bootstrap stage 1 (host deps). If it\'s missing, either bootstrap didn\'t complete or the Termux packages were removed.',
        evidence: [
          {
            checkId: 'path.proot',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Install proot and proot-distro',
          description: 'Uses Termux pkg to install proot and proot-distro. Safe and fast.',
          steps: [
            {
              description: 'Install proot packages',
              command: 'pkg install -y proot proot-distro',
              modifiesState: true,
              estimatedSeconds: 30,
            },
          ],
          risk: 'safe',
          fixes: ['proot will be available for Linuxify to use'],
          doesNotFix: ['Does not install any distro'],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/23-mobile/termux-internals.md',
        confidence: 0.95,
      };
    },
  },

  // ── runtime.node ────────────────────────────────────────────────────
  {
    checkId: 'runtime.node',
    name: 'Node.js runtime check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail' && result.status !== 'missing') return null;
      return {
        id: 'runtime.node.missing',
        title: 'Node.js is not installed or too old',
        what: 'Node.js is required by most AI coding CLIs (Cline, Codex, Goose, Gemini CLI). Linuxify couldn\'t find a usable Node.js inside the active distro.',
        why: 'Node.js is installed during bootstrap stage 4. If it\'s missing, either bootstrap didn\'t complete or the Node installation got removed/corrupted.',
        evidence: [
          {
            checkId: 'runtime.node',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Reinstall Node.js LTS',
          description: 'Uses the runtime manager to install Node.js LTS inside the active distro.',
          steps: [
            {
              description: 'Install Node.js LTS',
              command: 'linuxify runtimes install node lts',
              modifiesState: true,
              estimatedSeconds: 120,
            },
          ],
          risk: 'safe',
          fixes: ['Node.js will be available for CLI packages'],
          doesNotFix: ['Does not reinstall npm packages that were globally installed'],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/06-launcher/runtime-management.md',
        confidence: 0.9,
      };
    },
  },

  // ── compat.platform ────────────────────────────────────────────────
  {
    checkId: 'compat.platform',
    name: 'Platform detection inside proot',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;
      return {
        id: 'compat.platform.android',
        title: 'process.platform reports "android" inside proot',
        what: 'Inside proot, Node.js still reports `process.platform === "android"` because proot translates syscalls but doesn\'t change the kernel. Many CLIs check `process.platform === "linux"` and refuse to run.',
        why: 'This is the core compatibility issue Linuxify exists to solve. The patcher applies patches to make CLIs accept "android" as a Linux variant, but either no patches are applied or the patches were reverted by an update.',
        evidence: [
          {
            checkId: 'compat.platform',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Re-apply platform patches to installed packages',
          description: 'Runs `linuxify patch <pkg>` for each installed package, re-applying the platform detection patches.',
          steps: [
            {
              description: 'Re-patch all installed packages',
              command: 'linuxify patch --all',
              modifiesState: true,
              estimatedSeconds: 30,
            },
          ],
          risk: 'safe',
          fixes: ['CLIs will treat Android-proot as Linux'],
          doesNotFix: ['Does not fix CLIs with no known patch (those need a new patch definition)'],
          requiresNetwork: false,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/08-patcher/platform-detection.md',
        confidence: 0.95,
      };
    },
  },

  // ── network.github / network.npm ───────────────────────────────────
  {
    checkId: 'network.github',
    name: 'GitHub reachability check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;
      return {
        id: 'network.github.unreachable',
        title: 'Cannot reach github.com',
        what: 'Linuxify couldn\'t reach github.com. The registry, package downloads, and self-update all require GitHub access.',
        why: 'Either your network is blocking GitHub, you\'re offline, or there\'s a DNS issue. Corporate networks and some mobile carriers block or throttle GitHub.',
        evidence: [
          {
            checkId: 'network.github',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Diagnose network connectivity',
          description: 'Run basic network diagnostics to identify where the connection fails.',
          steps: [
            {
              description: 'Check DNS resolution',
              command: 'nslookup github.com',
              modifiesState: false,
              estimatedSeconds: 5,
            },
            {
              description: 'Check HTTPS connectivity',
              command: 'curl -I https://github.com',
              modifiesState: false,
              estimatedSeconds: 10,
            },
            {
              description: 'If on corporate network, ask IT about GitHub access',
              command: '',
              modifiesState: false,
              estimatedSeconds: 0,
            },
          ],
          risk: 'safe',
          fixes: ['Identifies the network issue'],
          doesNotFix: ['Does not bypass network restrictions'],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/22-operations/troubleshooting.md',
        confidence: 0.7,
      };
    },
  },

  // ── host.storage ───────────────────────────────────────────────────
  {
    checkId: 'host.storage',
    name: 'Free storage space check',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail' && result.status !== 'warn') return null;
      return {
        id: 'host.storage.low',
        title: 'Low on storage space',
        what: 'Linuxify needs at least 2 GB free for bootstrap, and each package install adds ~50-500 MB. Your device is below the safe threshold.',
        why: 'Android devices have limited internal storage. Termux, proot distros, and Node modules add up quickly.',
        evidence: [
          {
            checkId: 'host.storage',
            checkName: result.name,
            status: result.status,
            message: result.message,
          },
        ],
        repair: plan({
          summary: 'Free up space by cleaning caches and old snapshots',
          description: 'Runs Linuxify\'s garbage collector, which removes old logs, cached downloads, and orphaned files. Also prunes old snapshots.',
          steps: [
            {
              description: 'Run garbage collection',
              command: 'linuxify gc',
              modifiesState: true,
              estimatedSeconds: 30,
            },
            {
              description: 'Prune old snapshots (keep last 3)',
              command: 'linuxify snapshots prune --keep 3',
              modifiesState: true,
              estimatedSeconds: 10,
            },
            {
              description: 'Remove unused distros',
              command: 'linuxify distros prune',
              modifiesState: true,
              estimatedSeconds: 30,
            },
          ],
          risk: 'moderate',
          fixes: ['Frees up to 1-2 GB of cached/unused data'],
          doesNotFix: ['Does not free space used by installed packages you still need'],
          requiresNetwork: false,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/12-testing/performance-budget.md',
        confidence: 0.85,
      };
    },
  },

  // ── path.proot-distro-usable ───────────────────────────────────────
  // This is the ROOT CAUSE rule. When proot-distro is broken (e.g., bad
  // interpreter after Python upgrade), this rule identifies it as the
  // root cause and explains that bootstrap.incomplete and distro.installed
  // are downstream symptoms.
  {
    checkId: 'path.proot-distro-usable',
    name: 'proot-distro usability check (root cause)',
    async diagnose(result: DoctorResult): Promise<Diagnosis | null> {
      if (result.status !== 'fail') return null;

      // Check if the detail has a diagnosis from the diagnostics engine.
      const detail = result.detail as { diagnosis?: { id?: string; title?: string; what?: string; why?: string; repair?: string; confidence?: number } } | undefined;
      const diag = detail?.diagnosis;

      if (diag) {
        // We have a specific diagnosis from the diagnostics engine.
        return {
          id: diag.id ?? 'path.proot-distro-usable.broken',
          title: diag.title ?? 'proot-distro is broken',
          what: diag.what ?? result.message,
          why: (diag.why ?? 'proot-distro is installed but cannot execute. ') +
            'This is the ROOT CAUSE of bootstrap failures and missing distro errors. ' +
            'Once proot-distro is repaired, bootstrap can proceed and the distro will be installed.',
          evidence: [
            {
              checkId: 'path.proot-distro-usable',
              checkName: result.name,
              status: result.status,
              message: result.message,
              interpretation: 'ROOT CAUSE — fixing this will resolve bootstrap.completed and distro.installed',
            },
          ],
          repair: plan({
            summary: diag.repair ?? 'pkg reinstall proot-distro',
            description: 'Reinstalling proot-distro updates its shebang to point to the current Python interpreter. This is a safe operation — no Linuxify data, Ubuntu installations, or user files will be affected. Only the proot-distro Termux package is reinstalled.',
            steps: [
              {
                description: diag.repair ?? 'pkg reinstall proot-distro',
                command: diag.repair ?? 'pkg reinstall proot-distro',
                modifiesState: true,
                estimatedSeconds: 30,
              },
              {
                description: 'Verify proot-distro works',
                command: 'proot-distro list',
                modifiesState: false,
                estimatedSeconds: 5,
              },
              {
                description: 'Resume bootstrap now that proot-distro is fixed',
                command: 'linuxify init',
                modifiesState: true,
                estimatedSeconds: 300,
              },
            ],
            risk: 'safe',
            fixes: [
              'proot-distro will be usable again',
              'Bootstrap can proceed past Stage 1',
              'Distro installation will work',
              'All downstream failures (bootstrap.incomplete, distro.installed) will resolve',
            ],
            doesNotFix: ['Does not affect your existing Ubuntu/Debian installations (if any)'],
            requiresNetwork: true,
          }),
          alternatives: [],
          docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/22-operations/troubleshooting.md',
          confidence: diag.confidence ?? 0.95,
        };
      }

      // No specific diagnosis — generic proot-distro failure.
      return {
        id: 'path.proot-distro-usable.broken',
        title: 'proot-distro is installed but cannot execute',
        what: 'proot-distro is on your PATH but `proot-distro list` fails. This is the ROOT CAUSE of bootstrap failures — without a working proot-distro, Linuxify cannot install or enter any Linux distro.',
        why: 'The most common cause is a Python upgrade in Termux that breaks the proot-distro script\'s shebang. The script still points to the old Python version (e.g., python3.13) but only the new one (e.g., python3.14) exists. Reinstalling proot-distro fixes the shebang.',
        evidence: [
          {
            checkId: 'path.proot-distro-usable',
            checkName: result.name,
            status: result.status,
            message: result.message,
            interpretation: 'ROOT CAUSE — fixing this will resolve bootstrap.completed and distro.installed',
          },
        ],
        repair: plan({
          summary: 'Reinstall proot-distro',
          description: 'Reinstalling proot-distro updates its shebang to the current Python. Safe — no data loss.',
          steps: [
            {
              description: 'Reinstall proot-distro',
              command: 'pkg reinstall proot-distro',
              modifiesState: true,
              estimatedSeconds: 30,
            },
            {
              description: 'Verify proot-distro works',
              command: 'proot-distro list',
              modifiesState: false,
              estimatedSeconds: 5,
            },
            {
              description: 'Resume bootstrap',
              command: 'linuxify init',
              modifiesState: true,
              estimatedSeconds: 300,
            },
          ],
          risk: 'safe',
          fixes: [
            'proot-distro will be usable',
            'Bootstrap can proceed',
            'All downstream failures will resolve',
          ],
          doesNotFix: [],
          requiresNetwork: true,
        }),
        alternatives: [],
        docsUrl: 'https://github.com/Bilal140202/linuxify/blob/main/docs/22-operations/troubleshooting.md',
        confidence: 0.9,
      };
    },
  },
];

/**
 * Auto-register all built-in rules when this module is imported.
 */
import { registerDiagnosisRules } from './rules.js';
registerDiagnosisRules(builtinRules);
