# Website Copy

> The full, ready-to-publish copy for the `linuxify.sh` marketing website. Every block of text below is final copy: it has been written to the voice and tone defined in the [Branding Guide](branding-guide.md), calibrated to the audience described in the [Executive Summary](../00-executive/executive-summary.md), and cross-referenced against the [CLI Specification](../03-cli/cli-specification.md) so that every command, flag, and output snippet is technically accurate. A frontend engineer or AI coding agent building the site should be able to lift this copy verbatim into the relevant components.
>
> **Audience**: frontend engineers building `linuxify.sh`, community managers running the project's social accounts, copywriters extending the site, and AI coding agents generating new pages. Every section below is one section of the site; the section heading matches the component the copy belongs in.
>
> **Related**: [Branding Guide](branding-guide.md) · [CLI Specification](../03-cli/cli-specification.md) · [Command Reference](../03-cli/command-reference.md) · [Contribution Guidelines](../16-community/contribution-guidelines.md) · [Roadmap](../15-roadmap/release-roadmap.md)

---

## 1. Homepage Hero

The hero is the first thing a visitor sees and the most-tested copy on the site. It has to answer three questions in under five seconds: what is this, who is it for, and what do I do next. The headline does the first; the subhead does the second; the CTAs and the quick-start block do the third. The hero is the only place on the site where we use the primary tagline verbatim; everywhere else, we elaborate.

**Headline** (Inter 900, 72px, line-height 1.1, color `linuxify-text-dark` on `linuxify-bg-dark`):

> Run Linux developer tools on Android.

**Subhead** (Inter 400, 20px, line-height 1.5, color `linuxify-text-dark` at 80% opacity, max-width 640px):

> Linuxify turns your Android phone into a Linux dev box. Cline, Codex, Aider, and 100+ CLIs — installed, patched, and ready in one command.

