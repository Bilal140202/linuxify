# Changelog

All notable changes to the Linuxify project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial public documentation set: 75 markdown documents across 25 thematic
  directories, 15 Architecture Decision Records (ADRs), an AI Build Guide for
  coding agents (Cline, Codex, Claude Code, Aider), full CLI specification,
  package and patch schemas, plugin SDK reference, security model, threat
  analysis, CI/CD design, release roadmap, branding guide, GitHub issue/PR
  templates, future-vision documents (cloud sync, package registry v2,
  beyond-Linux expansion), and operational runbooks (troubleshooting, disaster
  recovery, self-hosting, migration guide).
- Code of Conduct (Contributor Covenant v2.1).
- License: MIT for all client-side and documentation components; BSL 1.1
  planned for v2 server-side components (sync server, HTTP registry).

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

