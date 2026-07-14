# GitHub Templates

> **Audience**: Maintainers who configure the issue tracker and PR flow, and contributors who want to understand why every issue template asks what it asks. This document explains the rationale, the field-by-field usage, and the maintenance model for the templates in `.github/`.
>
> **Related**: [Contribution Guidelines](../16-community/contribution-guidelines.md) for the contributor contract these templates enforce · [CLI Specification §6](../03-cli/cli-specification.md) for the exit codes referenced in bug reports · [Doctor Engine](../07-doctor/doctor-engine.md) for the `linuxify doctor` output that bug reports require · [Troubleshooting](../22-operations/troubleshooting.md) for the user-facing recipes that should be tried before filing a bug.

The Linuxify project uses GitHub's issue-forms beta (YAML-based, schema-validated input) rather than the older markdown-template approach. YAML forms give us structured fields, dropdowns, and required inputs, which dramatically reduces the "missing info" back-and-forth on bug reports. This document covers the five templates that ship in v1, the rationale for each field, and the future templates we expect to add.

---

## 1. Overview

Five templates ship with the v1 repository, distributed across two directories:

```
.github/
├── ISSUE_TEMPLATE/
│   ├── bug-report.yml           # Structured bug report
│   ├── feature-request.yml      # Feature request with use-case-first structure
│   ├── package-request.yml      # Request to add a new CLI to the registry
│   └── config.yml               # Issue chooser (disables blank issues, routes to Discord/Docs/Security)
└── PULL_REQUEST_TEMPLATE.md     # Markdown checklist for PRs
```

The split between `.github/ISSUE_TEMPLATE/` (issue forms) and `.github/` (PR template) is dictated by GitHub: issue templates must live in `ISSUE_TEMPLATE/`, the PR template must live one level up. The `config.yml` in `ISSUE_TEMPLATE/` is special — it is the issue-chooser configuration, not a template itself. It controls what users see when they click "New issue."

The choice of YAML forms over markdown templates is deliberate. Markdown templates are free-form: a user pastes the template, deletes the sections they don't understand, fills in two of the eight fields, and the maintainer spends three rounds of asking for the missing info. YAML forms render as input fields, dropdowns, and checkboxes in the GitHub web UI; required fields cannot be skipped. The resulting issues are more uniform, easier to triage, and easier to bulk-process with tooling. The trade-off is that YAML forms cannot be filled in via the GitHub CLI or via email — they require the web UI — but for an open-source project where 95% of issues come through the web, this is an acceptable trade-off.

The templates are versioned with the repo. A change to a template is a PR like any other; the template's "version" is implicitly the commit hash. When a template changes, old issues filed against the previous version remain valid — GitHub does not retroactively modify them — but maintainers may close stale issues with a "please refile using the new template" comment. This is rare; the v1 templates are designed to be stable.

---

## 2. Bug Report Template

The bug-report template (`bug-report.yml`) is the most important template in the repo, because bug reports are the most common issue type and the one where missing information causes the most pain. The template's design is driven by the question: "what does a maintainer need to reproduce this bug?" The answer, in order of importance:

1. **The `linuxify doctor --markdown` output.** This single command produces a structured snapshot of the user's environment: Linuxify version, host OS, distro, runtime versions, installed packages, doctor check results, and any non-OK statuses. Without this, the maintainer is guessing. With this, the maintainer can usually reproduce the bug in 30 seconds.
2. **The exact command the user ran and the output they got.** Copy-paste, not paraphrase. A user who writes "I tried to install cline" leaves the maintainer wondering: `linuxify add cline`? `linuxify install cline`? `npm install -g cline` inside the proot? The template requires the literal command.
3. **What the user expected vs. what happened.** This catches user-error bugs (where the tool behaved correctly but the user misunderstood) and confirms the bug's severity.
4. **Reproduction steps.** Ordered, numbered, starting from a fresh install if possible. A bug that reproduces only on the user's specific install is much harder to fix than one that reproduces from scratch.
5. **Device + Android version + Termux version + Linuxify version.** These four pieces of context disambiguate "works for me" from "broken on Android 14 specifically." The Linuxify version is also in the doctor output, but asking for it separately catches users who skip the doctor step.

