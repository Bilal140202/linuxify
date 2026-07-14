# Architecture Decision Records

> **Audience**: AI coding agents learning the rationale behind Linuxify's design choices, human contributors proposing changes, and maintainers revisiting past decisions. Every non-trivial design choice in Linuxify is documented here so that future work does not relitigate settled questions and so that any reconsideration can reference the original forces.

## 1. What is an ADR?

An **Architecture Decision Record (ADR)** is a short text document that captures *one* architectural decision made on a software project: the context that forced the decision, the options that were considered, the choice that was made, and the consequences that followed. ADRs were popularized by Michael Nygard's 2011 essay *"Documenting Architecture Decisions"* and have since become the standard way that thoughtful engineering teams record *why* their codebases look the way they do. The premise is simple: source code records *what* the system does, but it rarely records *why* it does it that way, and the "why" is what new contributors and future maintainers most need. An ADR fills that gap.

In Linuxify, ADRs serve three concrete audiences. The first is **AI coding agents** — when an agent is asked to "add a new runtime" or "support a new distro backend," the agent should read the relevant ADR (e.g., [ADR-003](adr-003-typescript-cli-core.md) for the runtime model, [ADR-001](adr-001-use-proot-over-chroot.md) for the distro model) before writing code, so that the new work is consistent with the established pattern rather than introducing a second, divergent pattern. The second is **human contributors** proposing a change: if you want Linuxify to switch from YAML to TOML for package definitions, the first step is to read [ADR-002](adr-002-yaml-package-definitions.md), understand the original rationale, and write a superseding ADR that argues why the forces have changed. The third is **maintainers** doing quarterly reviews: ADRs make it possible to audit which decisions are still load-bearing and which have been quietly obsoleted by changes elsewhere in the system.

## 2. Why Linuxify Uses ADRs

Linuxify is a multi-subsystem project (bootstrap, distro, runtime, packages, doctor, patcher, launcher, registry, plugins, telemetry) with non-obvious choices at every layer. Why `proot` and not `chroot`? Why YAML and not JSON for package definitions? Why TypeScript and not Rust for the CLI core? Why shell-script launchers and not bare symlinks? Why opt-in telemetry and not opt-out? Each of these questions has a defensible answer, but the answer is only useful if it is written down in a place that future contributors will actually find. ADRs give us that place.

The alternative — leaving the rationale buried in git commit messages, PR threads, and Discord conversations — guarantees that the rationale will be lost within six months. We have seen this in every open-source project of non-trivial size: a new contributor asks "why is it this way?" on the issue tracker, the maintainers shrug, and the system slowly accumulates cruft that nobody feels empowered to remove because nobody knows if it is load-bearing. ADRs short-circuit this cycle. They are the project's institutional memory.

## 3. The Format (Michael Nygard Template)

Every Linuxify ADR follows the Nygard template, lightly extended. The template is intentionally short — an ADR is not a design document, it is a decision record — and the discipline of fitting the rationale into a single page forces clarity.

```markdown
# ADR-NNN: Title

- Status: proposed | accepted | deprecated | superseded by ADR-XXX
- Date: YYYY-MM-DD
- Deciders: maintainer names (or "Linuxify core team" for group decisions)
- Context: (the problem, the forces, the options considered)
- Decision: (what we decided, in one or two paragraphs)
- Consequences: (positive + negative, explicitly enumerated)
- Alternatives Considered: (brief, one paragraph per alternative)
```

The `Status` field is the single most important field for the project's ongoing health. An ADR with status `accepted` is the law of the land; an ADR with status `proposed` is a draft that may be discussed but should not yet be implemented against; an ADR with status `deprecated` is one whose decision is no longer followed (the ADR remains in the repo for historical reference, but a note explains what replaced it); an ADR with status `superseded by ADR-XXX` is one that has been overturned by a later ADR, and the reader is redirected to the new one. Status changes are themselves recorded in the worklog.

The `Date` field is the date the ADR was marked `accepted`, not the date it was first drafted. The `Deciders` field names the humans who made the call; for group decisions, "Linuxify core team" is acceptable. The `Context` section is the longest section and the most important: it must enumerate the *forces* (technical constraints, user needs, ecosystem pressures) that made the decision necessary, because those forces are what a future reader must check to see if the decision is still valid. The `Decision` section is short and declarative. The `Consequences` section is honest about both the wins and the costs. The `Alternatives Considered` section is brief — one paragraph per rejected option, naming the option and the single most important reason it was rejected.

## 4. How to Write an ADR

If you are proposing a non-trivial change to Linuxify's architecture, package format, security model, or external API, you should write an ADR. "Non-trivial" means: the change will affect more than one subsystem, or it will be hard to reverse, or it will constrain future work, or it establishes a pattern that future contributors should follow. Trivial changes (bug fixes, refactors within a single file, dependency bumps) do not need ADRs.

