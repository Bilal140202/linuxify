# Branding Guide

> The canonical reference for the Linuxify visual identity, voice, and written style. Every design choice documented here traces back to a single idea: Linuxify is the **Homebrew for Android/Linux CLIs** — a verb-driven developer tool, not a corporate product. Use this guide whenever you produce anything that carries the Linuxify name: a logo lockup, a tweet, a docs page, an error message, or a T-shirt.
>
> **Audience**: designers, illustrators, community managers, AI coding agents generating UI copy, contributors writing docs, and anyone producing outward-facing Linuxify material. When this guide and a contributor's instinct disagree, this guide wins. When this guide and the project's actual implementation disagree, open an issue so we can fix one of them.
>
> **Related**: [Website Copy](website-copy.md) · [Executive Summary](../00-executive/executive-summary.md) · [Vision](../00-executive/vision.md) · [CLI Specification](../03-cli/cli-specification.md) · [Contribution Guidelines](../16-community/contribution-guidelines.md)

---

## 1. Brand Vision

Linuxify exists for one reason: to make a developer's Android phone a first-class place to run the same Linux CLIs that live on their laptop. The brand must reflect that mission in every artifact it touches. The personality we project is pragmatic, developer-friendly, no-nonsense, and verb-driven. Think `git`, `npm`, `cargo`, or `brew` — tools that earn their place in a developer's muscle memory by being predictable and fast, not by being polished in the way a SaaS landing page is polished. We are not selling a productivity platform. We are giving away a tool that solves a real, painful, recurring problem and gets out of the way.

The developer we are talking to is busy. They are trying to run `cline` on a bus, or `aider` on a tablet in a classroom, or `codex` on a Chromebook in a hotel room. They have already fought with Termux and proot and PATH and `process.platform === "android"`. They do not need a hero narrative; they need a tool that works. So the brand vocabulary is the vocabulary of the terminal: install, add, run, doctor, repair, patch. Every verb in the CLI is also a verb in the brand. We never say "leverage," "synergize," "empower," or "unlock." We say "install," "patch," "diagnose," "fix." The taglines in §3 are written in this voice, and the rest of the visual identity is designed to support it.

The visual corollary of pragmatism is restraint. A developer tool's identity should look like the tool it describes. `git`'s branching logo, `npm`'s square, `cargo`'s crate — each is one concept, executed cleanly, recognizable at 16 pixels. Linuxify follows that lineage. We use one accent color (terminal green), one mono face (JetBrains Mono), one sans face (Inter), and a tightly bounded set of components. The brand is "loud" only in the way a successful `git commit` is loud: short, precise, and over. If you find yourself reaching for a third accent color, a fourth font, or an ornamental flourish, ask whether what you are producing is still recognizably Linuxify. If the answer is no, simplify until it is.

Finally, the brand is open-source and community-owned. It does not belong to a company, and it should never read like it does. There is no "Linuxify, Inc." logo lockup, no trademark assertion beyond what is required to protect the project from impersonation, no enterprise tier mentioned in copy. When we describe the project, we say "Linuxify is a community project" or "Linuxify is built in the open." When we list contributors, we list them as people, not as logos. The visual identity is itself open: all assets are CC BY-SA 4.0 (see §13), the source SVGs live in the repo, and any contributor can propose a change by opening a PR against this very document.

---

## 2. Name & Usage

The project's name is **Linuxify**, capitalized with a capital `L` and lowercase `ify`. This is the form used when referring to the project, the community, the documentation set, or any outward-facing artifact. The CLI command is **`linuxify`**, all lowercase, set in monospace in running prose to distinguish it from the project name. The distinction matters in writing because it signals to the reader whether they are reading about the project (Linuxify) or about the command they should type (`linuxify`). A sentence like "Linuxify ships v1.0 today; install it with `linuxify init`" uses both forms correctly. A sentence like "LinuxIfy is a great tool" is wrong on two counts: the camelCase is incorrect, and the absence of a monospace font on the command form makes it harder to skim.

The capitalization rules are stricter than they sound because the wrong form actively breaks readability. **Never** write "LinuxIfy," "linuxIfy," "LinuxiFy," or any other camelCase variant. **Never** write "LINUXIFY" in running prose — all-caps reads as shouting and is reserved for code, log output, and the wordmark component of the logo (see §4). In terminal output and log lines, `LINUXIFY_*` environment variables are the one legitimate all-caps use, because environment variable convention is uppercase. In filenames and URLs, use lowercase `linuxify` (e.g., `linuxify.sh`, `~/.linuxify/`, `packages/cline.yml`). In human-readable prose, use `Linuxify`. The convention is identical to the one `npm` uses: the package is `npm`, the project is sometimes "npm" and sometimes "npm, Inc." — we just lean harder on capitalization because we do not have a company.

Pluralization is a special case worth calling out. **Linuxify is both singular and plural.** You say "I installed Linuxify" (one installation, one project), and you also say "There are three Linuxify installs on this network" (multiple installations). Never write "Linuxifies" as a plural or a verb. If you need a verb form, use the lowercase CLI command: "I linuxified my phone" is acceptable informally; "I ran `linuxify init` on my phone" is preferred formally. This rule mirrors how we treat `git` ("I made three git commits," never "three gits") and `npm` ("I ran npm install three times," never "three npms"). The word is already verb-shaped; do not multiply it.

When the name appears at the start of a sentence, capitalize as normal: "Linuxify is open source." When it appears after a colon or em-dash, the same rule applies. When it appears in a code comment, use the lowercase command form if you are referring to the binary, and the capitalized project form if you are referring to the project. When in doubt, ask: "Am I talking about the project or the command?" Project → Linuxify. Command → `linuxify`. This rule is also enforced by the linter we run over the docs (see [Contribution Guidelines](../16-community/contribution-guidelines.md)); a PR that gets it wrong will fail CI and need amendment before merge.

---

## 3. Taglines

Linuxify has three approved taglines. Use one of them; **never mix them** in a single artifact, and never invent a fourth without sign-off from a maintainer. Mixing taglines fragments brand recognition — readers should see the same phrase in the homepage hero, the GitHub README, the Twitter bio, and the conference slide. The three taglines serve different spatial constraints, but they all carry the same underlying claim: desktop developer tools, delivered to Android, with the friction removed.

