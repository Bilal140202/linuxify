# QA Framework

> Audience: Linuxify maintainers, release managers, and contributors who need to understand *the process and tooling around testing* — as distinct from the [testing strategy](./testing-strategy.md) document, which covers *what* we test. This document is the contract for how a change moves from "PR opened" to "shipped to users."

Quality, in the Linuxify project, is treated as a property of the *process* that produces the code rather than as a property of the code itself. A codebase that happens to be free of bugs today can decay rapidly if the process that maintains it lacks rigor; conversely, a codebase with known gaps can be trustworthy if the process reliably catches regressions, fixes them fast, and learns from each incident. This document defines that process across fifteen interlocking concerns: pre-merge checks, post-merge surveillance, release gates, triage, reproduction standards, regression testing, performance and compatibility regressions, environment hygiene, manual testing, the beta channel, observability, postmortems, metrics, and the culture that ties them together.

---

## 1. QA Philosophy

Linuxify's QA philosophy rests on four commitments. **Shift-left** means catching bugs in the PR that introduced them, not in the release that ships them, not in the production incident that exposes them. The cost of fixing a bug rises by roughly an order of magnitude at each stage — a bug caught in review costs minutes, a bug caught in CI costs an hour, a bug caught in a release costs a day, a bug caught by a user costs a week (because it now includes the cost of writing a fix, an emergency release, a public advisory, and trust repair). **Blameless postmortems** mean that when something does escape, we focus on the systemic gap that let it escape, not on the individual who merged the PR. Punishing individuals hides future incidents; learning from them prevents them. **Fix-forward fast** means we prefer to ship a corrected version quickly over reverting and then re-fixing; this works because Linuxify's release pipeline supports same-day patch releases and because our user base is small enough that the blast radius of a quick follow-up is limited. **Observability over prevention** means we accept that some bugs will escape CI — the combinatorial matrix of distros, runtimes, archs, and Android versions is too large to test exhaustively — and we invest in the telemetry and doctor-output aggregation that lets us *detect* escapes fast and convert them into known issues.

These commitments are operationalized through the rest of this document. Pre-merge checks (§2) and release gates (§4) are the prevention layers. Post-merge checks (§3), observability (§13), and the beta channel (§12) are the detection layers. Bug triage (§5), regression testing (§7), and postmortems (§14) are the response layers. Metrics (§15) close the loop by telling us whether the system is improving over time.

---

## 2. Pre-Merge Checks