To write one, create a new file `docs/20-adrs/adr-NNN-<kebab-case-title>.md` where `NNN` is the next available number (check the existing files in this directory) and `<kebab-case-title>` is a short descriptive title. Copy the template above. Fill in every section. The Context section should be 150–300 words; the Decision section 100–200; the Consequences section 100–200; the Alternatives section 50–100 per alternative. Aim for 500–800 words total — long enough to be substantive, short enough that a maintainer can review it in 10 minutes. Link to relevant docs (the [system architecture](../02-architecture/system-architecture.md), the [PRD](../01-product/prd.md), the [CLI spec](../03-cli/cli-specification.md), the [security model](../13-security/security-model.md)) using relative Markdown paths.

Open a PR with the new ADR. Mark its status `proposed` in the PR. Maintainers will review the Context (does it accurately describe the forces?), the Decision (is it internally consistent?), and the Consequences (are the costs honestly stated?). Once two maintainers approve, the ADR's status is changed to `accepted` and the PR is merged. The decision is now part of the project's contract.

## 5. How to Supersede an ADR

To overturn an existing ADR, do **not** edit the existing ADR in place. Instead, write a new ADR (next number) with status `proposed` whose Context section explicitly references the ADR being superseded, explains what has changed in the world (a new option has appeared, the original forces have weakened, the predicted negative consequences have materialized), and proposes the new decision. The new ADR's `Alternatives Considered` section should include "keep the status quo (ADR-NNN)" as one of the alternatives and explain why it is no longer good enough. Once the new ADR is `accepted`, edit the old ADR's `Status` line to read `superseded by ADR-XXX` and add a one-line note at the top pointing to the replacement. The old ADR's body is left unchanged so that the historical record is intact.

## 6. Index of ADRs

| Number | Title | Status |
|--------|-------|--------|
| [ADR-001](adr-001-use-proot-over-chroot.md) | Use proot over chroot or QEMU | Accepted |
| [ADR-002](adr-002-yaml-package-definitions.md) | YAML for package definitions | Accepted |
| [ADR-003](adr-003-typescript-cli-core.md) | TypeScript + Node.js for the CLI core | Accepted |
| [ADR-004](adr-004-shell-launchers-over-symlinks.md) | Shell-script launchers over bare symlinks | Accepted |
| [ADR-005](adr-005-opt-in-telemetry.md) | Opt-in telemetry (off by default) | Accepted |
| [ADR-006](adr-006-distro-provider-abstraction.md) | DistroProvider abstraction (pluggable distros) | Accepted |
| [ADR-007](adr-007-runtime-provider-abstraction.md) | RuntimeProvider abstraction (pluggable runtimes) | Accepted |
| [ADR-008](adr-008-toml-config-over-yaml-json.md) | TOML for `config.toml` over YAML or JSON | Accepted |
| [ADR-009](adr-009-opt-in-vs-opt-out-telemetry.md) | Opt-in vs. opt-out telemetry — deeper dive (companion to ADR-005) | Accepted |
| [ADR-010](adr-010-monorepo-vs-polyrepo.md) | Monorepo vs. polyrepo (start monorepo, split on friction) | Accepted |
| [ADR-011](adr-011-git-based-registry-v1.md) | Git-based registry for v1 over HTTP API from day 1 | Accepted |
| [ADR-012](adr-012-no-cla-dco-only.md) | DCO only, no CLA | Accepted |
| [ADR-013](adr-013-ed25519-for-package-signing-v2.md) | Ed25519 for v2 package signing over RSA or PGP | Proposed |
| [ADR-014](adr-014-bsl-for-server-side-components.md) | BSL for server-side components over MIT or AGPL | Proposed |
| [ADR-015](adr-015-zod-for-schema-validation.md) | Zod for runtime schema validation | Accepted |

## 7. Future ADRs Already Anticipated

Several open questions in the [PRD](../01-product/prd.md) §12 and the [release roadmap](../15-roadmap/release-roadmap.md) will eventually require ADRs. The most pressing are: the **bundled-binary vs. npm-install** question (PRD Q1) — whether Linuxify ships as a single self-contained binary or as an npm package that bootstraps its own Node runtime; the **armv7l tier classification** (PRD Q10) — whether armv7l is a tier-1 supported architecture or a best-effort community port; the **cloud-sync architecture** (see [vision-extension](../19-future/vision-extension.md)) — whether sync uses a Linuxify-hosted service, a third-party cloud, or user-supplied storage; and the **v2 plugin sandboxing** decision — whether to use `worker_threads`, `seccomp`, or `landlock` to isolate third-party plugins. ADR slots 016 onward are reserved for these. When you write one, link back to the open question you are resolving so the PRD can be updated to mark it closed.
