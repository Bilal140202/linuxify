# User Journeys

> Narrative first-person stories from the perspectives of six Linuxify personas. Each journey follows a single user through a real session, with quoted terminal output and the emotional beats of frustration, relief, and delight. Each closes with an honest UX critique.
>
> **Audience**: product designers, contributors, and AI coding agents who need to understand the *felt* experience behind the [UX Flows](ux-flows.md).
> **Related**: [UX Flows](ux-flows.md) · [Command Reference](../03-cli/command-reference.md) · [Target Users](../../.agent-context.md#8-target-users)

---

## How to Read These Journeys

The six personas span the user base the project explicitly targets: a road-warrior engineer, a CS student first-time contributor, an OSS maintainer in disaster recovery, a power user exploring distros, a user on a metered hotspot, and an upstream maintainer of an obscure tool. They are composites, not caricatures — their frustrations are real frustrations reported in early testing, and their delights are the moments where the tool's design paid off. Each journey is 300–500 words, written in the first person, with terminal transcripts in fenced code blocks. The "What Linuxify did well / What could be better" closing critique is the most important part: it tells contributors where to focus polish.

Read these alongside the [UX Flows](ux-flows.md) document, which maps the same experiences onto formal flowcharts. Where the flow document is normative, this document is evocative — together they describe both what should happen and how it should feel.

---

## Journey 1: Ravi's First Weekend with Linuxify

Ravi is a backend engineer at a Series B startup. He travels three weeks a month and has a Pixel 8 with Termux installed for the inevitable "fix this from the airport" moments. He has heard of Linuxify from a colleague and decides to spend a Saturday setting it up.

He opens Termux and runs `pkg install linuxify`. The package downloads in seconds. He runs `linuxify install` and is greeted by a distro picker.

```
$ linuxify install
Welcome to Linuxify. Choose a distro:
  > Ubuntu 24.04  (recommended, 320 MB)
    Debian 12     (stable, 280 MB)
    Arch          (rolling, 210 MB)
    Alpine 3.20   (minimal, 45 MB)
```

He picks Ubuntu — recommended is recommended for a reason. The download takes about a minute on hotel wifi; the progress bar is honest about the ETA, which Ravi appreciates. He's been burned too many times by "progress bars" that sit at 99% for ten minutes.

```
✔ Installing Node.js LTS v20.10.0
✔ Installing Python 3.12.3
✔ Installing Git 2.49.0
Linuxify initialized. Run: linuxify add cline
```

He installs Cline and Codex — the two agents he uses most on his laptop.

```
$ linuxify add cline
✔ Ensuring runtime node@20 (present)
↓ npm install -g cline@1.2.0  (8.4 MB) [████████████] 100%
✔ Patching node_modules/cline/dist/platform.js
✔ Patching node_modules/cline/dist/arch.js
✔ Creating launcher: /data/data/com.termux/files/usr/bin/cline
Cline v1.2.0 installed. Run: cline
```

The patches worried him for a moment — he's seen what happens when you patch a tool blind — but the output told him exactly which files changed and what the find/replace was. He runs `linuxify info cline --json` and pipes it to `jq` to see the full patch definitions, and they're sensible: making `process.platform` accept `android` as if it were `linux`, and `process.arch` accept `arm64`. He nods. Sunday morning, his pager goes off — a customer hit a 500. From the hotel room, he opens Termux, `cd`s into his project (synced via Syncthing), and runs `cline`. It works. He ships the fix before he finishes his coffee. The delight is not the fix itself — it's that the tool on his phone is the same tool on his laptop, with no "well, except on Android it can't…" footnote.

**What Linuxify did well**: honest progress bars, transparent patch output, zero-friction first install, identical experience to desktop.

**What could be better**: the `~/.bashrc` modification prompt appeared without explaining *what* line it would add; Ravi had to read the source to be sure. A diff preview would build trust.

---

## Journey 2: Ana's First PR to an AI Tool

Ana is a third-year CS student who has been using Linuxify on her old Android tablet for a semester. She's gotten curious about how the package definitions work and wants to contribute one for Goose, an agent she's been using that isn't in the index yet.

She starts the way the docs suggest: by copying an existing YAML.

```
$ cd ~/src/linuxify-fork/packages
$ cp cline.yml goose.yml
$ vim goose.yml
```

She edits the fields — `name: goose`, `version: 0.9.2`, `runtime: node`, the `install:` line is just `npm install -g @block/goose`. The `patches:` block is where she's nervous. She doesn't know what Goose's source looks like yet.

She installs without patches first to see what breaks.

```
$ linuxify add ./goose.yml --local --no-patch
✔ Installed goose@0.9.2 (no patches)
⚠ Tool may not work without patches. Run: linuxify patch goose
$ linuxify run goose -- --version
Error: Unsupported platform: android
    at Object.<anonymous> (/usr/lib/node_modules/@block/goose/dist/index.js:42)
```

The error is suspiciously clear. She `linuxify shell`s in, finds the file, and sees `if (process.platform !== "linux") throw new Error(...)`. She writes her first patch:

```yaml
patches:
  - file: "node_modules/@block/goose/dist/index.js"
    find: "process.platform !== \"linux\""
    replace: "![\"linux\",\"android\"].includes(process.platform)"
```

She tests with `linuxify add goose --force --local`, runs `goose --version`, and it prints the version string. She actually cheers, alone, in her dorm room. She runs `linuxify doctor goose` — all checks pass. She commits, pushes, opens a PR.

```
$ linuxify patch goose --list
1. node_modules/@block/goose/dist/index.js
   find:    process.platform !== "linux"
   replace: !["linux","android"].includes(process.platform)
```

CI runs and goes green within two minutes. A maintainer reviews, asks her to add `compat.tested_distros: [ubuntu, debian]` since she's only tested on Ubuntu, she does, and the PR merges an hour later. Her first open-source contribution. The emotional arc was: hesitation → "wait, that's it?" → pride.

**What Linuxify did well**: `--local` flag for testing without pushing, `--no-patch` for incremental discovery, `patch --list` for validating syntax, clear error messages from the tool itself (not Linuxify, but Linuxify got out of the way).

**What could be better**: Ana wished there was a `linuxify new-package <name>` scaffolding command that would generate a starter YAML with comments explaining each field, rather than having to copy `cline.yml` and figure out what to delete.

---

## Journey 3: Mira's Termux Disaster Recovery

Mira maintains a popular CLI tool and runs Linuxify on her Galaxy phone for those "I need to test this on Android right now" moments. One Tuesday, her phone does a system update overnight, and Wednesday morning `cline` is broken.

```
$ cline --version
Error: proot: cannot exec: No such file or directory
```

She doesn't panic — she's been here before with other tools. She runs `linuxify doctor`.

```
$ linuxify doctor

Linuxify v0.2.0
────────────────────────────────────────
✔  Storage         11.8 GB free
✔  Termux          OK
✖  proot           Missing binary (/data/data/com.termux/files/usr/bin/proot)
✖  PATH            Misconfigured (Linuxify bin dir not in PATH)
✔  Ubuntu          Installed
⚠  Node.js         v20.10.0 (expected v20.18.0+)
✔  Cline           v1.2.0 (launcher ok)
────────────────────────────────────────
2 failures, 1 warning. Run: linuxify repair
```

She's relieved — the doctor identified exactly what the Android update broke (Termux's `proot` got unlinked somehow, and her PATH got reset). She runs `linuxify repair`.

