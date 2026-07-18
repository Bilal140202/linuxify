# Frequently Asked Questions

> **Audience**: New users evaluating Linuxify, existing users hitting a snag, contributors figuring out how to engage, and AI coding agents that need a quick orientation. Questions are grouped by category; within each category, questions progress from common to niche. If your question is not here, check the [glossary](./glossary.md), the [troubleshooting guide](../22-operations/troubleshooting.md), or ask in [Discord `#support`](https://discord.gg/linuxify).

## General

### What is Linuxify?

Linuxify is an open-source developer toolkit that lets you run Linux-oriented developer CLIs — AI coding agents like Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, and Freebuff, plus conventional tools like `rg` and `jq` — directly on Android, by automatically setting up and managing a Ubuntu (or other distro) `proot` environment inside Termux. The pitch is one command: `pkg install linuxify && linuxify init && linuxify add cline`, after which `cline` works from your Termux shell exactly as it would on a Linux laptop. See the [README](../../README.md) and [executive summary](../00-executive/executive-summary.md).

### Who is Linuxify for?

Linuxify is for anyone who wants to run Linux developer tools on an Android phone or tablet without manually wrangling Termux, proot, Ubuntu, Node, PATH, and per-tool patches. The primary audience is developers who travel or who use an Android device as a secondary coding surface; the secondary audience is students and hobbyists whose only computer is an Android phone; the tertiary audience is open-source contributors to the AI tooling ecosystem who need to test their tools on Android. See the [personas in user-journeys](../04-ux/user-journeys.md) for concrete composite users.

### Is Linuxify free?

Yes. Linuxify is free both as in beer (no cost) and as in speech (open source). There is no paid tier, no freemium upsell, no "enterprise" edition. Future cloud features (sync, hosted registry) may have a paid tier for teams, but the core tool will always be free. See [vision](../00-executive/vision.md) §3 for the sustainability model.

### What's the license?

Linuxify is licensed under the **MIT License** — the same license as React, Vue, and most of the npm ecosystem. You can use it, modify it, distribute it, and incorporate it into proprietary software, provided you include the license notice. Package definitions in the registry are also MIT unless an individual package declares otherwise (some upstream CLIs have stricter licenses, which Linuxify respects). See the `LICENSE` file in the repo root.

### Who maintains Linuxify?

Linuxify is maintained by a core team of volunteer open-source contributors, listed in `MAINTAINERS.md` in the repo root. The project is governed by a rough consensus model: any maintainer can merge a PR that has one other maintainer's approval; security-sensitive changes require two approvals; project-wide decisions are documented as [ADRs](../20-adrs/README.md). The team coordinates in the Linuxify Discord and holds a monthly public office-hours call. See [contribution-guidelines](../16-community/contribution-guidelines.md).

### How is Linuxify different from Termux?

Termux is the foundation Linuxify runs on top of — it provides the terminal emulator, the bash shell, and the `pkg` package manager for Android-native (bionic-libc) binaries. Linuxify does not replace Termux; it extends it by installing a full glibc Linux distribution (Ubuntu, Debian, Arch, or Alpine) inside a proot within Termux, then managing developer CLIs that expect that glibc environment. Without Termux, Linuxify cannot run. Without Linuxify, running `cline` in Termux requires a long manual ritual of proot setup, Node installation, PATH fixing, and per-tool patching. See [executive-summary](../00-executive/executive-summary.md) §6.

### How is Linuxify different from proot-distro?

`proot-distro` is a Termux community tool that installs and manages Linux distros inside proot — it handles rootfs download, unpack, and `login`. Linuxify uses `proot-distro` under the hood (per [ADR-001](../20-adrs/adr-001-use-proot-over-chroot.md)) as its default distro backend. The difference is that `proot-distro` stops at "you have a distro; do whatever you want inside it," while Linuxify continues: it installs runtimes, installs CLI tools, patches them for Android compatibility, generates launchers, runs health checks, and provides repair. `proot-distro` is the engine; Linuxify is the car around it.

### How is Linuxify different from UserLAnd/Andronix?

UserLAnd and Andronix are Android apps that install a Linux distro via proot or chroot, with a GUI front-end and optional VNC for desktop use. They target users who want a Linux desktop on their phone. Linuxify targets the opposite: CLI-first developer tools, no GUI, no VNC, no desktop environment. Linuxify's value is in the developer-CLI ecosystem (package definitions, patches, doctor, launchers), not in the distro installation itself. If you want a desktop Linux on your phone, use UserLAnd; if you want `cline` and `codex` to just work in Termux, use Linuxify. See [executive-summary](../00-executive/executive-summary.md) §6.

### Can I use Linuxify on iPhone?

Not natively. iOS does not have a Termux equivalent — Apple's App Store policies prohibit the JIT compilation and untrusted-code execution that Linuxify relies on. There are workarounds (iSH, a x86 emulator for iOS; or SSH-ing from your iPhone to a remote Linux box), but Linuxify does not run on iOS and there are no plans to port it. The future [cloud-sync](../19-future/cloud-sync.md) feature will let iOS users keep their Linuxify manifest in sync with a remote Linux box, which is the closest equivalent.

### Can I use Linuxify on Chromebook?

Yes, if your Chromebook supports Android apps (most Chromebooks shipped since 2019 do). Install Termux from F-Droid (not the Play Store — the Play Store version is deprecated), then install Linuxify as usual. Chromebooks typically run on `x86_64` or `aarch64` Intel/AMD/ARM chips, both of which Linuxify supports. The experience is generally better than on a phone because Chromebooks have more RAM and a real keyboard. See [arm-considerations](../23-mobile/arm-considerations.md).

## Installation

### What are the prerequisites?

An Android device (phone, tablet, or Chromebook) running Android 9 or later, with at least 2 GB of free storage (Linuxify itself is ~50 MB, but a Ubuntu rootfs + Node + Python + a few CLIs adds up to ~1.5 GB). The F-Droid version of Termux installed (the Play Store version is deprecated and will fail). An internet connection for the initial bootstrap (after that, Linuxify works offline). See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §1.

### Does Linuxify need root?

No. Linuxify works entirely without root, using `proot` (a ptrace-based syscall translator) instead of `chroot`. This is a core design decision — see [ADR-001](../20-adrs/adr-001-use-proot-over-chroot.md) — because the vast majority of Android users do not have rooted devices and requiring root would shrink the addressable audience by ~99%. The trade-off is a small per-syscall performance overhead (10–40 ms), which is invisible in interactive CLI use.

### How much storage does it use?

A fresh `linuxify init` (Ubuntu 24.04 minimal + Node LTS + Python 3.12 + Git) uses ~1.2 GB. Each managed CLI adds 50–500 MB depending on the tool (Cline is ~80 MB, Aider with its Python deps is ~300 MB, OpenHands is ~500 MB). Snapshots (see [disaster-recovery](../22-operations/disaster-recovery.md)) add ~500 MB each. Run `linuxify doctor` to see current usage; run `linuxify gc` to reclaim space from old caches. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §6 for the storage budget.

### How long does install take?

A fresh `linuxify init` takes 3–8 minutes on a modern phone with a decent internet connection: ~1 minute to download the Ubuntu rootfs (~80 MB compressed), ~1 minute to unpack it, ~2 minutes to install Node and Python inside the proot, ~1 minute for the remaining stages. On a slow connection or a low-end phone, it can take 15–20 minutes. Re-running `linuxify init` is fast (~5 seconds) because it skips stages that already have `.done` markers. See [bootstrap-design](../05-bootstrap/bootstrap-design.md) §5 for the performance budget.

### Can I install Linuxify offline?

Partially. The initial `linuxify init` requires internet to download the Ubuntu rootfs and runtime packages. Once those are cached, subsequent `linuxify add <pkg>` calls work offline if the package's upstream artifacts are already cached. For fully air-gapped installs, you can pre-download the rootfs tarball and run `linuxify init --offline --bundle ./ubuntu-rootfs.tar.gz` — see [cli-specification](../03-cli/cli-specification.md) §4. The `--offline` flag is also available for `linuxify update` and `linuxify upgrade` to force offline mode.

### How do I uninstall Linuxify?

Run `linuxify uninstall` (or `linuxify reset --purge` for a more aggressive removal) to remove all packages, distros, runtimes, and state. Then `pkg uninstall linuxify` (Termux) or `npm uninstall -g linuxify` (npm). Finally, manually `rm -rf ~/.linuxify/` if anything remains. See [disaster-recovery](../22-operations/disaster-recovery.md) §5 for what is lost and what is preserved.

### Can I have multiple Linuxify installs?

Not on a single Termux installation. Linuxify uses the fixed home directory `~/.linuxify/` and there is no v1 mechanism for multiple homes. If you need isolation (e.g., a "work" profile and a "personal" profile), use the `--profile` flag and the `[profile.<name>]` blocks in `config.toml` — see [cli-specification](../03-cli/cli-specification.md) §7. If you genuinely need two completely separate installs, install a second Termux (Termux:FDroid and Termux:Play are different apps, though only F-Droid is supported).

### Linuxify refuses to install — says "Termux from Play Store not supported"

The Google Play Store version of Termux is deprecated, no longer receives updates, and lacks the permissions Linuxify needs (notably the ability to execute arbitrary binaries). Uninstall the Play Store Termux, install the F-Droid Termux (or the GitHub Release APK), and re-run. The check is in bootstrap Stage 0 (Preflight) and emits `E_BOOTSTRAP_FDROID_REQUIRED`. See [termux-internals](../23-mobile/termux-internals.md) §1.

## Packages

### How do I install a CLI tool?

`linuxify add <package-name>`. For example, `linuxify add cline` downloads the Cline package definition from the registry, runs its `install:` steps (typically `npm install -g cline` inside the proot), applies its `patches:` (rewriting `process.platform === 'linux'` checks to include `android`), generates a launcher shim at `$PREFIX/bin/cline`, and runs its `doctor:` checks to verify the install. After that, typing `cline` in your Termux shell works. See [cli-specification](../03-cli/cli-specification.md) §4.

### What tools are supported?

The v1 registry includes: Cline, Codex, Aider, Goose, Gemini CLI, OpenHands, Freebuff, plus conventional tools like `rg`, `jq`, `fzf`, `bat`, `delta`. The full list is at `linuxify search ''` or in the registry directory. New tools are added by community contribution — see [contribution-guidelines](../16-community/contribution-guidelines.md). Tools not in the registry can still be installed manually inside the proot, though you lose the patching and launcher benefits.

### How do I request a new tool?

Open a `package-request` issue on GitHub (use the issue template in `.github/ISSUE_TEMPLATE/package-request.yml`). Include the tool name, homepage, license, why you want it on Android, and (if you know) what Android-specific issues it likely has. A maintainer or contributor will pick it up, write the package definition, and submit a PR. If you want to write it yourself, even better — see "How do I add a new package to the registry?" below.

### Can I install tools not in the registry?

Yes, but you lose Linuxify's patching and launcher integration. You can `linuxify shell` to enter the proot Ubuntu and `npm install -g <whatever>` or `pip install <whatever>` manually. The tool will run inside the proot but may hit Android-specific issues (`process.platform === 'android'`, wrong arch, missing glibc symbols) that Linuxify's patches would have fixed. For tools you use regularly, contributing a package definition to the registry is the better path.

### How do I update a tool?

`linuxify upgrade <package>` upgrades a single package to the latest version in the registry. `linuxify upgrade` (no argument) upgrades all installed packages. `linuxify update` (without `upgrade`) only refreshes the local registry metadata — it does not change installed packages. Re-running `linuxify add <pkg>` is equivalent to `upgrade` for that package. Patches are re-applied automatically after upgrade. See [cli-specification](../03-cli/cli-specification.md) §4.

### How do I uninstall a tool?

`linuxify remove <package>`. This removes the launcher shim, runs the package's declared uninstall steps, deletes its state entry, and removes its patch backups (unless `--keep-config` is passed, which preserves user config files inside the distro like `~/.config/<tool>/`). Use `--purge` to also delete cached downloads. See [cli-specification](../03-cli/cli-specification.md) §4.

### The tool I installed fails with "Unsupported platform" — what now?

This means the tool's source code has a platform check that rejects `android` (typically `process.platform === 'linux'` returning false because `process.platform === 'android'` inside Termux, or `process.arch === 'x64'` returning false on aarch64). If you installed via `linuxify add`, the patcher should have handled this automatically — if it didn't, run `linuxify patch <pkg>` to re-apply patches, then `linuxify doctor` to verify. If the patch is missing entirely, the package definition needs a new patch entry — open an issue or contribute one. See [patcher-engine](../08-patcher/patcher-engine.md) §2 and [troubleshooting](../22-operations/troubleshooting.md) §3.

### Can I have different versions of the same tool?

Not in v1. Linuxify manages one version per package, installed globally inside the proot. If you need multiple versions (e.g., `cline@1.2` and `cline@1.3` side by side), the workaround is to install them in separate proot distros (e.g., `linuxify use ubuntu` for one, `linuxify use debian` for the other) and switch with `linuxify use`. Per-package version pinning across a single distro is on the v2 roadmap — see [package-spec](../09-registry/package-spec.md) §14.

## Distro

### Which distro should I use?

For most users: **Ubuntu 24.04** (the default). It has the broadest package availability, the most pre-built aarch64 binaries, and is what the maintainers test against most heavily. Choose **Alpine** if you want the smallest footprint (~80 MB vs ~600 MB) and fastest cold-starts, at the cost of musl-libc incompatibility with some pre-built binaries. Choose **Debian** if you want Ubuntu's ecosystem with a slower release cadence. Choose **Arch** if you want bleeding-edge package versions and are comfortable with occasional breakage. See [distro-management](../05-bootstrap/distro-management.md) §3.

### Can I switch distros later?

Yes — `linuxify use <distro>` switches the active distro. Your installed packages are per-distro (each distro has its own rootfs and its own installed CLIs), so switching distros means the tools you installed in the previous distro are not available until you switch back. Run `linuxify add <pkg>` again in the new distro to reinstall. The launchers in `$PREFIX/bin/` are regenerated to point at the new active distro. See [distro-management](../05-bootstrap/distro-management.md) §4.

### Can I have multiple distros installed?

Yes. Each distro lives in its own `~/.linuxify/distros/<name>/` directory and persists independently. Install with `linuxify use --create <distro>`, switch with `linuxify use <distro>`, list with `linuxify distros list`, remove with `linuxify distros uninstall <name>`. The storage cost is ~600 MB per Ubuntu-class distro, ~80 MB per Alpine. See [distro-management](../05-bootstrap/distro-management.md) §4.

### How do I add a custom distro?

For distros in the supported list (Ubuntu, Debian, Arch, Alpine), `linuxify use --create <name>`. For a truly custom distro (e.g., Fedora, Kali), you need a custom DistroProvider plugin — see [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) §10 for a worked Fedora example. The plugin implements the `DistroProvider` interface (install/uninstall/start/stop/exec/shell/info/update/snapshot/restore) and registers it via the plugin manifest. Custom distros are a power-user feature; the maintainer team does not commit to supporting arbitrary distros in v1.

### Alpine vs Ubuntu — which is faster?

Alpine is faster for cold-starts (smaller rootfs, fewer files to scan) and uses less RAM and storage. Ubuntu is faster for warm operations (more packages cached, glibc is faster than musl for some workloads) and has broader binary compatibility. For interactive CLI use (the Linuxify use case), the difference is usually 50–150 ms per `linuxify run` invocation — noticeable in benchmarks, barely perceptible in practice. If in doubt, start with Ubuntu; switch to Alpine if you measure a real bottleneck. See [user-journeys](../04-ux/user-journeys.md) Journey 4 (Devon) for a benchmarking narrative.

### Can I install desktop Linux (GNOME, KDE)?

Not via Linuxify. Linuxify is CLI-first and does not support GUI desktop environments. If you want a desktop Linux on your phone, use UserLAnd or Andronix (which provide VNC-based desktops). Linuxify's [non-goals](../../.agent-context.md) §10 explicitly exclude GUI toolkits. You can technically `apt install xorg` inside the proot and VNC to it, but Linuxify provides no support for this and the result will be janky.

## Doctor & Repair

### What does `linuxify doctor` check?

Doctor runs a catalog of ~30 health checks across 9 categories: host (Termux version, Android version, arch), bootstrap (stage markers, integrity), distro (rootfs present, mounts correct), runtime (Node, Python, Git versions), PATH (launcher directory on PATH, no stale entries), packages (each installed package's doctor checks), compatibility (compat-db lookup for each installed combo), network (registry reachable, mirror healthy), services (optional services like Redis for aider-memory). Each check returns `ok`/`warn`/`fail`/`missing` with a fix command. See [doctor-engine](../07-doctor/doctor-engine.md) §3.

### Doctor reports a failure — what do I do?

Read the failure message — it includes (a) what failed, (b) why, (c) a copy-pasteable fix command, and (d) a docs link. If the fix command looks safe (most are), run `linuxify repair` to apply all safe fixes automatically, or run the specific fix command manually. If the fix is marked unsafe (would delete data or change versions), `repair` will prompt for confirmation. After fixing, re-run `linuxify doctor` to verify. If the failure persists, see [troubleshooting](../22-operations/troubleshooting.md) §3 or file an issue with `linuxify doctor --markdown` output attached. See [doctor-engine](../07-doctor/doctor-engine.md) §6.

### How does `linuxify repair` work?

`repair` walks the most recent doctor results and, for each `fail` or `missing` with a `fix_command`, executes the fix. Safe fixes (e.g., regenerating a launcher, cleaning a cache) run without prompting; unsafe fixes (e.g., reinstalling a runtime, deleting a corrupted snapshot) prompt for confirmation unless `--yes` is passed. Each executed fix is logged to `~/.linuxify/logs/repair-<timestamp>.json`. Repair is idempotent — re-running it after a successful repair is a no-op. See [doctor-engine](../07-doctor/doctor-engine.md) §6.

### Can I run doctor automatically?

Yes. The `--profile ci` flag runs only the critical subset of checks and elevates `warn` to `fail` (so CI fails on warnings), with `--json` output suitable for parsing. The `--quiet` flag suppresses all output except failures. Common patterns: run `linuxify doctor --profile ci --json` in a `preRun` hook, in a cron job via Termux:Boot, or in a CI pipeline. See [doctor-engine](../07-doctor/doctor-engine.md) §9.

### Doctor says everything is OK but my tool still fails — what now?

Doctor checks the environment (distro installed, runtime present, launcher exists, patches applied), not the tool's runtime behavior. If doctor is green but the tool fails, the issue is likely: (a) the tool's own configuration (API keys, config files), (b) a network issue the tool is hitting, (c) a tool bug not related to Android compatibility, or (d) a patch that applied but is insufficient (the patch fixed one `process.platform` check but the tool has another elsewhere). Run the tool with `linuxify run <pkg> --verbose` to see the full env and proot invocation, then check the tool's own logs. See [diagnostics](../07-doctor/diagnostics.md) §3.19 and [troubleshooting](../22-operations/troubleshooting.md) §3.

## Security & Privacy

### Is Linuxify safe to use?

Linuxify is as safe as the tools it installs. Linuxify itself (the CLI, the patcher, the doctor) is signed, audited, and runs with user privileges only — no root. The CLIs it installs (Cline, Codex, etc.) come from upstream registries (npm, PyPI) and Linuxify does not re-verify their signatures in v1 (a known limitation — see [security-model](../13-security/security-model.md) §4). The patches Linuxify applies are sourced from a signed registry and reviewed by maintainers, but they modify upstream code — read the patch YAML if you are cautious. proot is not a sandbox: a malicious CLI inside proot has the same access as the Termux user. See [security-model](../13-security/security-model.md) §15 for known limitations.

### Does Linuxify send telemetry?

Not unless you opt in. Telemetry is **off by default** (per [ADR-005](../20-adrs/adr-005-opt-in-telemetry.md) and PRD FR-052). On first run, Linuxify asks once whether you want to enable telemetry; the default is "no." If you say no, no data is ever sent. If you say yes, Linuxify collects anonymous usage events (which commands run, which packages installed, which errors hit) to `~/.linuxify/telemetry/queue.jsonl` and batches them to the maintainers' server. You can change your mind with `linuxify config telemetry false` and purge collected data with `linuxify telemetry purge`. See [telemetry-privacy](../24-telemetry/telemetry-privacy.md).

### Can Linuxify plugins be malicious?

In v1, yes — plugins run with full user privileges, the same trust model as `npm install` scripts. A malicious plugin could read your files, exfiltrate data, or install backdoors. The mitigations are: plugins are opt-in (you must explicitly `linuxify plugin install <name>`), the install prompt is scary (lists the hooks the plugin registers and the files it can touch), and the plugin's source is on npm/GitHub for you to inspect. v2 will add sandboxing (worker_threads, seccomp, or landlock) and a capability-based permission model. See [security-model](../13-security/security-model.md) §6.

### I'm a security researcher — how do I report a vulnerability?

Email `security@linuxify.dev` (encrypted; the PGP key is in `SECURITY.md` and the `KEYS` file in the repo). Do not open a public GitHub issue for security reports — the maintainers will delete it and ask you to re-send via encrypted email. The maintainers acknowledge receipt within 48 hours, provide an initial assessment within 7 days, and target a fix within 90 days. Reporters are credited in the advisory (unless they prefer anonymity). See [security-model](../13-security/security-model.md) §12.

### Does Linuxify work with a VPN?

Yes. Linuxify makes outbound HTTPS connections to fetch rootfs tarballs, registry updates, and npm/PyPI packages. A VPN routes these through the VPN tunnel with no Linuxify configuration needed. If your VPN blocks certain regions or domains (e.g., a corporate VPN that blocks GitHub), you may need to configure a mirror or use `--offline` mode with a pre-bundled rootfs. See [security-model](../13-security/security-model.md) §10 for network security details.

## Contributing

### How do I contribute to Linuxify?

The easiest contributions are: a new package definition (write a YAML file, open a PR — see [package-spec](../09-registry/package-spec.md) §14 for the authoring FAQ), a bug report (use the bug-report template, include `linuxify doctor --markdown`), a documentation improvement (edit the Markdown, open a PR), or a patch for an existing package (add an entry to the `patches:` block). For code contributions to Linuxify core, read [contribution-guidelines](../16-community/contribution-guidelines.md) first, then claim an issue labeled `good-first-issue`. All commits must be DCO-signed (`git commit -s`).

### How do I add a new package to the registry?

Read [package-spec](../09-registry/package-spec.md) in full, copy the `cline.yml` example as a template, fill in your package's fields, run `linuxify package lint <your-file.yml>` to validate, test locally with `linuxify add <name> --local <path-to-yaml>`, then open a PR adding the file to `packages/<name>.yml` in the registry repo. A maintainer will review, request changes if needed, and merge. The package becomes available to all users after the next `linuxify update`. See [contribution-guidelines](../16-community/contribution-guidelines.md) §4.

### How do I write a patch?

Identify the Android-specific failure (run the tool, read the error, find the offending source line), determine the patch type (regex for simple find/replace, ast-js for JS AST edits, ast-ts for TS, python-ast for Python — see [patcher-engine](../08-patcher/patcher-engine.md) §5), add a `patches:` entry to the package YAML with `patch_id: <pkg>-<NNN>`, `file:`, `type:`, `find:`/`replace:`, and a mandatory `verify:` block. Test with `linuxify add <pkg> --local` and confirm the patch applies and verifies. Open a PR. See [patcher-engine](../08-patcher/patcher-engine.md) §10 for the full authoring workflow.

### Do I need to sign a CLA?

No. Linuxify uses the Developer Certificate of Origin (DCO) instead of a Contributor License Agreement. The DCO is a per-commit sign-off (`Signed-off-by: Your Name <email>`, added by `git commit -s`) asserting that you have the right to contribute the code under the project's MIT license. No separate CLA document, no copyright assignment. See [contribution-guidelines](../16-community/contribution-guidelines.md) §3.

### How do I become a maintainer?

Maintainers are added by rough consensus of the existing maintainers, typically after sustained high-quality contribution over 6+ months (code, reviews, issue triage, community help). There is no application form. If you are contributing regularly and want to discuss maintainership, raise it with an existing maintainer in Discord or office hours. New maintainers are added via the 2-of-3 key-signing procedure (see [security-model](../13-security/security-model.md) §7). See [contribution-guidelines](../16-community/contribution-guidelines.md) §9.

## Advanced

### Can I use Linuxify in CI?

Yes. Install Linuxify in your CI runner (GitHub Actions supports Android emulation, though it is slow; alternatively, run Linuxify on a self-hosted ARM runner), use `linuxify doctor --profile ci --json` as a gate, and `linuxify run <pkg> --json` for tool invocations. The `ci` profile elevates warnings to failures. See [doctor-engine](../07-doctor/doctor-engine.md) §9 and [cicd-design](../14-cicd/cicd-design.md).

### Can I share my Linuxify setup across devices?

In v1, manually: run `linuxify export > linuxify-manifest.json` on device A, copy the file to device B, run `linuxify import < linuxify-manifest.json` on device B. The manifest captures installed packages, versions, distros, and runtime versions — but not secrets (API keys, tokens), which you must re-enter. In v2, [cloud-sync](../19-future/cloud-sync.md) will automate this. See [disaster-recovery](../22-operations/disaster-recovery.md) §3 for the backup levels.

### How do I write a plugin?

Read [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) in full. The TL;DR: create a Node package with `linuxify.plugin.json` at the root, declare your `provides` (distros, runtimes, commands, hooks, doctor checks, patch types), implement the hook functions or provider interfaces, publish to npm with the `linuxify-plugin` keyword, and users install with `linuxify plugin install <name>`. The [plugin-sdk](../10-plugin-sdk/plugin-sdk.md) doc has worked examples for a Java runtime plugin, a team-onboarding command, and a custom Fedora distro.

### How do I pin a runtime version per package?

In the package YAML's `runtime:` and `runtime_min_version:` fields. For example, `runtime: node` and `runtime_min_version: "20"` requires Node 20+. The runtime manager installs the minimum-compatible version if not already present. Per-package exact-version pinning (e.g., "this package must use Node 22.11.0 exactly, not 22.12.0") is not supported in v1 — all packages in a distro share the distro's active runtime version. Per-package runtime isolation is on the v2 roadmap. See [runtime-management](../06-launcher/runtime-management.md) §5.

### Can I run Linuxify in Docker?

Linuxify is designed for Android Termux, not Docker. However, the Linuxify CLI itself (being a Node app) can run in a Docker container for testing or CI — the bootstrap will skip the Termux-specific stages if it detects a Linux host. This is not a supported configuration and the maintainers do not commit to it working, but it can be useful for reproducing bugs in a controlled environment. See [cicd-design](../14-cicd/cicd-design.md) for how the Linuxify CI uses containers.
