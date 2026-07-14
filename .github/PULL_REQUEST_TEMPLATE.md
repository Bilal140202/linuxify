<!--
  ─────────────────────────────────────────────────────────────────────────────
  Linuxify — Pull Request Template

  REVIEWER GUIDELINES (for maintainers — not shown to the PR author in the
  rendered template, but readable in the raw file):

  1. Does the PR title follow Conventional Commits? <type>(<scope>): <subject>
     where type is one of feat, fix, docs, style, refactor, perf, test, build,
     ci, chore, revert. Reject titles like "update stuff" or "fix #123" — ask
     the author to amend.

  2. Is the "What" a single, atomic change? A PR that does two things should
     be two PRs. Ask the author to split if the scope is too broad.

  3. Is the "Why" clear and linked to an issue? Every non-trivial PR should
     reference an issue (either "Closes #" or "Refs #"). A PR with no issue
     link and no "Why" explanation is a red flag — ask for context before
     reviewing the diff.

  4. Is the "How" actually brief? A PR description that rewrites the codebase
     in prose is a sign the change is too complex. Ask the author to summarize
     in three sentences and link to a design doc or ADR for the deep dive.

  5. Are the testing checkboxes checked honestly? An unchecked "Manually
     tested on (device/distro)" with no transcript is a blocker — ask the
     author to either test or explain why testing is not applicable.

  6. Is the compat-db updated? If the PR changes package behavior on any
     distro × runtime × arch combination, the compat-db entry for that
     package must be updated in the same PR. A behavior change without a
     compat-db update is a blocker.

  7. Are there secrets in the diff? Scan the diff for anything that looks
     like a token, key, or password. If you see one, ask the author to
     rotate it immediately and force-push the rotation out of the history.

  8. Is there a migration guide? If the PR introduces a breaking change
     (changed CLI flag, changed YAML schema, changed output format), the
     CHANGELOG must include a "Breaking changes" section with a migration
     guide. A breaking change without a migration guide is a blocker.

  9. Is the diff reviewable? If the PR has more than ~600 lines of diff,
     consider asking the author to break it into stacked PRs. Large PRs
     get worse reviews.

  10. Be kind. The author put work into this. Even if the PR is rejected,
      the rejection should be specific ("here is what would need to change
      for me to merge") and never personal.

  ─────────────────────────────────────────────────────────────────────────────
-->

## What

<!-- 1-2 sentences: what does this PR do? Be concrete. "Adds a `linuxify use --shell` flag that opens a subshell scoped to the active distro" is good. "Improves the use command" is not. -->

[1-2 sentences: what does this PR do?]

## Why

<!-- 2-4 sentences: what problem does this solve? Link the issue. "Closes #87 — users have asked for a way to run two distros simultaneously without losing state. This PR implements the `--shell` flag described in the issue." -->

[2-4 sentences: what problem does it solve? Link issues.]

## How

<!-- Brief technical description. Mention key files changed and any non-obvious design decisions. "Adds a `ShellSession` class in `src/distro/shell.ts` that wraps a proot login with a per-session state file. The `use` command gains a `--shell` flag in `src/commands/use.ts` that spawns the session and waits. State is stored under `~/.linuxify/sessions/<pid>.json` and cleaned up on exit." Keep this to 5-10 lines — deeper design belongs in an ADR. -->

[Brief technical description. Mention key files changed.]

## Testing

- [ ] Unit tests added / updated
- [ ] Integration tests added / updated
- [ ] E2E tests run locally
- [ ] Manually tested on (device/distro):

<!-- If you manually tested, paste a short transcript or attach a screenshot below. If you did NOT manually test (e.g., docs-only change), explain why testing is not applicable. -->

```text
# Paste a short transcript of your manual test here. For example:
$ linuxify use ubuntu --shell
(spawning subshell scoped to ubuntu)
$ linuxify env | grep DISTRO
LINUXIFY_DISTRO=ubuntu
$ exit
$ linuxify env | grep DISTRO
LINUXIFY_DISTRO=alpine
# State restored.
```

## Checklist

- [ ] Code follows the [style guide](https://linuxify.sh/docs/16-community/contribution-guidelines)
- [ ] Docs updated (CHANGELOG, README, relevant `docs/` files)
- [ ] [Compat-db](https://linuxify.sh/docs/11-compat-db/compatibility-database) updated if package status changed
- [ ] Tests pass locally (`npm test`)
- [ ] Lint passes (`npm run lint`)
- [ ] Conventional commit title (e.g., `feat(use): add --shell flag`)
- [ ] No secrets / tokens in code
- [ ] Migration guide written if this is a breaking change (see CHANGELOG)

## Screenshots / Transcripts

<!-- For UI or CLI output changes, paste a screenshot or a transcript showing the before and after. This is required for any change a user will see; optional for pure refactors. -->

## Related Issues

Closes #
Refs #

## Reviewer Notes

<!-- Anything reviewers should pay attention to? Known limitations, areas you are unsure about, parts of the diff that look scary but are actually safe? Help your reviewer help you. -->

