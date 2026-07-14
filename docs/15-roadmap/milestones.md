# Milestone Tracker — Linuxify

> The task-level companion to the [Release Roadmap](release-roadmap.md). Where the roadmap describes *what* ships in each version, this tracker describes *which issues* land and *who owns them*. Every issue listed here is (or will be) a GitHub Issue with a matching title, label, and milestone assignment. Maintainers and contributors should treat this file as the canonical issue backlog — when in doubt, the issue text on GitHub should match the issue text here.

This document is updated continuously. When an issue is merged, its entry is marked **✅ done**. When an issue is added, it is appended to the relevant milestone section with a new `LF-<milestone>-<n>` ID. When a milestone slips, its issues are not deleted — they are re-assigned to the new milestone with a note. The git history of this file is the audit trail of how the project's scope evolved.

---

## 1. Milestone Format

Each milestone is a GitHub Milestone with the following fields. The fields are enforced by the [`scripts/milestone-check.ts`](https://github.com/linuxify/linuxify) CI job, which fails if any milestone is missing a required field.

| Field | Required | Description |
|---|---|---|
| **Title** | Yes | `vX.Y.Z` (e.g., `v0.1.0`). Matches the version tag. |
| **Due date** | Yes | The target stable release date from the [roadmap](release-roadmap.md#5-detailed-milestones). |
| **Description** | Yes | One paragraph summarizing the milestone, copied from the roadmap. |
| **Issue list** | Yes | All issues assigned to the milestone, each with an `LF-<milestone>-<n>` ID. |
| **Exit criteria** | Yes | The bulleted list from the roadmap milestone entry. The milestone is not closed until every criterion is checked. |
| **Owner** | Yes | The maintainer responsible for the milestone. Can be a role name (e.g., "Bootstrap lead") rather than a person. |
| **Status** | Yes | One of `planned`, `in-progress`, `at-risk`, `slipped`, `done`. |

A milestone is **closed** only when: (a) every exit criterion is verified by the owner, (b) the release tag is cut and signed, (c) the [release health report](release-roadmap.md#11-success-metrics-per-release) is published, and (d) the post-release retrospective is complete (per [qa-framework §14](../12-testing/qa-framework.md)). Closing a milestone is a one-maintainer decision; the owner files the close-out PR with the verification evidence.

---

## 2. v0.1.0 Issues

v0.1.0 is the alpha release. It establishes the bare minimum: a working CLI, a working bootstrap, a working doctor, and five packages that install and run. The issue list below is grouped by subsystem. Every issue has an ID, title, description, acceptance criteria, estimated effort (S/M/L — see [§6](#6-issue-estimation-guide)), dependencies, and an assignee placeholder (`@unassigned` until a contributor picks it up).

### 2.1 CLI

- **LF-0.1-01** — Scaffold TypeScript CLI project with `commander` entry point.
  - Description: Initialize the `linuxify` monorepo with the CLI package, ESLint, Prettier, Vitest, and the `bin/linuxify` shim. The CLI must print `linuxify v0.1.0` and exit 0 on `linuxify --version`. Establishes the project structure described in [`.agent-context.md` §12](../../.agent-context.md).
  - Acceptance: `npm install && npm run build && npm link && linuxify --version` works on Node 20+. `npm test` passes. `npm run lint` passes.
  - Effort: M. Dependencies: none. Assignee: `@unassigned`.

- **LF-0.1-02** — Implement command router for all 18 subcommands.
  - Description: Wire up the [command surface](../03-cli/cli-specification.md#4-subcommand-reference) with stubs. Each subcommand prints "not implemented" and exits with code 1. This unblocks parallel development of each subsystem.
  - Acceptance: `linuxify <each-of-18-subcommands> --help` prints usage. Running without `--help` exits 1 with a clear "not implemented" message.
  - Effort: M. Dependencies: LF-0.1-01. Assignee: `@unassigned`.

- **LF-0.1-03** — Implement global flags (`--json`, `--yes`, `--dry-run`, `--verbose`, `--quiet`, `--no-color`).
  - Description: Per [cli-specification §3](../03-cli/cli-specification.md). Global flags must be parsed before subcommand dispatch and available to every handler via the `GlobalFlags` context.
  - Acceptance: Each flag is tested. `--json` produces valid `linuxify.v1` schema output. `--dry-run` produces a plan and exits 0 without side effects.
  - Effort: M. Dependencies: LF-0.1-02. Assignee: `@unassigned`.

- **LF-0.1-04** — Implement `linuxify init` happy path.
  - Description: The init command orchestrates the [eight-stage bootstrap pipeline](../05-bootstrap/bootstrap-design.md). For v0.1, only Ubuntu on Node is supported; other distros and runtimes error with `E_BOOTSTRAP_DISTRO_NOT_SUPPORTED` / `E_BOOTSTRAP_RUNTIME_NOT_SUPPORTED`.
  - Acceptance: `linuxify init` on a fresh Termux install brings up Ubuntu with Node installed and exits 0. Re-running `linuxify init` is idempotent — exits 0 with "already initialized" message.
  - Effort: L. Dependencies: LF-0.1-03, LF-0.1-06, LF-0.1-07. Assignee: `@unassigned`.

- **LF-0.1-05** — Implement `linuxify doctor` MVP.
  - Description: Doctor runs the [check catalog](../07-doctor/doctor-engine.md#3-check-catalog) for host, bootstrap, distro, runtime, PATH, and per-package categories. Output matches the [doctor sample](../../.agent-context.md#7-doctor-output-example). `--json`, `--markdown`, `--quiet` output modes per [doctor-engine §5](../07-doctor/doctor-engine.md).
  - Acceptance: Doctor runs in <3s on a healthy install. Output format matches the spec. Exit code 2 on any `fail` per the [exit code namespace](../03-cli/cli-specification.md#6-exit-code-convention).
  - Effort: L. Dependencies: LF-0.1-03, LF-0.1-09. Assignee: `@unassigned`.

### 2.2 Bootstrap

- **LF-0.1-06** — Implement Stage 0 (Preflight) and Stage 1 (Host deps).
  - Description: Preflight checks Termux is from F-Droid (errors with `E_BOOTSTRAP_FDROID_REQUIRED` if Play Store version detected), Android version ≥9, available storage ≥2GB, and architecture. Stage 1 installs `proot` and `proot-distro` via `pkg install`.
  - Acceptance: Preflight blocks Play Store Termux installs with the correct error. Stage 1 succeeds on F-Droid Termux. Both stages are idempotent.
  - Effort: M. Dependencies: LF-0.1-02. Assignee: `@unassigned`.

- **LF-0.1-07** — Implement Stage 2 (Distro download), Stage 3 (First-boot), Stage 4 (Runtimes), Stage 5 (Linuxify home), Stage 6 (PATH wiring).
  - Description: The middle stages of the [bootstrap pipeline](../05-bootstrap/bootstrap-design.md). Stage 2 calls `proot-distro install ubuntu`. Stage 3 runs first-boot configuration inside proot. Stage 4 installs Node LTS inside proot. Stage 5 creates `~/.linuxify/` with the canonical layout. Stage 6 wires the launcher bin directory onto PATH via shell rc files.
  - Acceptance: All five stages run in sequence and produce a working Ubuntu+Node environment. State is persisted to `~/.linuxify/.bootstrap-progress.json` so a partial bootstrap can be resumed.
  - Effort: L. Dependencies: LF-0.1-06. Assignee: `@unassigned`.

- **LF-0.1-08** — Implement Stage 7 (Verification) and Stage 8 (First-run tips).
  - Description: Stage 7 runs the doctor MVP and confirms green. Stage 8 prints the first-run tips message (next steps, links to docs, Discord invite).
  - Acceptance: Stage 7 fails the bootstrap if doctor reports any `fail`. Stage 8 prints tips exactly once (tracked via `state.json`).
  - Effort: S. Dependencies: LF-0.1-05, LF-0.1-07. Assignee: `@unassigned`.

### 2.3 Doctor

- **LF-0.1-09** — Implement check scheduler with 8-worker parallel pool.
  - Description: Per [doctor-engine §4](../07-doctor/doctor-engine.md). The scheduler runs independent checks in parallel with a worker cap of 8 to avoid spawning too many proot processes. Returns `DoctorResult[]` with the 5-value status union (`ok|warn|fail|missing|skip`).
  - Acceptance: Scheduler runs 20 mock checks in <500ms. Worker cap enforced. Results sorted by category then severity.
  - Effort: M. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.1-10** — Implement host checks (`host.termux`, `host.android_version`, `host.arch`, `host.storage`).
  - Description: Per [diagnostics §3](../07-doctor/diagnostics.md). Each check returns a `DoctorResult` with `fixCommand` and `fixDocs` on failure.
  - Acceptance: All four checks return correct status on a real Termux install. Fix commands are runnable as-is.
  - Effort: M. Dependencies: LF-0.1-09. Assignee: `@unassigned`.

- **LF-0.1-11** — Implement bootstrap, distro, runtime, PATH, package checks.
  - Description: The remaining check categories from the v0.1 catalog. Package checks iterate over `~/.linuxify/manifest.json` and run each package's declared doctor checks (per [package-spec §7](../09-registry/package-spec.md)).
  - Acceptance: All checks return correct status. Total doctor runtime ≤3s on a 5-package install.
  - Effort: L. Dependencies: LF-0.1-09, LF-0.1-10, LF-0.1-16. Assignee: `@unassigned`.

### 2.4 Patcher

- **LF-0.1-12** — Ship in-tree manual patches for Cline, Codex, Aider, Goose, Gemini CLI.
  - Description: For v0.1, the patch engine is not built. Instead, the five launch packages ship with manually-authored patches applied via a simple `find/replace` step during `linuxify add`. Patches are committed in-tree at `packages/<tool>/patches/`.
  - Acceptance: All five tools install and run successfully on Ubuntu proot with Node. Patches are idempotent (re-applying does not double-patch).
  - Effort: L. Dependencies: LF-0.1-16. Assignee: `@unassigned`.

### 2.5 Launcher

- **LF-0.1-13** — Implement launcher shim generation.
  - Description: Per [launcher-architecture](../06-launcher/launcher-architecture.md). For each installed package, generate a shell script at `$PREFIX/bin/<launcher>` that execs into proot and runs the tool. Shims must forward signals, propagate environment, and exit with the tool's exit code.
  - Acceptance: `linuxify add cline` produces a `cline` shim that, when invoked, runs Cline inside proot and exits with Cline's exit code. SIGINT terminates the tool, not just the shim.
  - Effort: L. Dependencies: LF-0.1-07, LF-0.1-16. Assignee: `@unassigned`.

- **LF-0.1-14** — Implement `linuxify run <package>` and `linuxify shell`.
  - Description: `run` is an explicit exec into proot to run a tool (used when the shim is missing or to pass `--linuxify-*` flags). `shell` drops the user into a proot shell with the Linuxify environment sourced.
  - Acceptance: Both commands work. `run` exits with the tool's exit code. `shell` produces a working bash prompt inside proot with `linuxify` on PATH.
  - Effort: M. Dependencies: LF-0.1-13. Assignee: `@unassigned`.

### 2.6 Registry

- **LF-0.1-15** — Define package YAML schema v1 and JSON Schema validation.
  - Description: Per [package-spec §1](../09-registry/package-spec.md). The schema is a JSON Schema (draft 2020-12) that validates `packages/<tool>.yml`. Used by `linuxify package lint` and by CI on package PRs.
  - Acceptance: Schema validates the five launch package YAMLs. Schema rejects malformed YAML with specific error messages.
  - Effort: M. Dependencies: LF-0.1-01. Assignee: `@unassigned`.

- **LF-0.1-16** — Implement `linuxify add <package>` and `linuxify remove <package>`.
  - Description: `add` reads the YAML, runs install steps inside proot, applies in-tree patches, generates the launcher shim, and updates `~/.linuxify/manifest.json`. `remove` is the inverse: removes the shim, uninstalls, removes from manifest.
  - Acceptance: All five launch packages install and uninstall cleanly. Manifest stays consistent. `linuxify list` shows installed packages.
  - Effort: L. Dependencies: LF-0.1-12, LF-0.1-13, LF-0.1-15. Assignee: `@unassigned`.

- **LF-0.1-17** — Implement `linuxify list`, `linuxify info <package>`, `linuxify search <query>` (local only).
  - Description: `list` reads the manifest. `info` reads a YAML and prints metadata. `search` does a local fuzzy match against the in-tree package directory (the v0.1 "registry" is just `packages/`).
  - Acceptance: All three commands work with `--json` output.
  - Effort: S. Dependencies: LF-0.1-16. Assignee: `@unassigned`.

### 2.7 Docs

- **LF-0.1-18** — Write the v0.1 announcement blog post.
  - Description: A blog post for `linuxify.sh/blog/v0.1.0-alpha`. Covers: the problem, the solution, the five launch tools, install instructions, known limitations, what's next. Target audience: developers on Android who have felt the pain.
  - Acceptance: Blog post reviewed by ≥2 maintainers. Includes a working install transcript. Published on the same day as the alpha channel cut.
  - Effort: M. Dependencies: LF-0.1-04. Assignee: `@unassigned`.

- **LF-0.1-19** — Write the v0.1 install guide and quickstart.
  - Description: A docs page at `docs/quickstart.md` walking through: install Termux from F-Droid, `pkg install linuxify` (or curl install), `linuxify init`, `linuxify add cline`, `cline --version`. Includes troubleshooting for the top 5 expected failure modes.
  - Acceptance: A fresh user following the guide reaches a working Cline install in <15 minutes. Guide tested by ≥1 non-maintainer.
  - Effort: M. Dependencies: LF-0.1-04. Assignee: `@unassigned`.

- **LF-0.1-20** — Write the five launch package YAMLs (Cline, Codex, Aider, Goose, Gemini CLI).
  - Description: One YAML per tool, following the [package-spec](../09-registry/package-spec.md). Each YAML includes install steps, in-tree patches, env, compat, and doctor checks.
  - Acceptance: All five YAMLs pass `linuxify package lint`. All five install and run successfully.
  - Effort: L (5×S). Dependencies: LF-0.1-15. Assignee: `@unassigned`.

### 2.8 CI / Release

- **LF-0.1-21** — Set up GitHub Actions CI (lint, typecheck, unit tests, build).
  - Description: Per [cicd-design §3](../14-cicd/cicd-design.md). The `ci.yml` workflow runs on every PR. Must complete in <5 minutes.
  - Acceptance: PRs block on CI failure. CI runs in <5 min for typical PRs.
  - Effort: M. Dependencies: LF-0.1-01. Assignee: `@unassigned`.

- **LF-0.1-22** — Set up the alpha release pipeline.
  - Description: Per [release-pipeline](../14-cicd/release-pipeline.md). Tag-driven release. Produces npm package, GitHub Release with checksums, signed with the alpha GPG key.
  - Acceptance: Cutting tag `v0.1.0-alpha.1` produces a publishable release. Release artifacts verify against the published alpha key.
  - Effort: L. Dependencies: LF-0.1-21. Assignee: `@unassigned`.

- **LF-0.1-23** — Set up the Termux package repository (alpha channel).
  - Description: A self-hosted apt-style repo at `apt.linuxify.sh/alpha` that Termux can `pkg install linuxify` from. Signed with the alpha key.
  - Acceptance: `pkg install linuxify` works on a fresh Termux install after adding the repo. Package version matches the latest alpha tag.
  - Effort: M. Dependencies: LF-0.1-22. Assignee: `@unassigned`.

- **LF-0.1-24** — End-to-end smoke test on real Pixel and Samsung devices.
  - Description: Per [qa-framework §11](../12-testing/qa-framework.md). Manual checklist: install Termux, install Linuxify, `linuxify init`, `linuxify add` each of the 5 tools, `linuxify doctor` all-green, run each tool briefly, `linuxify remove` each, `linuxify doctor` clean.
  - Acceptance: Smoke test passes on Pixel (Android 14) and Samsung (Android 15). Results recorded in the v0.1 release notes.
  - Effort: M. Dependencies: LF-0.1-22. Assignee: `@unassigned`.

- **LF-0.1-25** — Set up Discord, Reddit, Mastodon, GitHub Discussions.
  - Description: Create the community channels per [contribution-guidelines §17](../16-community/contribution-guidelines.md). Discord server with `#general`, `#support`, `#contributing`, `#announcements`. Reddit `/r/linuxify`. Mastodon `@linuxify@hachyderm.io`. GitHub Discussions enabled.
  - Acceptance: All channels live. Links from README and docs.
  - Effort: S. Dependencies: none. Assignee: `@unassigned`.

- **LF-0.1-26** — Write `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md` scaffolds.
  - Description: Top-level repo files. CONTRIBUTING.md links to [docs/16-community/](../16-community/contribution-guidelines.md). CODE_OF_CONDUCT.md is the full text (not a link). SECURITY.md documents the [vulnerability reporting process](../13-security/security-model.md). CHANGELOG.md uses Keep-a-Changelog format.
  - Acceptance: All four files present and reviewed. Code of Conduct text is the full version, not a stub.
  - Effort: M. Dependencies: none. Assignee: `@unassigned`.

- **LF-0.1-27** — Set up issue and PR templates.
  - Description: Per [docs/18-templates/](../18-templates/github-templates.md). Bug report, feature request, package request, PR templates. All templates enforce the [reproduction standard](../12-testing/qa-framework.md#6-reproduction) (`linuxify doctor --markdown` mandatory in bug reports).
  - Acceptance: Templates render correctly on GitHub. Bug report cannot be submitted without the doctor output field.
  - Effort: S. Dependencies: LF-0.1-05. Assignee: `@unassigned`.

- **LF-0.1-28** — Establish CODEOWNERS for sensitive paths.
  - Description: Per [contribution-guidelines §6](../16-community/contribution-guidelines.md). `src/patcher/`, `src/registry/`, `src/security/` require 2 reviewer approvals. CODEOWNERS file lists maintainer GitHub handles per path.
  - Acceptance: PRs touching sensitive paths block on 2 approvals. CODEOWNERS enforced by GitHub branch protection.
  - Effort: S. Dependencies: LF-0.1-26. Assignee: `@unassigned`.

- **LF-0.1-29** — First public release announcement (Discord, Reddit, Mastodon, HN, Lobsters).
  - Description: Coordinated announcement post across all channels. Each channel gets a tailored version (Discord: casual, Reddit: technical, HN: link to blog post, Lobsters: link to blog post).
  - Acceptance: All posts published within 1 hour of the alpha tag cut. Respond to top-10 comments within 24 hours.
  - Effort: S. Dependencies: LF-0.1-18, LF-0.1-22. Assignee: `@unassigned`.

- **LF-0.1-30** — Post-release retrospective and v0.2 kickoff.
  - Description: Per [qa-framework §14](../12-testing/qa-framework.md). Run the blameless postmortem template. Identify what went well, what went poorly, action items for v0.2. File v0.2 issues based on action items.
  - Acceptance: Postmortem published at `docs/postmortems/<date>-v0.1.0-release.md`. v0.2 milestone created with issues.
  - Effort: S. Dependencies: LF-0.1-24. Assignee: `@unassigned`.

---

## 3. v0.2.0 Issues

v0.2.0 expands distro/runtime coverage, ships the patch engine, grows the registry to 20 packages, and introduces opt-in telemetry. The issue list is grouped by subsystem; some v0.2 issues are continuations of v0.1 themes (e.g., more packages, more doctor checks).

### 3.1 CLI

- **LF-0.2-01** — Implement `linuxify use <distro>` for switching active distro.
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Requires that the target distro is installed; if not, prompts to install. Updates `state.json` with the active distro.
  - Acceptance: Switching distros updates the active proot for all subsequent `linuxify run` / `linuxify shell` calls. Existing packages from the prior distro are not visible (each distro has its own package manifest).
  - Effort: M. Dependencies: LF-0.2-05, LF-0.2-06. Assignee: `@unassigned`.

- **LF-0.2-02** — Implement `linuxify patch <package>` (re-apply patches).
  - Description: Per [patcher-engine §8](../08-patcher/patcher-engine.md). Idempotent: checks each patch's verify command, applies only if not already applied. Records to `~/.linuxify/patches/<pkg>/<n>.json`.
  - Acceptance: Re-running `linuxify patch cline` after a manual `npm update -g cline` re-applies the patches and records the new state.
  - Effort: M. Dependencies: LF-0.2-10. Assignee: `@unassigned`.

- **LF-0.2-03** — Implement `linuxify config` get/set/show.
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Reads/writes `~/.linuxify/config.toml`. Supports dot-notation keys. `--json` output.
  - Acceptance: `linuxify config set telemetry.enabled true` writes to config.toml. `linuxify config get telemetry.enabled` prints `true`.
  - Effort: S. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-04** — Implement `linuxify env` (print resolved environment).
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Prints a two-column table: inside-proot env vs Termux-host env. `--json` produces the `linuxify.env.v1` schema.
  - Acceptance: Output clearly distinguishes the two environments. Useful for debugging "why doesn't my tool see X env var" questions.
  - Effort: S. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

### 3.2 Bootstrap

- **LF-0.2-05** — Implement Debian distro backend.
  - Description: Per [distro-management](../05-bootstrap/distro-management.md). Implements the `DistroProvider` interface for Debian. Reuses proot-distro's Debian image. Doctor checks for Debian-specific concerns (apt sources, debconf).
  - Acceptance: `linuxify use debian` after `linuxify init --distro debian` works end-to-end. All v0.1 packages installable on Debian.
  - Effort: L. Dependencies: LF-0.1-07. Assignee: `@unassigned`.

- **LF-0.2-06** — Implement Alpine distro backend.
  - Description: Per [distro-management](../05-bootstrap/distro-management.md). Alpine uses `apk` instead of `apt`; DistroProvider must handle the difference. Some packages may need Alpine-specific patches (musl vs glibc).
  - Acceptance: `linuxify use alpine` works end-to-end. ≥10 packages from the v0.2 registry work on Alpine.
  - Effort: L. Dependencies: LF-0.1-07. Assignee: `@unassigned`.

- **LF-0.2-07** — Implement multi-distro state management.
  - Description: Each installed distro has its own rootfs at `~/.linuxify/distros/<name>/`, its own runtime state at `~/.linuxify/distros/<name>/runtimes.json`, and its own package manifest at `~/.linuxify/distros/<name>/manifest.json`. The top-level `state.json` tracks only the active distro.
  - Acceptance: Switching distros does not affect other distros' state. Each distro can be uninstalled independently.
  - Effort: M. Dependencies: LF-0.2-05, LF-0.2-06. Assignee: `@unassigned`.

### 3.3 Runtime

- **LF-0.2-08** — Implement Python runtime manager.
  - Description: Per [runtime-management](../06-launcher/runtime-management.md). Implements the `RuntimeProvider` interface for Python. Installs Python 3.12 via apt inside proot. Manages pip and venv.
  - Acceptance: `linuxify add aider` (Python-based) installs and runs Aider on Ubuntu with Python 3.12.
  - Effort: L. Dependencies: LF-0.1-07. Assignee: `@unassigned`.

### 3.4 Patcher

- **LF-0.2-09** — Implement patch engine core (YAML schema, patch loader, apply pipeline).
  - Description: Per [patcher-engine §3–§4](../08-patcher/patcher-engine.md). The patch block in package YAML is now first-class. Loader validates each patch against the schema. Apply pipeline: locate file → check already-applied → backup to `~/.linuxify/patches/<pkg>/backups/<patch_id>.orig` → apply → verify → record to `~/.linuxify/patches/<pkg>/<n>.json`.
  - Acceptance: All v0.1 in-tree patches migrate to YAML patches. `linuxify add cline` now uses the patch engine.
  - Effort: L. Dependencies: LF-0.1-12, LF-0.1-15. Assignee: `@unassigned`.

- **LF-0.2-10** — Implement regex patch type.
  - Description: Per [patcher-engine §5](../08-patcher/patcher-engine.md). The `regex` patch type uses `String.prototype.replace` with a regex. Timeout at 250ms. Must support named capture groups and the `g` flag.
  - Acceptance: Cline's `process.platform === 'linux'` → `['linux','android'].includes(process.platform)` patch works via regex type.
  - Effort: M. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

- **LF-0.2-11** — Implement `ast-js` patch type (acorn-based).
  - Description: Per [patcher-engine §5](../08-patcher/patcher-engine.md). Uses acorn to parse the file, applies an AST selector (ast-grep syntax), replaces matches. 300ms–2s per file.
  - Acceptance: Codex's architecture detection patch works via `ast-js` type. Handles minified files.
  - Effort: L. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

- **LF-0.2-12** — Implement `ast-ts` patch type (ts-morph-based).
  - Description: Per [patcher-engine §5](../08-patcher/patcher-engine.md). Uses ts-morph. 500ms–5s per file. For TypeScript source files only.
  - Acceptance: At least one patch in the registry uses `ast-ts` successfully.
  - Effort: L. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

- **LF-0.2-13** — Implement `sed` and `python-ast` patch types.
  - Description: Per [patcher-engine §5](../08-patcher/patcher-engine.md). `sed` shells out to sed for non-JS files. `python-ast` uses Python's ast module for Python source files.
  - Acceptance: Both types tested with sample patches. Sed handles multi-line patterns.
  - Effort: M. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

- **LF-0.2-14** — Implement patch verification and rollback.
  - Description: Per [patcher-engine §6–§7](../08-patcher/patcher-engine.md). Verify command (must exit 0 or match regex). Rollback restores from `backups/<patch_id>.orig`. `linuxify patch --rollback <pkg> <patch_id>`.
  - Acceptance: A failed verify triggers automatic rollback. Manual rollback works.
  - Effort: M. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

### 3.5 Doctor

- **LF-0.2-15** — Add Debian-specific doctor checks (`distro.debian.sources`, `distro.debian.apt_update`).
  - Description: Per [doctor-engine §3](../07-doctor/doctor-engine.md). Checks Debian apt sources are reachable, apt update succeeds.
  - Acceptance: Checks run when Debian is active. Failure produces actionable fixCommand.
  - Effort: S. Dependencies: LF-0.2-05. Assignee: `@unassigned`.

- **LF-0.2-16** — Add Alpine-specific doctor checks (`distro.alpine.apk_repos`, `distro.alpine.musl_compat`).
  - Description: Per [doctor-engine §3](../07-doctor/doctor-engine.md). Checks Alpine apk repos are reachable, musl compatibility for installed binaries.
  - Acceptance: Checks run when Alpine is active.
  - Effort: S. Dependencies: LF-0.2-06. Assignee: `@unassigned`.

- **LF-0.2-17** — Add Python runtime doctor checks (`runtime.python.version`, `runtime.python.pip`).
  - Description: Per [doctor-engine §3](../07-doctor/doctor-engine.md). Checks Python ≥3.12, pip is functional.
  - Acceptance: Checks run when Python runtime is installed.
  - Effort: S. Dependencies: LF-0.2-08. Assignee: `@unassigned`.

### 3.6 Registry

- **LF-0.2-18** — Add 15 community-contributed package YAMLs.
  - Description: Reach 20 total packages (5 from v0.1 + 15 new). Each YAML is a separate PR reviewed by a maintainer. Candidates: OpenHands, Freebuff, Claude Code, Cursor CLI, Continue CLI, etc.
  - Acceptance: 20 packages in registry. Each passes `linuxify package lint`. Each installs on Ubuntu.
  - Effort: L (15×S). Dependencies: LF-0.2-09. Assignee: `@unassigned` (multiple contributors).

- **LF-0.2-19** — Implement compat-db v1 (manual entries).
  - Description: Per [compatibility-database](../11-compat-db/compatibility-database.md). A JSON file at `compat/compat-db.json` with one entry per (package, distro, runtime, Android version). Initially populated by maintainer testing.
  - Acceptance: File exists with entries for all 20 packages on Ubuntu. Schema validates.
  - Effort: M. Dependencies: LF-0.2-18. Assignee: `@unassigned`.

### 3.7 Telemetry

- **LF-0.2-20** — Implement opt-in telemetry collection.
  - Description: Per [telemetry-privacy §2–§4](../24-telemetry/telemetry-privacy.md). 7 event types: bootstrap, doctor, install, run, patch, performance, crash. Off by default; first-run prompt with y/N default. Five toggle mechanisms (config, flags, env var).
  - Acceptance: Telemetry fires only when opted in. Events validated against the v2 schema. No PII collected (verified by [§3 negative list](../24-telemetry/telemetry-privacy.md)).
  - Effort: L. Dependencies: LF-0.2-03. Assignee: `@unassigned`.

- **LF-0.2-21** — Stand up the telemetry server (staging).
  - Description: Per [telemetry-privacy §12](../24-telemetry/telemetry-privacy.md). MIT-licensed Go service at `github.com/linuxify/telemetry-server`. Deployed to staging at `telemetry-staging.linuxify.sh`. Accepts HTTPS POSTs of batched events.
  - Acceptance: Server accepts events from the v0.2 alpha channel. Schema validation 100%. Aggregate dashboard at Grafana.
  - Effort: L. Dependencies: LF-0.2-20. Assignee: `@unassigned`.

- **LF-0.2-22** — Implement `linuxify telemetry show/export/flush`.
  - Description: Per [telemetry-privacy §7](../24-telemetry/telemetry-privacy.md). User-facing commands to view, export (JSON), and flush locally-buffered telemetry.
  - Acceptance: `show` prints pending events. `export` produces a JSON file. `flush` deletes local buffer.
  - Effort: M. Dependencies: LF-0.2-20. Assignee: `@unassigned`.

### 3.8 Plugin SDK

- **LF-0.2-23** — Implement plugin SDK v0.1 (lifecycle, hooks, no isolation).
  - Description: Per [plugin-sdk](../10-plugin-sdk/plugin-sdk.md). Plugins are npm packages with `linuxify-plugin` keyword. Loader discovers, loads, initializes. 9 hooks: preInstall, postInstall, prePatch, postPatch, preRun, postRun, doctor, bootstrap, command. No sandboxing in v0.1 — plugins run with full privileges, scary install prompt required.
  - Acceptance: A test plugin loads, registers a hook, and the hook fires on the corresponding event. Install prompt shown.
  - Effort: L. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-24** — Document plugin SDK v0.1 with example Java runtime plugin.
  - Description: Per [plugin-sdk §8](../10-plugin-sdk/plugin-sdk.md). A reference plugin that registers a Java runtime provider, a `linuxify java-versions` command, and a doctor check.
  - Acceptance: Reference plugin published to npm as `linuxify-plugin-java-example`. README explains each file.
  - Effort: M. Dependencies: LF-0.2-23. Assignee: `@unassigned`.

### 3.9 CI

- **LF-0.2-25** — Expand CI matrix to (Ubuntu, Debian, Alpine) × (Node, Python) × aarch64.
  - Description: Per [cicd-design §4](../14-cicd/cicd-design.md). PRs run a slice; nightly runs the full matrix. Coverage strategy: every (distro, runtime) pair hits ≥1 Android version per nightly.
  - Acceptance: Matrix runs in <30 min on PRs, <4h nightly. All 20 packages tested against the matrix in nightly.
  - Effort: L. Dependencies: LF-0.2-05, LF-0.2-06, LF-0.2-08. Assignee: `@unassigned`.

- **LF-0.2-26** — Add compat-db auto-population from nightly CI.
  - Description: Per [compatibility-database](../11-compat-db/compatibility-database.md). Nightly CI runs each package against the matrix, writes results to `compat/compat-db.json` in a separate repo, opens a PR.
  - Acceptance: Nightly PR opened automatically with compat-db updates. Maintainer review before merge.
  - Effort: M. Dependencies: LF-0.2-19, LF-0.2-25. Assignee: `@unassigned`.

### 3.10 Docs

- **LF-0.2-27** — Write the v0.2 announcement blog post.
  - Description: Blog post covering: new distros, Python runtime, patch engine, telemetry, plugin SDK v0.1. Includes a "what's coming in v0.3" teaser.
  - Acceptance: Reviewed by ≥2 maintainers. Published with the v0.2 stable cut.
  - Effort: M. Dependencies: LF-0.2-21. Assignee: `@unassigned`.

- **LF-0.2-28** — Write plugin SDK authoring guide.
  - Description: A docs page at `docs/plugin-authoring.md` walking through creating, testing, and publishing a plugin. Cross-links to [docs/10-plugin-sdk/](../10-plugin-sdk/plugin-sdk.md).
  - Acceptance: A new contributor can follow the guide to publish their first plugin.
  - Effort: M. Dependencies: LF-0.2-24. Assignee: `@unassigned`.

- **LF-0.2-29** — Write the patch authoring guide.
  - Description: A docs page at `docs/patch-authoring.md` walking through identifying a failing tool, choosing a patch type, writing the YAML, testing locally, submitting. Cross-links to [patcher-engine §10](../08-patcher/patcher-engine.md).
  - Acceptance: A new contributor can follow the guide to submit their first patch.
  - Effort: M. Dependencies: LF-0.2-14. Assignee: `@unassigned`.

- **LF-0.2-30** — Update quickstart for v0.2 (multi-distro, Python).
  - Description: Update `docs/quickstart.md` to cover `linuxify use debian`, Python packages.
  - Acceptance: Quickstart reflects v0.2 capabilities.
  - Effort: S. Dependencies: LF-0.2-01. Assignee: `@unassigned`.

### 3.11 Release

- **LF-0.2-31** — Beta channel launch.
  - Description: Per [release-pipeline §2](../14-cicd/release-pipeline.md). Cut weekly beta from alpha after 7 days clean telemetry. `linuxify self-update --channel beta`.
  - Acceptance: Beta channel produces weekly cuts. ≥10 users opt in within first month.
  - Effort: M. Dependencies: LF-0.2-20, LF-0.2-21. Assignee: `@unassigned`.

- **LF-0.2-32** — Stable channel launch (v0.2.0).
  - Description: First stable release. Promote from beta after 7 days clean telemetry. Cut tag, sign, publish to npm, Termux repo, GitHub Release.
  - Acceptance: v0.2.0 stable tag cut and signed. Release health report published 2 weeks post-release.
  - Effort: M. Dependencies: LF-0.2-31. Assignee: `@unassigned`.

- **LF-0.2-33** — v0.2 retrospective.
  - Description: Per [qa-framework §14](../12-testing/qa-framework.md). Blameless postmortem.
  - Acceptance: Postmortem published. v0.3 issues filed from action items.
  - Effort: S. Dependencies: LF-0.2-32. Assignee: `@unassigned`.

### 3.12 Additional v0.2 Issues

- **LF-0.2-34** — Implement `linuxify self-update` (within-major).
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Self-update downloads the new version, verifies signature, runs migration hooks, atomically swaps, restarts. Auto-rollback on failure per [release-pipeline §7](../14-cicd/release-pipeline.md).
  - Acceptance: `linuxify self-update` on alpha channel fetches latest alpha. Migration hooks run idempotently. Failed migration triggers rollback.
  - Effort: L. Dependencies: LF-0.2-31. Assignee: `@unassigned`.

- **LF-0.2-35** — Implement `linuxify update` (update packages + Linuxify).
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Combines `self-update` with `upgrade` for all packages. Single progress bar. Resumable on failure.
  - Acceptance: `linuxify update` updates Linuxify and all packages in one command. Failure mid-update leaves the system in a consistent state.
  - Effort: M. Dependencies: LF-0.2-34, LF-0.3-04. Assignee: `@unassigned`.

- **LF-0.2-36** — Add shell completions (bash, zsh, fish).
  - Description: Per [cli-specification §11](../03-cli/cli-specification.md). `linuxify completions --shell bash` prints completion script. `--install` writes to the appropriate rc file.
  - Acceptance: Tab completion works in bash, zsh, fish after `linuxify completions --install`.
  - Effort: S. Dependencies: LF-0.1-02. Assignee: `@unassigned`.

- **LF-0.2-37** — Implement structured error codes (`E_<SUBSYSTEM>_<DESCRIPTION>`).
  - Description: Per [system-architecture §9](../02-architecture/system-architecture.md). Every user-facing error includes a stable code, a four-part message (what/why/fix/docs), and an exit code from the [exit namespace](../03-cli/cli-specification.md#6-exit-code-convention).
  - Acceptance: All error paths produce structured errors. `--json` includes the code field.
  - Effort: M. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-38** — Implement logging to `~/.linuxify/logs/linuxify.log`.
  - Description: Per [cli-specification §8](../03-cli/cli-specification.md). Daily rotation, 30-day retention, secret redaction patterns. Verbosity via `--verbose`/`--debug`.
  - Acceptance: Log file written. Redaction patterns strip Authorization headers, API tokens, etc.
  - Effort: M. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-39** — Implement `linuxify state show` and `linuxify state reset`.
  - Description: `state show` prints the contents of `~/.linuxify/state.json` (the active distro, runtime versions, etc.). `state reset --confirm` clears state, forcing re-bootstrap on next init. Dangerous; requires `--confirm`.
  - Acceptance: `state show` produces valid JSON. `state reset` requires interactive confirm unless `--yes` passed.
  - Effort: S. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-40** — Add `--dry-run` support to all mutating commands.
  - Description: Per [cli-specification §3](../03-cli/cli-specification.md). `init`, `add`, `remove`, `upgrade`, `self-update`, `repair`, `snapshot`, `restore` all support `--dry-run`, which prints the plan and exits 0 without side effects.
  - Acceptance: Every mutating command supports `--dry-run`. Output is a clear plan of actions.
  - Effort: M. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.2-41** — Add property-based tests for patch engine rollback.
  - Description: Per [testing-strategy §8](../12-testing/testing-strategy.md). Use `fast-check` to verify that `apply(patch); rollback(patch)` returns the file to its original state for any patch and any file.
  - Acceptance: Property test runs 1000 cases, all pass.
  - Effort: M. Dependencies: LF-0.2-14. Assignee: `@unassigned`.

- **LF-0.2-42** — Set up `linuxify package lint` command.
  - Description: Per [package-spec §12](../09-registry/package-spec.md). Validates a package YAML against the schema. CI uses this on package PRs.
  - Acceptance: `linuxify package lint ./my-package.yml` exits 0 on valid YAML, exits 1 with specific errors on invalid YAML.
  - Effort: S. Dependencies: LF-0.1-15. Assignee: `@unassigned`.

- **LF-0.2-43** — Write package authoring guide.
  - Description: A docs page at `docs/package-authoring.md` walking through creating, testing, and submitting a package YAML. Cross-links to [package-spec](../09-registry/package-spec.md).
  - Acceptance: A new contributor can follow the guide to submit their first package.
  - Effort: M. Dependencies: LF-0.2-42. Assignee: `@unassigned`.

---

## 4. v0.3.0 Issues

v0.3.0 adds Arch and Rust/Go, reaches 50 packages, ships plugin SDK v1.0 with sandboxing, adds doctor profiles, repair, snapshot/restore, and I18N. The issue list is grouped by subsystem; some issues are continuations of v0.2 themes.

### 4.1 CLI

- **LF-0.3-01** — Implement `linuxify repair` command.
  - Description: Per [doctor-engine §6](../07-doctor/doctor-engine.md). Runs doctor, classifies failures as safe-fixable or unsafe-fixable, applies safe fixes automatically, prompts for unsafe fixes. Logs to `~/.linuxify/logs/repair-<timestamp>.json`.
  - Acceptance: `linuxify repair` resolves ≥80% of common doctor failures automatically. Unsafe fixes require `--yes` or interactive prompt.
  - Effort: L. Dependencies: LF-0.1-05. Assignee: `@unassigned`.

- **LF-0.3-02** — Implement `linuxify snapshot` and `linuxify restore`.
  - Description: Per [distro-management](../05-bootstrap/distro-management.md). Snapshot creates a tarball of the distro rootfs at `~/.linuxify/snapshots/<distro>-<timestamp>.tar.gz`. Restore extracts a snapshot, replacing the current rootfs (with confirmation prompt).
  - Acceptance: Snapshot of Ubuntu (5GB) completes in <10 min. Restore survives an Android reboot. `--list` shows snapshots.
  - Effort: L. Dependencies: LF-0.2-07. Assignee: `@unassigned`.

- **LF-0.3-03** — Implement `linuxify doctor --profile <name>`.
  - Description: Per [doctor-engine §7](../07-doctor/doctor-engine.md). Profiles: minimal, standard, deep, pre-flight, post-install, ci. Each profile selects a subset of checks.
  - Acceptance: `--profile ci` exits 1 on any warn (per the CI profile spec). `--profile minimal` runs in <1s.
  - Effort: M. Dependencies: LF-0.1-05. Assignee: `@unassigned`.

- **LF-0.3-04** — Implement `linuxify upgrade [<package>]`.
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). Without args, upgrades all packages. With arg, upgrades one. Re-runs patches if needed. Respects `compat.min_linuxify`.
  - Acceptance: `linuxify upgrade cline` updates Cline and re-applies patches. `linuxify upgrade` updates all packages with progress bar.
  - Effort: M. Dependencies: LF-0.2-02. Assignee: `@unassigned`.

### 4.2 Bootstrap

- **LF-0.3-05** — Implement Arch distro backend.
  - Description: Per [distro-management](../05-bootstrap/distro-management.md). Arch uses `pacman`. Some packages may need AUR builds. DistroProvider handles Arch-specific concerns.
  - Acceptance: `linuxify use arch` works end-to-end. ≥10 packages from the registry work on Arch.
  - Effort: L. Dependencies: LF-0.2-07. Assignee: `@unassigned`.

- **LF-0.3-06** — Implement `linuxify use` across all 4 distros.
  - Description: Verify that `linuxify use` works for Ubuntu, Debian, Alpine, Arch. Tests multi-distro switching scenarios.
  - Acceptance: User can switch between all 4 distros without re-init. Each distro maintains its own package manifest.
  - Effort: M. Dependencies: LF-0.3-05. Assignee: `@unassigned`.

### 4.3 Runtime

- **LF-0.3-07** — Implement Rust runtime manager.
  - Description: Per [runtime-management](../06-launcher/runtime-management.md). Installs Rust via rustup inside proot. Manages cargo.
  - Acceptance: A Rust-based package (e.g., ripgrep built from source) installs and runs.
  - Effort: L. Dependencies: LF-0.1-07. Assignee: `@unassigned`.

- **LF-0.3-08** — Implement Go runtime manager.
  - Description: Per [runtime-management](../06-launcher/runtime-management.md). Installs Go via apt or tarball. Manages GOPATH.
  - Acceptance: A Go-based package installs and runs.
  - Effort: L. Dependencies: LF-0.1-07. Assignee: `@unassigned`.

### 4.4 Patcher

- **LF-0.3-09** — Implement patch conflict detection.
  - Description: Per [patcher-engine §9](../08-patcher/patcher-engine.md). SHA-256 cross-check on files; rejects conflicting patches at YAML load time with `E_PATCH_CONFLICT`. `--force` override for advanced users.
  - Acceptance: Two patches touching the same file range are detected and rejected.
  - Effort: M. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

- **LF-0.3-10** — Implement patch library (`linuxify-patches` repo).
  - Description: Per [patcher-engine §11](../08-patcher/patcher-engine.md). Separate GitHub repo `linuxify/linuxify-patches` with versioned patch packs. `linuxify add` queries the library for unknown packages.
  - Acceptance: A package not in the registry can still be installed if the patch library has patches for it.
  - Effort: M. Dependencies: LF-0.2-09. Assignee: `@unassigned`.

### 4.5 Doctor

- **LF-0.3-11** — Add Arch-specific doctor checks.
  - Description: Per [doctor-engine §3](../07-doctor/doctor-engine.md). Checks pacman repos, keyring, AUR helper.
  - Acceptance: Checks run when Arch is active.
  - Effort: S. Dependencies: LF-0.3-05. Assignee: `@unassigned`.

- **LF-0.3-12** — Add Rust and Go runtime doctor checks.
  - Description: Per [doctor-engine §3](../07-doctor/doctor-engine.md). Checks rustup, cargo, go version.
  - Acceptance: Checks run when respective runtime is installed.
  - Effort: S. Dependencies: LF-0.3-07, LF-0.3-08. Assignee: `@unassigned`.

- **LF-0.3-13** — Implement doctor history log.
  - Description: Per [doctor-engine §10](../07-doctor/doctor-engine.md). `~/.linuxify/logs/doctor-<timestamp>.json` with 50-entry rotation. `linuxify doctor history` shows recent runs; `--verbose` shows diff.
  - Acceptance: History persists across reboots. Diff view highlights changed checks.
  - Effort: M. Dependencies: LF-0.1-05. Assignee: `@unassigned`.

### 4.6 Registry

- **LF-0.3-14** — Add 30 community-contributed package YAMLs (reach 50 total).
  - Description: Continued community contributions. Each YAML is a separate PR.
  - Acceptance: 50 packages in registry. Each installs on Ubuntu; ≥80% install on Debian, Alpine, Arch.
  - Effort: L (30×S). Dependencies: LF-0.2-18. Assignee: `@unassigned` (multiple contributors).

- **LF-0.3-15** — Implement compat-db auto-testing.
  - Description: Per [compatibility-database](../11-compat-db/compatibility-database.md). Nightly CI runs each package against the full matrix, populates compat-db automatically. Human review before `broken` status propagates.
  - Acceptance: Compat-db has entries for all 50 packages × 4 distros × 4 runtimes × 2 Android versions = 1,600 cells with ≥90% populated.
  - Effort: L. Dependencies: LF-0.2-26, LF-0.3-14. Assignee: `@unassigned`.

### 4.7 Plugin SDK

- **LF-0.3-16** — Implement plugin SDK v1.0 (stable API, sandboxing).
  - Description: Per [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) and [security-model §16](../13-security/security-model.md). API frozen. Untrusted plugins run in `worker_threads` with explicit capability grants. Trusted plugins run unsandboxed with explicit consent.
  - Acceptance: v1.0 API documented and frozen. Sandboxed plugin cannot access fs/net/exec without granted capabilities.
  - Effort: L. Dependencies: LF-0.2-23. Assignee: `@unassigned`.

- **LF-0.3-17** — Plugin SDK v1.0 documentation and migration guide.
  - Description: Full API docs at `docs/10-plugin-sdk/`. Migration guide for v0.1 plugins. Examples for each capability.
  - Acceptance: A v0.1 plugin can be migrated by following the guide.
  - Effort: M. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

### 4.8 I18N

- **LF-0.3-18** — Implement I18N framework.
  - Description: Per [cli-specification §9](../03-cli/cli-specification.md). Message catalog at `locales/<lang>.json`. Locale detection via `LANG`/`LC_ALL` env vars. English fallback. Error codes never translated.
  - Acceptance: `LANG=es_ES.UTF-8 linuxify init` prints Spanish messages. Unknown locale falls back to English.
  - Effort: L. Dependencies: LF-0.1-03. Assignee: `@unassigned`.

- **LF-0.3-19** — Translate CLI strings to Spanish, French, Hindi (≥80% coverage).
  - Description: Initial translations for the three target locales. Community contributions welcome.
  - Acceptance: Coverage tool reports ≥80% for all three locales.
  - Effort: L (3×M). Dependencies: LF-0.3-18. Assignee: `@unassigned`.

### 4.9 CI / Release

- **LF-0.3-20** — Expand CI matrix to 4 distros × 4 runtimes.
  - Description: Per [cicd-design §4](../14-cicd/cicd-design.md). Nightly matrix now covers all distros and runtimes.
  - Acceptance: Matrix runs in <4h nightly. All 50 packages tested.
  - Effort: M. Dependencies: LF-0.3-05, LF-0.3-07, LF-0.3-08. Assignee: `@unassigned`.

- **LF-0.3-21** — Set up real-device CI (Pixel 7 + Samsung S22).
  - Description: Per [cicd-design §5](../14-cicd/cicd-design.md). Self-hosted runners connected via ADB to x86 NUCs.
  - Acceptance: Real-device smoke test runs weekly. Catches issues the termux-container emulator misses.
  - Effort: L. Dependencies: LF-0.2-25. Assignee: `@unassigned`.

- **LF-0.3-22** — v0.3.0 stable release.
  - Description: Promote from beta after 7 days clean telemetry. Tag, sign, publish.
  - Acceptance: v0.3.0 stable tag cut. Release health report published.
  - Effort: M. Dependencies: LF-0.3-16, LF-0.3-19. Assignee: `@unassigned`.

### 4.10 Docs

- **LF-0.3-23** — Write the v0.3 announcement blog post.
  - Description: Blog post covering: Arch, Rust/Go, 50 packages, plugin SDK v1.0, doctor profiles, repair, snapshot/restore, I18N. Teases v1.0.
  - Acceptance: Reviewed by ≥2 maintainers. Published with v0.3 stable cut.
  - Effort: M. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

- **LF-0.3-24** — Write the v1.0 readiness checklist.
  - Description: A docs page at `docs/v1.0-readiness.md` tracking the v1.0 exit criteria (security audit, 100 packages, LTS policy, full docs, conference talk).
  - Acceptance: Checklist live and updated monthly.
  - Effort: S. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

### 4.11 Misc

- **LF-0.3-25** — Establish the RFC process.
  - Description: Per [release-roadmap §10](release-roadmap.md#10-community-feedback-loop). RFC template at `docs/rfcs/0000-template.md`. Numbering shared with ADRs.
  - Acceptance: First RFC (for v1.0 scope) filed and discussed.
  - Effort: S. Dependencies: none. Assignee: `@unassigned`.

- **LF-0.3-26** — First quarterly community survey.
  - Description: Per [release-roadmap §10](release-roadmap.md#10-community-feedback-loop). 10-question survey, posted to all channels.
  - Acceptance: Survey results published. v1.0 roadmap review incorporates results.
  - Effort: S. Dependencies: LF-0.2-25. Assignee: `@unassigned`.

- **LF-0.3-27** — First annual contributor awards.
  - Description: Recognize top contributors in each category (code, docs, packages, patches, support). Announced at the v0.3 release.
  - Acceptance: Awards announced. Recipients added to `CONTRIBUTORS.md` hall of fame.
  - Effort: S. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

### 4.12 Additional v0.3 Issues

- **LF-0.3-28** — Implement `linuxify plugin install/list/uninstall`.
  - Description: Per [plugin-sdk §5](../10-plugin-sdk/plugin-sdk.md). Install plugins from npm, git URL, or local path. List shows installed plugins with version and capability grants. Uninstall removes and unregisters.
  - Acceptance: Plugin lifecycle works end-to-end. `list` shows source, version, and whether sandboxed.
  - Effort: M. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

- **LF-0.3-29** — Implement `linuxify plugin info <name>` and `linuxify plugin search <query>`.
  - Description: `info` shows manifest, hooks, capabilities, install source. `search` queries npm for `linuxify-plugin` keyword.
  - Acceptance: Both commands produce structured output. `--json` supported.
  - Effort: S. Dependencies: LF-0.3-28. Assignee: `@unassigned`.

- **LF-0.3-30** — Implement plugin debug logging.
  - Description: Per [plugin-sdk §15](../10-plugin-sdk/plugin-sdk.md). `LINUXIFY_DEBUG_PLUGINS=1` env var enables per-plugin log files at `~/.linuxify/logs/plugins/<name>.log`. 5MB rotation, 30-day retention.
  - Acceptance: Plugin log files appear when env var set. Logs include hook entry/exit, errors, timing.
  - Effort: S. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

- **LF-0.3-31** — Implement doctor plugin checks (plugins can register doctor checks).
  - Description: Per [doctor-engine §8](../07-doctor/doctor-engine.md) and [extension-api §9](../10-plugin-sdk/extension-api.md). Plugins register `DoctorCheck` objects via the doctor API. Checks appear in the standard doctor output with a `plugin.<name>.<check>` ID.
  - Acceptance: A test plugin's doctor check appears in `linuxify doctor` output. Failing the check fails doctor.
  - Effort: M. Dependencies: LF-0.3-16, LF-0.1-05. Assignee: `@unassigned`.

- **LF-0.3-32** — Implement custom commands via plugins.
  - Description: Per [extension-api §10](../10-plugin-sdk/extension-api.md). Plugins register subcommands via `cli.registerCommand()`. Commands appear in `linuxify --help` and are invokable.
  - Acceptance: A test plugin's custom command appears in `--help` and is invokable.
  - Effort: M. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

- **LF-0.3-33** — Implement custom distro plugin (FedorARM reference).
  - Description: Per [plugin-sdk §10](../10-plugin-sdk/plugin-sdk.md). A reference plugin that registers a Fedora distro provider, demonstrating the plugin SDK's distro extension point.
  - Acceptance: `linuxify plugin install linuxify-plugin-fedora && linuxify use fedora` works end-to-end.
  - Effort: L. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

- **LF-0.3-34** — Implement custom runtime plugin (Bun reference).
  - Description: A reference plugin that registers a Bun runtime provider.
  - Acceptance: `linuxify plugin install linuxify-plugin-bun && linuxify add <bun-package>` works.
  - Effort: L. Dependencies: LF-0.3-16. Assignee: `@unassigned`.

- **LF-0.3-35** — Add `linuxify doctor --fix` (alias for `linuxify repair`).
  - Description: Per [doctor-engine §6](../07-doctor/doctor-engine.md). Some users instinctively type `doctor --fix`; this alias redirects to `repair`.
  - Acceptance: `linuxify doctor --fix` runs `linuxify repair`.
  - Effort: S. Dependencies: LF-0.3-01. Assignee: `@unassigned`.

- **LF-0.3-36** — Add `linuxify snapshot --cloud` (stub for v1.1 cloud sync).
  - Description: Snapshot command gains `--cloud` flag that errors with `E_SNAPSHOT_CLOUD_NOT_AVAILABLE` in v0.3, with a message pointing to v1.1. This is a placeholder so users see a clear error rather than a missing flag.
  - Acceptance: `linuxify snapshot --cloud` produces a clear "coming in v1.1" error.
  - Effort: S. Dependencies: LF-0.3-02. Assignee: `@unassigned`.

- **LF-0.3-37** — Add migration hooks framework.
  - Description: Per [release-pipeline §8](../14-cicd/release-pipeline.md). Migration scripts at `migrations/<from-version>-<to-version>.ts`. Idempotent via `state.json`'s `migrations.applied` array. Rollback on failure.
  - Acceptance: A test migration runs once, does not re-run on second invocation. Failed migration rolls back state.
  - Effort: M. Dependencies: LF-0.2-34. Assignee: `@unassigned`.

- **LF-0.3-38** — Add `linuxify doctor history --diff <ts1> <ts2>`.
  - Description: Per [doctor-engine §10](../07-doctor/doctor-engine.md). Diff two doctor runs from history. Shows checks that changed status (ok→warn, warn→fail, etc.).
  - Acceptance: Diff output is clear and actionable. Used in bug reports.
  - Effort: S. Dependencies: LF-0.3-13. Assignee: `@unassigned`.

- **LF-0.3-39** — Add `linuxify repair --retry-failed` flag.
  - Description: Per [doctor-engine §6](../07-doctor/doctor-engine.md). Re-runs only the fixes that failed in the prior repair attempt.
  - Acceptance: Flag re-runs only previously-failed fixes. Logged to repair log.
  - Effort: S. Dependencies: LF-0.3-01. Assignee: `@unassigned`.

- **LF-0.3-40** — Implement `linuxify env --json`.
  - Description: Per [cli-specification §4](../03-cli/cli-specification.md). JSON output of the `linuxify env` command. Schema: `linuxify.env.v1`.
  - Acceptance: `--json` produces valid schema-conformant output.
  - Effort: S. Dependencies: LF-0.2-04. Assignee: `@unassigned`.

- **LF-0.3-41** — Add `linuxify info <package> --compat`.
  - Description: Adds `--compat` flag to `linuxify info` that shows the compat-db entry for the package across all distros and runtimes.
  - Acceptance: `--compat` shows a table of (distro, runtime, Android version) → status.
  - Effort: S. Dependencies: LF-0.2-19. Assignee: `@unassigned`.

- **LF-0.3-42** — Add `linuxify search --online` flag.
  - Description: Queries the (still git-based) registry on GitHub for packages not yet in the local cache. Pulls the registry repo on first use.
  - Acceptance: `--online` returns results for packages not in the local cache. Falls back to local if offline.
  - Effort: M. Dependencies: LF-0.1-17. Assignee: `@unassigned`.

- **LF-0.3-43** — Implement `linuxify config import` and `linuxify config export`.
  - Description: `export` writes the config to a TOML file (or stdout). `import` reads from a file (or stdin). Enables config portability and version control.
  - Acceptance: Round-trip (export then import) produces identical config. Errors on malformed input.
  - Effort: S. Dependencies: LF-0.2-03. Assignee: `@unassigned`.

- **LF-0.3-44** — Add `linuxify list --outdated`.
  - Description: Lists packages with available updates. Shows current and available versions.
  - Acceptance: `--outdated` shows only packages with updates. `--json` produces machine-readable output.
  - Effort: S. Dependencies: LF-0.3-04. Assignee: `@unassigned`.

- **LF-0.3-45** — Implement `linuxify remove --purge`.
  - Description: `remove --purge` removes the package AND its cache (downloaded tarballs, npm cache entries, etc.). Default `remove` keeps the cache for fast reinstall.
  - Acceptance: `--purge` frees more disk than default `remove`. Documented in `--help`.
  - Effort: S. Dependencies: LF-0.1-16. Assignee: `@unassigned`.

- **LF-0.3-46** — Add fuzzing harnesses for YAML, TOML, and regex parsers.
  - Description: Per [testing-strategy §9](../12-testing/testing-strategy.md). Use `jsfuzz` to fuzz the parsers. Goal: find crashes and panics.
  - Acceptance: Fuzzing runs in nightly CI. Any crashes found are fixed.
  - Effort: M. Dependencies: LF-0.2-37. Assignee: `@unassigned`.

- **LF-0.3-47** — Add performance benchmarks for bootstrap, doctor, launcher, patcher.
  - Description: Per [testing-strategy §10](../12-testing/testing-strategy.md). Benchmarks in `tests/perf/`. Run in nightly CI. ≥10% regression blocks the PR.
  - Acceptance: Benchmarks run automatically. Baseline established. Regression detection working.
  - Effort: M. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

- **LF-0.3-48** — Add snapshot testing for doctor output and launcher scripts.
  - Description: Per [testing-strategy §7](../12-testing/testing-strategy.md). Snapshot tests detect drift in doctor output format and launcher script content.
  - Acceptance: Snapshots checked into repo. CI fails on drift. `--update-snapshots` flag for intentional changes.
  - Effort: M. Dependencies: LF-0.1-05, LF-0.1-13. Assignee: `@unassigned`.

- **LF-0.3-49** — Implement `linuxify feedback` command.
  - Description: Opens an interactive prompt: "Is something wrong? (bug) / Missing a feature? (request) / Just want to chat? (discussion)". Pre-fills a GitHub issue template with `linuxify doctor --markdown` output attached.
  - Acceptance: Command produces a ready-to-paste issue body. Works offline (just prints the body).
  - Effort: S. Dependencies: LF-0.1-05. Assignee: `@unassigned`.

- **LF-0.3-50** — Localize the install and doctor flows to Spanish.
  - Description: First end-to-end localization. All strings shown during `init` and `doctor` translated.
  - Acceptance: `LANG=es_ES.UTF-8 linuxify init` shows Spanish throughout. Coverage ≥90% for these two flows.
  - Effort: M. Dependencies: LF-0.3-19. Assignee: `@unassigned`.

- **LF-0.3-51** — Add `linuxify version --check` (check for updates without updating).
  - Description: Checks the registry for a newer Linuxify version. Prints "you're on v0.3.0, latest is v0.3.1" or "you're up to date". Exit 0 if up to date, exit 1 if update available (useful for scripts).
  - Acceptance: Works against alpha, beta, stable channels. `--json` output.
  - Effort: S. Dependencies: LF-0.2-34. Assignee: `@unassigned`.

- **LF-0.3-52** — Add `linuxify doctor --ci` flag (CI mode).
  - Description: Per [doctor-engine §9](../07-doctor/doctor-engine.md). `--ci` implies `--profile ci --json`. Exits 1 on any warn (elevated to fail). For CI pipelines.
  - Acceptance: `--ci` produces JSON output. Warn elevated to fail. Exit codes match the [exit namespace](../03-cli/cli-specification.md#6-exit-code-convention).
  - Effort: S. Dependencies: LF-0.3-03. Assignee: `@unassigned`.

- **LF-0.3-53** — Write v0.3 → v1.0 migration guide.
  - Description: Document what users need to do when upgrading from v0.3 to v1.0. Includes any config schema changes, deprecated commands, etc.
  - Acceptance: Guide published at `docs/migrations/v0.3-to-v1.0.md`.
  - Effort: M. Dependencies: LF-1.0-06. Assignee: `@unassigned`.

---

## 5. v1.0.0 Issues

v1.0.0 is the stable release. The exit criteria from [the roadmap](release-roadmap.md#v100-stable--q4-2026) gate this milestone: security audit, 100 packages, full docs, LTS policy enforced, conference talk submitted.

### 5.1 Security

- **LF-1.0-01** — Engage third-party security audit firm.
  - Description: Per [release-roadmap §5 v1.0.0](release-roadmap.md#v100-stable--q4-2026). Firm reviews codebase, patch engine, plugin sandbox, threat model. Output: audit report with findings.
  - Acceptance: Firm engaged. Audit scoped. Estimated completion before v1.0 target date.
  - Effort: M. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

- **LF-1.0-02** — Remediate audit findings.
  - Description: All critical findings patched. High findings patched or risk-accepted with documented rationale. Medium findings scheduled for v1.1.
  - Acceptance: Zero critical findings open at v1.0 cut. Audit report published.
  - Effort: L. Dependencies: LF-1.0-01. Assignee: `@unassigned`.

- **LF-1.0-03** — Implement LTS policy enforcement in release pipeline.
  - Description: Per [release-roadmap §2](release-roadmap.md#2-versioning-policy). Pipeline refuses to cut patch releases on out-of-support branches. `linuxify self-update` warns on EOL branches.
  - Acceptance: Attempting to cut v0.1.x patch after v0.3 ships fails CI. Warning shown to users on EOL branches.
  - Effort: M. Dependencies: LF-0.2-32. Assignee: `@unassigned`.

### 5.2 Registry

- **LF-1.0-04** — Add 50 community-contributed package YAMLs (reach 100 total).
  - Description: Continued community contributions. Push to reach 100 by v1.0.
  - Acceptance: 100 packages in registry. Each installs on Ubuntu; ≥70% install on all 4 distros.
  - Effort: L (50×S). Dependencies: LF-0.3-14. Assignee: `@unassigned` (multiple contributors).

- **LF-1.0-05** — Public roadmap published at `linuxify.sh/roadmap`.
  - Description: Per [release-roadmap §13](release-roadmap.md#13-roadmap-process). Website deploys from this file via CI.
  - Acceptance: `linuxify.sh/roadmap` shows the current roadmap. Updates within 1 hour of merge to main.
  - Effort: S. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

### 5.3 Docs

- **LF-1.0-06** — Complete and review all docs in `docs/`.
  - Description: Per [release-roadmap §5 v1.0.0](release-roadmap.md#v100-stable--q4-2026). Every doc in the [INDEX](../INDEX.md) complete, reviewed by ≥2 maintainers, no TODOs.
  - Acceptance: Doc CI job reports zero TODOs, zero broken cross-links, zero stale references.
  - Effort: L. Dependencies: all prior docs work. Assignee: `@unassigned`.

- **LF-1.0-07** — Write the v1.0 announcement blog post.
  - Description: The "Linuxify 1.0" post. The big one. Covers: the journey from v0.1, the 100 packages, the security audit, the LTS promise, what's next (cloud sync, HTTP registry).
  - Acceptance: Reviewed by all maintainers. Published with v1.0 stable cut. Linked from HN, Lobsters, Reddit.
  - Effort: L. Dependencies: LF-1.0-02. Assignee: `@unassigned`.

### 5.4 Outreach

- **LF-1.0-08** — Submit conference talk (FOSDEM / LinuxConf / SCaLE).
  - Description: Per [release-roadmap §5 v1.0.0](release-roadmap.md#v100-stable--q4-2026). 30-minute talk proposal covering the project, the technical challenges, the community.
  - Acceptance: Talk submitted to ≥1 conference. Acceptance not required for v1.0 exit.
  - Effort: M. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

- **LF-1.0-09** — v1.0.0 stable release.
  - Description: Promote from beta after 7 days clean telemetry. Tag, sign, publish. Stable GPG key.
  - Acceptance: v1.0.0 tag cut and signed. Release health report published 2 weeks post-release. LTS branches created for v1.0.x.
  - Effort: M. Dependencies: LF-1.0-02, LF-1.0-03, LF-1.0-06. Assignee: `@unassigned`.

### 5.5 Sustainability

- **LF-1.0-10** — Establish Open Collective and GitHub Sponsors.
  - Description: Per [release-roadmap §14](release-roadmap.md#14-funding--sustainability). Open Collective account with public ledger. GitHub Sponsors profiles for individual maintainers.
  - Acceptance: Both channels live. Links from README and CONTRIBUTING.
  - Effort: S. Dependencies: none. Assignee: `@unassigned`.

- **LF-1.0-11** — Grow maintainer team to ≥5.
  - Description: Per [risk RR-03](release-roadmap.md#8-risk-register). Promote ≥2 contributors to maintainer status via the [governance process](../16-community/contribution-guidelines.md#14-governance).
  - Acceptance: ≥5 maintainers with merge access. ≥2 with release access.
  - Effort: M. Dependencies: LF-0.3-22. Assignee: `@unassigned`.

- **LF-1.0-12** — v1.0 retrospective.
  - Description: Per [qa-framework §14](../12-testing/qa-framework.md). Blameless postmortem covering the v0.x → v1.0 arc. Identifies what to change for v1.x.
  - Acceptance: Postmortem published. v1.1 issues filed.
  - Effort: S. Dependencies: LF-1.0-09. Assignee: `@unassigned`.

### 5.6 Additional v1.0 Issues

- **LF-1.0-13** — Public website launch (`linuxify.sh`).
  - Description: Marketing site with landing page, docs, blog, roadmap. Built from this docs repo via static site generator. Deployed via Cloudflare Pages.
  - Acceptance: Site live. Docs render correctly. Blog posts published. Roadmap page mirrors `release-roadmap.md`.
  - Effort: L. Dependencies: LF-1.0-06. Assignee: `@unassigned`.

- **LF-1.0-14** — Establish the RFC process formally.
  - Description: Per [release-roadmap §10](release-roadmap.md#10-community-feedback-loop). RFCs accepted via PR. Numbering shared with ADRs. README in `docs/rfcs/` explaining the process.
  - Acceptance: First v1.x RFC (for cloud sync or HTTP registry) filed and discussed.
  - Effort: S. Dependencies: LF-0.3-25. Assignee: `@unassigned`.

- **LF-1.0-15** — Write the contributor onboarding guide.
  - Description: A docs page at `docs/onboarding.md` for new contributors. Walks through: read the docs, join Discord, pick a `good first issue`, set up dev env, open first PR. Cross-links to [contribution-guidelines](../16-community/contribution-guidelines.md).
  - Acceptance: A new contributor can follow the guide to their first merged PR.
  - Effort: M. Dependencies: LF-1.0-06. Assignee: `@unassigned`.

- **LF-1.0-16** — Set up the `linuxify/community` GitHub repo for discussions, RFCs, governance.
  - Description: Separate repo for non-code community artifacts: RFC proposals, governance docs, meeting notes, survey results. Issues are for actionable work; discussions are for everything else.
  - Acceptance: Repo live. RFC template copied. Meeting notes from v1.0 onwards archived there.
  - Effort: S. Dependencies: LF-1.0-14. Assignee: `@unassigned`.

- **LF-1.0-17** — Publish the v1.0 design philosophy essay.
  - Description: A long-form blog post / essay explaining *why* Linuxify exists, *why* it's built this way (proot, YAML, AST patching), and *what* it's not. Aimed at the broader open-source community, not just users.
  - Acceptance: Essay reviewed by all maintainers. Published at `linuxify.sh/blog/v1.0-design-philosophy`.
  - Effort: M. Dependencies: LF-1.0-07. Assignee: `@unassigned`.

- **LF-1.0-18** — Conduct the first annual sustainability audit.
  - Description: Per [release-roadmap §14](release-roadmap.md#14-funding--sustainability). Review income vs expenses, maintainer burnout signals, contributor pipeline health. Publish the audit.
  - Acceptance: Audit published at `linuxify.sh/blog/sustainability-2026`. Any structural changes (e.g., introducing paid tier) RFC'd.
  - Effort: M. Dependencies: LF-1.0-10. Assignee: `@unassigned`.

- **LF-1.0-19** — Establish contributor bounties program.
  - Description: Per [release-roadmap §9](release-roadmap.md#9-resource-plan). Funded from Open Collective. Bounties on high-impact issues, paid on merge. Public bounty board.
  - Acceptance: Bounty board live. ≥3 bounties claimed and paid in the first quarter.
  - Effort: M. Dependencies: LF-1.0-10. Assignee: `@unassigned`.

- **LF-1.0-20** — Promote `CONTRIBUTORS.md` to first-class artifact.
  - Description: Every merged PR adds the contributor to `CONTRIBUTORS.md` (automated via GitHub Action). Categorize by contribution type (code, docs, packages, patches, etc.). Display on the website.
  - Acceptance: Action runs on every merge. Contributors file stays current. Website shows contributor grid.
  - Effort: S. Dependencies: LF-0.1-26. Assignee: `@unassigned`.

- **LF-1.0-21** — Freeze the v1.x public API surface.
  - Description: Per [release-roadmap §2](release-roadmap.md#2-versioning-policy). Document the v1.x public API: CLI surface, package YAML schema, config schema, plugin SDK v1.0, doctor check IDs, exit codes, error codes. Any change requires a major version bump.
  - Acceptance: Public API surface documented at `docs/public-api.md`. CI job enforces no breaking changes to v1.x surface.
  - Effort: M. Dependencies: LF-1.0-03. Assignee: `@unassigned`.

- **LF-1.0-22** — Add API stability tests.
  - Description: Per [testing-strategy](../12-testing/testing-strategy.md). Tests that fail if the public API surface changes (CLI flags removed, exit codes changed, schema fields removed). Snapshot-based.
  - Acceptance: Tests run in CI. Breaking changes fail CI until major version bumped.
  - Effort: M. Dependencies: LF-1.0-21. Assignee: `@unassigned`.

- **LF-1.0-23** — Set up the v1.0 LTS branch.
  - Description: Per [release-roadmap §2](release-roadmap.md#2-versioning-policy). Create `lts/v1.0` branch. Back-port critical fixes for 3 months after v1.2 ships.
  - Acceptance: Branch created. Back-port process documented. CI runs on LTS branch.
  - Effort: S. Dependencies: LF-1.0-09. Assignee: `@unassigned`.

- **LF-1.0-24** — Set up governance documentation.
  - Description: Per [contribution-guidelines §14](../16-community/contribution-guidelines.md#14-governance). Document maintainer roles (maintainer, core maintainer, lead maintainer), how to become one, decision-making process, conflict resolution.
  - Acceptance: Governance doc at `docs/governance.md`. Reviewed by all maintainers.
  - Effort: M. Dependencies: LF-1.0-11. Assignee: `@unassigned`.

- **LF-1.0-25** — Establish the monthly community call cadence.
  - Description: Per [release-roadmap §10](release-roadmap.md#10-community-feedback-loop). First Saturday of each month, 16:00 UTC, Discord. Notes posted to GitHub Discussions within 48 hours. Recording published.
  - Acceptance: First call held. Notes published. Recording on YouTube.
  - Effort: S. Dependencies: LF-0.2-25. Assignee: `@unassigned`.

- **LF-1.0-26** — First quarterly roadmap review.
  - Description: Per [release-roadmap §13](release-roadmap.md#13-roadmap-process). Maintainer team reviews progress, risks, RFCs. Diff to `release-roadmap.md` committed as PR.
  - Acceptance: Review held. PR merged. Community notified.
  - Effort: S. Dependencies: LF-1.0-09. Assignee: `@unassigned`.

- **LF-1.0-27** — Write the security disclosure runbook.
  - Description: Per [security-model §13](../13-security/security-model.md). Step-by-step process for receiving, triaging, fixing, and disclosing a security vulnerability. Includes the `conduct@linuxify.sh` and `security@linuxify.sh` email routing.
  - Acceptance: Runbook published. Reviewed by security lead. Tested with a tabletop exercise.
  - Effort: M. Dependencies: LF-1.0-02. Assignee: `@unassigned`.

- **LF-1.0-28** — Set up the threat-model delta process.
  - Description: Per [security-model §16](../13-security/security-model.md). Every release produces a "threat-model delta" — what changed in the threat model since the last release. Reviewed by security lead as a release gate.
  - Acceptance: Delta process documented. v1.0 release includes the first delta.
  - Effort: M. Dependencies: LF-1.0-02. Assignee: `@unassigned`.

- **LF-1.0-29** — Add SBOM (Software Bill of Materials) generation to release pipeline.
  - Description: Per [cicd-design §8](../14-cicd/cicd-design.md). Each release publishes an SBOM in SPDX or CycloneDX format.
  - Acceptance: SBOM published with each release. Validated by `syft` or equivalent.
  - Effort: M. Dependencies: LF-0.2-32. Assignee: `@unassigned`.

- **LF-1.0-30** — Set up the package signing ceremony for stable releases.
  - Description: Per [release-pipeline §5](../14-cicd/release-pipeline.md). GPG signing of release artifacts. KEYS file published. Web-of-trust established.
  - Acceptance: Stable releases signed. KEYS file published. Verification instructions in install guide.
  - Effort: M. Dependencies: LF-0.2-32. Assignee: `@unassigned`.

---

## 6. Issue Estimation Guide

All estimates use the **S/M/L** scale. The scale is calibrated to a contributor who is already familiar with the Linuxify codebase; a first-time contributor should expect to multiply their estimate by 2–3x.

| Size | Effort | Description | Examples |
|---|---|---|---|
| **S** | Half-day (≤4 hours) | Single file, clear spec, no architectural decisions. | Adding a doctor check, fixing a typo, updating a config schema field. |
| **M** | Two days (8–16 hours) | Multiple files, clear spec, may require coordination with another subsystem. | Implementing a subcommand, adding a patch type, writing a package YAML with patches. |
| **L** | One week (20–40 hours) | Cross-cutting, architectural decisions, requires design discussion. | Implementing a new distro backend, the patch engine core, the plugin SDK. |

**Velocity tracking.** Each sprint, the team tracks velocity in story points (S=1, M=3, L=5). Velocity is recorded in the sprint review notes and trended over time. A sustainable velocity for a 2-person maintainer team is 15–25 points per 2-week sprint. Velocity is not a target — it is a measurement. We do not push contributors to "increase velocity"; we use the trend to detect scope creep (velocity flat while backlog grows) or burnout (velocity drops suddenly).

**Re-estimation.** Issues can be re-estimated at any time. If an issue turns out to be larger than estimated, the contributor updates the estimate and notes the reason in the issue. This is not a failure — it is signal. Persistent under-estimation of a category of issues (e.g., "every distro backend takes 2× longer than estimated") triggers a retro entry.

---

## 7. Sprint Cadence

Linuxify runs on **2-week sprints**. The sprint rhythm is the heartbeat of the project — it determines when work is planned, when work is reviewed, and when work is celebrated. Sprints are not gates (work does not have to finish in a sprint), but they are the unit of progress reporting.

```mermaid
flowchart LR
  plan[Sprint Planning<br/>Monday week 1] --> dev1[Development<br/>Weeks 1-2]
  dev1 --> daily[Daily Async Standup<br/>Slack #standup]
  daily --> review[Sprint Review<br/>Friday week 2]
  review --> retro[Retrospective<br/>Friday week 2]
  retro --> plan2[Next Sprint Planning<br/>Monday week 3]
```

**Sprint planning** happens on Monday of week 1. Maintainers and active contributors meet (sync or async) to pick issues for the sprint. The sprint backlog is recorded in a GitHub Project board column. Issues are pulled from the milestone's open issues. The team commits to a velocity target based on the prior 3-sprint average.

**Daily standup** is async, in the `#standup` Discord channel. Each contributor posts three lines: what I did yesterday, what I'm doing today, what's blocking me. Maintainers are expected to post daily; contributors are encouraged but not required. Blocking issues are flagged with `@maintainer` and get a same-day response.

**Sprint review** happens on Friday of week 2. Each contributor demos what they shipped. Demos are recorded and posted to Discord. The sprint review is the primary mechanism for cross-team visibility — a contributor working on the patcher sees what the registry contributor shipped, and vice versa.

**Retrospective** happens immediately after the sprint review, in the same meeting. The team discusses what went well, what went poorly, and what to change. Action items are filed as issues and assigned to the next sprint. Retros are blameless by rule (per [qa-framework §14](../12-testing/qa-framework.md)).

**Sprint skip weeks.** The team takes one week off between Christmas and New Year's, and one week off in July (northern summer / southern winter). These are no-expectation weeks — no sprint planning, no standups, no required reviews. Contributors who want to keep working can; nobody is expected to.

---

## 8. Burndown

Each milestone has a burndown chart, generated automatically by GitHub Projects. The chart shows the number of open issues (y-axis) versus time (x-axis), with an ideal line from sprint start to sprint end. The chart is reviewed at every sprint review.

**What "on track" looks like.** The actual line tracks the ideal line within ±15%. Small deviations are normal (a contributor takes a sick day, an issue turns out to be larger than estimated). Large deviations are signal: if the actual line is consistently above the ideal line, the milestone is at risk and the team should re-baseline (see [§9](#9-milestone-slippage-protocol)). If the actual line is consistently below, the team is under-committing and should pull more issues into the sprint.

**What "off track" looks like.** The actual line flattens (no issues closing) or diverges sharply from the ideal line (issues opening faster than closing). Either is a trigger for the milestone owner to investigate. Common causes: an unsurfaced blocker, an under-estimated issue, a contributor who has gone quiet, or scope creep (new issues being added mid-sprint).

**Reading the chart.** Burndown charts are not performance reviews. They are diagnostic tools. A bad burndown is not a reflection on the contributors — it is a reflection on the plan. The response to a bad burndown is to fix the plan, not to push the contributors harder.

---

## 9. Milestone Slippage Protocol

Milestones slip. It happens. The protocol below is the agreed-upon response when a milestone's target date becomes unrealistic. The protocol exists to make slippage a structured, low-drama event rather than a slow-burn crisis.

**Communicate early.** As soon as the milestone owner suspects slippage (typically 4–6 weeks before the target date), they post in the `#roadmap` Discord channel and open a `roadmap-update` PR noting the risk. Early communication is the single most important rule — a slip announced 6 weeks out is a plan adjustment; a slip announced 6 days out is a crisis.

**Re-baseline.** The milestone owner proposes a new target date. The proposal includes: what's done, what's in progress, what's not started, the new target date, and the rationale (was the original estimate wrong? did a dependency slip? did scope grow?). The proposal is reviewed by the maintainer team in the next weekly maintainer sync.

**De-scope aggressively.** Before pushing the target date, the team reviews the milestone scope for items that can move to the next milestone. The default question is "what's the smallest milestone that delivers user value?" If a milestone can ship with 80% of its scope and the remaining 20% moves to the next milestone, that's almost always the right call. Scope items are not sacred; user trust is.

**Don't sacrifice quality.** Quality is non-negotiable. We do not skip tests to make a date. We do not skip docs to make a date. We do not skip security review to make a date. If the only way to make a date is to compromise quality, the date slips. This is the rule that separates sustainable projects from burnout projects.

**Document the slip.** The `roadmap-update` PR is merged with the new target date and a note in the milestone's "Risks" field explaining what was learned. The slip is announced in the next release blog post and the next monthly community call. Slippage is not hidden — it is part of the project's history.

---

## 10. Definition of Done

An issue is **done** when all of the following are true. The Definition of Done (DoD) is enforced by the PR template's checklist (per [contribution-guidelines §6](../16-community/contribution-guidelines.md#6-pr-process)) and verified by the reviewer. A PR that does not meet the DoD is not merged, regardless of how urgent the fix is.

| Criterion | Verified by | Notes |
|---|---|---|
| Code merged to main | GitHub | Squash merge on approval (per [contribution-guidelines §6](../16-community/contribution-guidelines.md)). |
| Tests added | Reviewer | New behavior requires new tests. Bug fixes require a regression test that fails pre-fix and passes post-fix (per [qa-framework §7](../12-testing/qa-framework.md)). |
| Tests pass in CI | GitHub Actions | All workflows green. |
| Docs updated | Reviewer | If the issue changes user-visible behavior, the relevant docs file is updated in the same PR. |
| CHANGELOG entry added | Reviewer | Under the appropriate section (`Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`) in `CHANGELOG.md`. |
| compat-db updated (if applicable) | Reviewer | If the issue adds/changes a package or patch, the compat-db entry is updated in the same PR. |
| Signed off by reviewer | Reviewer | 1 approval minimum; 2 for sensitive paths (`src/patcher/`, `src/registry/`, `src/security/`) per [contribution-guidelines §6](../16-community/contribution-guidelines.md#6-pr-process). |
| DCO sign-off | GitHub DCO app | Every commit signed off (`Signed-off-by: Name <email>`). Per [contribution-guidelines §18](../16-community/contribution-guidelines.md). |

An issue is **closed** when its PR is merged. The PR description contains `Closes LF-<milestone>-<n>`, which auto-closes the issue. If an issue requires multiple PRs, each PR references the issue without closing it; the final PR closes.

The DoD is the contract between contributors and maintainers. It is also the contract between the present maintainer team and the future maintainer team — every merged PR is a small piece of project history, and the DoD ensures that history is testable, documented, and traceable.