```
$ linuxify repair
Doctor reported 3 issues. Repair plan:
  1. Reinstall proot (pkg install proot)
  2. Re-add Linuxify bin to PATH (~/.bashrc)
  3. Upgrade Node.js 20.10.0 → 20.18.0 (LTS point release)
Proceed? [Y/n] y
✔ 3/3 repairs applied. Run: linuxify doctor
```

She watches the three steps run, each with a brief log line. She re-runs doctor — all green. She runs `cline --version` and it works. The whole recovery took under two minutes. The previous time this happened (with a different tool, before Linuxify), she spent an hour reinstalling things by hand and another hour figuring out what had broken. This time the tool did the diagnosis and the fix.

The emotional arc: annoyance at the Android update (not Linuxify's fault), brief worry that she'd lose her morning to recovery, then genuine relief when doctor nailed the diagnosis, then a small delight at how smoothly repair ran.

```
$ linuxify doctor
✔ All checks passed.
```

**What Linuxify did well**: doctor's diagnosis was precise and actionable; repair's plan-and-confirm pattern gave her confidence before destructive actions; the whole recovery was faster than the alternative.

**What could be better**: doctor didn't proactively notify her that an Android update was likely the cause — she had to infer. A "this pattern of breakage is typical after Android system updates" hint would feel caring.

---

## Journey 4: Devon Explores Multi-Distro

Devon is the kind of user who reads architecture docs for fun. He has been running Linuxify on Ubuntu for a month and is curious whether Alpine's smaller footprint would speed up his launcher cold-starts. He decides to benchmark.

```
$ linuxify use alpine --create
↓ Downloading Alpine 3.20 rootfs (45 MB) [████████████] 100%
✔ Provisioning alpine (apk update, base packages)
✔ Active distro: alpine
```

He's immediately struck by the download — 45 MB vs Ubuntu's 320 MB. He installs cline under Alpine.

```
$ linuxify add cline --distro alpine
✔ Ensuring runtime node@20 (present)
↓ npm install -g cline@1.2.0
✔ Patching platform.js
✔ Patching arch.js
✔ Creating launcher
$ time cline --version
cline/1.2.0 linux-arm64 node-v20.10.0
real    0m1.42s
$ linuxify use ubuntu
$ time cline --version
real    0m1.38s
```

Cold-start is essentially identical — the proot enter cost dominates, not the distro. He's mildly disappointed; he had a hypothesis and it was wrong. But he's delighted that the tool let him test the hypothesis in under five minutes.

He tries Arch next.

```
$ linuxify use arch --create
↓ Downloading Arch Linux rootfs (210 MB)
✔ Active distro: arch
$ linuxify add cline --distro arch
```

Arch's cline install fails because Arch's `nodejs` package is at v22 and the patch wasn't tested against it. Linuxify reports this honestly:

```
✖ Patch failed.
  Reason: Patch 'platform.js' could not find expected string.
          The package may have been updated.
  Fix:   linuxify patch cline --list
         linuxify add cline --no-patch
```

He files an issue noting that Arch's rolling node breaks the patch, then switches back to Ubuntu for real work. He keeps Alpine around for lightweight tasks (he installs `httpie` and `jq` under it), and writes a `profile.minimal` in his config so he can `linuxify --profile minimal run httpie ...` without changing his active distro. He feels like a wizard.

The emotional arc: curiosity → mild disappointment at the benchmark result → delight at the speed of testing → "huh, Arch doesn't work, that's honest" → satisfaction at the multi-profile setup.

**What Linuxify did well**: per-distro isolation let him experiment without risk; honest failure on Arch rather than a silent broken install; profiles for context switching without state mutation.

**What could be better**: the patch-failure message could have noted "Arch's node v22 may be too new for this patch" — the user shouldn't have to infer the version mismatch.

---

## Journey 5: Priya on a 4G Hotspot

Priya is doing a semester abroad with a 4G hotspot that charges per gigabyte. She needs Linuxify for a class project but is anxious about data. She reads the docs and discovers the offline mode.

While she's at a cafe with wifi, she pre-caches.

```
$ linuxify add --download-only cline codex aider
↓ Caching cline-1.2.0.tar.gz (8.4 MB)
↓ Caching codex-0.20.1.tar.gz (6.1 MB)
↓ Caching aider-0.14.0.tar.gz (4.2 MB)
✔ 3 packages cached (~/.linuxify/cache/)
```

She also caches the Ubuntu rootfs (already done by `init`) and the registry index. Total pre-cache: about 350 MB, which fits in the cafe's generous wifi. Back on her hotspot, she installs.

```
$ linuxify add cline --offline
✔ Using cached tarball (4 hours old)
✔ Patching (2 patches)
✔ Launcher created
$ linuxify run cline
(cline session begins)
```

She works for an hour. No data consumed by Linuxify. She runs `linuxify doctor`, `linuxify list`, `linuxify info` — all work offline. She tries `linuxify update` and gets an honest refusal:

```
$ linuxify update
✖ Network unavailable and --check-only not given.
  Reason: cannot reach registry.linuxify.dev
  Fix:   linuxify update --check-only   (use cached index, 4h old)
         or wait until you have wifi.
[exit 10]
```

She runs `linuxify update --check-only` and gets the cached version. She appreciates that Linuxify didn't try to be clever — she'd rather have a clear "no, I won't do that offline" than a mysterious hang. The emotional arc: anxiety about data → relief at the explicit offline support → mild pride at being a "precache power user" → trust that the tool respects her constraints.

The class project ships on time. She writes a blog post titled "How I did my AI class project on Android without blowing my data cap" and gets it to the front page of a small dev community. A commenter asks if she tried `--offline` for `self-update`; she has to reply honestly that binary updates require network, which is the one thing she couldn't pre-cache.

**What Linuxify did well**: explicit `--offline` mode, `--download-only` for pre-caching, honest refusal rather than silent failure, clear distinction between "needs network" and "fully local" commands.

**What could be better**: `self-update` offline support would be nice for users who want to upgrade during a brief wifi window and apply later; the "cached index is N hours old" warning could include a hint about staleness vs. freshness tradeoffs.

---

## Journey 6: Kenji Contributes a Patch

Kenji maintains a small, obscure CLI tool called `txtsuite` — a text-processing utility with a few hundred users. He's heard that some of them run it on Android via Linuxify, but there's no package definition for it. He decides to write one and contribute it upstream.

He forks the repo, copies `aider.yml` (since `txtsuite` is Python-based), and writes the definition. The `install:` is `pip install txtsuite`. He doesn't think he needs patches — his code is pure Python and uses `sys.platform` only in a non-critical way. He tests.

```
$ linuxify add ./txtsuite.yml --local --no-patch
✔ Installed txtsuite@2.1.0
$ linuxify run txtsuite -- --help
Usage: txtsuite [options] <command>
...
```

It works. He's mildly surprised — he'd braced for a platform-check failure. He runs the full test suite of his tool under Linuxify; everything passes. He submits the PR with a minimal YAML (no patches needed). The maintainer who reviews asks him to add a `doctor` block so that `linuxify doctor txtsuite` verifies the install. He adds:

```yaml
doctor:
  - check: python_version
    min: "3.10"
  - check: executable
    binary: txtsuite
```

CI runs, passes, PR merges.

A week later, a user reports that `txtsuite` crashes on Android armv7 (not arm64). Kenji reproduces — his tool uses `struct.unpack` with a format string that assumes 64-bit alignment. He can't fix this in the upstream code easily (it's a design decision), so he writes a Linuxify patch that detects armv7 and switches to a slower but correct code path. He updates the YAML:

