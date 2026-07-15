# Linuxify Strategy

> **Status:** Living document. Updated when strategic assumptions change.
> **Audience:** Maintainers, contributors, and AI coding agents building Linuxify.
> **Purpose:** Capture the *why* behind product decisions so future contributors
> don't relitigate settled questions.

---

## 1. The killer feature is "Make Linux CLIs work on Android" — not Ubuntu

### The distinction

Ubuntu is an implementation detail. The killer feature is the outcome:

> A developer types `linuxify add cline`, and Cline *just works* on their phone.

How we make it work (proot + Ubuntu + Node + patches + launchers) is invisible
to the user. If a future version of Linuxify achieves the same outcome via
QEMU + Debian, or via a custom Android-native Node runtime with no proot at
all, that's a win — as long as `linuxify add cline` still works.

### Why this matters for product decisions

1. **Never make Ubuntu the centerpiece of marketing.** The tagline is
   "Run Linux developer tools on Android," not "Ubuntu on your phone."
   UserLAnd and Andronix already own the "Linux distro on Android" mind-share;
   competing there is a losing battle. We own "developer CLIs work on Android."

2. **Distro choice is user-facing but not user-critical.** `linuxify use debian`
   is a power-user feature, not a flagship. The default (Ubuntu) should be so
   good that 90% of users never think about it. The 10% who switch distros
   are the same 10% who file detailed bug reports — they're served by the
   pluggable `DistroProvider` abstraction.

3. **Future expansion beyond Linux is on the table.** Once the "Linux CLIs on
   Android" wedge is solid, the same architecture (install → patch → launch →
   diagnose) applies to:
   - macOS-only CLIs (via Swift toolchain for Linux — no QEMU needed)
   - Windows-only CLIs (via Wine + Box86/Box64 for ARM)
   - GUI tools (via X11/VNC forwarding)
   - iOS (via cloud-hosted Linuxify — not native iOS)

   The name "Linuxify" stays because it's a verb (`linuxify my CLI`) and a
   brand, not because the project is permanently limited to Linux.

4. **The distro abstraction (`DistroProvider`) is the most important interface
   in the codebase.** It's what makes the "Ubuntu is an implementation detail"
   principle real in code. Every subsystem that touches the distro
   (bootstrap, runtimes, packages, launcher, doctor) must go through the
   provider — never shell out to `proot-distro` directly. Bootstrap stage
   implementations that bypass the provider (a known tech-debt item as of
   v0.1.0-alpha.1) are bugs to fix, not patterns to copy.

---

## 2. Doctor is the AI mechanic — the second-most-important feature

### The vision

`linuxify doctor` is not a status reporter. It's a mechanic that:

1. **Diagnoses** — tells you what's wrong in plain English, not just `✖ PATH`
2. **Explains why** — root-cause hypothesis, not just symptoms
3. **Prescribes** — the exact command to fix it, with risk level
4. **Offers to apply** — one Enter-press away from fixed

### The diagnosis contract

Every failing doctor check should produce a diagnosis with:

```
━━━ Title ━━━
  WHAT: <plain English, 1-3 sentences>
  WHY:  <root-cause hypothesis, 1-3 sentences>
  EVIDENCE: [status] check.id — message
  REPAIR: <summary> (risk: safe|moderate|risky, ~Ns)
    → step 1  [command]
    → step 2  [command]
  ALTERNATIVES:
    · <alternative repair> (risk: ...)
  DOCS: <link>
  CONFIDENCE: <0-100%>
```

This is what `linuxify fix` produces. The user never has to read raw doctor
output unless they want to (`linuxify doctor` is still available for power
users and CI).

### Evolution path

| Version | Diagnosis engine |
|---------|------------------|
| v0.1 (now) | Local rules engine — 9 hand-authored rules for the most common failures |
| v0.2 | Package-defined `repair:` recipes (schema added in v0.1.1) — packages describe their own repairs |
| v0.3 | Community rules registry — contributors add rules via PR |
| v1.0 | Stable rules API; rules can be registered via plugin SDK |
| v2.0 | Optional LLM backend (`linuxify fix --ai`) — calls Cline/Codex/Ollama with diagnosis context; rules engine validates LLM proposals against safety allowlist before presenting |

### Safety contract

The diagnosis engine NEVER auto-applies repairs without explicit user consent.
Even with `--apply`, only `safe`-risk repairs are auto-applied; `moderate` and
above require confirmation. The safety filter refuses to present destructive
commands (`rm -rf /`, `mkfs`, `curl | sh`, fork bombs) regardless of source.

---

## 3. The compatibility database is a community asset

### The vision