The critical importance of `linuxify doctor --markdown` cannot be overstated. The doctor output includes the Linuxify version, the host OS, the active distro and its version, every installed runtime with version, every installed package with version, and the result of every doctor check (with `ok`/`warn`/`fail`/`missing` status). It is a forensic snapshot. The template makes this field required and includes a hint: "Run `linuxify doctor --markdown` and paste the full output here. Do not truncate — even the 'OK' lines matter."

Common mistakes filling out the bug report:

- **Truncating the doctor output.** Users often paste only the failing checks, assuming the OK lines are noise. They are not: the OK lines confirm what is *not* broken, which narrows the search. A doctor output with only `FAIL` lines is much harder to triage than a full output.
- **Paraphrasing the command.** "I ran linuxify install" is not a command. The literal command, including flags, is required.
- **"It doesn't work" as the expected/actual.** The template asks for specific expected behavior ("cline should start and print its help text") and specific actual behavior ("cline prints 'Error: cannot find module /platform.js' and exits with code 1"). Vague descriptions lead to vague fixes.
- **Skipping reproduction steps because "it always happens."** Even an always-happens bug has a first-time reproduction path. The maintainer needs to know what install state to start from.

The template includes a "willing to debug" checkbox (`willing_to_debug`), which affects triage priority. A user who is willing to run additional diagnostic commands, try candidate fixes, or build from source is a much higher-leverage reporter than one who files the report and disappears. Maintainers weight such reports higher in the queue.

---

## 3. Feature Request Template

The feature-request template (`feature-request.yml`) is structured use-case-first. The first field is the **problem** the user is trying to solve, not the solution they propose. This is a deliberate inversion of the natural inclination to start with "it would be cool if Linuxify could X." A feature request that begins with a solution is often a feature request that solves the wrong problem.

The template's fields, in order:

1. **What problem are you trying to solve?** (required, textarea, ≥3 sentences suggested). This is the use case. "I want to install a CLI tool that's only available as a GitHub release tarball, not on npm or pip." The maintainer reads this first; if the problem is well-stated, the solution often suggests itself.
2. **What solution would you like?** (required, textarea). The user's proposed feature, in their own words. This is the user's *suggestion*, not the contract — the maintainer may implement a different solution that solves the same problem better.
3. **What alternatives have you considered?** (required, textarea). This field forces the user to think about whether the problem is already solvable. Often the answer is "yes, with a workaround," and the maintainer can either improve the workaround or accept the feature request as a quality-of-life improvement rather than a blocker.
4. **Would this feature be useful to other users?** (required, dropdown: "Yes, broadly", "Yes, but niche", "No, just me"). This is a self-assessment of the feature's audience. It is not a vote; it is a sanity check. A user who honestly answers "just me" is signaling that the feature may not be worth maintainer time, and the maintainer may suggest the user implement it as a plugin instead.
5. **Are you willing to contribute?** (required, dropdown: "Yes, I can write the code", "Yes, I can write docs/tests", "Yes, I can help triage", "No, just suggesting"). The most important field for triage priority.

The "willing to contribute" field is the single biggest driver of triage priority. A feature request with a willing contributor moves to the top of the queue, because the maintainer's job becomes review rather than implementation. A feature request with no willing contributor moves to the bottom, because implementation would require maintainer time that is better spent on bugs and contributed features. This is not a judgment of the feature's merit — a no-contributor feature may still be valuable — but it is a realistic allocation of limited maintainer hours.

The template's "use case first" structure is borrowed from the Rust and Zig communities. The Go project uses a similar structure in its proposal template. The pattern is well-established: force the reporter to articulate the problem before the solution, and the resulting proposals are sharper, more often accepted, and more often implemented quickly.