1. **"Run Linux developer tools on Android."** — Primary tagline. Use this in the homepage hero, the GitHub repo description, the README first paragraph, the press kit, and any artifact with room for a full sentence. It is the most literal statement of what the project does, and it is the only tagline that contains the words "Linux," "developer tools," and "Android" in one breath. Search engines, support agents, and developers skimming a directory all benefit from this literalism. If you can use only one tagline anywhere, use this one.
2. **"Desktop developer tools. Android simplicity."** — Alternative tagline, for contexts where a two-clause structure reads better than a single sentence. Use in conference talk titles, podcast show notes, and the second line of a print ad. It contrasts the heavyweight origin ("desktop developer tools") with the lightweight delivery ("Android simplicity"), which is the entire product thesis in six words. Avoid this tagline on Twitter bios and other character-limited surfaces where the period between clauses eats into the budget without adding clarity.
3. **"Linux CLIs. Zero hassle."** — Tertiary tagline, for short spaces. Use in the footer of email signatures, in social cards where horizontal space is at a premium, and as a secondary line under the primary tagline in large-format posters. It is the punchiest of the three but also the least self-explanatory: "zero hassle" only makes sense if the reader already knows what hassle is being removed. Reserve this tagline for audiences who already know what Linuxify is.

When choosing a tagline, match the surface to the audience. New visitors need the primary tagline. Existing developers who already know the project can take the tertiary. The alternative tagline works best in editorial contexts (talks, podcasts, articles) where the rhythm of two short clauses is more important than information density. Whatever you pick, set it in the project's sans face (Inter, see §6), at the same size as a subhead or large body text, and never abbreviate it. "Run Linux dev tools on Android." is not an approved tagline; the apostrophe-free "developer tools" is the canonical phrasing. The same applies to the other two — copy them verbatim.

---

## 4. Logo

The Linuxify logo is built around a single concept: a stylized terminal prompt (`$`) that morphs into a penguin silhouette. The metaphor is direct — `linuxify` is a command you type at a prompt, and the result is Linux (the penguin, Tux) appearing on your device. The logo is constructed from two geometric primitives: a 7-segment-style `$` glyph (the prompt) and a beak-and-body silhouette derived from Tux's classic outline, with the prompt's lower curve doubling as the penguin's belly. The mark is intentionally legible at 16 pixels because that is roughly the size at which it appears in a browser tab favicon and in a Discord profile picture.

**Primary logo (full lockup).** The full lockup combines the icon and the wordmark "Linuxify" set in Inter 800, with optical kerning tightened by 1.5%. The icon sits to the left of the wordmark, vertically centered, with a gap equal to 50% of the icon's width. The wordmark's baseline is the visual baseline of the lockup. The full lockup is the default for any horizontal surface wider than 200px: website headers, README banners, presentation title slides, business cards (when those exist), and the open-graph preview image. It exists in four variants — full color on light, full color on dark, mono on light, mono on dark — and the choice is dictated by the background (see §5 for color rules). The minimum size for the full lockup is **120px wide**; below that, switch to the icon-only variant.

**Icon only.** A square crop of the icon, with internal padding equal to 12.5% of the canvas on all sides. Use this variant for favicons (16px, 32px, 48px), app icons (192px, 512px for PWA manifest), social profile pictures (Discord, Twitter, GitHub org avatar), and any context where the wordmark would be illegible. The minimum size for the icon is **24px**; below 24px the penguin silhouette starts to lose its silhouette and the mark reads as an abstract glyph. The icon's safe area (the inner 75% of the canvas) must contain the entire mark; the outer 12.5% is margin only. When the icon appears in a circular container (e.g., GitHub org avatar), the mark should be scaled so the icon's bounding box touches 70% of the circle's diameter.

**Wordmark only.** "Linuxify" set in Inter 800, no icon. Use on header strips where the icon is already present elsewhere on the page (e.g., a sticky header where the favicon has done the brand work), on dense text surfaces like email signatures, and on the spine of print materials. The wordmark may be set in any of the four color treatments (full color, mono, inverted light, inverted dark) but should always be at the same visual weight as the full lockup's wordmark. Do not re-typeset the wordmark in a different font. Do not substitute "Linuxify" set in a heading style for the wordmark; the wordmark has specific optical adjustments that a heading style does not.

**Mono version.** A single-color silhouette of the icon and wordmark, used in contexts where color is unavailable or undesirable: black-and-white print, embroidery, single-color vinyl, footers of legal documents. The mono version uses 100% black on light backgrounds or 100% white on dark backgrounds; no grays. The mono version is the same vector paths as the full-color version, with all fills flattened to a single color. Use the mono version when printing on a one-color press, when a third party refuses color assets, or when the surrounding design is already monochrome and a color logo would clash.

**Inverted version.** For dark backgrounds (`#0D0D1A` or darker — see §5). The icon's body fill becomes `#FAFAFA` (text light), the beak retains `#FFD93D` (highlight yellow), and the prompt's `$` glyph becomes `#16F0A0` (terminal green). The wordmark becomes `#FAFAFA`. The inverted version is not simply a hue-rotated full-color version; the green and yellow accents are preserved because they carry the "terminal" association that is the entire point of the mark. The inverted version is the default for dark-mode UI surfaces, dark conference slide decks, and printed materials on dark stock.

**Clear space.** The clear space around the logo — the area into which no other graphic element may intrude — is **1× the icon's height** on all four sides. For the full lockup, "the icon's height" is the height of the square icon component, not the height of the wordmark. This clear space is non-negotiable; it is what allows the mark to breathe in dense layouts and what prevents it from being visually absorbed into adjacent content. The clear space may be filled with background color but never with text, imagery, or other logos.

**Don'ts.** Do not stretch or compress the logo horizontally or vertically. Do not recolor the logo outside the four approved variants. Do not add drop shadows, glows, gradients, or bevels. Do not rotate the logo. Do not place the full-color logo on a busy photographic background (use the mono or inverted version with a solid-color overlay instead). Do not use the logo as a button (see §14). Do not add a stroke or outline to the logo. Do not typeset the wordmark in a different typeface. Do not animate the logo except for the one approved entrance animation (a 200ms fade-in of the icon followed by a 150ms wipe-in of the wordmark, used only on the homepage hero).