Every PR must pass a defined set of checks before it can be merged. The checks are encoded in GitHub Actions workflows and enforced by branch protection on `main`. The set is: **schema validation** (every YAML in `packages/` and every TOML in `tests/fixtures/configs/` must pass `validate`); **lint** (`eslint` with the project's custom rules including `linuxify/no-shared-state-in-tests` and `linuxify/no-clock-in-tests`); **type check** (`tsc --noEmit`); **unit tests** (full `@unit`-tagged suite, target <60 seconds); **integration tests** (full `@integration`-tagged suite, target <5 minutes); **docs build** (the `docs/` directory must build cleanly with MkDocs, including all Mermaid diagrams); and **code review** (minimum one approval from a maintainer, two approvals for PRs touching sensitive paths — defined as `src/patcher/`, `src/registry/`, `src/cli/router.ts`, or any file in `.github/workflows/`).

PR titles must follow **Conventional Commits** format (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `perf:`, `ci:`) — enforced by `amannn/action-semantic-pull-request`. This is not pedantry; the title drives the CHANGELOG generation and the semantic-version bump, and a malformed title produces a malformed release. The PR template includes checkboxes for: tests added/updated (with justification if not), CHANGELOG entry added, migration guide written (for breaking changes), compat-db updated (if the PR changes a package's compatibility status), and a regression test added (if the PR fixes a bug). The checkbox for regression tests is *enforced* — CI greps the diff for a new test file referencing the bug's tracking issue number, and blocks merge if a `fix:` PR lacks one.

---

## 3. Post-Merge Checks

Merge to `main` is not the end of the pipeline. A set of slower, more expensive checks runs after merge and on schedule. **E2E on main**: every merge to `main` triggers the full 8-job E2E matrix (2 distros × 2 runtimes × 2 archs — see [testing-strategy](./testing-strategy.md) §5). Failures open a tracking issue automatically with logs attached and ping the merging maintainer. **Nightly compat matrix**: the full compatibility matrix runs at 02:00 UTC nightly, populating the compat-db (see [testing-strategy](./testing-strategy.md) §6). **Weekly security scan**: every Monday at 06:00 UTC, `npm audit` runs against the lockfile, `osv-scanner` runs against the full dependency tree, and a custom scanner checks `packages/*.yml` for any package whose upstream has published a security advisory. **Monthly performance benchmark review**: the QA lead reviews the benchmark trend lines (see [testing-strategy](./testing-strategy.md) §10) and writes a short report to the maintainers' mailing list noting any persistent regressions and their causes.

Post-merge checks do not block merge, but they block *release*. A `main` branch that is currently failing any post-merge check is ineligible for release until the failure is resolved or explicitly waived by two maintainers. This separation keeps the PR feedback loop fast while still maintaining a high bar for what reaches users.

---

## 4. Release Gates

A release is gated on a checklist that is enforced by both tooling and human review. The hard gates are:

1. **All CI green on `main` for the past 7 days** — including the nightly compat matrix. Intermittent failures (flaky tests, transient network issues) are not excused; they must be fixed or quarantined before release.
2. **Zero open P0 bugs**, **≤3 open P1 bugs** — see §5 for the priority definitions. P0 means "core function blocked for one or more users"; nothing with an open P0 ships.
3. **CHANGELOG updated** — generated from Conventional Commits since the last release, then hand-edited for clarity. Breaking changes are called out at the top with migration instructions.
4. **Migration guide written** — for any release that changes a user-visible contract (CLI flags, config schema, file layout, exit codes), a `docs/migrations/<version>.md` file is required and linked from the CHANGELOG.
5. **compat-db regenerated** — the public compat-db is rebuilt from the latest nightly matrix run and the registry's curated entries, then published to the registry mirror network.
6. **Smoke test on a real device** — a maintainer installs the release candidate on a real Pixel (aarch64) and a real Samsung (aarch64, different kernel), runs the manual testing checklist (§11), and signs off in the release-tracking issue. Emulator-only testing is not sufficient; the smoke test exists to catch device-specific kernel/SELinux issues that emulators do not reproduce.

The release manager (a rotating role among maintainers) is responsible for verifying each gate. The release is published as a GitHub Release with signed artifacts, a signed tag, and an npm publish triggered by the tag push. The Termux package update is a separate PR to the `termux-packages` repository, prepared in parallel with the release. See [release-pipeline](../14-cicd/release-pipeline.md) for the full pipeline diagram.

---

## 5. Bug Triage Process

Bugs arrive via three channels: GitHub issues, anonymized telemetry (when the user has opted in), and the compat matrix's automated detection. All three feed into a single triage queue maintained in GitHub Project board with columns `New → Triaged → In Progress → Fixed → Verified → Closed`. Triage is performed by a rotating on-call maintainer, with a 30-minute triage sweep each weekday morning and a 5-minute sweep each weekend morning.

The SLA by priority is: **P0 (critical — blocks core function for one or more users)** → 4-hour first response, 24-hour fix or workaround. **P1 (major — significant degradation, no clean workaround)** → 24-hour first response, 1-week fix. **P2 (minor — cosmetic or rare edge case)** → 1-week first response, fix as capacity allows. **P3 (cosmetic — typos, color choices, message phrasing)** → backlog, fix opportunistically. The SLAs are *first response*, not *resolution* — the on-call acknowledges, assigns a priority, and either starts the fix or queues it; the resolution SLA is set per-bug during triage based on complexity.

Triage meeting cadence: a 30-minute weekly triage review with all maintainers, where the past week's new bugs are reviewed for correct priority, stale P2/P3 bugs are revisited, and patterns (multiple bugs in the same subsystem, multiple bugs from the same user environment) are surfaced. The triage review is also where we decide which bugs are "wishlist" (won't fix in v1, but tracked for v2) versus "won't fix" (closed with explanation). Both decisions are recorded in the issue for future searchability.

---

## 6. Reproduction Standards

A bug report without a reproduction is a hypothesis, not a bug. Linuxify enforces a strict reproduction standard: every bug report must include the output of `linuxify doctor --markdown`, which produces a Markdown-formatted doctor report suitable for pasting into a GitHub issue. The doctor output includes the Linuxify version, the detected environment (Android version, kernel, arch, Termux version, proot version, distro, runtime versions), the installed packages and their versions, and any current warnings or failures — enough information for a maintainer to identify the user's exact cell in the compat matrix.

For bugs that the doctor output alone does not reproduce, maintainers request a **reproduction on a clean environment**. The repro checklist per bug type is:

- **Install/bootstrap bugs**: `linuxify init --reset` followed by `linuxify init` with `--verbose` and capture the full output.
- **Patch bugs**: `linuxify patch <pkg> --dry-run --verbose` and `linuxify patch <pkg> --verbose`, plus the contents of `~/.linuxify/patches/<pkg>/latest.json` (the patch record).
- **Launcher bugs**: the contents of `$PREFIX/bin/<launcher>`, the output of `linuxify env`, and the exact error message including the exit code.
- **Doctor bugs**: `linuxify doctor --json` (the machine-readable form, which includes more detail than the human form).
- **Network bugs**: `linuxify --verbose <command>` plus the contents of `~/.linuxify/logs/linuxify.log` for the relevant timestamp (with secrets auto-redacted).

The bug-report issue template (`/.github/ISSUE_TEMPLATE/bug-report.yml`) includes these checklists and refuses to submit if the doctor output is missing. Maintainers close bugs that lack reproduction after a 7-day wait for the reporter to provide one, with a comment inviting them to reopen if they can repro on a clean environment. This is strict but necessary: bugs that we cannot reproduce cannot be fixed, and they accumulate as noise in the tracker if not closed.

---

## 7. Regression Testing

The rule is absolute: **when a bug is fixed, a regression test must be added in the same PR.** The PR template includes a checkbox for this, and CI enforces it by checking that any PR whose title starts with `fix:` includes a new test file (or modifies an existing one) whose name or content references the bug's tracking issue number (e.g., `tests/regression/issue-1234-patch-rollback-corrupt-state.test.ts`). The regression test must fail *before* the fix is applied and pass *after* — this is verified by a CI job that checks out the pre-fix commit, runs the new test, confirms it fails, then checks out the PR HEAD and confirms it passes. This proves the test actually exercises the bug, rather than passing for unrelated reasons.

Regression tests live in `tests/regression/` with a clear naming convention: `issue-<n>-<short-description>.test.ts`. They are tagged `@regression` (in addition to `@unit` or `@integration` as appropriate) so they can be reported on separately in the QA dashboard. The regression test count is a tracked metric (see §15) — a rising count is good (we are fixing bugs and preventing their return), but a *falling* count is suspicious and triggers a review of whether tests are being deleted rather than maintained. Regression tests are never deleted; if the behavior they assert changes, the test is updated, not removed, and the update is called out in the PR description with a justification.

---

## 8. Performance Regression

Benchmarks run on every PR (see [testing-strategy](./testing-strategy.md) §10) and on every merge to `main`. A regression of **≥10% on any benchmark blocks merge** by default. The PR author can request an override from a maintainer; the override request must include: (a) the name of the regressing benchmark, (b) the percentage regression, (c) the root cause (e.g., "the new feature requires an extra filesystem scan on every launch"), (d) the justification (e.g., "the alternative — caching the scan result — introduces a stale-cache bug that is worse than the perf hit"), and (e) a tracking issue for re-evaluating the decision in 90 days. Overrides are recorded in `docs/perf-overrides.md` and reviewed quarterly.

Performance regressions that escape CI — typically because they only manifest on real devices, not on the GitHub Actions runner class — are caught by the manual smoke test (§11) and by telemetry-aggregated doctor timing. If `linuxify doctor` time in the wild creeps up by ≥10% over a rolling 30-day window, an issue is auto-filed for investigation. This catches the "death by a thousand cuts" pattern where no single PR is responsible but the cumulative drift is unacceptable.

---

## 9. Compatibility Regression

The compat-db is the authoritative source of truth for "does package X work on environment Y." A PR that changes a package's compatibility status — for example, by widening a patch to also fix Alpine, or by adding a new `compat.tested_distros` entry — must update the compat-db in the same commit. CI enforces this by diffing the package YAML's `compat:` block against the compat-db entry; if they disagree and the PR does not include a compat-db update, merge is blocked.

This rule exists because a stale compat-db is worse than no compat-db. A user who consults the compat-db, sees "aider works on Alpine," and then runs `linuxify add aider` on Alpine only to find it broken has lost trust in the entire system. The single-commit rule ensures that the compat-db always reflects the current state of the registry's package definitions, with no lag. For the nightly compat matrix's automated discoveries (a previously-passing cell starts failing because of an upstream change), the compat-db update is automated: the matrix runner opens a PR with the updated entry, and a maintainer reviews and merges within 48 hours.

---

## 10. Test Environment Hygiene

Tests must not depend on host state. **CI runners are ephemeral** — GitHub Actions spins up a fresh VM for each job, so host state is naturally clean. **Local test runners use Docker** to isolate: the project ships a `Dockerfile.test` that reproduces the CI environment (Ubuntu 22.04, Node 20, Python 3.12, a fake proot) and a `make test-docker` target that builds the image, mounts the repo, and runs the test suite inside. This means a contributor on macOS, a contributor on Windows/WSL, and a contributor on Arch Linux all get the same test results — no "works on my machine" drift.

The Docker-based local test environment is also the canonical environment for *reproducing* CI failures locally. When a CI job fails and the contributor cannot reproduce it on their host, they run `make test-docker LINUXIFY_TEST_TAGS=integration` and almost always see the same failure. The few cases where Docker does not reproduce the failure are typically Android-specific (e.g., proot-on-Android kernel quirks) and are escalated to E2E or real-device testing.

Tests that need to write to `~/.linuxify/` write to a temp directory under `/tmp/linuxify-test-<pid>/` set via `LINUXIFY_HOME` env var, which the test harness sets in `beforeEach` and cleans up in `afterEach`. No test reads or writes the real `~/.linuxify/` — the one exception is the `@destructive`-tagged tests, which run only on dedicated CI runners (never locally, never on PR pipelines) and which use real paths so they can catch path-resolution bugs that a fake `LINUXIFY_HOME` would mask.

---

## 11. Manual Testing Checklist

Before each release, the release manager (or a designated deputy) runs through a manual testing checklist on real hardware. The checklist is stored in `docs/release/manual-checklist.md` and includes:

- **Install on a real Pixel** (aarch64, current Android) — `pkg install linuxify`, `linuxify init`, verify completion in under 5 minutes.
- **Install on a real Samsung** (aarch64, different kernel) — same as above, to catch device-specific kernel issues.
- **Run each supported CLI end-to-end** — for every package marked `stable` in the registry: `linuxify add <pkg>`, `linuxify run <pkg> --version`, `linuxify run <pkg> --help`, and one functional invocation (e.g., for Cline, start an interactive session and send one prompt).
- **Test offline mode** — pre-cache with `linuxify add <pkg> --download-only` on wifi, then disable network and `linuxify add <pkg> --offline`, verify success.
- **Test multi-distro** — `linuxify use ubuntu`, `linuxify use debian`, `linuxify use alpine`, verify each switch works and that installed packages are preserved per-distro.
- **Test upgrade path** — install the previous release, then `linuxify self-update`, verify the upgrade completes and existing packages still work.
- **Test the doctor → repair escalation** — manually break the environment (e.g., delete a launcher), run `linuxify doctor`, verify it detects the issue, run `linuxify repair`, verify it fixes it.

The checklist is signed off in the release-tracking issue with screenshots or terminal captures for each step. Steps that fail block the release. The checklist is reviewed and updated quarterly to add new packages and retire steps that have become redundant with automated coverage.

---

## 12. Beta Channel

Linuxify ships a beta channel for users who want to test new features before they reach the stable channel. The mechanism is `linuxify self-update --channel beta`, which switches the user's update source to the beta release stream. Beta releases are cut from `main` weekly (every Thursday), one week ahead of the corresponding stable release. Beta users get features one week early; in exchange, they accept a higher likelihood of encountering bugs and are expected to report them.

The beta feedback loop is structured. Beta releases include a `linuxify feedback` command that opens a pre-filled GitHub issue template tagged with the beta version. The release manager reviews beta feedback daily during the week between beta and stable release; bugs reported against beta are triaged with elevated priority (a P2 reported against beta becomes a P1 if it would also affect stable). If a beta release reveals a serious issue, the stable release is delayed until the issue is fixed and re-validated on a fresh beta. The beta channel is also the primary vehicle for testing breaking changes: a breaking change lands in beta, the migration guide is published alongside the beta, and feedback on the migration guide shapes the final stable release's documentation.

Beta channel adoption is tracked (anonymously, via opt-in telemetry) as a metric. A healthy beta channel has ~5–10% of the user base; too few beta users means we are not getting enough early warning, too many means the stable channel is being neglected. The release manager adjusts beta-release frequency based on adoption and feedback volume.

---

## 13. Observability

Opt-in telemetry (per PRD FR-052; off by default, prompted on first run — see [telemetry-privacy](../24-telemetry/telemetry-privacy.md)) is the primary observability channel into how Linuxify behaves in the wild. Telemetry events include: command invocations (with arguments stripped of values, only flag *names* preserved), doctor results (anonymized environment fingerprint + per-check pass/warn/fail), install/remove outcomes (success/failure + error code if applicable), self-update outcomes, and benchmark timings (bootstrap time, doctor time, launcher overhead — collected client-side and reported weekly).

The telemetry pipeline ingests these events into a time-series store and produces three dashboards. **The test pass-rate dashboard** shows, per command, the success rate over the past 7 and 30 days, segmented by environment cell (distro × runtime × arch × Android version). A cell whose success rate drops by ≥5 percentage points week-over-week is flagged for investigation. **The common-errors dashboard** shows the top error codes by frequency, segmented by cell. A new error code entering the top 10 — or an existing one climbing rapidly — is treated as a regression signal even if no user has reported it. **The perf metrics dashboard** shows the median and p95 of client-reported bootstrap/doctor/launcher times, segmented by cell. This catches real-world performance drift that the lab benchmarks cannot see.

Observability is also the input to the "testing in production" loop described in [testing-strategy](./testing-strategy.md) §18. Doctor results inform the compat-db; common errors inform the troubleshooting guide; perf metrics inform the benchmark review. The loop is closed by maintainers who review the dashboards weekly and convert observations into issues, compat-db updates, or doc improvements.

---

## 14. Postmortem Template

For every P0 incident and every P1 incident that escapes to users, a postmortem is written and published in `docs/postmortems/<yyyy-mm-dd>-<short-slug>.md`. The template is:

```markdown
# Postmortem: <short title>

**Date:** YYYY-MM-DD
**Severity:** P0 | P1
**Incident lead:** <name>
**Status:** Final

## Summary
<one paragraph — what happened, who was affected, how long, what was the impact>

## Timeline
<UTC timestamps with brief notes — first detection, triage, mitigation, root cause identified, fix shipped, incident closed>

## Root cause
<the specific technical cause, not "human error" — what code path, what assumption, what interaction>

## Contributing factors
<what made the root cause possible or made the impact worse — missing test, missing alert, misleading docs, etc.>

## What went well
<what worked in our response — fast detection, clean rollback, helpful logs, etc.>

## What went poorly
<what did not work — slow triage, missing telemetry, misleading error message, etc.>

## Action items
<table with: action, owner, due date, status>

## Lessons learned
<broad takeaways that should inform future process changes>
```

Postmortems are **blameless by rule**. The "Root cause" section never names an individual; it names a code path, a missing test, a process gap. The "Action items" table is tracked in a separate GitHub Project board with owners and due dates; the incident lead is responsible for follow-through and reports status at the weekly triage review until all action items are closed. Postmortems are published openly (in the public repo) unless they disclose a security vulnerability that is still under embargo, in which case they are published after the embargo lifts. The postmortem archive is also the input to the quarterly QA retrospective — patterns across multiple postmortems (e.g., "four of the last six P0s involved the patch engine") drive process improvements.

---

## 15. QA Metrics

The QA program measures itself with four metrics, reported monthly to the maintainers' mailing list and quarterly to the broader community. **MTTR (mean time to repair)**: the average wall-clock time from bug-report-open to bug-fixed-and-verified, measured per priority. Target: P0 MTTR <24 hours, P1 MTTR <1 week, P2 MTTR <1 month. A rising MTTR indicates either that bugs are getting harder to fix or that the fix pipeline is bottlenecked; both warrant investigation. **Escape rate**: the fraction of bugs found by users (in production) versus found by CI (before release), measured per release. Target: <10% escape rate for P0/P1 bugs. A rising escape rate means our pre-merge and release-gate coverage is losing ground to the combinatorial matrix and we need to invest in additional automated coverage, typically in the compat matrix or in property-based tests.

**Test stability (flaky test rate)**: the fraction of test runs that fail and then pass on retry with no code change, measured per test and aggregated per suite. Target: <1% flaky rate per suite. Flaky tests are quarantined (moved to a `@flaky` tag, excluded from blocking pipelines) within 24 hours of being identified, and a tracking issue is opened to fix them. A flaky test that is not fixed within 2 weeks is deleted — a flaky test provides false signal and is worse than no test. **Coverage trend**: the project-wide line and branch coverage, plus the per-subsystem breakdown, plotted over time. Target: monotonically non-decreasing (small dips allowed for refactors, with PR-description justification). A coverage trend that is flat or declining for 3 consecutive months triggers a "coverage sprint" where the maintainers prioritize test improvements over new features until the trend recovers.

These four metrics are the leading indicators of QA health. They are reviewed in the monthly maintainer meeting, and significant deviations trigger explicit action plans: a rising MTTR might prompt adding a second on-call maintainer; a rising escape rate might prompt expanding the compat matrix; a rising flaky rate might prompt a test-infrastructure audit; a declining coverage trend might prompt a coverage sprint. The metrics are not the goal — the goal is a trustworthy release pipeline — but the metrics are how we know whether the goal is being met.
