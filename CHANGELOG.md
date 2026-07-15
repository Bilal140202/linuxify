# Changelog

All notable changes to the Linuxify project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (v0.1.0-alpha.4)
- **CRITICAL: `repair --yes` no longer crashes Termux.** The old code used
  `child_process.exec()` to run fix commands, which creates a shell with piped
  stdio. When `linuxify init` (a fix command) spawned proot with
  `stdio: 'inherit'`, it hijacked the parent terminal's stdio, causing Termux
  to close when the child exited. Fixed: now uses `spawn()` with
  `stdio: 'inherit'` directly, giving child processes proper terminal access
  without hijacking the parent.
- **CRITICAL: `repair` now has a real interactive prompt.** The old code
  printed "Proceed with repair? (y/N)" as plain text via `out.info()` then
  immediately returned — it never actually waited for input. When the user
  typed `y`, Termux interpreted it as a new command (`y: command not found`).
  Fixed: new `src/utils/prompt.ts` module uses Node's `readline` to create a
  real prompt that waits for Enter. In non-interactive mode (piped stdin, CI),
  it returns the default (no) immediately.
- **Re-diagnose-after-each-phase.** Repair now re-runs doctor after each
  phase and skips downstream phases that are already fixed. If `linuxify init`
  fixes PATH as a side effect, `linuxify repair paths` is skipped. This is
  the "smarter repair graph" the user described — fix root cause first, then
  re-evaluate before applying secondary fixes.
- **Repair session logging.** Every repair session is now logged to
  `~/.linuxify/logs/repair-<timestamp>.log` with the plan, each step's exit
  code, and the final doctor result. If a repair crashes, the user can
  retrieve the log instead of relying on terminal capture.

### Added (v0.1.0-alpha.4)
- **`src/utils/prompt.ts`** — readline-based `confirm()` and `prompt()`
  utilities with TTY detection. Non-interactive environments get the default
  value immediately; interactive terminals get a real prompt that waits.
- **`docs/testing-guide.md`** — deep-dive baby-steps testing guide with 6
  phases, 20+ steps, and a printable checklist. Each step has expected
  output and troubleshooting instructions.

### Added (v0.1.0-alpha.3)
- **`linuxify doctor --explain`** — for each failing check, shows a detailed
  "why this matters" explanation: What this checks, Why it matters, If not
  fixed (concrete consequence), and Recommended fix. Written for new users
  who don't know what PATH is, what proot does, or why `process.platform`
  matters. All 18 built-in checks now have explanation text.
- **Repair execution plan (apt/brew-style).** `linuxify repair` now shows a
  phased plan before executing:
  ```
  Linuxify Repair Plan
  1. Bootstrap → linuxify init
  2. Environment → pkg install termux
  3. PATH → linuxify repair paths, pkg install proot-distro
  Total: 4 step(s) across 3 phase(s).
  Proceed with repair? (y/N)
  ```
  Fixes are grouped into phases (Bootstrap, Environment, Distro, Runtime,
  PATH, Compatibility, Network) and deduplicated. If a root-cause phase
  (Bootstrap, Environment) fails, downstream phases are skipped.
- **ADR-016: Bootstrap as a Dependency Graph** (proposed) — documents the
  future refactor from numbered stages (0-8) to a dependency graph where
  each stage declares prerequisites. Defers to v0.2.0; current numbered
  model is stable for v0.1.
- **Clean Clone CI workflow** (`.github/workflows/clean-clone.yml`) —
  verifies that a completely fresh `git clone → npm install → typecheck →
  test → build → CLI smoke test → npm pack → PII check` succeeds on every
  PR. This is the "works on a clean machine" gate before npm publish.

### Changed
- `DoctorCheck` interface now has an optional `explain` field
  (`DoctorExplanation`) for the "why this matters" text shown by
  `doctor --explain`.
- `DoctorExplanation` type added: `what`, `why`, `consequence`, `fix`.
- All 18 built-in doctor checks now provide `explain` metadata.

### Fixed (v0.1.0-alpha.2)
- **npm install works on clean clone** (was: ERESOLVE eslint/@eslint/js conflict).
  Pinned `@eslint/js` to `^9.15.0` to match `eslint@^9.15.0`. No more
  `--legacy-peer-deps` needed.
- **`linuxify init --resume` no longer called** (was: unknown option). The
  `bootstrap.completed` doctor check now suggests `linuxify init` (idempotent,
  auto-resumes from marker files). The old `--resume` flag was never
  implemented.
- **`linuxify use ubuntu` no longer called before Ubuntu is installed** (was:
  "Distro 'ubuntu' is not installed"). The `distro.installed` check now
  suggests `linuxify init` (which installs the default distro as part of
  bootstrap) instead of `linuxify use ubuntu` (which requires `--create` to
  auto-install).
- **`linuxify init --from-stage 6` no longer called without prerequisites**
  (was: "Stage 7 verification failed — Missing state.json"). The
  `path.linuxify_bin` check now suggests `linuxify repair paths` (targeted
  repair that doesn't need full bootstrap) instead of `--from-stage 6` (which
  requires stages 0-5 + state.json to exist first).