---

## 4. Package Request Template

The package-request template (`package-request.yml`) is for users who want a CLI tool added to the Linuxify registry. It is distinct from a feature request: a feature request is for new Linuxify functionality, a package request is for an existing CLI tool that Linuxify should support.

The template's fields, with rationale:

1. **Package name** (required, text). The name as it appears upstream (`cline`, `aider`, `codex`). Used to check for duplicates and to name the YAML file.
2. **Homepage / repository URL** (required, URL). The maintainer needs to find the tool's source to assess license, dependencies, and platform-specific code.
3. **What does this tool do?** (required, textarea, 1–2 sentences). The maintainer triages 10+ package requests per month; a one-line description lets them prioritize. "AI coding agent" is enough; "AI coding agent that runs in your terminal, supports MCP, has a chat interface" is better.
4. **What runtime does it require?** (required, dropdown: node, python, rust, go, bun, deno, none, unsure). Routes the request to the right maintainer (each runtime has a de facto owner) and estimates the integration cost (node is easy, rust is medium, custom-DSL tools are hard).
5. **Have you tried installing it manually?** (required, dropdown: "Yes, it worked", "Yes, with patches", "Yes, it failed", "No"). The most important field. A request where the user has already tried manual install — and ideally identified which patches are needed — is a 30-minute integration; a request where the user has not tried is a multi-hour investigation.
6. **If it failed, what was the error?** (optional, textarea, shown only if "Yes, it failed" is selected). The error message is the single most useful piece of information; it usually identifies the platform-specific code path that needs patching.
7. **Are you willing to write the package YAML?** (required, dropdown: "Yes, I've read the spec", "Yes, but I need help", "No, but I can test", "No, just requesting"). Routes the request to the contribution pipeline. A user willing to write the YAML is routed to the [contribution guidelines](../16-community/contribution-guidelines.md); the maintainer's job becomes reviewing the YAML rather than writing it.

The "willing to write the YAML" field is the package-request analog of the feature-request's "willing to contribute." A user who has read the [package-spec](../09-registry/package-spec.md) and authored a YAML is a contributor, not a requester; the maintainer's role becomes reviewer. This is the highest-leverage path: a contributor-authored YAML usually merges in one round of review, while a maintainer-authored YAML requires the maintainer to find time to write it (often weeks).