---

## 5. Color Palette

Linuxify's palette is deliberately small. Six colors cover every brand surface, and the relationships between them are fixed: one primary, three accents, two backgrounds, two text colors (which are derived from the backgrounds). The palette is designed to render correctly on a developer's terminal, in a browser, on a phone screen in bright sunlight, and on a conference stage projector. Each color below is given in **hex**, **RGB**, **HSL**, and a **Tailwind CSS token** so that designers, frontend engineers, and AI coding agents generating UI can all consume the same values without conversion errors. The Tailwind tokens are the canonical names used in the Linuxify website and documentation theme; if you are building a UI for the project, import these tokens rather than re-defining hex values inline.

### Primary

| Token | Hex | RGB | HSL | Tailwind |
|-------|-----|-----|-----|----------|
| Primary (deep space) | `#1A1A2E` | `rgb(26, 26, 46)` | `hsl(240, 27%, 14%)` | `linuxify-space` |

The primary color is a near-black navy. It is the color of a developer's terminal at midnight, the color of `git`'s default UI chrome, and the color that lets the accent green pop. Use it for: dark-mode backgrounds (when not using the even darker `#0D0D1A`), the wordmark in the full-color logo, primary buttons in dark mode, and the footer of the website. Never use it for large areas of light-mode UI; it is too heavy and will read as a black hole on a white page. In code, reference it as `linuxify-space` (Tailwind) or `var(--lf-space)` (CSS custom property).

### Accents

| Token | Hex | RGB | HSL | Tailwind |
|-------|-----|-----|-----|----------|
| Accent 1 (terminal green) | `#16F0A0` | `rgb(22, 240, 160)` | `hsl(158, 87%, 51%)` | `linuxify-green` |
| Accent 2 (alert red) | `#FF6B6B` | `rgb(255, 107, 107)` | `hsl(0, 100%, 71%)` | `linuxify-red` |
| Accent 3 (highlight yellow) | `#FFD93D` | `rgb(255, 217, 61)` | `hsl(48, 100%, 62%)` | `linuxify-yellow` |

Terminal green is the brand's signature color. It is the green of a successful `git commit`, the green of `✓` in the doctor output, and the green of the `$` prompt in the logo. It carries the entire emotional payload of the brand — "this worked" — in a single hex value. Use it for: primary CTAs in light mode, success states, the icon's prompt glyph, links in dark mode, and the underline of the active nav item. Do not use it for error states (use red) or warning states (use yellow). Do not use it for large background areas; at full saturation it is fatiguing.

Alert red is reserved for errors, destructive actions, and doctor `fail` states. It is a warm, slightly desaturated red — not fire-engine red — so that it reads as "something needs attention" rather than "the building is on fire." Use it for: danger buttons, error alert backgrounds at low opacity (8–12%), the `✖` glyph in doctor output, and validation errors in forms. Never use it for primary CTAs, never use it for decorative purposes, and never pair it with terminal green at small sizes (the two are visually dissonant side by side and can cause vibration artifacts).

Highlight yellow is the rarest accent. Use it for: the penguin's beak in the logo, the `warn` state in doctor output, highlight backgrounds in marketing illustrations, and the `badge` component when calling out "new" or "beta" features. It is too saturated for body text and too bright for large background areas; reserve it for small marks where it adds a touch of warmth without overwhelming. In dark mode, yellow on the dark background achieves a Vercel/Linear-style "single accent on dark" look that is the basis of the illustration style (see §8).

### Backgrounds

| Token | Hex | RGB | HSL | Tailwind |
|-------|-----|-----|-----|----------|
| Background light | `#FAFAFA` | `rgb(250, 250, 250)` | `hsl(0, 0%, 98%)` | `linuxify-bg-light` |
| Background dark | `#0D0D1A` | `rgb(13, 13, 26)` | `hsl(240, 33%, 8%)` | `linuxify-bg-dark` |

The two backgrounds are intentionally not pure white and pure black. `#FAFAFA` is a hair off pure white so that white cards on the background have a visible edge without needing a border. `#0D0D1A` is a hair off pure black so that the foreground text (`#FAFAFA`) does not buzz against the background at high contrast. Use the light background as the default for documentation pages, the packages list, and form inputs. Use the dark background for the homepage hero, code blocks, the docs landing hero, and the entire dark-mode theme. The two backgrounds are the only colors permitted as page-level fills.

### Text

| Token | Hex | RGB | HSL | Tailwind |
|-------|-----|-----|-----|----------|
| Text on light | `#1A1A2E` | `rgb(26, 26, 46)` | `hsl(240, 27%, 14%)` | `linuxify-text-light` |
| Text on dark | `#FAFAFA` | `rgb(250, 250, 250)` | `hsl(0, 0%, 98%)` | `linuxify-text-dark` |

Text colors are derived from the palette: text on light backgrounds is the same as the primary color (`#1A1A2E`), and text on dark backgrounds is the same as the light background (`#FAFAFA`). This symmetry is intentional — the two text colors are the two extremes of the palette, and reusing them as text reinforces the palette's economy. Secondary text (captions, metadata, helper text) uses these colors at 60% opacity. Tertiary text (placeholder, disabled) uses them at 40% opacity. Never introduce a separate "gray" for secondary text; the opacity rules are the entire system.

### Color contrast

All four primary text/background combinations (dark text on light bg, light text on dark bg, terminal green on dark bg, terminal green on light bg) pass WCAG AA at all relevant sizes. Terminal green on the dark background passes AAA for large text and AA for body text. Alert red on the dark background passes AA for large text only; for body-text warnings, use yellow on dark or red on light. These contrast values are checked by an automated test in the website repo; if you change a color, run the test.

---

## 6. Typography

The Linuxify type system uses two typeface families: **Inter** for headings and body text, and **JetBrains Mono** for code, command examples, and the wordmark-adjacent numerals in the doctor output. Both are open-source, both are available on Google Fonts, and both have a permissive license that allows bundling in the project's website, docs, and downloadable assets. The system is intentionally restricted to two families because a third family adds cognitive load without adding meaning: every switch between sans and mono in a Linuxify artifact should signal "this is a command or code," and nothing else.