- **Repair engine deduplicates and dependency-orders fixes.** If multiple
  failing checks suggest the same fixCommand (e.g., both `bootstrap.completed`
  and `distro.installed` suggest `linuxify init` on a fresh install), only one
  runs. Fixes are also priority-ordered: bootstrap before distro, distro before
  path. If a root-cause fix (bootstrap, host) fails, downstream fixes are
  skipped to prevent the cascade of "stage 6 failed because stage 0 wasn't
  done" errors.
- **Bootstrap state mismatch between doctor and report fixed.** Doctor's
  `bootstrap.completed` check now reads `stage-N.done` marker files from disk
  (ground truth) instead of `state.bootstrap_progress.completed_stages` from
  state.json (which may not exist yet on a fresh install). Both doctor and
  report now show the same stage count.
- **Termux version detection in report fixed.** Was calling `pkg --version`
  (doesn't exist). Now reads `TERMUX_VERSION` env var first, falls back to
  `dpkg -s com.termux` (same method doctor uses).
- **Report clipboard suggestion Android-appropriate.** Was suggesting
  `clip`/`pbcopy`/`xclip` (desktop-only). Now suggests "long-press in Termux
  to copy" and `linuxify report --markdown > report.md`.
- **Distro check UX improved.** "No active distro set in state.json" →
  "No active distro. Ubuntu is not installed yet. Run: linuxify init"
- **Bootstrap check message improved.** Now shows the next stage name (e.g.,
  "Next: stage 0 (preflight)") and lists failed stages with their names.

### Added (v0.1.1-alpha.1)
- **`linuxify report`** command — generates a deterministic, redacted,
  copy-pasteable environment report for bug filing. Four formats: `--text`
  (default, colored if TTY), `--json` (stable `linuxify.report.v1` schema),
  `--markdown` (fenced block for GitHub issues), `--fingerprint` (compact
  one-liner). No PII. Replaces the manual version-listing ritual in every
  bug report.
- **`linuxify fix`** command — AI-assisted diagnosis with local rules engine.
  Runs doctor, identifies the highest-impact failure, produces a structured
  diagnosis (WHAT / WHY / EVIDENCE / REPAIR / ALTERNATIVES / DOCS / CONFIDENCE),
  and optionally applies the repair with user consent. 9 built-in rules cover
  the most common failure modes (Termux source, bootstrap incomplete, distro
  missing, PATH issues, proot missing, Node missing, platform compat, network,
  storage). Safety filter refuses destructive commands (`rm -rf /`, `mkfs`,
  `curl | sh`, fork bombs).
- **`report` subsystem** (`src/report/`) — collects environment state from
  every subsystem into a structured `Report` object. Includes fingerprint
  extraction (compact one-liner for log signatures).
- **`diagnosis` subsystem** (`src/diagnosis/`) — rule-based diagnosis engine
  with safety filter. Rules are extensible via plugin SDK. Package-defined
  `repair:` recipes (see below) are checked before built-in generic rules.
- **Package YAML `repair:` block** — declarative repair recipes. Each package
  can describe how `linuxify fix` should repair its own failing doctor checks
  (e.g., `cline.yml` declares `reinstall` and `patch-platform` strategies).
  Schema: `RepairRecipeSchema` in `src/packages/schema.ts`.
- **`docs/strategy.md`** — captures the strategic pivots: killer feature is
  "make Linux CLIs work on Android" (not Ubuntu); Doctor as AI mechanic;
  compat-db as community asset; fingerprint for bug reports; don't rush to npm.

### Changed
- `PackageSchema` now includes a `repair` field (default `[]`). Existing
  package YAMLs without `repair:` continue to validate.
- `cline.yml` seed package now includes two `repair:` recipes as a reference
  implementation for package authors.
- README "Project structure" section updated to reflect actual source layout.
- README status banner updated to "v0.1.0-alpha.1" with subsystem inventory.

## [0.1.0-alpha.1] - 2026-07-14

### Added

### Notes
- This is a documentation-only release. The Linuxify CLI source code will be
  added in a subsequent milestone (see `docs/15-roadmap/milestones.md` for
  the v0.1.0 issue breakdown).
- AI coding agents implementing Linuxify from this doc set should start with
  `docs/00-executive/ai-build-guide.md` for the recommended build order.

## [0.1.0] - TBD

The first alpha release of the Linuxify CLI. Tracked in
`docs/15-roadmap/milestones.md` under milestone v0.1.0. Will include:
- CLI scaffold with command router and global flags
- Bootstrap subsystem (stages 0-8) for Ubuntu 24.04 aarch64
- Single runtime provider (Node LTS)
- Five seed packages: cline, codex, aider, goose, gemini-cli
- Doctor engine with default profile
- Launcher generator
- Patch engine with regex type
- v1 git-based registry client

