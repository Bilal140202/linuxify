# Changelog

All notable changes to the Linuxify project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