```bash
$ linuxify search ai

✓ Cline          Supported    Ubuntu, Debian  ·  Node 20+
✓ Codex          Supported    Ubuntu          ·  Node 22+
✓ Aider          Supported    Ubuntu, Debian  ·  Python 3.10+
⚠ Claude Code    Partial      Needs Python 3.13
✖ Warp           Broken       Desktop only
```

People won't need to search GitHub issues to know what works. The compat-db
is the single source of truth, queryable from the CLI and rendered on the
website.

### What makes it an asset

1. **It's built from real test data, not marketing claims.** CI runs
   `linuxify add <pkg> && linuxify run <pkg> --version` for every package on
   every supported distro × runtime × arch × Android version. Results auto-
   update the compat-db. A "supported" badge means "CI verified this works,"
   not "the maintainer thinks it probably works."

2. **It grows with the community.** Users submit compat reports via
   `linuxify compat report <package>`. Maintainers review and update the
   database. The database is open data, exportable as JSON/CSV/Markdown.

3. **It's queryable.** `linuxify search ai --compat distro=alpine` filters
   by what actually works on Alpine. `linuxify info cline --compat` shows
   the full matrix for one package.

4. **It feeds back into the product.** If 80% of compat reports for a
   package show "broken on Android 15," that's a signal to prioritize the
   fix. If 95% show "works on Ubuntu," the package graduates from
   "partial" to "supported."

### Architecture

- **v1 (now):** Static JSON in the registry repo, updated manually from CI
  results and user reports.
- **v2:** HTTP API at `registry.linuxify.sh/v1/compat` with real-time query,
  auto-updated from CI, signed entries.
- **v3:** Community-submitted reports with reputation system — trusted
  reporters' reports count more.

---

## 4. The build fingerprint makes bug reports actionable

### The problem

Every bug report used to start with a 10-message exchange:

> **User:** "Cline doesn't work"
> **Maintainer:** "What Android version? What Termux version? What Node version? What distro? Is proot installed? Run `linuxify doctor` and paste the output."
> **User:** *pastes 200 lines of doctor output*
> **Maintainer:** "OK, you're on Android 14 with Node 20 — that's the bug. Upgrade to Node 22."

### The solution

`linuxify report` produces a deterministic, redacted, copy-pasteable summary.
`linuxify report --fingerprint` produces a one-liner:

```
linuxify/0.1.0 android/16 termux/0.119 distro/ubuntu node/24.18 arch/arm64 kernel/6.17 storage/ok doctor/clean
```

Bug reports become:

> **User:** "Cline doesn't work. Fingerprint: `linuxify/0.1.0 android/16 ...`"
> **Maintainer:** *matches fingerprint against known-issue database* → "Known issue on Android 16 + Node 24.18. Run `linuxify fix`."

### Design principles

1. **No PII.** No username, hostname, device serial, IP, file paths beyond
   `~/.linuxify/`, env var values. The report is safe to paste in a public
   GitHub issue.
2. **Deterministic.** Same environment → same fingerprint. Enables
   "does this fingerprint match a known-good config?" matching.
3. **Human-readable.** Not a hash. Users can eyeball differences between
   two fingerprints ("oh, my Node version is different").
4. **Machine-readable.** `--json` output for tooling. The fingerprint is
   parseable with a simple `key/value` splitter.

---

## 5. Don't rush to npm

### The principle

npm publish is a one-way door. Once a version is on npm, it can be yanked
but not deleted. Users who installed it will keep it. A broken alpha on npm
poisons the project's reputation for months.

### The pre-npm checklist

Before `npm publish` for v0.1.0, Linuxify MUST be tested on:

- [ ] **Android 13** (Pixel or Samsung)
- [ ] **Android 14** (Pixel or Samsung)
- [ ] **Android 15** (Pixel or Samsung)
- [ ] **Android 16** (any device — newest, likely to have kernel surprises)

Different manufacturers if possible (Pixel = clean Android; Samsung = One UI
quirks; Motorola = near-vanilla; Xiaomi = MIUI restrictions).

On EACH device, run the full happy path:

```bash
linuxify init
linuxify doctor
linuxify add cline
linuxify add codex
linuxify add aider
linuxify shell
```

All six must succeed without manual intervention. Any failure blocks the
npm release.

### Why this matters

The first version a user installs is their first impression. If `linuxify init`
fails on their device, they uninstall and never come back. The documentation
set can be imperfect; the install experience cannot.

### The exception

Internal alpha testing (by maintainers, on their own devices) doesn't need
this gate. The gate is for *public* npm release. Until then, installation
is via `git clone && npm install && npm link` — documented in CONTRIBUTING.md.

---

## 6. Documentation structure