```yaml
patches:
  - file: "txtsuite/parsers.py"
    find: "struct.unpack('>Q', buf)"
    replace: "struct.unpack('>Q', buf) if struct.calcsize('P') == 8 else _slow_unpack_q(buf)"
compat:
  tested_distros: [ubuntu]
  known_issues:
    - "armv7: uses slow path for 64-bit unpacking"
```

He tests on an armv7 Android emulator (he doesn't have armv7 hardware). It works. He updates the PR. The emotional arc: casual "I'll add a YAML" → pleasant surprise it just worked → "oh, armv7 edge case" → satisfaction at being able to ship a workaround without forking his own tool's release process.

What he most appreciates is that Linuxify let him express a real workaround for a real platform limitation without making him re-architect `txtsuite`. The patch layer absorbed the platform weirdness so his tool's codebase stayed clean.

**What Linuxify did well**: minimal YAML when no patches are needed (no ceremony), `--local` testing without push, the `compat.known_issues` field for honest documentation of limitations.

**What could be better**: Kenji wished Linuxify had an `--emulate-arch armv7` flag for `run` so he could test on his arm64 phone rather than spinning up an emulator. Even a warning that "this package has untested arches" would have prompted him to think about armv7 before a user hit it.

---

## Closing Notes on the Journey Set

Across all six journeys, three themes recur. First, **honesty is the most-praised quality**: users explicitly called out that they trusted Linuxify because it refused operations it couldn't safely do, rather than silently failing or hanging. Second, **the `--local` flag for package-definition testing is a quiet hero**: it appears in three of six journeys and is what makes contribution accessible to first-timers. Third, **error messages are the product**: every journey's emotional turning point came from a clear, actionable error message (or, in the negative cases, from a message that could have been clearer). The investment in the four-part error structure (what / why / fix / docs) pays out in every single journey, and the gaps users identified are almost all of the form "the message could have been more specific about *my* situation."

These journeys are not the end of the design conversation — they are a baseline. As Linuxify ships and real user feedback arrives, these narratives should be updated to reflect what users actually do, not what we imagine they will do. The [UX Flows](ux-flows.md) document is the normative companion to this one: when a journey and a flow disagree, the flow is right and the journey should be rewritten to match.