**CTAs** (in a horizontal row, 16px gap, vertically centered on the subhead's last line):

- **Primary button**: "Get Started" → `/docs/quick-start`
- **Secondary button**: "View on GitHub" → `https://github.com/linuxify/linuxify` (opens in new tab, with GitHub icon at 16px to the left of the label)

**Quick-start code block** (below the CTAs, 24px gap, full-width on mobile, max-width 720px on desktop, dark code block per the [Branding Guide](branding-guide.md#11-ui-components) §11):

```bash
# 1. Install Termux (from F-Droid — not Play Store)
# 2. From the Termux shell:
pkg install linuxify
linuxify init
linuxify add cline
```

The code block has a copy-to-clipboard button (top-right, ghost variant, 24px icon) and a label "bash" in the top-left at 12px, 40% opacity. The three commands are the canonical v1 quick-start and must remain in sync with the [Command Reference](../03-cli/command-reference.md); if a command name changes, this block changes.

**Below the code block**, a one-line caption (Inter 400, 14px, color `linuxify-text-dark` at 60% opacity):

> No root. No emulator. Works on any Android 9+ device with Termux.

---

## 2. Homepage Features Section

The features section sits immediately below the hero. It contains six feature cards in a 3×2 grid on desktop (1 column on mobile, 2 on tablet). Each card follows the [Branding Guide](branding-guide.md#11-ui-components) §11 card spec: 24px padding, 6px radius, light background, 1px border at 10% opacity. Each card contains a 24px icon (from the [icon set](branding-guide.md#7-iconography)) in the accent green at the top, a headline in Inter 700 at 20px, and a two-sentence description in Inter 400 at 16px. The two-sentence limit is strict: if a feature cannot be described in two sentences, the feature is too complex for the homepage and should be cut or moved to a detail page.

**Card 1 — One-command setup** (icon: terminal)

> **One-command setup**

> `linuxify init` installs Termux, proot, Ubuntu, and every runtime you need — idempotently. Run it once on a fresh phone or a hundred times on a battered one; the result is the same working environment.

**Card 2 — Works with your CLIs** (icon: package)

> **Works with your CLIs**

> Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, Freebuff — Linuxify ships with the AI coding agents developers actually use. Each one is wrapped in a YAML package that handles install, patch, and launch.

**Card 3 — Multi-distro support** (icon: distro)

> **Multi-distro support**

> Ubuntu is the default, but Debian, Arch, and Alpine are first-class citizens. Switch distros with `linuxify use debian` and your installed packages follow you, re-patched against the new distro's quirks.

**Card 4 — Doctor & auto-repair** (icon: doctor)

> **Doctor & auto-repair**

> `linuxify doctor` checks your environment end-to-end and tells you exactly what is broken. `linuxify repair` fixes the common cases — a missing runtime, a stale PATH, a patch that drifted — without you reading a single log line.

**Card 5 — Plugin SDK** (icon: patch)

> **Plugin SDK**

> Need a distro Linuxify doesn't ship? A runtime? A custom patcher rule? The plugin SDK lets you extend every layer without forking the core. Plugins are versioned, signed, and discoverable through the registry.

**Card 6 — Open source forever** (icon: settings)

> **Open source forever**

> MIT-licensed, community-owned, no enterprise tier, no telemetry trap. The brand assets are CC BY-SA 4.0. The roadmap is public. The maintainer team is listed in the README, with their commits and their emails.

The grid is wrapped in a section with a heading (Inter 800, 40px) reading "Everything you need to develop on a phone." and a one-line subhead (Inter 400, 18px) reading "Linuxify is not a Termux script. It is a compatibility layer, a package manager, and a diagnostic engine — in one verb-driven CLI." The heading sits above the grid with 32px of vertical space; the subhead sits 8px below the heading.

---

## 3. Homepage How It Works

The "How it works" section explains Linuxify in three steps, illustrated with a visual flow and supported by 100-word explanations. The visual is a horizontal flow on desktop (vertical on mobile) of three panels connected by arrows, with a final screenshot panel on the right. Each step panel is a card (per the [Branding Guide](branding-guide.md#11-ui-components) §11 card spec) with a step number in the top-left (Inter 800, 14px, in a 24px circle of `linuxify-green` at 20% opacity), a step title in Inter 700 at 20px, a step command in a small code block, and the 100-word explanation below.

**Section heading** (Inter 800, 40px):

> Three commands. One working dev box.

**Section subhead** (Inter 400, 18px):

> No SDK downloads, no Android Studio, no QEMU. Just Termux, Linuxify, and the tool you actually want to run.

**Step 1 — Install Termux**

> Install Termux from F-Droid. The Play Store version is abandoned and will not work; F-Droid is the only supported source. Open Termux and you have a real Linux shell on Android, with `pkg` as the package manager and `/data/data/com.termux/files/usr` as your `$PREFIX`. Termux is the foundation Linuxify is built on — it is not replaced, it is empowered. From here on, every command in this guide runs inside the Termux shell.

**Step 2 — `pkg install linuxify`**

> Install Linuxify itself. This pulls the CLI binary, the default package definitions, and the bootstrap scripts into your Termux environment. The install is small — under 10 MB — because everything else (Ubuntu, runtimes, the actual tools) is fetched on demand by `linuxify init`. After install, the `linuxify` command is on your `$PATH` and ready. No `sudo`, no root, no Android Studio, no ADB.

**Step 3 — `linuxify init` then `linuxify add cline`**

> `linuxify init` bootstraps the rest of the environment: it installs proot, downloads the Ubuntu 24.04 rootfs, installs Node and Python and Git inside the proot, and wires up `$PATH`. The whole thing takes about five minutes on a warm cache and is fully idempotent — re-running it after a crash picks up where it left off. Then `linuxify add cline` installs Cline, applies the platform-detection patches, generates the launcher shim, and drops a `cline` command on your Termux `$PATH`. Type `cline` and the AI coding agent starts.

**Final panel — Screenshot**

> [Screenshot: a Termux session on a phone, showing the `cline` agent running — a prompt, a tool call, and a code edit in progress. The screenshot is dark-mode, cropped tightly to the terminal content, with the phone's status bar redacted.]

The screenshot panel has a caption below it (Inter 400, 14px, 60% opacity): "Cline running on a Pixel 7, installed via `linuxify add cline`."

---

## 4. Homepage Social Proof

The social proof section is intentionally modest in v1, because the project is new and over-claiming would damage credibility. The section has three rows: a one-line "trusted by" claim, a star-GitHub button, and a row of "featured-in" logos. The trusted-by count and the featured-in logos are both placeholders in v1 — they get filled in as real numbers accrue. The placeholder copy makes clear that the numbers update dynamically from the GitHub API and the registry.

**Row 1 — Trusted by** (Inter 500, 24px, centered, color `linuxify-space` on `linuxify-bg-light`):

> Trusted by **<span data-source="github">N</span>** developers and **<span data-source="registry">M</span>** installed packages.

The `N` and `M` are populated client-side from the GitHub API (stargazers count) and the registry's install-counts endpoint. Until those endpoints are live, the values default to "early" and "8" respectively, and the line reads "Trusted by early developers and 8 installed packages." This is intentionally honest: pretending to have more traction than we have would be the worst kind of brand damage.

**Row 2 — GitHub star button**

> [★ Star on GitHub] — `<span data-source="github-stars">N</span>`

A secondary button per the [Branding Guide](branding-guide.md#11-ui-components) §11, with the GitHub icon to the left of the label. The button links to `https://github.com/linuxify/linuxify`. The star count is populated client-side from the GitHub API and updates on page load. If the API call fails, the count is hidden and only the label remains.

**Row 3 — Featured in** (a row of logos, each at 120px wide, grayscale by default, full-color on hover, 32px gap between logos):

> [Logo placeholder: Hacker News]
> [Logo placeholder: /r/termux]
> [Logo placeholder: Linux Action News]
> [Logo placeholder: Android Police]

The placeholder logos are text-only "Logo" badges in Inter 500 at 14px, in `linuxify-space` at 40% opacity, set in 120px × 40px rectangles with a 1px border at 10% opacity. When real press coverage arrives, each placeholder is replaced with the actual publication's logo in grayscale, with a `prefers-color-scheme: dark` variant where applicable. The row has a caption above it (Inter 400, 14px, 60% opacity): "As seen on."

---

## 5. Packages Page

The packages page is the second-most-visited page on the site (after the homepage) and the primary discovery surface for the registry. It is a single-page app: a header, a search bar, a filter sidebar, and a grid of package cards. The page is server-rendered for SEO and hydrated client-side for interactivity. The empty state (no results) shows a helpful suggestion to open a package request.

**Page header** (Inter 800, 56px):

> Pick your tools. We'll do the rest.

**Page subhead** (Inter 400, 20px, max-width 720px):

> Every package is a YAML file — install steps, platform patches, doctor checks, and a launcher shim. Browse the catalogue, then `linuxify add <name>` to install.

**Search bar** (full-width, 12px below the subhead, with a 24px search icon to the left of the input and placeholder text):

> Search 100+ packages — try "ai", "python", "rust"…

The search bar is the [Branding Guide](branding-guide.md#11-ui-components) §11 input component, scaled to 56px tall. It supports fuzzy matching against package name, description, and category. Typing triggers a debounce (250ms), then filters the grid below.

**Filter sidebar** (left, 240px wide on desktop, collapsible drawer on mobile):

> **Filter by category**
> - [ ] AI coding agents (32)
> - [ ] Web frameworks (14)
> - [ ] Python tools (18)
> - [ ] Rust tools (9)
> - [ ] Go tools (11)
> - [ ] DevOps (16)
>
> **Filter by runtime**
> - [ ] Node (47)
> - [ ] Python (24)
> - [ ] Rust (12)
> - [ ] Go (15)
> - [ ] Bun (4)
> - [ ] Deno (3)
>
> **Filter by distro**
> - [ ] Ubuntu (98)
> - [ ] Debian (74)
> - [ ] Arch (52)
> - [ ] Alpine (31)

Each filter is a ghost-variant checkbox with a count in parentheses. Selecting a filter narrows the grid in real time. Multiple filters within a category are OR'd; filters across categories are AND'd.

**Package grid** (right of the sidebar, responsive: 1 column on mobile, 2 on tablet, 3 on desktop). Each card contains:

- **Icon**: 48px square, package-specific (defaults to the "package" icon from the [icon set](branding-guide.md#7-iconography) if no upstream icon is available).
- **Name**: Inter 700, 20px. Example: "Cline".
- **Description**: Inter 400, 14px, two-line clamp. Example: "AI coding agent that runs in your terminal. Cline can use your terminal, run commands, edit files, and ship pull requests."
- **Supported distros**: row of mini distro icons (16px each, from the [icon set](branding-guide.md#7-iconography)). Example: [Ubuntu] [Debian] [Arch] (Alpine is grayed out and struck through if unsupported).
- **Install command**: a small code block, single-line, with a copy button. Example: `linuxify add cline`.
- **Detail link**: a ghost button "View details →" linking to `/packages/<name>`.

**Empty state** (when search returns no results, replacing the grid):

> No packages match "**<span data-bind="query"></span>**".
>
> We don't have a package for that yet. [Open a package request](https://github.com/linuxify/linuxify/issues/new?template=package-request.yml) and we'll help you write the YAML.

---

## 6. Package Detail Page Template

Each package has its own detail page at `/packages/<name>`. The page is generated from the package's YAML definition in the registry, so the copy below is a template — the actual content varies by package. The template is what an AI coding agent generating a new package detail page should follow.

**Hero section** (top of the page, dark background, 120px vertical padding):

- **Package name** (Inter 900, 56px, `linuxify-text-dark`): "Cline"
- **Description** (Inter 400, 20px, `linuxify-text-dark` at 80%, max-width 720px): "AI coding agent that runs in your terminal."
- **Install command** (large code block, 18px JetBrains Mono, with copy button): `linuxify add cline`
- **Upstream link** (ghost button, "View on GitHub →"): `https://github.com/cline/cline`
- **Registry YAML link** (ghost button, "View package YAML →"): links to `packages/cline.yml` on the Linuxify repo.

**Screenshot** (full-width below the hero, dark code block showing the package running):

> [Screenshot: a Termux session showing the Cline agent making a code edit. The screenshot is dark-mode, tightly cropped to the terminal content.]

**Key features** (a list, with 16px bullets, Inter 400 at 16px, max-width 720px):

> - Reads and writes files in your project, with diff preview before applying changes.
> - Runs terminal commands and parses their output, with per-command approval prompts.
> - Uses any OpenAI-compatible or Anthropic-compatible LLM endpoint.
> - Works with MCP servers for tool extensibility.
> - Streams responses, supports checkpoints, and can resume a session after a crash.

**Compatibility matrix** (a compact table, four columns: Distro × Runtime × Arch × Status):

| Distro | Runtime | Arch | Status |
|--------|---------|------|--------|
| Ubuntu 24.04 | Node 20+ | aarch64 | ✓ Supported |
| Ubuntu 24.04 | Node 20+ | armv7l | ⚠ Best-effort |
| Debian 12 | Node 20+ | aarch64 | ✓ Supported |
| Arch | Node 20+ | aarch64 | ✓ Supported |
| Alpine | Node 20+ | aarch64 | ✖ Not supported (musl) |

Each row's status cell is color-coded per the [Branding Guide](branding-guide.md#11-ui-components) §11 table spec. The "Not supported" row links to the relevant known-issues entry.

**Known issues** (a list, with 16px warning icons in `linuxify-yellow`, Inter 400 at 16px):

> - On `armv7l`, the `sharp` native module must be rebuilt; `linuxify repair` handles this automatically.
> - On Alpine (musl), the upstream binary segfaults; no fix is currently known. Track issue [#124](https://github.com/linuxify/linuxify/issues/124).
> - The `--no-browser` flag is required when running on Android, because no system browser is available. The launcher shim sets this flag automatically.

**Footer of the page** (Inter 400, 14px, 60% opacity):

> Package definition: [`packages/cline.yml`](https://github.com/linuxify/linuxify/blob/main/packages/cline.yml) · Last updated: 2026-04-12 · Maintained by: [@cline](https://github.com/cline), [@linuxify-core](https://github.com/linuxify-core)

---

## 7. Docs Landing

The docs landing page is the front door to the documentation set and the page that `linuxify.sh/docs` redirects to. Its job is to orient a visitor who knows they want to read docs but does not yet know which doc. The page has a hero, a search bar, and a grid of cards linking to the major doc sections. The cards mirror the structure of [`docs/INDEX.md`](../INDEX.md), so the docs landing and the in-repo index are always in sync.

**Hero** (dark background, 80px vertical padding, centered):

> **Everything you need to build with Linuxify.**

> The full design record for Linuxify — architecture, CLI spec, package format, plugin SDK, security model, roadmap. Written for contributors and AI coding agents alike.

**Search bar** (56px tall, full-width, with placeholder):

> Search the docs — try "init", "package YAML", "doctor"…

The search bar is wired to a local search index built from the docs at deploy time (we use a Lunr-based index for v1, with a planned upgrade to a hosted search service in v1.1). Typing triggers a dropdown of matching doc sections; selecting a result navigates to that doc.

**Cards grid** (5 cards in a 2×3 grid, with the sixth cell holding a "View all docs" link):

> **Quick Start**
> Install Linuxify, run `init`, add your first tool. Five minutes from zero to a working CLI.
> → `/docs/03-cli/cli-specification`

> **CLI Reference**
> Every subcommand, every flag, every exit code. The canonical contract for the `linuxify` command.
> → `/docs/03-cli/command-reference`

> **Package Spec**
> How to write a `packages/<tool>.yml` file. Install steps, patches, env, doctor checks, compat.
> → `/docs/09-registry/package-spec`

> **Plugin SDK**
> Extend Linuxify with new distros, runtimes, patchers, and doctor checks. The full extension API.
> → `/docs/10-plugin-sdk/plugin-sdk`

> **Contribution Guide**
> How to open a PR, how to write a commit message, how to add a package, how to be a good citizen.
> → `/docs/16-community/contribution-guidelines`

> **View all docs →**
> The complete index of all 25 documentation sections.
> → `/docs/INDEX`

Each card uses the [Branding Guide](branding-guide.md#11-ui-components) §11 card spec, with a 24px icon (terminal, settings, package, patch, doctor, and arrow-right respectively) in the accent green at the top.

---

## 8. Compatibility Page

The compatibility page is the public face of the [compatibility database](../11-compat-db/compatibility-database.md) and the page a developer visits before investing time in installing a tool. It is a single, large, interactive matrix: rows are packages, columns are (distro × runtime × arch × Android version) combinations, cells are color-coded support statuses. The matrix is filterable along every axis, and clicking a cell opens a detail drawer with the underlying data.

**Page header** (Inter 800, 40px):

> What works where.

**Page subhead** (Inter 400, 18px, max-width 720px):

> The Linuxify compatibility matrix is crowd-sourced from `linuxify doctor` reports. Every cell links to the evidence — a test transcript, an issue, or a maintainer sign-off.

**Filter bar** (sticky, 12px below the subhead, with four dropdowns in a horizontal row):

> Distro: [All ▼] · Runtime: [All ▼] · Arch: [All ▼] · Android: [All ▼]

Each dropdown is a styled `<select>` (or a custom dropdown component for styling). Selecting a filter narrows the matrix in real time. Multiple selections within a dropdown are not supported in v1 (one filter per axis); multi-select is a v1.1 feature.

**Matrix** (a large table, sticky header row, sticky first column):

| Package | Ubuntu/aarch64 | Debian/aarch64 | Arch/aarch64 | Alpine/aarch64 | Ubuntu/armv7l |
|---------|----------------|----------------|--------------|----------------|---------------|
| Cline | ✓ | ✓ | ✓ | ✖ | ⚠ |
| Codex | ✓ | ✓ | ⚠ | ✖ | ✖ |
| Aider | ✓ | ✓ | ✓ | ✓ | ⚠ |
| Goose | ✓ | ⚠ | ⚠ | ✖ | ✖ |
| Gemini CLI | ✓ | ✓ | ✓ | ✖ | ⚠ |
| OpenHands | ✓ | ✓ | ✓ | ✖ | ✖ |
| Freebuff | ✓ | ✓ | ⚠ | ✖ | ✖ |

Cells use the color coding from the [Branding Guide](branding-guide.md#11-ui-components) §11 table spec: green at 20% opacity for ✓, yellow at 20% opacity for ⚠, red at 20% opacity for ✖. Clicking a cell opens a drawer on the right with: the test transcript (if available), the issue link (if open), the last-tested date, the maintainer who signed off, and a "Run this test yourself" command (`linuxify doctor --package cline --distro alpine`).

**Legend** (below the matrix, Inter 400, 14px):

> ✓ Supported · ⚠ Best-effort (may require `linuxify repair`) · ✖ Not supported (known issue)

---

## 9. Blog Post: "Introducing Linuxify"

This is the launch announcement blog post. It is the personal, technical, optimistic voice of the project founder(s), not the marketing voice of the homepage. It runs about 1,000 words. The post lives at `/blog/introducing-linuxify` and is the canonical link shared on launch day.

---

# Introducing Linuxify

*April 15, 2026 · 8 min read · by the Linuxify team*

Last month I tried to run Cline on my phone. Cline is an AI coding agent that lives in your terminal — it reads files, runs commands, ships pull requests. It is exactly the kind of tool that should run on a phone, because the phone is the computer I have with me when I am on a bus, in a café, or waiting for a flight. Cline is a Node CLI. Node runs on ARM. Termux gives me a Linux shell on Android. This should be ten minutes of work.

It took me a weekend.

The first hour was Termux: install it from F-Droid (not the Play Store — the Play Store version is abandoned), update packages, install `proot`. The next two hours were Ubuntu inside proot: download the rootfs, configure the mount points, fix the DNS resolver. The fourth hour was Node: install it inside the proot, but discover that `process.platform === "android"` from inside Termux and `process.platform === "linux"` from inside the proot, and Cline's platform detection breaks on both. The fifth hour was patching Cline's source to handle Android and arm64. The sixth hour was a launcher shim — a shell script that entered the proot, set the right environment variables, and exec'd the patched Cline binary. By the end of the weekend I had one tool running.

Then I tried Codex. Same problem. Then Aider. Same problem, plus Python packaging quirks. Then Gemini CLI. Same problem, plus a different `process.platform` check. Each tool failed in the same five ways: it assumed `process.platform === "linux"`, it assumed glibc, it assumed `x86_64`, it assumed a desktop environment, it assumed a system browser. Each fix was the same five patches. Each install was the same five-hour ritual.

This is not a tool-specific problem. It is a systemic one. Android, despite being the most widely deployed operating system on Earth, has no first-class developer-tool story. iOS has Swift Playgrounds. Windows has WSL. macOS has Homebrew. Linux desktops have apt, dnf, pacman, flatpak, snap, brew. Android has Termux — and Termux, for all its brilliance, is a shell, not a compatibility layer. Termux explicitly does not own the "make desktop tools work here" problem. It leaves that problem to the user.

So we built Linuxify.

Linuxify is a compatibility layer, a package manager, and a diagnostic engine for Linux developer CLIs on Android. It is not a Termux replacement — it sits on top of Termux, uses proot for syscall translation, and adds the missing layer between "Android kernel + Termux + proot" and "the developer CLI ecosystem." With Linuxify, the weekend ritual becomes three commands:

```bash
pkg install linuxify
linuxify init
linuxify add cline
```

`linuxify init` bootstraps the environment: Termux, proot, Ubuntu 24.04, Node, Python, Git, and the right `$PATH`. `linuxify add cline` installs Cline, applies the platform-detection patches (the same five patches, applied automatically), generates the launcher shim, and drops a `cline` command on your Termux `$PATH`. Type `cline` and it works.

The same YAML-driven flow handles every other tool. Each tool gets a `packages/<tool>.yml` file — install steps, patches, env, doctor checks, compat matrix. The patcher is AST-aware for JS and TS, with a regex fallback for everything else. The doctor runs declarative checks and reports `ok`, `warn`, `fail`, or `missing` — with a remediation hint for every failure. `linuxify repair` fixes the common cases without you reading a log.

Linuxify is open source, MIT-licensed, and community-owned. There is no enterprise tier, no telemetry trap, no "contact sales." The brand assets are CC BY-SA 4.0. The roadmap is public. The maintainer team is listed in the README, with their commits and their emails. We are not a company. We are developers who got tired of the same weekend ritual.

The vision is bigger than v1. Today Linuxify runs seven launch tools — Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, Freebuff — on Ubuntu, with best-effort support for Debian, Arch, and Alpine. Next is the plugin SDK, so the community can add new distros, runtimes, and patchers without forking the core. After that, a real package registry — signed, namespaced, searchable — so that `linuxify search` returns ranked, verified results. After that, cloud sync, so the Linuxify environment on your phone follows you to your tablet and your Chromebook. The full vision is in the docs; the short version is "Homebrew for Android/Linux CLIs, and eventually for any platform where desktop developer tooling needs a compatibility layer."

But v1 is the wedge. If you have ever tried to run a Linux CLI on Android and given up, Linuxify is for you. If you maintain a CLI tool and want it to work on Android without you writing Android-specific code, Linuxify is for you. If you are an AI coding agent looking for a project to contribute to, the package registry is the place to start — every new `packages/<tool>.yml` file is a real contribution, schema-validated, reviewable in a PR, and immediately useful to every Linuxify user.

Install it. Break it. File issues. Write packages. The terminal is yours.

→ [Get started](/docs/quick-start) · [View on GitHub](https://github.com/linuxify/linuxify) · [Join the Discord](https://discord.gg/linuxify)

---

## 10. FAQ Page

The FAQ page is a single long page at `/faq`, with a sticky table of contents on the left (desktop) and an accordion of questions on the right. Each question is a `<details>` element with the question as the `<summary>` and the answer as the body. The page is also searchable; typing in the search bar at the top filters the questions in real time. The copy below is the 20 canonical v1 questions and answers, written to be lifted verbatim into the page.

**Page header** (Inter 800, 56px):

> Frequently asked questions

**Page subhead** (Inter 400, 18px, max-width 720px):

> Twenty questions we get a lot. If yours is not here, [ask in Discord](https://discord.gg/linuxify) or [open a discussion](https://github.com/linuxify/linuxify/discussions).

**Q1. Does this need root?**

> No. Linuxify runs entirely without root, using `proot` for syscall translation. You install Termux from F-Droid, install Linuxify from inside Termux, and everything else runs in user space. We will never require root, and a future root-optional mode is the only place root would ever appear.

**Q2. Does it work on iPhone?**

> No. iOS does not allow the kind of process model Linuxify requires (fork, exec, arbitrary syscalls). We are Android-only for the foreseeable future. If you are on iOS, your closest equivalent is iSH, which is a different project with a different scope.

**Q3. Will it drain my battery?**

> Linuxify itself is a CLI and uses no background resources when you are not running it. The tools you install (Cline, Codex, etc.) will use battery exactly as they would on a laptop — more when they are actively running, none when they are idle. Running an AI coding agent for an hour on a phone will use roughly the same battery as running it for an hour on a laptop.

**Q4. Is it safe?**

> Linuxify is MIT-licensed open source, and every line is reviewable on GitHub. It does not phone home with your data (see our [telemetry policy](/docs/24-telemetry/telemetry-privacy)). It does not modify your Android system outside Termux's sandbox. It does not require root. The tools you install through Linuxify are the same tools you would install through `npm` or `pip` on a laptop — review their upstream licenses and security postures separately.

**Q5. How is this different from Termux?**

> Termux is a Linux-like shell on Android. Linuxify is a compatibility layer, package manager, and diagnostic engine that runs *on top of* Termux. Termux gives you a shell; Linuxify gives you a working Linux dev box with the AI coding agents you actually want to use, patched and ready. We love Termux. Linuxify is not a replacement; it is the next layer up.

**Q6. How is this different from proot-distro?**

> `proot-distro` is a Termux package that installs Linux distros inside proot. It is excellent, and Linuxify uses it under the hood. `proot-distro` stops at "you have a Ubuntu shell." Linuxify starts there and adds runtime management, package definitions, platform patching, doctor diagnostics, and launcher shims. Think of `proot-distro` as the engine and Linuxify as the car around it.

**Q7. Can I run X tool?**

> Probably. If the tool is a Linux CLI written in Node, Python, Rust, Go, Bun, or Deno, and it runs on `aarch64`, the answer is almost always yes — possibly with patches. Check the [packages page](/packages) for an existing package, or [open a package request](https://github.com/linuxify/linuxify/issues/new?template=package-request.yml) and we will help you write the YAML.

**Q8. How much storage does it use?**

> A fresh `linuxify init` uses about 1.2 GB: 800 MB for the Ubuntu rootfs, 250 MB for runtimes (Node, Python, Git), and 150 MB for the Linuxify core and cache. Each installed tool adds 50–500 MB depending on its dependencies. A typical setup with Cline, Codex, and Aider installed uses about 3 GB total.

**Q9. Can I use it offline?**

> Yes, once the initial install is done. `linuxify init` and `linuxify add` need network to download the rootfs and the tool's source, but everything after that is local. `linuxify doctor`, `linuxify list`, `linuxify info`, `linuxify env`, and running installed tools all work fully offline. The CLI distinguishes "needs network" commands from "fully local" commands in its help output.

**Q10. Is there a GUI?**

> No. Linuxify is CLI-first, by design. The terminal is the right interface for the tools Linuxify installs. A future GUI wrapper is on the roadmap ([v2](/docs/15-roadmap/release-roadmap)) but is not a v1 priority.

**Q11. How do I contribute?**

> Read the [Contribution Guide](/docs/16-community/contribution-guidelines). The fastest way to contribute is to write a `packages/<tool>.yml` for a tool you use that is not yet in the registry. The second-fastest way is to file good bug reports using the issue templates. The third is to pick an issue labeled `good-first-issue` and open a PR.

**Q12. What's the license?**

> MIT for the code. CC BY-SA 4.0 for the brand assets (logo, colors, illustrations). See `LICENSE` and `LEGAL.md` in the repo for the full text.

**Q13. Who's behind this?**

> A team of maintainers listed in the project README, plus a growing community of contributors. There is no company. The project is funded by GitHub Sponsors and by community donations; the funding ledger is public.

**Q14. How do I report a bug?**

> [Open a bug report](https://github.com/linuxify/linuxify/issues/new?template=bug-report.yml). The template asks for the package, the Linuxify version, the distro, the runtime, the device, the doctor output, and the steps to reproduce. Filling it out fully is the fastest way to get help.

**Q15. How do I request a new package?**

> [Open a package request](https://github.com/linuxify/linuxify/issues/new?template=package-request.yml). Tell us the package name, the upstream URL, why you want it, and whether you are willing to write the YAML yourself. We will help you through the rest.

**Q16. Does it work on tablets?**

> Yes. Tablets are typically the best Linuxify experience — more screen real estate for terminal output, often more RAM than phones, and frequently a keyboard accessory. The install and CLI are identical to the phone flow.

**Q17. Does it work on Chromebooks?**

> Yes, if your Chromebook supports Android apps (most do, post-2017). Install Termux from the Play Store on the Chromebook (the Play Store Termux works on ChromeOS, even though it does not work on phones), then install Linuxify from inside Termux. The `x86_64` architecture is supported alongside `aarch64`.

**Q18. Can I use multiple distros?**

> Yes. `linuxify use debian` switches the active distro. Installed packages are re-patched against the new distro automatically. You can have Ubuntu, Debian, Arch, and Alpine installed simultaneously and switch between them at will. Storage is per-distro, so each additional distro adds about 800 MB.

**Q19. How do I uninstall?**

> `linuxify remove <package>` removes a single tool. `linuxify uninstall` removes Linuxify itself but leaves your distros and data in place. To remove everything, including distros and cache, delete the `~/.linuxify/` directory and the `linuxify` package from Termux (`pkg uninstall linuxify`).

**Q20. What's coming next?**

> See the [roadmap](/docs/15-roadmap/release-roadmap). The short version: v1.1 ships the plugin SDK and the remote registry; v1.2 ships Alpine support and Chromebook hardening; v2 ships cloud sync and the GUI wrapper. We ship on a roughly quarterly cadence.

---

## 11. Footer

The footer is on every page of the site. It is dark (`linuxify-bg-dark`), 80px vertical padding on desktop (48px on mobile), and contains the logo, the tagline, four columns of links, social icons, a "made with" line, the copyright, and a status page link. The footer is the only place the tertiary tagline appears site-wide.

**Top row** (logo + tagline on the left, social icons on the right):

- **Logo** (the inverted full lockup, 160px wide)
- **Tagline** (Inter 400, 14px, `linuxify-text-dark` at 60%, immediately below the logo): "Linux CLIs. Zero hassle."
- **Social icons** (24px, ghost buttons, in a row with 12px gap): GitHub, Twitter/X, Discord, Mastodon.

**Middle row** (four columns of links, each column has a heading in Inter 700 at 14px and a list of links in Inter 400 at 14px, `linuxify-text-dark` at 80%, with 12px line-height):

> **Product**
> - [Packages](/packages)
> - [Compatibility](/compatibility)
> - [Roadmap](/docs/15-roadmap/release-roadmap)
> - [Changelog](/changelog)

> **Docs**
> - [Quick Start](/docs/quick-start)
> - [CLI Reference](/docs/03-cli/command-reference)
> - [Package Spec](/docs/09-registry/package-spec)
> - [Plugin SDK](/docs/10-plugin-sdk/plugin-sdk)

> **Community**
> - [GitHub](https://github.com/linuxify/linuxify)
> - [Discord](https://discord.gg/linuxify)
> - [Contributing](/docs/16-community/contribution-guidelines)
> - [Code of Conduct](/docs/CODE_OF_CONDUCT)

> **Legal**
> - [License (MIT)](/LICENSE)
> - [Trademark Policy](/LEGAL)
> - [Privacy](/docs/24-telemetry/telemetry-privacy)
> - [Security Policy](/SECURITY)

**Bottom row** (Inter 400, 12px, `linuxify-text-dark` at 50%, in a horizontal flex with space-between):

> Made with ❤️ by the Linuxify community.
>
> © 2026 Linuxify contributors. MIT-licensed.
>
> [System status ↗](https://status.linuxify.sh)

---

## 12. 404 Page

The 404 page is the one place the brand voice gets to be openly playful. The page is dark, full-height, centered, and contains the inverted logo, a headline, the joke command, and two CTAs. The page is reachable from any invalid URL under `linuxify.sh`.

**Logo** (inverted full lockup, 120px wide, centered, 48px from the top)

**Headline** (Inter 800, 40px, `linuxify-text-dark`, centered, 32px below the logo):

> 404

**Subhead / joke** (Inter 400, 20px, `linuxify-text-dark` at 80%, max-width 480px, centered, 16px below the headline):

> Looks like this package isn't in the registry. Try `linuxify search <what-you-wanted>`.

The `<what-you-wanted>` portion of the code block is populated from the URL path — if the user landed on `/foo/bar`, the code block reads `linuxify search foo bar`. This is a small touch that turns the 404 from a dead-end into a helpful suggestion.

**CTAs** (centered, 16px gap, 32px below the subhead):

- **Primary button**: "Back home" → `/`
- **Secondary button**: "Search docs" → `/docs`

---

## 13. Twitter/X Bio + Sample Tweets

The Twitter/X presence is run by the maintainer team, posting from the `@linuxify` account. The bio is fixed; the tweets below are samples that establish the voice for future posts. The voice per the [Branding Guide](branding-guide.md#9-voice-tone) §9 is "witty, technical in-jokes welcome" — these samples set the bar.

**Bio** (160 characters max, Twitter limit):

> Run Linux developer tools on Android. Open source. One command. ↘️ github.com/linuxify/linuxify

**Sample tweet 1 — Launch announcement** (with a screenshot of the homepage hero attached):

> After a weekend of failing to run Cline on a Pixel, we built Linuxify.
>
> Three commands. No root. AI coding agents on your phone.
>
> pkg install linuxify
> linuxify init
> linuxify add cline
>
> ↘️ linuxify.sh
> ↘️ github.com/linuxify/linuxify

**Sample tweet 2 — New package added** (with the package's icon attached):

> `linuxify add aider` is now a thing.
>
> Aider — the AI pair programmer — now installs, patches, and runs on Android via Linuxify. One command, no weekend ritual.
>
> Thanks to @maintainer for the YAML. PRs welcome for the long tail of CLIs that should work here.
>
> ↘️ linuxify.sh/packages/aider

**Sample tweet 3 — Milestone reached** (with a screenshot of the GitHub star count):

> 1,000 stars. 🤯
>
> Thank you to everyone who installed, filed issues, wrote packages, and told a friend. The registry has 23 packages now. The next 100 are easier than the first 23 — come write one.
>
> ↘️ github.com/linuxify/linuxify

**Sample tweet 4 — Community spotlight** (with a screenshot of the showcased project):

> @communitymember is running their entire side hustle — a SaaS deployed from a Pixel 7 via Linuxify + Cline + a GitHub Action — from a bus.
>
> This is the future of mobile-first development. Show us what you build.
>
> ↘️ linuxify.sh/showcase

**Sample tweet 5 — Dev tip** (with a small screen recording of the tip in action):

> Tip: `linuxify doctor --markdown` outputs a markdown-formatted doctor report, perfect for pasting into a GitHub issue.
>
> Every bug report that includes this gets triaged 3× faster. Save your future self the back-and-forth.
>
> ↘️ linuxify.sh/docs/07-doctor

---

## 14. Discord Server

The Linuxify Discord is the primary real-time community space. The channel structure below is the v1 layout; channels are added as the community grows but never removed (a removed channel fragments history). Each channel has a topic (Discord's "channel topic" field) that sets the scope; the topics below are the canonical text. New members land in `#general` by default and are prompted to read `#announcements` and `#rules` (a static channel, not listed below, that contains the Code of Conduct summary).

**Channel structure** (in order, with topic text):

> **#announcements** — Releases, security advisories, and project news. Read-only. Maintainers post; everyone reads.

> **#general** — General chat about Linuxify. New here? Introduce yourself. Stuck? Ask in #support.

> **#support** — Installation problems, broken tools, "why doesn't X work?" questions. Be patient, be specific, paste your `linuxify doctor` output.

> **#package-requests** — Want a tool that's not in the registry? Suggest it here. Maintainable YAML gets added fast.

> **#plugin-dev** — Building a distro backend, runtime, patcher, or doctor pack? Share progress, ask API questions, coordinate releases.

> **#patches** — Deep dive on platform patches. Show off a clever fix; complain about `process.platform` checks; coordinate upstream PRs to the tools we patch.

> **#showcase** — What did you build with Linuxify? Screenshots, videos, links to repos. No self-promo of unrelated products.

> **#off-topic** — Everything else. Be kind. No politics, no crypto, no recruiting spam.

**Welcome message** (auto-posted by the Discord bot when a new member joins, in `#general`):

> Welcome to the Linuxify Discord, **@username**! 👋
>
> You're now part of a community building the Homebrew for Android/Linux CLIs.
>
> A few pointers:
> - Read **#announcements** for the latest release news.
> - Head to **#support** if you're stuck — include your `linuxify doctor` output for faster help.
> - Want a tool that's not in the registry? Drop it in **#package-requests**.
> - Building a plugin? **#plugin-dev** is your channel.
>
> Code of Conduct applies: be kind, be technical, be helpful. Full text in **#rules**.

---

## 15. Email Templates

The project sends four kinds of email: a welcome email (when a user joins the Discord or subscribes to the newsletter), a monthly newsletter, a release announcement, and a security advisory. Each template below is the canonical copy, written in plain text (the email client renders markdown to HTML via the project's email service). The from-name is always "Linuxify" and the from-address is always `hello@linuxify.sh`. The footer is shared across all four templates.

**Shared footer** (appended to every email):

> ---
>
> Linuxify · Run Linux developer tools on Android.
>
> GitHub: https://github.com/linuxify/linuxify
> Docs: https://linuxify.sh/docs
> Discord: https://discord.gg/linuxify
>
> You're receiving this because you subscribed at linuxify.sh. [Unsubscribe](%unsubscribe_url%).

---

**Template 1 — Welcome email** (sent immediately on Discord join or newsletter signup)

> Subject: Welcome to Linuxify 🐧
>
> Hi,
>
> Welcome to Linuxify — the Homebrew for Android/Linux CLIs. You're now on the newsletter (low-traffic: one email per release, plus a monthly digest).
>
> Three things to get you started:
>
> 1. Install Linuxify (3 commands):
>    pkg install linuxify
>    linuxify init
>    linuxify add cline
>
> 2. Read the Quick Start:
>    https://linuxify.sh/docs/quick-start
>
> 3. Join the Discord (if you haven't already):
>    https://discord.gg/linuxify
>
> Reply to this email if you get stuck. We read every reply.
>
> — The Linuxify team

---

**Template 2 — Monthly newsletter** (sent on the first of each month)

> Subject: Linuxify Monthly — April 2026
>
> Hi,
>
> Here's what happened in Linuxify in April.
>
> **Releases**
> - v0.3.2 shipped (Apr 12): Alpine support, 6 new packages, doctor improvements.
>   Full changelog: https://github.com/linuxify/linuxify/releases/tag/v0.3.2
>
> **New packages**
> - aider, goose, freebuff, ripgrep, fzf, jq (6 new, 29 total)
>
> **Community**
> - 1,043 GitHub stars (+312 this month)
> - 418 Discord members
> - 12 new contributors
>
> **Roadmap progress**
> - Plugin SDK: in alpha, target v0.4.
> - Remote registry: design phase, target v0.5.
> - Cloud sync: research, target v1.0.
>
> **Featured issue**
> - "Support ChromeOS x86_64" — needs a tester with a Chromebook.
>   https://github.com/linuxify/linuxify/issues/87
>
> **Featured package**
> - `aider` — AI pair programming in the terminal. `linuxify add aider`.
>
> Until next month,
>
> — The Linuxify team

---

**Template 3 — Release announcement** (sent within 24 hours of a release)

> Subject: Linuxify v0.3.2 is out
>
> Hi,
>
> Linuxify v0.3.2 is now available. To upgrade:
>
>    linuxify self-update
>
> **What's new**
>
> - Alpine distro support (beta). `linuxify use alpine`.
> - 6 new packages: aider, goose, freebuff, ripgrep, fzf, jq.
> - `linuxify doctor` now reports disk space per distro.
> - 14 bug fixes — see the full changelog.
>
> **Breaking changes**
>
> - The `linuxify install` alias for `init` is deprecated and will be removed in v0.4. Use `linuxify init`.
>
> **Upgrade notes**
>
> - If you have Alpine installed from the v0.3.1 beta, run `linuxify use alpine --rebuild` to pick up the new rootfs.
>
> Full release notes: https://github.com/linuxify/linuxify/releases/tag/v0.3.2
>
> As always, file bugs at https://github.com/linuxify/linuxify/issues — include your `linuxify doctor --markdown` output.
>
> — The Linuxify team

---

**Template 4 — Security advisory** (sent within 24 hours of a security fix)

> Subject: [Security] Linuxify v0.3.2 — update recommended
>
> Hi,
>
> A security issue was identified in Linuxify v0.3.1 and earlier. We recommend updating to v0.3.2 immediately.
>
> **What**
>
> A path traversal vulnerability in the patcher allowed a malicious `packages/<tool>.yml` to write files outside the intended target directory.
>
> **Impact**
>
> If you installed a package from an untrusted source (not the official registry), an attacker could have written arbitrary files to your Termux `$HOME`. No privilege escalation beyond the Termux sandbox.
>
> **Affected versions**
>
> All versions prior to v0.3.2.
>
> **Action required**
>
>    linuxify self-update
>    linuxify doctor --security
>
> If `doctor` reports any unexpected files, run `linuxify repair --security` to clean up.
>
> **Credit**
>
> Reported by @researcher via the security policy. Bounty paid from the Linuxify security fund.
>
> Full advisory: https://github.com/linuxify/linuxify/security/advisories/GHSA-xxxx-xxxx-xxxx
>
> — The Linuxify team