**Headings.** Set in Inter, weights 700 (bold), 800 (extra-bold), and 900 (black). Use 700 for section subheadings (h3, h4), 800 for page titles and major section headings (h1, h2), and 900 only for the homepage hero headline and the docs-landing hero. Inter's geometric, slightly condensed forms read well at large sizes and remain legible at small sizes; the higher weights carry enough presence to anchor a page without needing all-caps treatment. Never set headings in all-caps; the only all-caps type in Linuxify artifacts is in the logo wordmark and in environment-variable names in code blocks. Heading line-height is **1.2**; heading letter-spacing is `-0.02em` at h1 and h2, `-0.01em` at h3 and h4, and `0` at h5 and h6.

**Body.** Set in Inter, weights 400 (regular) and 500 (medium). Use 400 for running prose, 500 for emphasis within body text and for table headers. Body line-height is **1.5** for paragraphs; this is generous enough to allow the eye to track lines on a phone screen but tight enough to keep paragraphs feeling dense. Body letter-spacing is `0`. Body text minimum size on the web is 16px; never go below 14px for any text a user is expected to read. Long-form docs use 18px body for readability on mobile.

**Code and mono.** Set in JetBrains Mono, weights 400 (regular), 500 (medium), and 700 (bold). Use 400 for code blocks and inline code, 500 for emphasis within code blocks (e.g., the changed line in a diff), and 700 for command outputs that should read as "this is what the tool said." JetBrains Mono was chosen over SF Mono and Fira Code because it has a clearer distinction between `1`, `l`, and `I` (a critical property for command-line transcripts), because its ligatures are optional and off by default (we keep them off — ligatures in command output are confusing), and because it is open-source and bundleable. Code line-height is **1.5** to match body, ensuring code blocks and prose align on the same baseline grid.

**Fallbacks.** For headings and body: `Inter, "SF Pro Display", Roboto, system-ui, -apple-system, "Segoe UI", sans-serif`. For code: `"JetBrains Mono", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace`. The fallback chain prioritizes the system font on each platform so that the page renders instantly with a reasonable typeface even before web fonts load, then upgrades to Inter or JetBrains Mono once the web font is available. The website uses `font-display: swap` to make this upgrade invisible.

**Type scale.** The Linuxify type scale is a fixed 10-step modular scale, with each step defined in pixels and converted to `rem` in CSS (1rem = 16px). The scale is deliberately not a strict modular ratio (like 1.25 or 1.333); it is a hand-tuned set of sizes that work together across the website, the docs, and the CLI's terminal output.

| Step | Pixels | rem | Use |
|------|--------|-----|-----|
| 1 | 12px | 0.75rem | Captions, metadata, table sub-text |
| 2 | 14px | 0.875rem | Small body, table cells, badges |
| 3 | 16px | 1rem | Body, default |
| 4 | 18px | 1.125rem | Long-form body, lead paragraph |
| 5 | 20px | 1.25rem | Large body, small subhead |
| 6 | 24px | 1.5rem | h4, card titles |
| 7 | 32px | 2rem | h3, section subhead |
| 8 | 40px | 2.5rem | h2, page section |
| 9 | 56px | 3.5rem | h1, page title |
| 10 | 72px | 4.5rem | Hero headline |

The scale is exposed as CSS custom properties (`--lf-text-1` through `--lf-text-10`) and as Tailwind tokens (`text-12` through `text-72`). Use these tokens rather than raw values; the tokens are what the design system's automated tests check, and using them is what allows future type-scale refinements to propagate without manual find-and-replace.

---

## 7. Iconography

The Linuxify icon set is custom-drawn, not borrowed from an existing library. It exists in two sizes — **24px** and **16px** — and follows a single visual language: outline style, 2px stroke at 24px (scaled to 1.33px at 16px), rounded line joints, rounded line caps, and no fills. The reason for an outline-first language is that outline icons scale more cleanly to small sizes than filled icons, and small sizes are exactly where Linuxify icons live: in nav bars, in cards, in the doctor output, in feature bullets. A filled icon at 16px becomes a smudge; an outline icon at 16px stays legible. The 2px stroke weight matches the stroke weight of the logo's `$` glyph, creating visual continuity between the brand mark and the icon set.

The set covers eight concepts, each of which maps to a Linuxify subsystem or to a domain the docs need to illustrate:

1. **Terminal** — A rectangle with a `>` prompt inside. Used for any reference to the shell, to Termux, or to the `linuxify shell` command. The prompt's angle bracket is angled at 45°, matching the angle of the `$` glyph in the logo, so the icon and the logo share a visual rhyme.
2. **Package** — A cardboard-box outline with a horizontal divider line and a vertical tape line on top. Used for `packages/*.yml`, for the registry, and for `linuxify add`/`remove`. The box is drawn in isometric perspective (one-point, from the front-top-right) so that it reads as a physical object, not as a UI panel.
3. **Distro** — A family of four sub-icons, one per supported distro: Ubuntu (circle of dots), Debian (spiral), Arch (triangle), Alpine (summit). These are simplified, geometric interpretations of the official distro logos, recolored in Linuxify's terminal green so that they read as Linuxify-branded variants rather than the upstream marks. Used in the compatibility matrix, in package cards, and in the distro-switcher UI.
4. **Doctor** — A stethoscope outline. The chest-piece is a small circle at the bottom-left, the tubing curves up and to the right, and the earpieces form a small fork at the top-right. Used for `linuxify doctor`, the diagnostics subsystem, and any health-check concept.
5. **Patch** — A bandaid outline, tilted 45°, with three small dots on each pad. Used for `linuxify patch`, the patcher subsystem, and any reference to source-code modifications. The bandaid's tilt matches the terminal prompt's angle, again for visual rhyme.
6. **Launcher** — A rocket outline, pointing up-right at 45°. The rocket has two fins, a circular window, and a single flame trail. Used for `linuxify run`, the launcher subsystem, and any reference to executing a tool. The 45° angle is the same as the bandaid's tilt and the prompt's bracket — these three icons form a coherent visual cluster.
7. **Settings** — A gear outline with eight teeth, a circular hub, and a small dot at the center. Used for `linuxify config`, settings pages, and any reference to configuration. The gear is drawn with straight-cut teeth (not involute), matching the geometric, non-organic style of the rest of the set.
8. **Search** — A circle with a 45° line extending to the bottom-right. Used for `linuxify search`, the search bar on the packages page, and any reference to lookup. The handle's angle matches the rocket's and bandaid's, completing the 45° motif.

