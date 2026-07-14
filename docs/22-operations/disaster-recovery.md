# Disaster Recovery

> **Audience**: Users who have lost their Linuxify environment (or are about to), maintainers preparing for project-wide incidents, and AI coding agents helping a user recover from a catastrophic failure. This doc covers what counts as a disaster, how to back up proactively, and how to recover reactively when something goes wrong. For routine troubleshooting (single-tool failures, doctor warnings), see [troubleshooting](./troubleshooting.md); this doc is for the "I lost everything" tier.

## 1. Disaster Scenarios

A "disaster" in the Linuxify context is any event that loses data, breaks the environment beyond what `linuxify repair` can fix, or compromises security. The scenarios below are the ones the design explicitly anticipates. Each has a recovery procedure in §5–§9.

**Phone lost or stolen.** The most common disaster. The Linuxify environment (distros, packages, patches, config) is on the phone's internal storage, which goes with the phone. If you had no backup, you rebuild from memory. If you had a manifest backup (§3 Level 1) on another device or in the cloud, you can rebuild in ~10 minutes.

**Phone factory reset.** Same data-loss profile as a lost phone, but you still have the hardware. A factory reset wipes `~/.linuxify/` along with everything else in Termux's private storage. Recovery is the same as for a lost phone (§5).

**Android OS upgrade breaks proot.** A major Android version upgrade can change kernel behavior, SELinux policies, or ptrace semantics in ways that break proot. This is not data loss — your `~/.linuxify/` is intact — but the environment becomes unusable until proot (or Linuxify itself) is updated to accommodate the new Android. Recovery in §6.

**Termux app uninstalled accidentally.** Removing the Termux app wipes its private storage (`/data/data/com.termux/files/`), which includes `~/.linuxify/`. Same data-loss profile as factory reset. Recovery in §5.

**Linuxify state corruption.** A power-off during a write, a disk error, or a bug in Linuxify itself can leave `state.json`, `manifest.json`, or a patch record in an unparseable state. The distro and packages may be intact on disk, but Linuxify cannot reason about them. Recovery in §7.