The "have you tried manual install" field is critical because it surfaces the "should this even be a Linuxify package?" question. Some tools work fine inside proot without patches (they're already platform-agnostic); those tools don't need a Linuxify package, they need a one-line `npm install -g` that the user can run themselves. The template's question helps the user discover this before the maintainer has to.

---

## 5. Config (Issue Chooser)

The `config.yml` file in `ISSUE_TEMPLATE/` is the issue-chooser configuration. It controls what users see when they click the "New issue" button. The Linuxify `config.yml` does two things:

1. **Disables blank issues.** `blank_issues_enabled: false`. A blank issue has no template, no required fields, no structure. The project's experience is that blank issues are almost always missing critical information, leading to multi-round clarification that wastes both user and maintainer time. Disabling blank issues forces users to pick a template, which structures their report from the start.
2. **Routes non-issue traffic.** The `contact_links` section provides four alternative destinations for things that are not GitHub issues:
   - **Discord** (`https://discord.gg/linuxify`) for support questions and chat. A "how do I..." question is not a bug and should not be filed as an issue; Discord is the right venue.
   - **GitHub Discussions** (`https://github.com/cline/cline/discussions`) for long-form Q&A and ideas that are not yet ready to be feature requests. Discussions supports threaded replies, marking answers, and is generally better for open-ended questions than issues.
   - **Docs** (`https://docs.linuxify.dev`) for "how does X work" questions that are likely already answered. The link sends the user to the docs homepage, where the search bar is the first thing they see.
   - **Security reports** (`mailto:security@linuxify.dev`) for vulnerability reports. Security reports must not be filed as public GitHub issues — the project's security policy (see [security-model.md §12](../13-security/security-model.md)) requires private reporting via encrypted email so that the maintainers can investigate and patch before public disclosure.

The rationale for disabling blank issues is that the project would rather close a mis-filed issue with "please refile using the bug-report template" than spend maintainer time extracting structured information from a free-form report. The friction is intentional. Users who genuinely cannot find a fitting template are routed to Discord, where a maintainer or community member can suggest the right template or the right venue.

The four contact links cover the four most common non-issue traffic patterns. Without them, users would file "how do I" questions as issues (cluttering the tracker), file "I have an idea" issues (cluttering the tracker and missing Discussions' threading), file "the docs are confusing" issues (which are not actionable as issues), and — worst case — file security issues publicly (which is dangerous). The links give each of these traffic types a better destination.

---

## 6. PR Template

The PR template (`PULL_REQUEST_TEMPLATE.md`) is a markdown checklist that auto-populates the PR description when a contributor opens a PR. Every checkbox must be ticked before the PR can be merged; CI verifies this by parsing the PR description for unchecked boxes (using a simple `grep -c '[ ]'` check). The template's structure:

```markdown
## Summary
<!-- One-paragraph summary of what this PR changes and why. -->

## Type of change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update
- [ ] Package YAML addition (new CLI tool)
- [ ] Patch addition (new patch for an existing tool)

## Checklist
- [ ] I have read the [CONTRIBUTING.md](../CONTRIBUTING.md)
- [ ] My code follows the project's style guidelines (eslint, prettier pass)
- [ ] I have added tests that prove my fix is effective or my feature works
- [ ] New and existing unit tests pass locally with `npm test`
- [ ] I have updated the documentation accordingly
- [ ] My changes generate no new warnings
- [ ] I have added a changelog entry (or N/A: this is a docs-only change)

## Test plan
<!-- How did you verify this change? Be specific: commands run, scenarios tested. -->

## Screenshots / output
<!-- If the change affects user-visible output, paste before/after. -->

## Reviewer notes
<!-- HTML comment with reviewer guidelines — see below. -->
```

Walking through each checkbox:

- **CONTRIBUTING.md read.** The contribution guidelines (see [contribution-guidelines.md](../16-community/contribution-guidelines.md)) define the DCO sign-off, the commit message format, the branch naming, and the code review criteria. Ticking the box is an attestation that the contributor has read them. The checkbox is required because the guidelines change over time, and a contributor who read them last year may not be aware of new rules.
- **Style guidelines (eslint/prettier).** The CI lint job enforces this, but the checkbox is a self-check before pushing. A contributor who runs `npm run lint` locally and fixes the issues saves a CI round-trip.
- **Tests added.** A bug fix without a regression test will regress. A feature without tests will break in a refactor. This checkbox enforces the testing contract from [testing-strategy.md](../12-testing/testing-strategy.md).
- **Tests pass locally.** CI is the source of truth, but local testing catches issues faster.
- **Documentation updated.** A code change that affects user-visible behavior requires a doc update. A pure refactor does not. The checkbox forces the contributor to think about whether docs need updating.
- **No new warnings.** A `console.log` left in, a `any` type, an unused import — these accumulate. The checkbox enforces zero new warnings.
- **Changelog entry.** The project follows [Keep a Changelog](https://keepachangelog.com/); every user-visible change needs an entry. Docs-only changes are exempt.

The HTML comment at the bottom of the template is **reviewer guidelines** — text that the contributor sees but is hidden when the PR is rendered. It tells the reviewer what to look for:

```html
<!--
REVIEWER GUIDELINES:
1. Does the PR match its summary? (Scope creep is the most common review issue.)
2. Are the tests adequate? (Each bug fix should have a regression test.)
3. Does the code follow the module boundaries in docs/02-architecture/source-code-structure.md §2?
4. If this is a package YAML, does it pass `linuxify package lint`?
5. If this is a patch, does the verify command actually verify? (See docs/08-patcher/patcher-engine.md §6.)
6. Is the changelog entry in the right section (Added/Changed/Fixed/Removed)?
7. Does the PR touch security-sensitive code? If so, request review from a maintainer with security context.
-->
```

These seven reviewer checks are the maintainer's mental checklist when reviewing. Encoding them in the template means every reviewer sees them on every PR, which normalizes review quality across the maintainer team. A new maintainer can review confidently by following the list; an experienced maintainer uses the list as a reminder.

---

## 7. Maintenance

Templates are updated via PR like any other file. The most common update is adding a field to an existing template (e.g., adding a "Linuxify version" dropdown when we realize users are typing it freeform and getting the format wrong). The second most common is adding a new template for a new issue type (see §8 below).

Template updates should be rare and announced. A template change invalidates in-flight issues that were filed against the old template — not technically (GitHub does not modify them), but practically (the maintainer's mental model of "this issue has these fields" no longer matches). When a template changes, the maintainer team should:

1. **Announce the change** in Discord #announcements and in the weekly digest.
2. **Close stale issues** that were filed against the old template with a polite "please refile using the new template" comment. This is rare; most template changes are additive (a new field, not a removed one).
3. **Update the docs** if the template change affects any documented workflow. For example, if the bug-report template's required doctor output format changes, this document and [troubleshooting.md §6](../22-operations/troubleshooting.md) should be updated in the same PR.

Backward compatibility with old issues is handled by closing them. The project does not attempt to migrate old issues to new templates — the migration is rarely worth the maintainer time. The standard reply is: "Thanks for filing. We've updated our bug-report template to capture some additional information. Could you refile using the new template? The 'linuxify doctor --markdown' field is the most important addition." Users generally refile willingly because they want their bug fixed.

Template versioning (explicit version stamps in the template) was considered and rejected. The version is implicitly the commit hash; a user filing an issue today gets the current template, a user filing in six months gets the then-current template. There is no need for explicit versions because GitHub does not support template pinning and the maintainer team does not want to support multiple concurrent template versions.

---

## 8. Future Templates

Three templates are planned for future releases, contingent on the corresponding features landing:

1. **`compatibility-report.yml`** (v1.1). A structured form for users to submit compatibility data — "I tested cline 1.3.0 on Alpine 3.20 with Node 22.11.0 and these three things broke." The form's fields would mirror the [compat-db schema](../11-compat-db/schema.md): package, version, distro, runtime, arch, test outcome, observed issues. The submitted reports would feed into the compatibility database that powers `linuxify doctor --check compat`. This is the structured-data pipeline that replaces freeform "works for me" comments on package-request issues.

2. **`plugin-submission.yml`** (v1.2). A form for plugin authors to submit their plugin for inclusion in the official plugin registry (or for vetting before self-publication). Fields: plugin name, manifest, hook list, config schema, test results, license. The form ensures plugins meet the SDK contract documented in [plugin-sdk.md](../10-plugin-sdk/plugin-sdk.md) before the maintainer spends review time. Submissions that fail the form's automatic checks (manifest invalid, hooks missing, no tests) are auto-closed with a pointer to the failing check.

3. **`security-advisory.yml`** (v1.1, private). A private issue template (visible only to maintainers with security-context role) for filing internal security advisories. This is distinct from the public security-report email flow — the public flow is for external reporters; this template is for maintainers filing an advisory after triaging an external report or after discovering a vulnerability internally. Fields: severity (CVSS vector), affected versions, exploit description, proposed patch, disclosure timeline. The template enforces the security policy from [security-model.md §12](../13-security/security-model.md) and ensures every advisory has the required fields for the CVE submission process.

These future templates will follow the same design principles as the v1 set: structured fields over freeform text, "use case first" for feature-like templates, "willing to contribute" affecting triage priority, and explicit reviewer guidelines for PR-style templates. The principles scale; the specific fields evolve with the project.