### Current state

The docs are organized by *number* (`00-executive/`, `01-product/`, ...,
`24-telemetry/`). This is good for the writing process (agents can claim a
number range) but bad for navigation (a user looking for "how does the
patcher work?" has to know it's in `08-patcher/`).

### Target state

Reorganize into *topic-based* directories that match how users think:

```
docs/
  getting-started/      ← quick start, install, first package
  architecture/         ← system design, component diagrams, ADRs
  package-format/       ← YAML schema, repair recipes, patches
  launcher/             ← how launchers work, customization
  bootstrap/            ← init stages, distro management
  doctor/               ← health checks, profiles, output formats
  repair/               ← fix command, diagnosis rules, safety
  distro/               ← Ubuntu, Debian, Arch, Alpine, custom
  runtimes/             ← Node, Python, Rust, Go
  compatibility/        ← compat-db, search, reports
  adr/                  ← architecture decision records
  roadmap/              ← release roadmap, milestones
  contributing/         ← contribution guide, dev setup, i18n
  troubleshooting/      ← symptom catalog, disaster recovery, FAQ
```

### Migration plan

1. Keep the numbered structure as the source of truth (don't break existing
   cross-links).
2. Add topic-based *symlink* or *index* directories that reference the
   numbered files.
3. Eventually (v1.0), flip: topic-based becomes primary, numbered is the
   implementation detail.

This is a v0.2 task — not blocking v0.1.0 alpha testing.

---

## 7. What NOT to build next

### Don't add more package definitions first

The bottleneck is NOT package coverage. Five well-supported packages (Cline,
Codex, Aider, Goose, Gemini CLI) cover 80% of AI-developer use cases. Adding
50 more packages before v0.1 is tested on real devices adds surface area
without adding validation.

### Don't build the cloud sync

Cloud sync is a v1.1+ feature. It depends on a stable v1.0 that users
actually want to sync. Building sync before v1.0 is premature optimization
for a user base that doesn't exist yet.

### Don't build the HTTP registry

The v1 git-based registry is fine for <500 packages. The HTTP registry is
v1.2+. The git registry is simpler, more transparent, and free to host.

### Don't build the plugin sandbox

Plugin sandboxing (capability-based permissions) is v2. In v1, plugins run
with full user privileges, same as the CLI itself. The security model
explicitly documents this limitation (see `docs/13-security/security-model.md`
§15).

### Do build next: `linuxify report` + `linuxify fix`

These are the features that turn "it doesn't work" reports into actionable
diagnostics. They're built (as of v0.1.1-alpha.1) and ready for testing.
Every alpha tester should be told: "if something breaks, run
`linuxify report --markdown` and paste it in the issue."

---

## 8. The wedge → platform arc

### The wedge (v0.1–v1.0)

"Run Linux AI coding CLIs on Android." Cline, Codex, Aider, Goose, Gemini CLI.
This is the thin wedge that gets the first 1,000 users.

### The expansion (v1.1–v2.0)

- 100+ packages (not just AI — web dev, Python, Rust, Go, DevOps)
- Plugin SDK for third-party extensions
- Multi-distro power users
- Self-hosted registry for enterprise
- Cloud sync for cross-device

### The platform (v2.0+)

- `linuxify fix --ai` (LLM-assisted diagnosis)
- HTTP registry with package signing
- Capability-based plugin sandbox
- QEMU for x86 binaries
- GUI doctor
- Beyond-Android: iOS (via cloud), ChromeOS (via Crostini)

### The endgame (v3.0+)

Linuxify is the standard way developers run any CLI on any mobile device.
AI agents (not humans) are the primary "users" — Linuxify is the API they
call to provision dev environments on demand. See
`docs/19-future/vision-extension.md` for the 5- and 10-year vision.

---

## 9. Decision log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-14 | "Linux CLIs on Android" is the wedge, not "Ubuntu on Android" | UserLAnd owns the latter; we own the former |
| 2026-07-14 | Doctor becomes `linuxify fix` — AI mechanic, not status reporter | Turns bug reports from "it doesn't work" into actionable diagnostics |
| 2026-07-14 | `linuxify report` is the v0.1.1 flagship feature | Makes community support scalable |
| 2026-07-14 | Package YAML gains `repair:` block | Packages describe their own repairs; diagnosis engine becomes declarative |
| 2026-07-14 | Don't publish to npm until tested on Android 13/14/15/16 | First impression is permanent; alpha must "just work" |
| 2026-07-14 | Compat-db is a first-class community asset | "What works?" is the #1 user question after install |
| 2026-07-14 | DistroProvider is the most important interface | Keeps "Ubuntu is an implementation detail" real in code |