**Malicious package compromise.** A package (or a patch in a package's YAML) in the registry turns out to be malicious — exfiltrating data, installing backdoors, etc. This is a security incident, not just a data-loss one; recovery involves removing the package, assessing the damage, and rotating exposed secrets. Recovery in §9; incident response in [security-model](../13-security/security-model.md) §13.

**Linuxify itself ships a broken release.** A new Linuxify version has a regression that breaks existing installs. The self-update mechanism reaches users before the maintainers can yank it. Recovery in §8.

## 2. Recovery Prerequisites

To recover from any of the above, you need four things. **Backups** are the most important — without them, recovery is "rebuild from scratch and re-enter all your secrets." Backups come in four levels (§3); even the lowest level (a manifest export) is vastly better than nothing. **Knowledge of which packages were installed** is captured by the manifest; if you have no manifest, you must remember (or reconstruct from your shell history). **Knowledge of your config** (active distro, release channel, telemetry preference, custom env vars) is captured by `config.toml`; secrets (API keys, tokens) are *not* captured in any backup and must be re-entered manually after recovery. **Time and battery** — a full re-bootstrap takes 5–15 minutes and is CPU-intensive; do not start a recovery with 5% battery.

## 3. Backup Strategy

Linuxify supports four levels of backup, each trading off size, restoration speed, and completeness. Choose the level that matches your risk tolerance and storage budget.

### Level 1: Manifest only

```bash
linuxify export > linuxify-manifest.json
```

Produces a tiny JSON file (~5 KB) capturing: installed packages and their versions, active distro, runtime versions, patch fingerprints. Does *not* capture: `config.toml` preferences, secrets, snapshots. **Restoration**: `linuxify import < linuxify-manifest.json` re-bootstraps the distro and re-installs packages per the manifest; takes ~10 minutes. This is the minimum backup every user should have — copy it to `/sdcard/`, email it to yourself, or put it in a cloud drive. Re-entry of secrets is required.

### Level 2: Manifest + config

```bash
linuxify export --include-config > linuxify-backup.json
```

Adds your `config.toml` (minus redacted secrets) to the export. ~50 KB. Captures: distro preference, release channel, telemetry opt-in, custom env var names (not values), doctor profile, run defaults. **Restoration**: same as Level 1, but `config.toml` is also restored; you only need to re-enter secret values, not re-decide all your preferences.

### Level 3: Snapshot

```bash
linuxify snapshots create pre-flight
```

A full tarball of the active distro's rootfs, stored at `~/.linuxify/backups/snapshot-<name>-<timestamp>.tar.zst`. ~500 MB for Ubuntu, ~80 MB for Alpine. Captures: the entire distro state, including all installed packages, all patches applied, all package-level config files inside the distro. Does *not* capture: Termux-side `config.toml` (that is Level 2), secrets in env vars (those are not in the distro). **Restoration**: `linuxify snapshots restore <name>` unpacks the tarball into a fresh distro directory; takes ~3 minutes. This is the fastest restoration path.

### Level 4: Multi-snapshot (time-travel)

Periodic snapshots (e.g., weekly via Termux:Boot) give you time-travel recovery — if a package upgrade three days ago broke something, restore the snapshot from four days ago. Storage cost is ~500 MB per snapshot; with the default 5-snapshot rotation (§10), that is ~2.5 GB. **Restoration**: `linuxify snapshots list` to see available snapshots, `linuxify snapshots restore <name>` to restore one.

The recommended baseline for most users is **Level 2 (manifest + config) copied to `/sdcard/` and to a cloud drive, plus Level 3 snapshots before risky operations** (package upgrades, patch applications, distro switches). Power users who experiment heavily should add Level 4 weekly snapshots.

## 4. Backup Locations

Backups are only useful if they survive the disaster that destroyed the original. A backup on the same phone that was lost is no backup at all.

**Local (`~/.linuxify/backups/`)**: Auto-rotated, kept last 7. This is where snapshots live by default. Survives most disasters except phone loss / factory reset / Termux uninstall. Useless for those three.

**`/sdcard/`**: Manual copy (`cp linuxify-manifest.json /sdcard/`). Survives Termux uninstall (the `/sdcard/` partition is not wiped when Termux is uninstalled). Does *not* survive factory reset (which wipes `/sdcard/` too on most phones). This is the minimum off-Termux backup location.

**Cloud (`linuxify sync` — future, v2)**: Encrypted manifest sync to a Linuxify-hosted or user-supplied cloud endpoint. Survives phone loss, factory reset, everything short of cloud-provider-level disaster. See [cloud-sync](../19-future/cloud-sync.md) for the v2 design.

**User-chosen (`linuxify config backup.destination <path>`)**: Any path Linuxify can write to — a Syncthing directory, an SSH-mounted remote, a USB OTG drive. The most flexible option; you bring the storage, Linuxify writes the backup.

The best practice is **defense in depth**: Level 2 manifest on `/sdcard/` *and* in a cloud drive *and* (for the paranoid) printed on paper in a fireproof safe. Secrets are the hard part — a password manager (Bitwarden, 1Password) is the right place for API keys, not a Linuxify backup.

## 5. Recovery Procedure: Lost Phone

1. **Get a new phone.** Any Android 9+ device will do.
2. **Install Termux from F-Droid** (not the Play Store — see [termux-internals](../23-mobile/termux-internals.md) §1).
3. **Install Linuxify**: `pkg install linuxify` (Termux) or `npm install -g linuxify` (if you installed Node manually).
4. **Restore from backup**:
   - If you had cloud sync (v2): `linuxify sync login` and follow prompts.
   - If you had a manifest backup: copy it to the new phone (via cloud drive, email, USB), then `linuxify import < linuxify-manifest.json`.
   - If you had no backup: you are rebuilding from memory. Run `linuxify init`, then `linuxify add <pkg>` for each tool you remember using.
5. **Linuxify re-bootstraps and re-installs packages** per the manifest. This takes 5–15 minutes depending on how many packages and your network speed.
6. **Re-enter secrets**: API keys, tokens, credentials. These are never in the backup. Use your password manager to look them up. Set them via `linuxify config run.env.<KEY> <value>` or export them in your shell.
7. **Verify with `linuxify doctor`**: all green means you are back. If any check fails, run `linuxify repair` or consult [troubleshooting](./troubleshooting.md).

## 6. Recovery Procedure: Android Upgrade Broke Things

1. **Run `linuxify doctor`**: identify what specifically broke. Common post-upgrade issues: proot segfault (§3.13 in troubleshooting), SELinux denials, missing ptrace capabilities.
2. **Try `linuxify repair`**: applies safe fixes for any doctor-detected issues.
3. **If still broken, try `linuxify init --force`**: re-runs all bootstrap stages. This re-downloads and re-unpacks the rootfs, re-installs runtimes — heavy but thorough.
4. **If still broken, check [compat-db](../11-compat-db/compatibility-database.md)** for known issues with your new Android version. If the issue is known, the compat-db entry may link to a workaround or an estimated fix timeline.
5. **If the issue is unknown**, file a bug report (see [troubleshooting](./troubleshooting.md) §6) with `linuxify doctor --markdown` output. The maintainers are likely already aware (because the upgrade affects many users simultaneously) but more data helps prioritize.
6. **If you cannot wait**, roll back the Android upgrade (if your phone supports it) or restore a snapshot from before the upgrade (`linuxify snapshots restore pre-android-update` — if you followed the prevention tip in §3.34).

## 7. Recovery Procedure: Corrupted State

1. **`linuxify repair state`**: attempts to fix `state.json` by re-deriving state from the filesystem. Scans `~/.linuxify/packages/`, `~/.linuxify/distros/`, `~/.linuxify/patches/`, `~/.linuxify/runtimes/` and reconstructs the state entries. Non-destructive — does not delete anything.
2. **If `repair state` fails**, manually move the corrupted file aside: `mv ~/.linuxify/state.json ~/.linuxify/state.json.bak`. Then `linuxify init --rebuild-state` scans `~/.linuxify/` to reconstruct state from on-disk evidence (similar to `repair state` but more aggressive — it does not try to preserve the old state.json).
3. **Verify with `linuxify doctor`**: all green means state is consistent. If some packages are now "missing" (because their state entries could not be reconstructed), reinstall them with `linuxify add <pkg> --force`.
4. **If `~/.linuxify/manifest.json` is also corrupted**, the same procedure applies — `linuxify repair manifest` reconstructs it from `state.json` and the per-package files in `~/.linuxify/packages/`.
5. **Patch records** (`~/.linuxify/patches/<pkg>/<n>.json`) are per-file and atomic — corruption of one does not affect others. If a patch record is corrupted, `linuxify patch --rollback <pkg> <id>` may fail with `E_PATCH_BACKUP_MISSING`; in that case, `linuxify remove <pkg> && linuxify add <pkg>` reinstalls cleanly.

## 8. Recovery Procedure: Broken Release

1. **`linuxify self-update --rollback`**: reverts to the previous Linuxify version, which is kept at `~/.linuxify/cache/linuxify-<old-version>/`. This is the fastest fix and works for most regression bugs. The rollback is atomic and verified.
2. **If `linuxify` itself won't run** (the new version crashes before it can rollback), manually reinstall the previous version:
   - Termux: `pkg install linuxify=<previous-version>` (e.g., `pkg install linuxify=0.3.1`).
   - npm: `npm install -g linuxify@<previous-version>` (e.g., `npm install -g linuxify@0.3.1`).
   - GitHub Release: download the binary for your arch from the v0.3.1 release, verify the `.sig`, and place it on your PATH.
3. **Report the bug** (see [troubleshooting](./troubleshooting.md) §6). Include the Linuxify version that broke, the previous version that worked, and the error output. The maintainers will yank the broken version from the stable channel (it remains available on alpha/beta for users who want to test the fix) and ship a patch release.
4. **Wait for the fix**, then `linuxify self-update` to the fixed version. Read the [changelog](../../CHANGELOG.md) first to confirm the fix is in the new version.

Exit code 27 `MIGRATION_FAILED` indicates the self-update's migration script failed partway — the previous version is automatically restored, and the failure is logged. See [cli-specification](../03-cli/cli-specification.md) §6.

## 9. Recovery Procedure: Malicious Package

1. **`linuxify remove <pkg>` immediately**: uninstalls the package, removes its launcher, deletes its state entry. Use `--purge` to also delete cached downloads and patch backups.
2. **Run `linuxify doctor --deep`**: runs the full check catalog plus additional security-oriented checks (looking for unexpected files in `~/.linuxify/`, unexpected crontab entries inside the distro, unexpected setuid binaries). Reports anything suspicious.
3. **Review what the package could have accessed**: a malicious package ran with your Termux user privileges — it could read every file you can read, including `~/.linuxify/config.toml` (which may contain API keys if you put them there), `~/.ssh/` (if you have SSH keys in Termux), your `/sdcard/` (if you granted Termux storage permission), and any other app's files that Termux can access. proot is not a sandbox (see [security-model](../13-security/security-model.md) §15).
4. **Rotate any secrets that may have been exposed**: API keys (OpenAI, Anthropic, etc.), SSH keys, GitHub tokens, cloud credentials. Assume the worst — rotate everything the package could plausibly have read.
5. **Report to the Linuxify security team**: email `security@linuxify.dev` (encrypted; PGP key in `SECURITY.md`). Include the package name, the version you installed, when you installed it, and any evidence of malicious behavior. The security team will yank the package from the registry (mark it `withdrawn: true`), issue an advisory within 4 hours, and notify downstream users via the doctor check (the next time any affected user runs `linuxify doctor`, they see a warning with a link to the advisory). See [security-model](../13-security/security-model.md) §13 for the full incident-response procedure.

## 10. Snapshot Rotation Policy

Snapshots are the fastest restoration path but consume storage. The rotation policy balances retention against disk budget.

- **Auto-snapshots** are taken before risky operations: `linuxify add`, `linuxify upgrade`, `linuxify patch`, `linuxify init --force`. These are named `auto-<operation>-<pkg>-<timestamp>` and are kept until the 5-most-recent threshold is exceeded, at which point the oldest is pruned.
- **Manual snapshots** (e.g., `linuxify snapshots create pre-android-update`) are user-named and kept until the user explicitly deletes them (`linuxify snapshots delete <name>`). They do not auto-prune.
- **Total snapshot budget** defaults to 5 GB, configurable via `linuxify config storage.snapshot_budget_gb 10`. When the budget is exceeded, the oldest auto-snapshots are pruned first; manual snapshots are pruned only if the budget is still exceeded after all auto-snapshots are gone.
- **Compression**: snapshots use zstd by default (good compression, fast decompression). Use `linuxify config snapshots.compression gzip` for smaller files at the cost of slower restoration.

The snapshot budget does *not* count against your `~/.linuxify/` storage warning threshold (`storage.warn_gb`) — snapshots are expected to be large, and warning on them would be noise.

## 11. Testing Your Backups

A backup you have never restored is a hope, not a backup. **Quarterly drill**: pick a snapshot (or a manifest, if you are at Level 1/2), install Termux on a spare device (or wipe a test directory), and restore. Verify that:

- All packages you expect are present (`linuxify list`).
- Each package's `doctor` checks pass (`linuxify doctor`).
- You can run a representative tool end-to-end (`linuxify run cline -- --version`).
- Your config preferences are intact (`linuxify config get` for each key you care about).

Document any issues — if a package's state is not fully captured by the manifest, that is a bug in the package definition (the `doctor:` block should catch it) and should be reported. The drill takes ~30 minutes and is the single best way to ensure your disaster recovery will actually work when you need it.

## 12. Disaster Recovery for the Project Itself

What if the Linuxify project itself disappears — the maintainers stop maintaining, the GitHub org is deleted, the domain lapses? This is a real concern for any open-source project, and Linuxify is designed to survive it.

**All code is open source under MIT.** Forks are legal and encouraged. If the maintainers disappear, the community can fork the repo, continue maintenance, and even publish under a new name. The MIT license imposes no restrictions on forking.

**The registry is a git repo.** Every Linuxify install has a full clone at `~/.linuxify/registry/`. If the upstream registry disappears, your local clone continues to work for all already-installed packages. New packages cannot be added without a new registry source, but the existing set is preserved. Mirrors are encouraged — the registry is designed to be forkable.

**Documentation is in the repo.** Every doc you are reading right now is in the Linuxify repo under `docs/`. If the repo is forked, the docs go with it. The docs are written to be self-contained — an AI coding agent or a new maintainer can pick up the project from the docs alone.

**Distribution channels have fallbacks.** If npm disappears, Linuxify can be installed from the Termux package or from GitHub Releases. If GitHub disappears, the Termux package still works. If all three disappear simultaneously, users who already have Linuxify installed continue to work; new installs require `git clone` of any surviving mirror and `npm install` against the local clone.

**Worst case**: a user with a working Linuxify install and a local registry clone can continue using Linuxify indefinitely even if the entire upstream project vanishes. They will not get updates, but their existing tools continue to work. This is the resilience property that "local-first, cloud-optional" (per the [vision](../00-executive/vision.md)) buys.

## 13. Communication Plan

For project-wide disasters (a compromised signing key, a malicious package in the registry, a critical vulnerability in Linuxify core), the maintainers follow a defined communication plan to reach affected users as quickly as possible.

- **GitHub Security Advisory**: the primary channel. Published at github.com/linuxify/linuxify/security/advisories — users who watch the repo get a notification. The advisory includes: a description, affected versions, fixed version, workaround (if any), and credit to the reporter.
- **Discord `#security` and `#announcements` channels**: for time-sensitive notification. The `#security` channel is for technical discussion; `#announcements` is for the broad user-facing summary. Both are pinned for visibility.
- **Blog post** on the Linuxify website: a longer-form writeup with remediation steps, suitable for users who find the issue via search engines days or weeks later.
- **Email to the opt-in newsletter**: for users who subscribed (separate from telemetry opt-in). This reaches users who may not check Discord or GitHub regularly.
- **In-tool notification**: for severe incidents, the next `linuxify doctor` run displays a prominent warning with a link to the advisory. This is the highest-reach channel — every user who runs doctor sees it.

The communication plan is rehearsed annually as part of the maintainer key-rotation tabletop exercise (see [security-model](../13-security/security-model.md) §7). The goal is to publish an advisory within 4 hours of confirmed incident, and to push a fix release within 24 hours for critical issues. See [security-model](../13-security/security-model.md) §13 for the full incident-response procedure, which this communication plan supports.
