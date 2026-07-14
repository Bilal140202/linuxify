# Platform Detection

> **Audience**: AI coding agents implementing Linuxify's platform-detection and override logic, and contributors who want to understand *why* the patcher is necessary. This doc explains the syscall-level reason `process.platform` reports `"android"` inside proot, the three-layer platform model Linuxify uses, and the override strategies. For the patcher itself (how patches are defined and applied), see [patcher-engine.md](patcher-engine.md). For the doctor's platform check, see [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md) §3.7.

## 1. The `process.platform` Mystery

The most common question from new Linuxify users is some variant of: "I'm inside a Linuxify proot. I run `node -e "console.log(process.platform)"` and it prints `"android"`. But I'm in Ubuntu 24.04! Why doesn't it print `"linux"`?"

The answer is that `process.platform` in Node.js is set at compile time based on the operating system Node was built for, *and* it does not change inside proot. Specifically, Node's source has:

```c
// from node.cc (simplified)
const char* platform = "android";  // if compiled with __ANDROID__
// or
const char* platform = "linux";    // if compiled with __linux__ but not __ANDROID__
```

Node detects the platform via the C preprocessor macros `__ANDROID__` and `__linux__`. When you install Node *inside the proot* (where there is no `__ANDROID__` macro — the proot's glibc headers define `__linux__` but not `__ANDROID__`), Node is built as a Linux binary and `process.platform` is `"linux"`. So far, so good.

The mystery is when the user runs Node *on the Termux host* (not inside the proot). Termux's Node is built with `__ANDROID__` defined, so `process.platform` is `"android"`. But the user *thinks* they are inside the proot because they typed `linuxify shell` and got a prompt. What actually happens is that `linuxify shell` execs proot, which execs the proot's shell, but the user's `node` is still Termux's Node (because the Termux `node` is on `PATH` before the proot's `node`). The fix is to ensure the proot's `node` wins on `PATH` — which is what `linuxify shell` does, but only after the proot's environment is set up. If the user invokes `node` *before* `linuxify shell` finishes setting up, they get the Termux Node.

There is a second, subtler issue: even inside the proot, some Node built-ins query the kernel directly (e.g., `os.release()` calls `uname()`), and `uname()` inside proot still reports the host kernel (Android). So `process.platform` might be `"linux"` but `os.release()` might be `"4.14.190-perf+"` (an Android kernel version). This is correct proot behavior — proot does not virtualize the kernel — but it confuses tools that check the kernel version.

The syscall flow, for the curious:

```
node → process.platform   (set at compile time from __ANDROID__/__linux__)
node → os.release()       → uname(2) syscall → proot intercepts → host kernel
node → os.arch()          → set at compile time from __aarch64__/__x86_64__
node → process.arch       → set at compile time (same as os.arch)
```

proot intercepts syscalls via `ptrace` (or its built-in syscall translator). For most syscalls, proot rewrites the path arguments (so `/proc/self/exe` resolves to the proot's binary, not the host's) but does not rewrite the *return values* of syscalls like `uname`. So `uname` returns the host's kernel info even inside proot. This is by design: proot is not a virtual machine, it is a syscall-translation layer, and the kernel is still the host's kernel.

The takeaway for Linuxify is: `process.platform` and `process.arch` are compile-time constants of the Node binary, so they are determined by *which Node binary is running*, not by where it is running. To make a tool see `process.platform === "linux"`, Linuxify must ensure the tool runs against the proot's Node (built with `__linux__`), not the Termux host's Node (built with `__ANDROID__`). For tools that hardcode platform checks in their *source* (so even the proot's Node sees them fail because the source checks `process.platform` against `"linux"` and the tool was loaded in a context where `process.platform` was somehow `"android"` — e.g., a precompiled binary blob), Linuxify's patcher applies source patches (see [patcher-engine.md](patcher-engine.md) §2.1).

## 2. Detection Vectors

Linuxify detects the host platform through several independent vectors, each with different trust levels and use cases. Using multiple vectors lets the patcher cross-check its conclusions and handle edge cases (e.g., a custom ROM that reports a different `getprop` value).

**`uname -a`** is the primary vector. Inside proot, it reports the host kernel: e.g., `Linux localhost 4.14.190-perf+ #1 SMP PREEMPT ... aarch64 Android`. The `Android` token at the end is a strong signal that the host is Android, even if `process.platform` is `"linux"`. Linuxify parses `uname` to extract the kernel version (for the compat matrix), the arch (for binary selection), and the `Android` token (for the platform-detection sanity check).

**`/proc/version`** is a secondary vector that reports the same information as `uname` but in a slightly different format. Linuxify reads it as a cross-check; if `uname` and `/proc/version` disagree (which would indicate a very unusual setup), Linuxify warns.

**`getprop ro.build.version.release`** is an Android-specific vector. `getprop` is a binary on Android that reads system properties; `ro.build.version.release` is the user-visible Android version (e.g., `14`). Linuxify runs `getprop` (which is on the host's PATH but not inside the proot) at bootstrap time to record the Android version in `state.json`. This is used for the compat matrix (see §9) and for the `host.android_version` doctor check.

**`os.arch()` and `process.arch`** in Node are compile-time constants. Linuxify reads them to determine the binary architecture (`arm64`, `arm`, `x64`). These are always consistent with the Node binary being run; if they disagree with `uname -m`, it indicates a misconfigured environment (e.g., a 32-bit Node on a 64-bit kernel).

**`process.config.variables`** in Node exposes the compile-time options Node was built with, including `host_arch`, `target_arch`, and `v8_enable_i18n`. Linuxify uses this in the `linuxify env` command to show the user exactly what their Node was built for. It is also useful for diagnosing "why does this native module not load" issues: if `target_arch` is `arm64` but the module is `x64`, the module will not load.

## 3. The Three-Layer Platform Model

Linuxify thinks about platform in three layers. Conflating them is the source of most "why doesn't this work" confusion, so the model is worth internalizing.

**Layer 1: Host.** This is the Android device: the kernel, the CPU arch, the ABI. The host is fixed for a given device. Linuxify cannot change it. The host's kernel is what proot translates from; the host's arch is what binaries must match. The host is what `uname` reports.

**Layer 2: proot.** This is the Linux userland inside the proot: glibc, the FHS directory layout, the package manager (apt/pacman/apk), the system configuration files. The proot is what makes the environment "feel like Linux" — it has `/etc`, `/usr`, `/var`, `/home`, and so on. The proot is what `ldd --version`, `cat /etc/os-release`, and `apt list` report on.

**Layer 3: User-facing.** This is what CLIs see when they query their environment: `process.platform`, `process.arch`, `os.release()`, `os.platform()`, `uname`, `getenv("OS")`, etc. Linuxify's job is to make this layer report Linux-despite-Android-host. This is the layer the patcher manipulates.

The three-layer model is what makes Linuxify's design coherent. The host is immutable; Linuxify does not try to change it. The proot is a stable, predictable Linux userland that Linuxify fully controls. The user-facing layer is the surface where Linuxify applies overrides (env vars, source patches, preload modules) so that tools written for "Linux" work even though the host is Android.

The model also explains what Linuxify cannot do. It cannot make a 64-bit-only binary run on a 32-bit kernel (host arch mismatch). It cannot make a binary that depends on a syscall the host kernel does not support work (kernel feature mismatch — e.g., `unshare` for user namespaces is restricted on many Android kernels). It cannot make a tool that requires a GUI work without an X server (the proot does not include one by default). For these cases, Linuxify's role is to detect the issue (via the doctor) and document the workaround (e.g., "use proot-termux-fork for Android 14+", see §9).

## 4. Platform Override Strategies

Linuxify applies platform overrides in a specific order of preference. The order is from least invasive to most invasive: the earlier strategies are preferred because they are easier to maintain and less likely to break with tool updates.

### 4.1 Env var override (preferred)

The least-invasive strategy is to set an environment variable that the tool respects. Many modern Node tools check `process.env.PLATFORM` or `process.env.FORCE_PLATFORM` before falling back to `process.platform`. For these tools, the package YAML's `env:` section sets the appropriate variable, and no source patch is needed:

```yaml
env:
  FORCE_PLATFORM: linux
  PRETEND_LINUX: "1"
```

The launcher applies these env overrides at invocation time (see [../06-launcher/launcher-architecture.md](../06-launcher/launcher-architecture.md) §5). The advantage is that the tool's source is untouched, so updates do not break the override. The disadvantage is that it only works for tools that already respect such env vars (which is a minority).

A variant of this strategy is the **preload module**. Linuxify ships a small `linuxify-preload.js` that, when loaded via `NODE_OPTIONS=--require ~/.linuxify/preload/linuxify-preload.js`, monkey-patches `process.platform` to return `"linux"`:

```javascript
// linuxify-preload.js
const originalPlatform = process.platform;
Object.defineProperty(process, 'platform', {
  get() { return 'linux'; },
  configurable: true,
});
```

The launcher sets `NODE_OPTIONS` for packages that opt into this strategy (declared in the package YAML as `platform_strategy: preload`). This is more invasive than an env var (it changes a global) but less invasive than a source patch (the tool's source is untouched, so updates still work).

### 4.2 Source patch (second choice)

For tools that hardcode platform checks in their source (`if (process.platform === "linux")`) and do not respect env vars, the patcher applies a source patch (see [patcher-engine.md](patcher-engine.md) §2.1). This rewrites the check to `["linux", "android"].includes(process.platform)` or, in extreme cases, replaces the entire condition with `true`. Source patches are necessary for tools that do not respect env overrides, but they are fragile: an upstream update that changes the formatting or the surrounding code can break the patch, requiring a patch update.

The patcher's verify command (see [patcher-engine.md](patcher-engine.md) §6) is what catches broken source patches. If an upstream update changes the source so the regex no longer matches, the patch is a no-op (no change made, verify fails because the original behavior is still present). The patcher reports this to the user, who can run `linuxify patch <pkg>` to attempt re-application, or check the patch library for an updated patch.

### 4.3 Binary patch (last resort)

For precompiled binaries (e.g., a Rust CLI distributed as a single static binary), source patches are not possible (no source to patch). In this case, Linuxify can use `patchelf` to change the binary's interpreter (the dynamic linker path) or its `RUNPATH`. This is rare and is used only when:

- The binary hardcodes `/lib/ld-linux-aarch64.so.1` but the proot's linker is at `/usr/lib/ld-linux-aarch64.so.1`.
- The binary has an RPATH that points outside the proot.

`patchelf` is invoked by the patcher as a `shell`-type patch (see [patcher-engine.md](patcher-engine.md) §5.6). The verify command runs the binary with `--version` to confirm the patch worked. Binary patches are not reversible in the same way as source patches (the original binary is backed up, but `patchelf` is not perfectly idempotent); the patcher records the binary's SHA-256 before and after, and rollback restores from the backup.

## 5. Architecture Handling

Android phones are overwhelmingly aarch64. Many CLIs, however, ship x64-only native modules — either because the maintainer did not build for arm64, or because a specific optional dependency is x64-only. Linuxify's strategy is layered:

1. **Install the arm64 build if available.** For Node packages, this means checking `npm view <pkg>` for `optionalDependencies` with `arm64` in the os/cpu field, and ensuring the install selects the arm64 variant. For prebuilt binaries, this means choosing the `arm64` download URL over the `x64` one. Linuxify's package YAMLs declare the arch explicitly when the upstream does not auto-detect.

2. **Rebuild the native module from source inside proot.** When no arm64 prebuilt exists, the patcher (with the user's permission) runs `npm rebuild <pkg>` inside the proot. This requires `build-essential`, `python3`, and `make` to be installed in the proot distro (Linuxify's bootstrap Stage 4 installs these by default). The rebuild can take minutes for large modules (e.g., `better-sqlite3`), but it produces a working arm64 binary. The result is cached in `~/.linuxify/cache/rebuild/<pkg>/` so subsequent installs are fast.

3. **Fall back to a pure-JS implementation.** Some packages ship both a native module and a pure-JS fallback (e.g., `bcrypt` has `bcrypt` (native) and `bcryptjs` (pure JS)). When the native module cannot be loaded, the patcher can patch the package's `require()` calls to use the pure-JS fallback. This is slower at runtime but always works.

4. **QEMU emulation (future, slow).** For packages with no arm64 build and no pure-JS fallback, Linuxify's long-term plan is to invoke the x64 binary under QEMU user-mode emulation. This works (QEMU translates x64 instructions to arm64 at runtime) but is 5-20× slower than native execution. It is acceptable for tools that are invoked infrequently (e.g., a one-shot code generator) but not for interactive tools. QEMU support is on the v2 roadmap (see [../15-roadmap/release-roadmap.md](../15-roadmap/release-roadmap.md)) and is not in v1.

The `compat.arch_supported` doctor check (see [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md) §3.7) reports which strategy was used for each installed package. If a package is running under a slow strategy (pure-JS fallback), the doctor warns the user so they can decide whether to install a different version.

## 6. The `linuxify env` Command

`linuxify env` prints the resolved environment a CLI will see when launched. It is the single most useful command for diagnosing platform issues. The output looks like:

```
$ linuxify env
Linuxify v0.1.0
Active distro: ubuntu (24.04)
Active runtimes: node 22.11.0, python 3.12.3, git 2.49.0

── From inside proot ──
process.platform    linux
process.arch        arm64
process.version     v22.11.0
os.release()        4.14.190-perf+
os.type()           Linux
os.hostname()       localhost
uname -a            Linux localhost 4.14.190-perf+ ... aarch64 GNU/Linux
ldd --version       ld.so (Ubuntu glibc 2.39) stable release version 2.39
/etc/os-release     Ubuntu 24.04 LTS

── From Termux host ──
uname -a            Linux localhost 4.14.190-perf+ ... aarch64 Android
getprop ro.build.version.release  14
node --version      v22.11.0 (Termux)
arch                aarch64
```

The command runs both inside the proot (to show what CLIs see) and on the Termux host (to show the underlying platform). Comparing the two columns immediately reveals discrepancies: e.g., if `process.platform` is `android` instead of `linux`, the user knows the launcher is invoking the wrong Node. If `os.release()` reports an Android kernel version, the user knows proot is correctly passing through the host kernel (this is expected, not a bug). If `ldd --version` reports an old glibc, the user knows they need to switch to a newer distro.

`linuxify env` is invoked by the diagnostic flow in [../07-doctor/diagnostics.md](../07-doctor/diagnostics.md) §3.1 (and many other entries). It is also the input to the bug-report template (see [../07-doctor/diagnostics.md](../07-doctor/diagnostics.md) §7): `linuxify doctor --markdown` includes `linuxify env` output, so the maintainer reviewing the issue can immediately see the user's exact platform configuration.

## 7. Compatibility Database Link

Each known CLI has a compatibility entry in the compatibility database, documented in [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md). The entry describes:

- Which patches are needed (by patch ID, matching the patch library).
- Which Android versions are known to work, and which have known issues.
- Which distros are tested (Ubuntu 24.04, Debian 12, etc.).
- Which arches are supported (e.g., "arm64 only; x64 not tested").
- Which optional features are unavailable (e.g., "GPU acceleration not supported inside proot").
- A link to the upstream issue tracker, if relevant.

The compatibility database is the source of truth for "does this tool work on Linuxify?" When a user runs `linuxify add <pkg>`, the CLI queries the compat DB (cached for 24 hours) and warns the user if the package has known issues on their Android version or arch. The doctor's `compat.arch_supported` and `compat.glibc_version` checks (see [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md) §3.7) cross-reference the compat DB to give specific, actionable warnings.

Contributors who add a new package to the registry must also add a compat DB entry (see [../16-community/contribution-guidelines.md](../16-community/contribution-guidelines.md) for the contribution process). The compat DB is versioned alongside the patch library: a new compat entry is a minor version bump; a regression (a previously-working tool stops working on a new Android version) is a major version bump.

## 8. Detection Runbook

When a CLI fails with "Unsupported platform" or a similar platform-related error, the runbook is:

1. **Run `linuxify doctor --check compat`.** This runs the three compatibility checks (`platform_patched`, `arch_supported`, `glibc_version`) and reports which (if any) are failing. If `platform_patched` fails, the tool's source has unpatched platform checks. If `arch_supported` fails, the tool's native module is the wrong arch. If `glibc_version` fails, the distro is too old.
2. **Run `linuxify env`** to confirm what the CLI actually sees. Compare `process.platform` and `process.arch` to what the tool expects. If `process.platform` is `"android"`, the launcher is using the Termux Node instead of the proot Node — fix the PATH or reinstall the runtime. If `process.platform` is `"linux"` but the tool still fails, the tool's source has a hardcoded check that needs patching.
3. **Check the compat DB** at [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md) for the failing tool. If there is an entry, follow the prescribed patches. If there is no entry, proceed to step 4.
4. **Identify the failing code.** Inside the proot, run `grep -r "process.platform" node_modules/<pkg>/` (or the equivalent for the tool's language). The output will show every platform check in the tool's source. Look for the one that is failing (often obvious from the error message's stack trace).
5. **Author a patch.** Follow the patch authoring guide in [patcher-engine.md](patcher-engine.md) §10. Test locally with `linuxify add <pkg> --local ./my-pkg.yml`.
6. **Contribute.** Open a PR to the patch library (see [../16-community/contribution-guidelines.md](../16-community/contribution-guidelines.md)). The maintainers will review, run CI tests, and (if accepted) merge. The patch will be available to all Linuxify users on the next library refresh.

This runbook is the same one the doctor's `fixDocs` field points to for `compat.platform_patched` failures. The doctor's job is to get the user to step 1; the rest of the runbook is a human (or AI agent) workflow.

## 9. Edge Cases

proot on Android is subject to kernel-version-specific quirks. Linuxify maintains a per-Android-version compat matrix in `~/.linuxify/distros/<name>/compat/android-<version>.json` (copied from the compat DB at install time). The notable edge cases:

**Android 14+** introduced changes to `fstatat` and related syscalls that cause the stable `proot` binary to segfault. The workaround is to switch to the `proot-termux-fork` binary, which patches the syscall translator. Linuxify's bootstrap detects Android 14+ and prompts the user to install the fork; the doctor's `distro.<name>.bootable` check fails with a clear remediation if the fork is not installed. See [../07-doctor/diagnostics.md](../07-doctor/diagnostics.md) §3.3 for the full diagnosis flow.

**Android 12+** restricted `ptrace`-based syscall interception (which proot uses) in some SELinux policies. On affected devices, proot login fails with "Operation not permitted". The workaround is to use `proot` with `--kill-on-exit` and `--root-id` (which bypasses some ptrace restrictions) or to root the device and use `chroot` instead. Linuxify's doctor detects this case and recommends the workaround.

**Android 9 and 10** have older kernels that lack some features proot relies on (e.g., `memfd_create` was added in kernel 3.17; some Android 9 devices ship kernel 3.18, which works, but a few ship 3.10, which does not). Linuxify's bootstrap checks the kernel version at Stage 0 and refuses to proceed on unsupported kernels.

**Custom ROMs** sometimes report unusual `getprop` values (e.g., a LineageOS build might report `ro.build.version.release = 14` but `ro.build.version.sdk = 33`, which is inconsistent). Linuxify's compat matrix keys on the API level (SDK), not the user-visible version, so this is handled correctly. The doctor's `host.android_version` check warns if the SDK and version are inconsistent (which usually indicates a custom ROM and may indicate other quirks).

**Chromebooks running Android** (via the Android runtime on ChromeOS) report a different kernel (`x86_64` instead of `aarch64`). Linuxify supports this configuration (it is one of the target arches per the project context), but some prebuilt arm64 binaries obviously will not work. The doctor's `compat.arch_supported` check reports this case.

## 10. Testing Platform Patches

Linuxify's test suite (see [../12-testing/testing-strategy.md](../12-testing/testing-strategy.md) for the overall strategy) includes a dedicated platform-patch test matrix. The matrix runs each platform patch against:

- **Multiple Node versions**: 20 LTS, 22 LTS, 24 (current). This catches cases where a patch works on one Node version but not another (e.g., a regex that depends on a Node-specific syntax change).
- **Multiple distros**: Ubuntu 24.04, Debian 12, Alpine 3.20. This catches cases where a patch depends on a distro-specific file layout.
- **Multiple Android versions**: emulated Android 12, 14, 15 (via the test lab's device farm). This catches cases where a patch depends on Android-specific behavior.
- **Multiple arches**: arm64 (the primary target), x64 (for Chromebook testing). armv7l is tested on a best-effort basis.

Each test case applies the patch, runs the verify command, runs the tool's own test suite (if it has one), and asserts that the patch produces the expected behavior. Failures are reported with the full matrix coordinates (Node version, distro, Android version, arch) so the patch author can reproduce the failure.

The test matrix is run on every PR to the patch library (via CI, see [../14-cicd/cicd-design.md](../14-cicd/cicd-design.md)). A patch that passes on the author's device but fails on a different Android version is caught before merge. This is what gives Linuxify the confidence to recommend patches in the doctor's `fixCommand`: every patch in the library has been tested across the full matrix.

The test suite also includes regression tests for known-broken cases: e.g., a test that verifies `process.platform` is `"linux"` inside the proot (catching regressions in the preload module), a test that verifies the proot's `uname` reports the host kernel (catching regressions in proot's syscall translator), and a test that verifies the launcher's PATH ordering puts the proot Node first (catching regressions in the launcher's env setup). These regression tests are the safety net that lets Linuxify evolve without silently breaking the platform contract.
