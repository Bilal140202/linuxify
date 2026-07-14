# Bundle Format Specification

> Path: `docs/09-registry/bundle-format.md`
> Audience: AI coding agents, contributors, security engineers, enterprise admins building or verifying offline Linuxify installations.
> Related: [Registry Format](./registry-format.md) · [Package Spec](./package-spec.md) · [Compatibility Database](../11-compat-db/compatibility-database.md) · [System Architecture §5 Storage Layout](../02-architecture/system-architecture.md#5-storage-layout) · [Data Formats §15 Snapshot Tarball](../02-architecture/data-formats.md#15-linuxifybackupsnametarzst--snapshot-tarball) · [CLI Specification](../03-cli/cli-specification.md) · [Disaster Recovery §7 Snapshots](../22-operations/disaster-recovery.md#7-snapshots) · [Security Model](../13-security/security-model.md) · [Key Management](../13-security/key-management.md).

## 1. Use Case

A Linuxify **bundle** is a single offline-installable archive that contains everything Linuxify needs to bootstrap a working environment on a fresh Termux install without any network access. The motivating use cases are concrete and recurring: a developer on a long flight with no Wi-Fi who wants to set up a new phone; a student in a region where GitHub and Ubuntu's CDN are slow or blocked; an enterprise that enforces air-gapped developer machines and operates an internal Linuxify mirror; a humanitarian field worker whose only connectivity is an intermittent satellite link where every megabyte costs more than a coffee. In each of these, the round-trip to fetch a distro rootfs, two or three runtimes, a registry snapshot, and a compat-db snapshot is the dominant cost of `linuxify init`, and caching those artifacts *once* on a connected machine then shipping them as a single file is the obvious fix.

Bundles also serve a second, subtler use case: **reproducible environments**. A team can publish a bundle that pins exact distro, runtime, and package versions, and every team member who installs from that bundle gets the same starting state — bit-for-bit identical, with the same compat-db snapshot, the same registry commit, the same patch definitions. This is the same guarantee that `package-lock.json` gives npm, but at the level of the whole environment. A bundle is the unit of "this is the Linuxify state as of <date>, full stop." See [ADR-002](../20-adrs/adr-002-yaml-package-definitions.md) for the related decision to make package definitions the version-pinned unit; a bundle is the same idea extended to distros and runtimes.

The bundle format is distinct from the [snapshot tarball](../02-architecture/data-formats.md#15-linuxifybackupsnametarzst--snapshot-tarball) in `~/.linuxify/backups/`. A snapshot is a backup of an *installed* state (it includes `state.json`, per-package install records, patch backups); a bundle is a pre-installation package of *source artifacts* (rootfs tarballs, runtime installers, registry snapshot, compat-db) that can bootstrap a fresh machine. Snapshots restore a known-good state; bundles establish a known-good starting state. The two share the `.tar.zst` container and the manifest-at-root convention but have different schemas and different purposes.

## 2. Bundle Creation

`linuxify bundle create [options]` produces a single file `linuxify-bundle-<version>.tar.zst` in the current directory (or `--out <path>` to override). The creation command downloads every artifact the bundle will contain (or reuses cached copies in `~/.linuxify/cache/`), verifies each one against its published SHA-256, lays them out in the bundle directory structure (§3), writes the bundle manifest (§4), compresses the directory into a tarball, and computes the bundle's overall SHA-256.

The supported options are:

- `--distros <list>` — comma-separated list of distros to include (default: `ubuntu`). Each distro adds its rootfs tarball (one per architecture, defaulting to the host arch; use `--arch <list>` for cross-arch bundles).
- `--runtimes <list>` — comma-separated list of `runtime@version` (default: `node@lts,python@3.12`). Each runtime adds its installer tarball.
- `--packages <list>` — comma-separated list of packages to pre-cache (default: none). Pre-cached packages are stored as their registry tarballs and are installable offline via `linuxify add <pkg> --offline`.
- `--arch <list>` — comma-separated list of architectures (default: host arch). Cross-arch bundles are larger but enable provisioning multiple devices from one bundle.
- `--minify` — strip everything non-essential: registry docs, compat-db historical entries, runtime debug symbols. Produces the smallest possible bundle for a given config.
- `--out <path>` — output file path (default: `./linuxify-bundle-<version>.tar.zst`).
- `--sign <key-id>` — sign the bundle with the given Ed25519 key (v2 feature; see §12).
- `--include-cli` — include the Linuxify CLI itself (default: true). Produces a self-contained bundle (§10).

Bundle creation is destructive only in the sense that it consumes disk and network; it never modifies `~/.linuxify/` state. The CLI caches intermediate downloads in `~/.linuxify/cache/bundle-build/` so re-creating a bundle with one added package reuses all the prior downloads. The build is parallelizable across files (rootfs, runtimes, packages) but each file's download and verify is sequential within itself.

## 3. Bundle Structure

A bundle is a zstd-compressed tar of a directory named `linuxify-bundle-<version>/`. The directory structure is fixed; clients parse it by walking the tree and matching filenames against the manifest. The structure for a standard bundle (Ubuntu + Node + Python + a few packages) is:

```
linuxify-bundle-0.2.0/
├── bundle.toml                        # manifest (see §4)
├── linuxify-cli.tar.zst               # the CLI itself (self-contained bundle)
├── distros/
│   ├── ubuntu-24.04-aarch64.tar.zst
│   ├── debian-12-aarch64.tar.zst       # if --distros ubuntu,debian
│   └── ...
├── runtimes/
│   ├── node-22.11.0-aarch64.tar.gz
│   ├── python-3.12.3-aarch64.tar.gz
│   └── ...
├── packages/
│   ├── cline-1.2.0.tar.gz              # pre-cached package tarballs
│   ├── codex-0.20.1.tar.gz
│   └── ...
├── registry/
│   └── registry-snapshot.tar.gz        # frozen registry snapshot (git checkout)
└── compat-db.json                      # frozen compat-db snapshot
```

Every file in the bundle (except `bundle.toml` itself) is listed in `bundle.toml`'s `contents` array with its SHA-256. The `distros/` and `runtimes/` files are themselves compressed (zstd for distros, gzip for runtimes — matching the upstream format); the bundle's outer zstd compression does not double-compress them (zstd detects already-compressed data and stores it with `--no-compress` for those members). The `packages/` files are npm-style tarballs (gzip) produced by `npm pack` against the registry snapshot.

The `registry/registry-snapshot.tar.gz` is a frozen git checkout of the registry at a specific commit, including the `KEYS` file, every `packages/*.yml`, every `patches/*/*`, and the `compat/compat-db.json` (which is also extracted as the top-level `compat-db.json` for fast access). The snapshot's commit SHA is recorded in `bundle.toml` so a client can verify it against the registry's signed history if the bundle is later updated online.

## 4. Bundle Manifest (`bundle.toml`)

The manifest is the bundle's table of contents, signed-ness record, and re-verification anchor. It is a TOML file at the bundle root. The schema:

```toml
# bundle.toml
bundle_schema_version = 1
bundle_name = "linuxify-bundle-0.2.0"
linuxify_version = "0.2.0"
created_at = "2025-06-18T09:00:00Z"
created_by = "linuxify bundle create"
bundle_size_bytes = 1284925184
bundle_sha256 = "f3a2...9e1b"           # sha256 of the entire .tar.zst
source_url = "https://linuxify.sh/bundles/0.2.0/ubuntu-node-python-aarch64.tar.zst"

# signature (v2; absent in v1)
[signature]
algorithm = "ed25519"
key_id = "0xABCD1234"
signed_at = "2025-06-18T09:00:01Z"
signature = "9a3f...e1b2"               # ed25519 signature over bundle_sha256

# contents — every file in the bundle
[[contents]]
path = "linuxify-cli.tar.zst"
size_bytes = 18425344
sha256 = "a1b2c3..."

[[contents]]
path = "distros/ubuntu-24.04-aarch64.tar.zst"
size_bytes = 412318720
sha256 = "9f8d7c..."

[[contents]]
path = "runtimes/node-22.11.0-aarch64.tar.gz"
size_bytes = 42180352
sha256 = "e5f6a7..."

[[contents]]
path = "runtimes/python-3.12.3-aarch64.tar.gz"
size_bytes = 28311552
sha256 = "8b9c0d..."

[[contents]]
path = "packages/cline-1.2.0.tar.gz"
size_bytes = 1842176
sha256 = "1a2b3c..."

[[contents]]
path = "packages/codex-0.20.1.tar.gz"
size_bytes = 982432
sha256 = "4d5e6f..."

[[contents]]
path = "registry/registry-snapshot.tar.gz"
size_bytes = 8421376
sha256 = "7a8b9c..."

[[contents]]
path = "compat-db.json"
size_bytes = 18432
sha256 = "0f1e2d..."

# provenance — where each artifact came from (for re-verification)
[provenance]
registry_commit = "abc1234..."          # git SHA of the registry snapshot
compat_db_generated_at = "2025-06-18T08:00:00Z"
cli_build_sha = "def5678..."            # git SHA the CLI was built from
```

The `bundle_sha256` is computed last: the bundle directory is tarred and zstd-compressed without the manifest, the manifest's other fields are filled, the manifest is written into the tarball (rewriting the tarball in-place — zstd supports this with `--stream` mode), and finally the SHA-256 of the full tarball is computed and written back into the manifest. This two-pass approach is necessary because the manifest's own hash cannot appear inside the hashed data; the alternative (detached sidecar `.sig` file) is rejected because it allows the manifest and bundle to be separated.

`source_url` is the URL the bundle was downloaded from (or empty for locally-created bundles). It is recorded so that `linuxify bundle verify` can re-download the bundle from the source and compare hashes, providing a tamper-detection mechanism even without cryptographic signatures (§5).

## 5. Bundle Verification

`linuxify init --bundle <path>` performs a multi-layer verification before installing anything from the bundle. The verification is mandatory and cannot be skipped — even `--yes` does not bypass it, because a tampered bundle could install a malicious distro rootfs. The verification sequence is:

1. **Bundle SHA-256.** Compute the SHA-256 of the entire `.tar.zst` file and compare to `bundle_sha256` in `bundle.toml`. If the manifest is missing or the hash does not match, abort with `E_BUNDLE_HASH_MISMATCH` and refuse to proceed.
2. **Per-file SHA-256.** Extract the bundle, then for each entry in `contents`, compute the file's SHA-256 and compare to the listed hash. Any mismatch aborts with `E_BUNDLE_FILE_HASH_MISMATCH` and names the offending file.
3. **Signature verification (v2).** If `bundle.toml` declares a `[signature]`, verify it against the bundled or hardcoded Ed25519 public key (see [Key Management](../13-security/key-management.md)). A missing signature in v2 is a warning (not an error) so v1 bundles continue to work, but a *present but invalid* signature is a hard error.
4. **Registry signature (v2).** If the bundled registry snapshot was signed at the commit recorded in `provenance.registry_commit`, verify the signature against the registry's signing key (see [Registry Format §10](./registry-format.md#10-registry-signing--trust)). This catches the case where a bundle was built from a tampered registry.
5. **Trusted source check.** If the bundle was downloaded (not locally created), `source_url` must be in the user's trusted-bundle-sources list (`linuxify config bundle.trusted_sources <list>`). A bundle from an untrusted source is refused with `E_BUNDLE_UNTRUSTED_SOURCE`. This is the v1 substitute for cryptographic bundle signing; in v2, signature verification subsumes this check.

If any check fails, Linuxify refuses to install from the bundle, names the failing check, and suggests `linuxify bundle verify <path>` for a full report. The partially-extracted bundle directory is deleted before aborting, so no leftover files remain. The verification is the trust boundary: anything past this point is trusted as if it had been downloaded over HTTPS from the official registry.

## 6. Bundle Distribution

Bundles are distributed through three channels. The **official channel** is `linuxify.sh/bundles/`, where pre-built bundles are published for common configurations (Ubuntu + Node + Python, the four distros × LTS runtimes, aarch64 and armv7l). Each published bundle has a stable URL like `https://linuxify.sh/bundles/0.2.0/ubuntu-node-python-aarch64.tar.zst` and a sibling `.sha256` file with the bundle's hash; clients verify the hash after download. The official bundles are rebuilt on every Linuxify release and on every registry commit that changes the compat-db (so a fresh bundle always reflects the latest known-good compat state).

The **local channel** is `linuxify bundle create` on a developer's machine. A locally-created bundle has `source_url = ""` and is verified only by its self-declared hashes (§5 step 1-2). Local bundles are the right answer for one-off air-gapped installs and for testing bundle creation itself.

The **shared channel** is everything else: a USB stick, a Syncthing folder, a corporate file share, an email attachment (for small bundles). A bundle received via any of these is verified by §5's full sequence before install. The sender is expected to communicate the bundle's SHA-256 out-of-band (e.g., a Discord DM with the hash) so the receiver can compare it to `bundle.toml`'s `bundle_sha256` before even running Linuxify — this catches in-transit corruption without needing Linuxify installed.

Each published official bundle is signed (v2) by the Linuxify release signing key (see [Key Management §1](../13-security/key-management.md#1-key-hierarchy)). The signature is over the `bundle_sha256`, so a signed bundle that has been tampered with will fail signature verification even if the attacker rewrites `bundle.toml` (because they cannot forge the signature without the private key). The corresponding public key is shipped with the Linuxify CLI and listed in `KEYS` at the project root.

## 7. Bundle Updates

Bundles are versioned: each bundle has a `linuxify_version` and a `bundle_schema_version`. Updating a bundle *is* creating a new one — there is no in-place bundle update. `linuxify bundle update` (which requires network) downloads the latest official bundle for the user's current config (distros, runtimes, arch) and writes it alongside the existing one, so the user can verify the new bundle before switching. The old bundle is not deleted automatically; the user deletes it (or archives it) once they have verified the new one works.

For an *installed* Linuxify that was bootstrapped from a bundle, `linuxify update` (the regular registry update command) works normally: it fetches the latest registry commit from the network and verifies it against the bundled registry's signing key (the bundled key is the trust anchor). The bundle is the *initial* trust anchor and the *offline* fallback; once the machine is online, the regular update protocol takes over. The bundle's `provenance.registry_commit` is recorded in `state.json` so that the first `linuxify update` can verify the chain from the bundled commit to the latest commit (the registry signs commits in a chain, so this is straightforward).

## 8. Bundle Sizes

Bundle sizes are dominated by the distro rootfs and the runtimes; the registry snapshot and packages are tiny by comparison. The estimated sizes for the three standard bundle classes are:

- **Minimal** (1 distro, 1 runtime, no packages) — ~500 MB. Ubuntu 24.04 aarch64 rootfs is ~410 MB; Node 22 LTS is ~85 MB; the rest is manifest, registry snapshot, compat-db. This is the smallest useful bundle; it bootstraps a working proot Ubuntu with Node but no packages installed.
- **Standard** (Ubuntu + Node + Python + 10 packages) — ~1.2 GB. Adds Python (~65 MB), 10 packages (~10-20 MB total), and a fuller registry snapshot. This is the recommended bundle for a new developer; it matches the "what most users install in the first week" profile.
- **Full** (all four distros, all six runtimes, all tier-1 packages) — ~5 GB. Useful as an enterprise internal mirror or for a power user who wants every option available offline. Not recommended for individual users; the download time and storage cost are prohibitive for most use cases.

The `--minify` flag reduces these by 10-30%: it strips the registry's `docs/` and `ADR/` directories, drops the compat-db's historical entries (keeping only the current snapshot), and uses `--strip-debug` on runtime tarballs. Minified bundles are not bit-for-bit compatible with non-minified ones (a minified bundle's registry snapshot has a different SHA-256 than the full one), but they install the same packages and produce the same final state.

## 9. Bundle Creation Performance

`linuxify bundle create` is slow because it downloads large files and compresses them. The dominant cost is the distro rootfs download (~410 MB for Ubuntu), followed by the runtime downloads (~85 MB each for Node and Python), followed by zstd compression of the final tarball (~30-60 seconds on a mid-range device for a 1.2 GB bundle). On a fast network (50 Mbps), a Standard bundle takes ~5-8 minutes to create; on a slow network (1 Mbps), it can take an hour or more.

The CLI mitigates this by caching every downloaded artifact in `~/.linuxify/cache/bundle-build/`. A re-run of `linuxify bundle create` with one added package reuses every prior download; only the new package is fetched. The cache is keyed by the upstream URL and SHA-256, so changing `--distros` to add Debian downloads only the Debian rootfs, leaving the Ubuntu rootfs in the cache untouched. The cache is not TTL-evicted (it's a build cache, not a runtime cache) but is cleared by `linuxify cache clear --bundle-build`.

For users who create bundles frequently (e.g., an enterprise CI that publishes a daily bundle), the recommendation is to run bundle creation on a wired-connection build server with the cache warm, then distribute the resulting bundle via the shared channel. Bundle creation on a phone over Wi-Fi works but is not the intended workflow.

## 10. Self-Contained Bundles

A self-contained bundle (the default; disable with `--include-cli=false`) includes the Linuxify CLI itself at `linuxify-cli.tar.zst`. This enables the cold-start scenario: a fresh Termux install on a phone with no network access, where the user has received the bundle file (via USB, Bluetooth file transfer, an SD card, or any other side-channel). The bootstrap sequence on the target device is:

```bash
pkg install tar wget        # install only tar and a downloader
wget file:///sdcard/linuxify-bundle-0.2.0.tar.zst   # or cp from USB
tar xf linuxify-bundle-0.2.0.tar.zst
cd linuxify-bundle-0.2.0/
tar xf linuxify-cli.tar.zst -C $PREFIX        # install the CLI into Termux
linuxify init --bundle ./linuxify-bundle-0.2.0.tar.zst
```

The key property is that no `npm install -g linuxify` is needed. The CLI tarball contains a single-file pre-bundled executable (built with `esbuild --bundle --platform=node` and a Node.js binary stub) that runs on Termux's Node without npm. This avoids the chicken-and-egg of needing npm to install Linuxify when the whole point is to bootstrap a clean environment. The CLI version inside the bundle is the version recorded in `bundle.toml`'s `linuxify_version`, so the bundle and the CLI are guaranteed to match — there is no "bundle was built for 0.2.0 but the installed CLI is 0.1.5" mismatch.

Self-contained bundles are larger than non-self-contained ones by ~18 MB (the size of the bundled CLI). For users who already have Linuxify installed (the typical case after the first bootstrap), `--include-cli=false` produces a smaller bundle that can be used to update the distros/runtimes/registry without re-shipping the CLI.

## 11. Differential Bundles

A future feature (v2.1+) is **differential bundles**: a bundle that contains only the files that have changed since a prior bundle. A differential bundle references its parent by `parent_bundle_sha256` and contains only the new/changed files; the client reconstructs the full bundle by combining the parent and the diff. This saves bandwidth for incremental updates: if a weekly bundle changes only the registry snapshot and one package (~10 MB), a differential bundle is 10 MB instead of 1.2 GB.

The mechanics are simple: the differential bundle's `bundle.toml` declares `bundle_kind = "differential"` and `parent_bundle_sha256`; the `contents` array lists only the changed files (with their new hashes); a separate `removed` array lists files that were in the parent but should be deleted. The client verifies the parent bundle (which must be available locally or referenced by URL) before applying the differential. The verification sequence (§5) applies to the *reconstructed* full bundle, not to the differential alone, so a tampered differential that produces a wrong full bundle is caught at the same point a tampered full bundle would be.

Differential bundles are not a v1 feature because the use case (frequent bundle updates on bandwidth-constrained links) is rare in the v1 user base, and the implementation requires stable file chunking (so small changes produce small diffs) that adds complexity. The v1 format reserves the `bundle_kind` field so differentials can be added without a schema-version bump.

## 12. Bundle Signing

Bundle signing (v2) closes the tampering gap that v1's hash-only verification leaves open: in v1, an attacker who can rewrite `bundle.toml` (e.g., by editing the file on a shared USB stick) can substitute a malicious distro rootfs and update the per-file hashes to match. v2 signing prevents this: the manifest's `bundle_sha256` is signed with the Linuxify release signing key (Ed25519), and the public key is hardcoded in the Linuxify CLI and published in `KEYS`. An attacker who rewrites the manifest cannot forge the signature without the private key, which lives on a YubiKey in the release manager's possession (see [Key Management §3](../13-security/key-management.md#3-key-storage)).

The signature algorithm is Ed25519 (per [Key Management §2](../13-security/key-management.md#2-key-generation)): modern, fast, small signatures (64 bytes), no parameter selection required. The signed data is the 32-byte `bundle_sha256` value (decoded from hex), not the full tarball — this keeps the signature constant-size regardless of bundle size. The signature is stored in `bundle.toml`'s `[signature]` table and is itself not signed (it *is* the signature). Signature verification is the first verification step (before §5 step 1) so a tampered bundle is rejected before any hash computation.

Key rotation follows the [Key Management §4](../13-security/key-management.md#4-key-rotation) protocol: the old key signs the new key, both are valid for a 90-day overlap, and the old key is revoked after the overlap. The CLI ships with both keys during the overlap and drops the old key after. A bundle signed with the old key continues to verify during the overlap and is rejected (with a helpful "this bundle was signed with a retired key; re-download from the official source" message) after.

## 13. Bundle Integrity Check

`linuxify bundle verify <path>` runs the full §5 verification sequence against a bundle without installing anything. It is the right command to run when receiving a bundle from an untrusted source (a colleague's USB stick, a forum download, an email attachment) before trusting it. The output is a structured report:

```
Bundle: linuxify-bundle-0.2.0.tar.zst
Size:   1284925184 bytes (1.2 GB)
SHA-256: f3a2...9e1b  [OK]
Signature: ed25519 key 0xABCD1234  [OK]
Contents:
  linuxify-cli.tar.zst                    18425344  [OK]
  distros/ubuntu-24.04-aarch64.tar.zst   412318720  [OK]
  runtimes/node-22.11.0-aarch64.tar.gz    42180352  [OK]
  runtimes/python-3.12.3-aarch64.tar.gz   28311552  [OK]
  packages/cline-1.2.0.tar.gz              1842176  [OK]
  packages/codex-0.20.1.tar.gz              982432  [OK]
  registry/registry-snapshot.tar.gz        8421376  [OK]
  compat-db.json                            18432  [OK]
Registry snapshot commit: abc1234  [trusted]
Result: PASS
```

A failing verification names the specific check and the offending file. `--json` produces the same report as a machine-readable object. The integrity check is read-only: it does not modify the bundle, does not write to `~/.linuxify/`, and does not require the global state lock. It is safe to run in parallel with any other Linuxify command.

## 14. Bundle Spec Compliance

The bundle format is a published spec: third parties can create bundles following this document and the Linuxify CLI will accept them, provided they pass §5 verification. This is the enterprise distribution channel: a corporate IT department can build a bundle containing the company's approved distro mirror, the company's pinned runtime versions, the company's approved packages, and the company's internal registry mirror, then distribute the bundle to every developer's phone via the corporate MDM. The developers' phones verify the bundle against the company's internal signing key (configured via `linuxify config bundle.trusted_keys <list>`) and install from it without ever touching the public internet.

Spec compliance is verified at two levels. The **structural level** (does the bundle have `bundle.toml` at the root, does `bundle.toml` parse, do all listed files exist with the listed sizes) is verified by `linuxify bundle verify --structural-only`, which is fast and catches formatting mistakes. The **cryptographic level** (do the SHA-256s match, is the signature valid) is verified by the full `linuxify bundle verify`. Third-party bundle creators should run both before publishing; the Linuxify project provides a `linuxify-bundle-lint` tool (in the registry repo) that checks structural compliance and warns about common mistakes (missing `source_url`, unsigned v2 bundle, untrusted signing key).

Third-party bundles that declare a `source_url` must serve the bundle at that URL for re-verification purposes; a bundle whose `source_url` returns 404 is still installable but is flagged with a warning so the user knows the re-verification path is broken. This is a soft requirement because enforcing it would prevent air-gapped distribution; the warning is the right trade-off. The full compliance matrix (which optional features a bundle declares) is documented in `linuxify-bundle-lint`'s output and is the basis for the "Linuxify-Compatible Bundle" badge that third-party distributors may display.