Each icon is delivered as an SVG with `stroke="currentColor"`, so the icon inherits the surrounding text color. To recolor an icon, set `color` on the parent element. The 24px set is the default; use the 16px set only when 24px would not fit (e.g., in dense tables, in badges, inline with body text). Never scale an icon below 16px; below that, the 2px stroke becomes 1.33px and starts to disappear on retina displays. The set is available as individual SVG files in the brand assets repo (see §13) and as a React component library (`@linuxify/icons`) for the website.

---

## 8. Illustration Style

Linuxify illustrations are minimal, geometric, and built around a single accent color on a dark background. The reference points are Vercel's product illustrations, Linear's marketing art, and Stripe's older (pre-2022) work — all of which share a discipline of using one bold color, one neutral background, and just enough geometry to suggest an idea without narrating it. A Linuxify illustration should be interpretable in under two seconds: the viewer should know what it is about before reading the surrounding copy. If an illustration requires a caption to be understood, it has failed.

The visual grammar is constrained: solid fills (no gradients), 2px strokes at large sizes (matching the icon set), and a maximum of three colors per illustration — the dark background, the accent green, and one of yellow or red for a secondary highlight. There are no people drawn in realistic style; if a human figure is needed, it is a simple geometric silhouette (a circle for a head, a rounded rectangle for a body) in the accent color. There are no photographic textures, no drop shadows except for a single hard-edged offset shadow in the accent color (used sparingly, for emphasis), and no perspective lines. The illustrations exist in 2D space.

Three anchor illustrations are commissioned for the launch and establish the style for everything that follows. These three are described here so that any future illustrator (human or AI) can match the established look:

1. **"Phone with terminal open showing Linuxify install."** A phone rendered as a simple rounded rectangle, held vertically. The phone's screen is a darker rectangle inside, taking up 80% of the phone's body. On the screen, three lines of mono text are rendered in the accent green: `$ pkg install linuxify`, `$ linuxify init`, `$ linuxify add cline`. The last line has a small green `✓` to its right. The phone is set against the dark background; no other elements are present. The illustration is used on the homepage hero, immediately to the right of the headline, and is the visual anchor of the entire marketing site.

2. **"Penguin gliding over a proot layer."** A simple Tux-derived penguin silhouette, in the accent green, gliding from left to right across the frame. Below the penguin is a thin horizontal line representing the proot layer, drawn in the highlight yellow. Above the penguin are three short horizontal lines (representing the Termux shell), drawn in the background's text color at 40% opacity. The penguin's body is tilted slightly forward, suggesting motion. The illustration is used on the "How it works" section of the homepage and on the docs landing page.

3. **"Doctor character examining a terminal."** A geometric human silhouette (circle head, rounded-rectangle body) wearing a stethoscope, leaning over a terminal that is rendered as a larger rounded rectangle with three lines of mono text. The stethoscope's chest-piece touches the terminal, suggesting diagnosis. The human silhouette is in the accent green, the stethoscope is in the highlight yellow, and the terminal's text is in the background's text color. The illustration is used on the doctor documentation page and on the "Doctor & auto-repair" feature card.

Future illustrations should follow the same recipe: one concept, one accent color, one dark background, no more than three colors total, and a clear subject that reads in under two seconds. When in doubt, simplify. An illustration that is too busy to read at a glance is worse than no illustration at all. When commissioning new illustrations, open an issue in the brand repo with a one-sentence description of the concept, the destination page, and a sketch (hand-drawn is fine); a maintainer will review and either approve or suggest revisions before work begins.

---

## 9. Voice & Tone

Voice is the personality that stays constant across everything Linuxify says. Tone is the modulation of that voice for a specific context. Linuxify's voice is **confident, direct, technical, and slightly playful**. We know what we are talking about, we say it without hedging, we assume the reader is technical, and we are not above a small joke when the moment calls for one. We are never corporate — no "leverage," no "synergy," no "unlock," no "empower." We are never condescending — no "simply," no "just," no "obviously," no "of course." A reader who is encountering Linuxify for the first time should feel respected, not marketed to.

The voice is constant; the tone shifts by context. **In documentation**, the tone is precise and exhaustive. Docs are where a reader comes to learn exactly how something works, and they should leave with no unanswered questions. Long sentences are acceptable when they carry necessary qualification ("`linuxify add` is idempotent, which means that running it twice produces the same result as running it once and does not corrupt state"). Code blocks are used liberally, because a working example is worth a paragraph of prose. Cross-references to other docs are expected, not optional. The docs are not the place to be witty; save the wit for the marketing surfaces.

**In marketing**, the tone is punchy and benefit-led. The homepage hero has nine words of headline and twenty words of subhead; that is the entire pitch, and every word has to earn its place. Benefit-led means leading with what the user gets ("Run Linux developer tools on Android") rather than what the project is ("Linuxify is a compatibility layer for…"). Marketing copy is allowed to be playful — the 404 page's "Looks like this package isn't in the registry" is a marketing-tone joke, not a docs-tone joke — but the playfulness should always be in service of the benefit, not in service of the writer's ego. If a joke does not help the reader understand the product, cut it.

**In error messages**, the tone is empathetic and actionable. Empathetic means acknowledging that the user is frustrated ("Couldn't install cline — here's what went wrong"). Actionable means telling the user what to do next, concretely ("Run `linuxify doctor` to diagnose, or `linuxify repair` to attempt a fix"). Never blame the user ("You entered an invalid command" → instead: "Unknown subcommand `ad`. Did you mean `add`?"). Never expose internal jargon without explanation ("ENOENT" → instead: "File not found: /data/data/com.termux/files/usr/bin/node. Run `linuxify repair` to reinstall the Node runtime."). The doctor output is the model here: every `✖` line is paired with a remediation hint, and the closing line tells the user the exact next command to run.

**In social media**, the tone is witty and welcomes technical in-jokes. Twitter and Discord are where the Linuxify community hangs out, and the brand voice there can be looser than in the docs. Technical in-jokes ("`process.platform === 'android'` is the new `process.platform === 'darwin'`") are welcome, provided they are inclusive — the joke should land for someone who has been doing this for two years and for someone who has been doing it for two weeks. Self-deprecation about the project's own rough edges is fine; condescension toward users, contributors, or other tools is not. The social tone is the closest to "person at a meetup, not brand on a billboard."

---

## 10. Writing Style

Linuxify writing follows a fixed set of mechanical rules. These rules apply to docs, marketing copy, error messages, social posts, and commit messages alike. They are enforced by a linter on the docs repo and by manual review on everything else; getting them right in the first place saves a round-trip.

**Active voice.** "Linuxify installs the package" — not "The package is installed by Linuxify." Active voice is shorter, clearer, and assigns responsibility, which is critical in a tool that runs other people's code. The passive voice is permitted only when the agent is genuinely unknown or irrelevant ("the package was deprecated by upstream" — we often do not know who exactly deprecated it) and even then, prefer "upstream deprecated the package."

**Short sentences for impact, longer for explanation.** Vary sentence length deliberately. A short sentence — six to twelve words — anchors a point. "Linuxify is idempotent." A longer sentence — twenty to forty words — develops a qualification. "Running `linuxify add cline` twice produces the same result as running it once, and does not corrupt state, because each install step checks whether its target already exists before executing." A paragraph of all-short sentences reads as choppy and aggressive; a paragraph of all-long sentences reads as academic and exhausting. Mix them on purpose.

**Code blocks liberally.** Any reference to a command, a file path, a config key, an environment variable, or a chunk of source code goes in a code block. Inline code uses single backticks; multi-line code uses fenced blocks with a language hint (` ```bash `, ` ```yaml `, ` ```ts `). When showing a shell transcript, include the prompt (`$`) so the reader knows what they type versus what the tool prints. When showing a diff, use the `diff` language hint so the syntax highlighter renders `+` and `-` lines correctly.

**No fluff.** "In order to" → "To." "At this point in time" → "Now." "It should be noted that" → (delete the entire phrase, the sentence is stronger without it). "Utilize" → "Use." "Leverage" → "Use." The fluff linter catches these; so should the writer's ear. If a phrase can be deleted without changing the meaning, delete it.

**Oxford comma.** "Install Cline, Codex, and Aider." Not "Install Cline, Codex and Aider." The Oxford comma resolves genuine ambiguity ("I thank my parents, Ayn Rand and God") and is the project's house style.

**American English spelling.** "Color," not "colour." "Behavior," not "behaviour." "Catalog," not "catalogue." "Canceled," not "cancelled." The exception is words that are technical terms with established international spelling (e.g., "metadata" is the same everywhere); these follow the technical convention, not the regional one. A PR that mixes American and British spelling will fail the prose linter.

**Headings.** Sentence case, not title case. "Run Linux developer tools on Android" — not "Run Linux Developer Tools On Android." Sentence case is easier to read, easier to write consistently, and matches the convention of the major developer-tool docs (Git, npm, Cargo, Homebrew). The only all-caps words in headings are acronyms (CLI, API, SDK, YAML) and the project name when used as a project name (Linuxify), never the command (`linuxify` is set in inline code in headings, same as in body).

---

## 11. UI Components

The Linuxify UI component library is small, opinionated, and exists to keep the website, the docs site, and any future admin UI visually consistent. Every component below is specified with its usage guideline and its visual spec; the visual specs are the source of truth, and the React implementations in `@linuxify/ui` are tested against them. The component radius is **6px** across the board — sharp enough to read as "developer tool," soft enough to not feel brutalist. The component padding follows a 4px grid (4, 8, 12, 16, 24, 32). The component border is `1px solid` at 10% opacity of the surrounding text color.

**Button.** Four variants. **Primary**: background `linuxify-green`, text `linuxify-bg-dark`, no border, font-weight 500, padding 12px 20px, radius 6px. Used for the main action on a page (one per page, ideally). **Secondary**: transparent background, border `1px solid linuxify-space` (or `linuxify-text-dark` on dark mode), text `linuxify-space`, padding 12px 20px, radius 6px. Used for the secondary action (e.g., "View on GitHub" next to a primary "Get Started"). **Ghost**: transparent background, no border, text `linuxify-space` at 80% opacity, padding 8px 12px. Used for tertiary actions (filter buttons, nav links). **Danger**: background `linuxify-red`, text `linuxify-bg-light`, padding 12px 20px, radius 6px. Used for destructive actions ("Uninstall", "Delete account"). All buttons have a `:hover` state that darkens the background by 10% and a `:focus-visible` state that adds a 2px outline in `linuxify-green` offset 2px from the button edge.

**Input.** Single-line text input. Background `linuxify-bg-light`, border `1px solid linuxify-space` at 15% opacity, text `linuxify-text-light`, padding 10px 14px, radius 6px, font-size 16px (to prevent iOS zoom on focus). Placeholder text uses `linuxify-text-light` at 40% opacity. Focus state replaces the border with `1px solid linuxify-green` and adds a 3px box-shadow at 20% opacity of `linuxify-green`. Error state replaces the border with `linuxify-red` and shows an error message below the input in `linuxify-red` at 14px.

**Modal.** Overlay: `linuxify-bg-dark` at 60% opacity. Modal panel: background `linuxify-bg-light`, radius 8px (slightly larger than other components, to read as a "container"), max-width 480px, padding 32px, box-shadow `0 16px 48px rgba(13, 13, 26, 0.32)`. Close button (X) in the top-right, ghost variant, 24px hit target. Title in Inter 700 at 24px, body in Inter 400 at 16px, action buttons in a row at the bottom-right.

**Card.** Background `linuxify-bg-light`, border `1px solid linuxify-space` at 10% opacity, radius 6px, padding 24px. On dark backgrounds, the card uses `linuxify-bg-dark` with border `1px solid linuxify-text-dark` at 10% opacity. Card title in Inter 700 at 20px, card body in Inter 400 at 16px. Used for feature cards on the homepage, package cards on the packages page, and docs-section cards on the docs landing.

**Badge.** Inline element, background `linuxify-yellow` at 20% opacity, text `linuxify-space`, padding 2px 8px, radius 4px, font-size 12px, font-weight 500. Used to call out "new", "beta", "v1.1", or a distro name on a package card. Variant colors: green for "stable" / "✓", yellow for "beta" / "warn", red for "deprecated" / "fail".

**Alert.** Block element, full-width, padding 16px, radius 6px, border-left 4px solid. Four variants. **Info**: background `linuxify-green` at 8% opacity, border-left `linuxify-green`. **Success**: same as info (we do not differentiate visually between info and success, only by icon). **Warning**: background `linuxify-yellow` at 12% opacity, border-left `linuxify-yellow`. **Error**: background `linuxify-red` at 10% opacity, border-left `linuxify-red`. Each alert has an icon (24px, matching the icon set) to the left of the message, and the message in Inter 500 at 16px. Optional title in Inter 700 at 16px above the message.

**Table.** Header row: background `linuxify-space` at 5% opacity, text `linuxify-text-light` in Inter 500 at 14px, padding 12px 16px, text-align left. Body rows: background `linuxify-bg-light`, text `linuxify-text-light` at 16px, padding 12px 16px, border-bottom `1px solid linuxify-space` at 10% opacity. Hover state: background `linuxify-space` at 3% opacity. The compatibility matrix on the website uses this table with the addition of color-coded cells (green/yellow/red at 20% opacity) for compat status.

**Code block.** Background `linuxify-bg-dark`, text `linuxify-text-dark`, padding 16px, radius 6px, font-family JetBrains Mono, font-size 14px, line-height 1.5. A copy button (ghost, 24px icon) appears in the top-right on hover. Language label (e.g., "bash", "yaml") appears in the top-left in `linuxify-text-dark` at 40% opacity, 12px. Inline code in body text uses the same background and font but at 14px with 2px 6px padding.

---

## 12. Photography

Linuxify uses photography sparingly. The default visual is an illustration or a screenshot — both of which the project controls fully and which match the brand's geometric, accent-on-dark aesthetic. Photography is harder to control: it brings in real-world lighting, real-world clutter, and real-world faces, all of which can clash with the brand if not art-directed carefully. The default policy is **avoid stock photography**. Stock photo sites are full of "developer at laptop" images that are posed, lit, and dressed in a way that reads as inauthentic to anyone who has actually been a developer. A Linuxify page with a stock photo of a smiling woman at a laptop is a Linuxify page that has lost the plot.

When photography is the right choice — and it sometimes is, particularly for blog posts about real users — the policy is to use **real developers using phones in real settings**. Not staged. Not lit. Not directed. A blurry photo of someone running `linuxify add cline` on a bus is better than a sharp photo of a model pretending to. The criteria for an acceptable photo: (a) the subject is a real Linuxify user or contributor; (b) the phone screen is visible and showing actual Linuxify output (not a mockup); (c) the setting is real (a desk, a café, a train) and not a set; (d) the lighting is whatever the setting provided, not added. Photos that meet these criteria have an authenticity that no stock photo can match, and they reinforce the brand's "by developers, for developers" positioning.

For blog posts and case studies, prefer screenshots over photos. A screenshot of `linuxify doctor` output on a real device, with the user's actual packages listed, is more useful to the reader than a photo of the device running the command. Screenshots also age better — a photo of a phone from 2026 looks dated in 2028, but a screenshot of terminal output is evergreen. When a screenshot is used, crop tightly to the relevant content (do not include the phone's status bar unless it is part of the story), use the dark-mode terminal theme so it matches the brand's dark aesthetic, and redact any API keys or personal tokens before publishing.

If photography is unavoidable — for example, a conference sponsor deck that demands a "people" image — use the brand's geometric illustration style instead of a photo. A simple silhouette illustration of a developer with a phone reads as "Linuxify" in a way that a stock photo never will. The illustration style is documented in §8 and the asset library is in §13; when in doubt, illustrate, do not photograph.

---

## 13. Brand Assets

All Linuxify brand assets are stored in the project repository under `brand/` and mirrored to a static asset host at `linuxify.sh/brand`. The canonical URL `linuxify.sh/brand` is the one to share externally; it redirects to a directory listing of the latest assets. The assets include: logo SVGs (full lockup, icon only, wordmark only, all four color variants, mono versions), the color palette as a JSON file and as Tailwind config, the icon set as individual SVGs and as a React component library, the type scale as CSS custom properties and as a Tailwind theme, the commissioned illustrations as SVGs, and the email and presentation templates.

The assets are versioned with the project. When the brand is updated (a color tweak, an icon addition, a new illustration), the version in `package.json` is bumped and a changelog entry is added. The `linuxify.sh/brand` URL always points to the latest version; older versions are available at `linuxify.sh/brand/v<version>/`. This versioning is important because downstream consumers — the website, the docs site, the GitHub README, third-party community sites — may pin to a specific version to avoid visual drift. We commit to never making a breaking change to an asset's filename or its core visual content without a major version bump.

**Licensing.** The brand assets are licensed under **CC BY-SA 4.0** for community use. This means anyone can use, remix, and redistribute the assets, provided they (a) attribute Linuxify (a link to `linuxify.sh/brand` is sufficient attribution) and (b) distribute derivative works under the same license. The CC BY-SA 4.0 license is chosen because it matches the open-source ethos of the project, because it is well-understood by the community, and because it prevents commercial appropriation of the brand without contributing back. The Linuxify name and the primary logo are additionally protected by a trademark policy (in `LEGAL.md` in the repo) that prevents their use in ways that imply endorsement of unrelated products.

**Commercial use.** For commercial use that falls outside CC BY-SA 4.0 — for example, a company wanting to print the Linuxify logo on merchandise for sale, or a conference wanting to use the logo in a sponsor deck without attribution — contact the maintainers at `brand@linuxify.sh`. We grant permission liberally for uses that support the community (conference slides, meetups, educational materials) and reserve it for uses that monetize the brand without giving back. The bar is not "are you making money" — many community members make money from Linuxify-related consulting and that is fine — the bar is "are you using the brand in a way that implies endorsement or that dilutes the mark."

**Contributing to the brand.** Brand changes are proposed via PR against this document and the `brand/` directory. Substantive changes (new color, new icon, logo modification) require sign-off from at least two maintainers and a 7-day comment period to allow the community to react. Minor changes (new illustration matching existing style, new icon for an existing concept) require only one maintainer sign-off. The bar for substantive changes is deliberately high: a brand that changes constantly is no brand at all. The bar for minor changes is low: an icon set that does not grow with the project is a dead icon set.

---

## 14. Brand Don'ts

The "don'ts" are short, absolute, and enforced. Each one exists because someone, at some point, will try it; the don'ts are pre-emptive answers. When a don't is violated in a community contribution, the contribution is rejected with a pointer to the relevant rule here. When a don't is violated by a maintainer, the maintainer amends the contribution. The don'ts apply to all brand assets: the logo, the wordmark, the colors, the type, the illustrations, and the voice.

**Don't use the logo as a button.** The logo is an identifier, not a call to action. A button labeled with the logo, or a button shaped like the logo, conflates "what is this" with "do this" and confuses the user. If you need a button that takes the user to the homepage, use a text button labeled "Home" or a small icon-only button with the icon set's "home" glyph, not the logo.

**Don't put the logo on a busy background.** The logo requires clear space (see §4) and a solid or near-solid background to read correctly. A photographic background, a gradient, or a pattern competes with the logo for attention and degrades its legibility. If the design absolutely requires the logo on a non-solid background, add a solid-color scrim (at least 80% opacity) behind the logo's clear space. The scrim's color should match the logo variant's intended background (light or dark).

**Don't change the colors.** The palette in §5 is the palette. Do not invent a fifth color, do not swap the accent green for a different green, do not "soften" the alert red to a coral. If a context seems to demand a color outside the palette (e.g., a third-party integration that requires its own brand color), use the third-party's color only for that third-party's element, and use the Linuxify palette for everything else. The Linuxify logo itself is always in the approved variants.

**Don't use the logo as a placeholder.** The logo is not a generic "developer tool" image. Do not use it in articles, slides, or videos about Linux-adjacent topics (Termux, proot, Android development in general) to illustrate those topics. Use a relevant screenshot or an icon from the icon set instead. Using the logo as a placeholder dilutes its meaning and implies Linuxify endorsement of the surrounding content.

**Don't imply endorsement.** The Linuxify logo on a third-party product, service, or article implies that Linuxify endorses that product, service, or article. It does not, unless a maintainer has explicitly said so in writing. Third parties may use the logo to indicate "this works with Linuxify" (e.g., a CLI tool whose package YAML is in the registry may display the Linuxify logo on its README with the caption "Available on Linuxify"), but they may not use the logo in a way that suggests Linuxify the project recommends or stands behind them. The trademark policy in `LEGAL.md` has the full rules.

**Don't recolor the logo for theming.** If a website has a dark mode and a light mode, switch between the approved light and dark logo variants — do not create a custom-colored variant. If a third-party site (e.g., a sponsor deck with a specific brand color) requires the logo in a specific color, use the mono variant in that color, with prior maintainer approval. The full-color logo is only ever in the four approved variants.

**Don't animate the logo** except for the one approved entrance animation (200ms icon fade-in + 150ms wordmark wipe-in, homepage hero only). Spinning, pulsing, bouncing, or color-shifting the logo in any context is prohibited. A static mark is a confident mark; an animated mark is a toy.

---

## 15. Sub-brands

Linuxify has three named sub-brands, each covering a distinct surface of the project. The sub-brands are not separate products; they are recognizable subsystems within Linuxify, given names so that the docs, the website, and the community can refer to them unambiguously. Each sub-brand uses the main Linuxify logo with a small modifier icon to its right (or below, in vertical layouts), and the modifier is drawn from the icon set documented in §7. The sub-brand name is set in Inter 700, same size as the wordmark, immediately following the wordmark with a 12px gap. The result reads as "Linuxify Registry," "Linuxify Cloud," or "Linuxify Doctor" — a unified brand family, not three separate identities.

**Linuxify Registry.** The package registry — the (currently local, eventually remote) catalogue of `packages/*.yml` files and their metadata. The modifier icon is the "package" icon from the set. The Registry sub-brand is used on the packages page of the website, in the `linuxify search` command's output header, in the docs section [09-registry](../09-registry/registry-format.md), and on any communication about package submission or maintenance. The sub-brand does not have its own color; it uses the main palette. When the registry becomes a remote service (Phase 2, per the [vision](../00-executive/vision.md)), the sub-brand will gain a dedicated landing page at `linuxify.sh/registry`, but the visual treatment will remain the same.

**Linuxify Cloud.** The future cloud-sync capability — the (Phase 3, per the [vision](../00-executive/vision.md)) service that syncs a user's installed packages, configs, and doctor state across devices. The modifier icon is the "launcher" icon, repurposed to suggest "to the cloud." The Cloud sub-brand is used sparingly in v1 materials — primarily in the roadmap docs ([15-roadmap](../15-roadmap/release-roadmap.md)) and in the future-work docs ([19-future](../19-future/cloud-sync.md)) — because the feature does not yet exist. When the feature ships, the sub-brand will appear on a dedicated landing page and in the CLI's `linuxify cloud` subcommand output. Until then, do not use the Cloud sub-brand in user-facing marketing that implies the feature is available today.

**Linuxify Doctor.** The diagnostic subsystem — the doctor engine and check catalogue documented in [07-doctor](../07-doctor/doctor-engine.md). The modifier icon is the "doctor" icon (stethoscope) from the set. The Doctor sub-brand is used on the doctor docs pages, in the `linuxify doctor` command's output header, in the "Doctor & auto-repair" feature card on the homepage, and in error messages that reference the doctor as a next step ("Run `linuxify doctor` to diagnose"). The Doctor sub-brand is the most visible of the three in v1, because the doctor is the user's primary support interface.

Sub-brands are introduced and retired by maintainer decision, documented in this file, and announced in the changelog. The bar for adding a new sub-brand is high: the subsystem must be user-facing, must have a distinct name that does not collide with existing sub-brands, and must warrant its own modifier icon. Internal subsystems (the patcher, the launcher, the bootstrap) are not sub-brands; they are referenced in docs and in CLI output but do not carry a logo variant. If a future subsystem (e.g., a GUI wrapper, a cloud-hosted sandbox) becomes prominent enough, the maintainers may elevate it to sub-brand status by amending this section.
