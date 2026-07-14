# Diagnostics Deep Dive

> **Audience**: End users who are staring at a broken Linuxify environment, and AI coding agents that are trying to recover one. This is the practical companion to [doctor-engine.md](doctor-engine.md): where that doc explains *how the Doctor works*, this doc explains *how to use the Doctor and friends to fix things*. For systematic troubleshooting recipes by symptom, see also [../22-operations/troubleshooting.md](../22-operations/troubleshooting.md).

## 1. Diagnostic Philosophy

Linuxify's diagnostic philosophy is **"show, don't hide."** Every error message the CLI emits includes four parts: (a) **what** went wrong, in one sentence; (b) **why** it went wrong, in one or two sentences with the relevant technical detail (file path, exit code, expected vs. actual); (c) **fix command**, a copy-pasteable shell command that resolves the issue in the common case; (d) **docs link**, a URL or relative path into the docs where the issue is discussed in depth. This four-part structure is the contract enforced by the CLI error-rendering layer (see [../03-cli/cli-specification.md](../03-cli/cli-specification.md) §13) and the same structure is mirrored in the Doctor's `fixCommand` and `fixDocs` fields.

The motivation is simple: the user's most common question when something breaks is "what do I do now?" If the CLI answers that question in the error message itself, the user does not need to open a browser, search the issue tracker, or ask on Discord. This is the difference between a tool that *reports* errors and a tool that *resolves* them. Every Linuxify error is a small interaction-design problem, and the four-part structure is the solution to it.

Layered detail is provided through three verbosity flags. The default output is brief — one or two lines per error, suitable for a phone screen. `--verbose` adds a stack trace (for unexpected exceptions) and the underlying system call that failed (e.g., `ENOENT` for a missing file, `EACCES` for a permission issue). `--debug` adds everything: full environment, full command line of any spawned process, full stdout/stderr of subprocesses, and a trace of the dispatcher's path through the code. The `--debug` output is intended for bug reports and is the default when `LINUXIFY_DEBUG=1` is set in the environment.

The philosophy extends to logging. Every command writes to `~/.linuxify/logs/linuxify.log` (see §4), and the log is structured so that a `grep` for `E_` (the error-code prefix defined in [../02-architecture/system-architecture.md](../02-architecture/system-architecture.md) §9) produces a complete transcript of every error the CLI has encountered. The user is always one command away from a full diagnostic dump.

## 2. Diagnostic Toolkit

Linuxify ships six commands that together form the diagnostic toolkit. Knowing which to use when is the first skill for any contributor.

**`linuxify doctor`** is the front-line tool. Run it whenever "something is wrong" and you do not yet know what. It performs a comprehensive sweep of host, bootstrap, distro, runtime, PATH, packages, compatibility, network, and services (see [doctor-engine.md](doctor-engine.md) §3 for the full catalog). It is read-only and safe to run any time. Use `--profile deep` for thorough checks (including network) and `--json` for machine-readable output.

**`linuxify env`** prints the resolved environment a CLI will see when launched. This includes `process.platform` (should be `linux` after patching), `process.arch` (e.g. `arm64`), `process.version` (Node version), `os.release()`, `uname -a` from inside proot, glibc version, and the active distro. It is the single most useful command when debugging "Unsupported platform" errors because it shows exactly what the failing CLI sees. See §6 of [../08-patcher/platform-detection.md](../08-patcher/platform-detection.md) for a detailed walkthrough.

**`linuxify info <pkg>`** shows the manifest entry for an installed package: declared version, installed version, patch fingerprint, declared doctor checks, env overrides, declared dependencies. Use it when a single package is misbehaving — for example, when `cline` runs but reports the wrong version, `linuxify info cline` will show whether the manifest version matches the installed version and whether all patches are still applied.

**`linuxify logs`** tails `~/.linuxify/logs/linuxify.log`. Without arguments, it shows the last 50 lines. With `--follow`, it tails in real time (useful when running a failing command in another terminal). With `--since <duration>`, it shows only entries from the last N minutes/hours. With `--grep <pattern>`, it filters. The `linuxify logs` command is a thin wrapper around `tail`/`grep` that knows the log location, so you can also use raw shell tools (see §4).

**`linuxify config show`** prints the resolved configuration: the contents of `~/.linuxify/config.toml` after merging with profile overrides and environment variables. Use it when you suspect a misconfiguration — for example, when `linuxify add` is installing to the wrong distro because `[default] distro = "debian"` was set by mistake.

**`linuxify state show`** prints the contents of `~/.linuxify/state.json`: the active distro, the runtime versions, the last bootstrap timestamp, the last doctor result summary. It is the machine-managed counterpart to `config show` and is useful when state has drifted (e.g., a user manually deleted a distro directory but `state.json` still claims it is active). `state show` is read-only; `state set` (used by `linuxify use`) is the only sanctioned mutator.

## 3. Common Issue Catalog

The catalog below covers 18 real-world issues, each with the user-visible symptom, the root cause, the diagnosis command, and the fix. These are the same issues tracked in [../22-operations/troubleshooting.md](../22-operations/troubleshooting.md), but here they are framed as Doctor-driven diagnosis flows rather than as prose explanations.

### 3.1 "Cline fails with `Unsupported platform: android-arm64`"

**Symptom**: User runs `cline` and gets `Error: Unsupported platform: android-arm64` before the agent starts.

**Root cause**: Cline's source contains `if (process.platform === "linux")` gates that fail because `process.platform` reports `"android"` inside proot (see [../08-patcher/platform-detection.md](../08-patcher/platform-detection.md) §1 for the syscall explanation).

**Diagnosis**: `linuxify doctor --check compat.platform_patched`. If this returns `fail`, the platform patch is not applied. If it returns `ok`, run `linuxify env` to confirm the Cline process actually sees `process.platform === "linux"` — sometimes the patch is applied globally but a specific tool's launcher is missing the env override.

**Fix**: `linuxify patch cline` re-applies the platform patch. If the patch is already applied but the tool still fails, run `linuxify patch cline --rollback-all && linuxify patch cline` to force a clean re-application.

### 3.2 "Node version mismatch after upgrade"

**Symptom**: User ran `apt install nodejs` inside proot (or `npm install -g n` and `n latest`), and now `linuxify run cline --version` reports a different Node version than `node --version` from a Termux shell.

**Root cause**: There are now two Node binaries: the Linuxify-managed one at `~/.linuxify/runtimes/node/22.11.0/bin/node` and the apt-installed one at `/usr/bin/node`. The launcher's PATH ordering should prefer the Linuxify one, but if the user edited their shell rc files, the wrong one may win.

**Diagnosis**: `linuxify doctor --check runtime.node.version,runtime.node.executable`. The `executable` check shows the absolute path of `node` as resolved by the launcher's PATH. If the path is `/usr/bin/node`, the apt-installed Node is winning.

**Fix**: `linuxify runtimes use node 22.11.0` re-symlinks the Linuxify Node. If the user genuinely wants a different Node version, `linuxify runtimes install node <version>` then `linuxify runtimes use node <version>`.

### 3.3 "proot segfault on Android 14"

**Symptom**: After a phone update to Android 14, `linuxify shell` exits immediately with `Segmentation fault` and no other output.

**Root cause**: Android 14's kernel changed the behavior of `fstatat` and related syscalls in a way that the stable `proot` binary does not handle. This is a known regression documented in the compat matrix at `~/.linuxify/distros/<name>/compat/`.

**Diagnosis**: `linuxify doctor --profile deep --check distro.ubuntu.bootable`. The check's `detail` field will contain the proot exit signal (SIGSEGV) and the failing syscall if `strace` is available.

**Fix**: Switch to the patched proot fork: `linuxify config set bootstrap.proot_binary proot-termux-fork` then `linuxify init --from-stage 3`. This re-installs the rootfs using the forked proot. See the compat matrix entry for Android 14 in [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md).

### 3.4 "npm install fails with EACCES"

**Symptom**: Inside `linuxify shell`, running `npm install <pkg>` fails with `EACCES: permission denied, mkdir '/usr/lib/node_modules/<pkg>'`.

**Root cause**: Global npm installs go to `/usr/lib/node_modules/`, which requires root in a real Linux system. Inside proot, the user is `linuxify` (UID 1000), not root, so the install fails. Linuxify's managed runtimes install globals to `~/.linuxify/runtimes/node/<ver>/lib/node_modules/` instead, but if the user's npm config points to the system path, this fails.

**Diagnosis**: `linuxify doctor --check runtime.npm.version` (which also checks the npm prefix). `linuxify config show` will show whether `[npm] prefix` is set.

**Fix**: `linuxify config set npm.prefix ~/.linuxify/runtimes/node/current/lib/node_modules` then re-run the install. Or, prefer `linuxify add <pkg>` over manual `npm install -g`, which handles the prefix automatically.

### 3.5 "Binary launches but immediately exits"

**Symptom**: `linuxify run <pkg>` prints nothing and exits with code 127 or 134.

**Root cause**: A native library the binary depends on is missing inside proot. Common with Node native modules (e.g., `node-pty`, `better-sqlite3`) and with Rust binaries that link against a newer glibc.

**Diagnosis**: Inside `linuxify shell`, run `ldd $(which <pkg>)` (for binaries) or `node -e "require('<pkg>')"` (for Node modules). The output will show `not found` for missing libraries.

**Fix**: Install the missing library: `apt install libstdc++6` (or whichever is reported missing). If the issue is glibc version, switch to a newer distro: `linuxify use ubuntu` (24.04 ships glibc 2.39).

### 3.6 "Cannot access /sdcard from inside CLI"

**Symptom**: A tool running inside `linuxify run` cannot read files in `/sdcard/` even though they exist from the Termux shell.

**Root cause**: The proot invocation does not bind-mount `/sdcard` (or the user's preferred host path) into the proot root. By default, Linuxify binds `$HOME`, `$TMPDIR`, and the Linuxify home, but not `/sdcard`.

**Diagnosis**: `linuxify doctor --check distro.ubuntu.bootable` (which also reports the bind-mount list in `detail`). Inspect `~/.linuxify/config.toml` `[run]` section for `bind_mounts`.

**Fix**: `linuxify config set run.bind_mounts '["/sdcard"]'` (or whichever path) then re-run. The launcher regenerates automatically on the next invocation.

### 3.7 "Slow proot startup"

**Symptom**: Every `linuxify run <pkg>` takes 3+ seconds before the tool starts, even for trivial invocations like `--version`.

**Root cause**: proot's startup cost is dominated by `--bind` processing. Each bind mount adds a small overhead; a long bind list (especially with `/sdcard` which has many files) can balloon startup. Also, `proot-distro`'s `login` command does a rootfs integrity check on every invocation unless disabled.

**Diagnosis**: `time linuxify run <pkg> --version` from a Termux shell. `linuxify run <pkg> --profile <pkg>` prints a timing breakdown of the launcher's phases.

**Fix**: `linuxify config set run.skip_rootfs_check true` disables the integrity check (safe in normal use; re-enable if you suspect corruption). Audit bind mounts with `linuxify config show` and remove any you do not need.

### 3.8 "Disk full"

**Symptom**: `linuxify add <pkg>` fails with `ENOSPC` or `No space left on device`.

**Root cause**: The `~/.linuxify/` directory (which lives on `/data`) has filled the partition. Common culprits are old distro rootfs tarballs in `cache/`, accumulated npm cache in `cache/npm/`, and unused distros in `distros/`.

**Diagnosis**: `linuxify doctor --check host.storage_free`. `linuxify gc --dry-run` shows what would be cleaned up.

**Fix**: `linuxify gc` removes caches, old logs, and unused distro tarballs. `linuxify gc --distro <name>` removes an entire installed distro. For aggressive cleanup, `linuxify gc --aggressive` also prunes the npm cache (run `npm cache clean --force` inside proot afterward).

### 3.9 "Package install hangs on download"

**Symptom**: `linuxify add <pkg>` hangs at "Downloading rootfs..." or "Downloading <pkg>..." for minutes with no progress.

**Root cause**: The default mirror is unreachable from the user's network (common in regions with restricted internet access). The download is retrying with exponential backoff.

**Diagnosis**: `linuxify doctor --check network.ubuntu_mirror_reachable,network.npm_registry_reachable`. The check's `detail` will show the failing URL and the error.

**Fix**: Switch to a regional mirror: `linuxify config set ubuntu.mirror https://<regional-mirror>/ubuntu/`. For npm, `linuxify config set npm.registry https://<regional-mirror>/`. Restart the install. For fully offline use, pre-cache with `linuxify add <pkg> --download-only` on a working network, then transfer the cache directory.

### 3.10 "Wrong arch binary installed"

**Symptom**: A package installs without error, but `linuxify run <pkg>` fails with "cannot execute binary file: Exec format error" or an immediate segfault.

**Root cause**: The package's install step downloaded an x86_64 binary instead of an arm64 one. This happens with packages whose install scripts hardcode `x64` in the URL or that use `process.arch` to select the binary (and the arch patch is not applied to the installer).

**Diagnosis**: `linuxify doctor --check compat.arch_supported`. `uname -m` inside proot should report `aarch64`. `file $(which <pkg>)` shows the binary's architecture.

**Fix**: Uninstall and reinstall with the arch override: `linuxify remove <pkg> && linuxify add <pkg> --arch arm64`. If the package's YAML does not support arch overrides, check the compat DB at [../11-compat-db/compatibility-database.md](../11-compat-db/compatibility-database.md) for a known-good version.

### 3.11 "TERM not set, vim broken"

**Symptom**: Inside `linuxify shell`, `vim` (or `nano`, `tmux`, etc.) crashes with "terminal not set" or renders garbage.

**Root cause**: The launcher's environment propagation did not include `TERM`. This happens when the user's Termux shell does not export `TERM` (unusual but possible after a custom `.bashrc`).

**Diagnosis**: `linuxify env` should show `TERM=xterm-256color` (or similar). If it shows `TERM=` (empty), the env propagation is broken.

**Fix**: `export TERM=xterm-256color` in the Termux shell, then re-run. To make this permanent, add it to `~/.bashrc`. Alternatively, `linuxify config set env.TERM xterm-256color` to set it for all Linuxify-managed tools.

### 3.12 "SIGINT doesn't kill node process"

**Symptom**: User presses Ctrl+C to stop a running tool, but the Termux prompt does not return; the process is still running in the background.

**Root cause**: The launcher's signal forwarding is not working. This is the bug described in [../06-launcher/launcher-architecture.md](../06-launcher/launcher-architecture.md) §8 — if `setsid` is not invoked correctly, the inner CLI's process group is the same as the launcher's, and killing the launcher does not kill the child.

**Diagnosis**: `linuxify doctor --check pkg.<name>.binary_executes --verbose` — the verbose output includes the launcher's `setsid` invocation. If `setsid` is missing, this is a launcher bug.

**Fix**: `linuxify patch --regenerate-launcher <name>` rewrites the launcher with the correct `setsid` invocation. If the bug persists, file an issue with `linuxify doctor --markdown`.

### 3.13 "Codex crashes on first prompt"

**Symptom**: `codex` starts fine, but as soon as the user submits the first prompt, it exits with an "OpenAI API key not set" error.

**Root cause**: The launcher's env propagation does not pass through `OPENAI_API_KEY`. This is by design — secret-like variables are not persisted in launcher scripts (see [../02-architecture/system-architecture.md](../02-architecture/system-architecture.md) §6.1) — but it means the user must have the variable exported in their Termux shell.

**Diagnosis**: `linuxify env` should show `OPENAI_API_KEY` if it is exported. If not, the user forgot to export it.

**Fix**: `export OPENAI_API_KEY=sk-...` in the Termux shell, then re-run `codex`. To make this permanent, add it to `~/.bashrc` (but be careful with secrets in shell rc files — prefer a secrets manager).

### 3.14 "Aider can't find git"

**Symptom**: `aider` starts but reports "git not found" when trying to commit changes.

**Root cause**: `git` is on the Termux PATH but not on the proot PATH. This happens if the user installed git via `pkg install git` (Termux) but did not install it inside the proot distro via `apt install git`.

**Diagnosis**: `linuxify doctor --check runtime.git.version`. `linuxify run git --version` (which runs git *inside proot*) should print a version; if it prints "command not found", git is not installed in the distro.

**Fix**: `linuxify runtimes install git` installs git inside the proot distro. (This is the Linuxify-managed way; the alternative is `apt install git` inside `linuxify shell`, but Linuxify will not track that install.)

### 3.15 "Slow npm install inside proot"

**Symptom**: `npm install` inside `linuxify shell` is 5-10× slower than the same install on a Linux desktop.

**Root cause**: npm's cache is not bind-mounted into proot, so every install re-downloads all dependencies. Also, npm's default log level is verbose, which on Android's slow terminal I/O can dominate the install time.

**Diagnosis**: `linuxify doctor --check path.no_conflicts` (which also reports the npm cache location). `linuxify config show` shows whether `[npm] cache` is set.

**Fix**: `linuxify config set npm.cache ~/.linuxify/cache/npm` bind-mounts the cache. Also, `npm config set loglevel error` reduces I/O. For large installs, `npm install --prefer-offline` after a warm cache is dramatically faster.

### 3.16 "Python C extension import error"

**Symptom**: A Python tool (e.g., a pip-installed package using `numpy` or `pillow`) fails with `ImportError: cannot import name '_C'` or "undefined symbol".

**Root cause**: The C extension was compiled against a different Python ABI or a different glibc than the one inside the proot distro. This happens when a wheel is installed that was built for a different Python version, or when the user mixed Termux's Python with the proot's Python.

**Diagnosis**: `linuxify doctor --check runtime.python.version`. `linuxify run python3 -c "import sys; print(sys.executable, sys.version)"` confirms which Python is running.

**Fix**: Reinstall the package against the proot's Python: `linuxify run pip install --force-reinstall <pkg>`. If the wheel is the issue, `pip install --no-binary :all: <pkg>` forces a source build inside proot (requires `build-essential`).

### 3.17 "Launcher not on PATH after distro switch"

**Symptom**: User ran `linuxify use debian`, and now `cline` (which was installed under Ubuntu) is not found from the Termux shell.

**Root cause**: Launchers are regenerated on distro switch *only for packages installed in the new distro*. If `cline` was installed under Ubuntu and the user switches to Debian, the Ubuntu launcher is removed (because it would not work) but no Debian launcher is created (because `cline` is not installed in Debian).

**Diagnosis**: `linuxify doctor --check path.linuxify_bin,pkg.cline.launcher_exists`. The first check passes (PATH is correct); the second fails (launcher missing).

**Fix**: Either `linuxify add cline` in the new distro (re-installs), or `linuxify use ubuntu` to switch back. If you want the same package available in both distros, install it in each.

### 3.18 "apt update fails inside proot"

**Symptom**: Inside `linuxify shell`, `apt update` fails with "Temporary failure resolving" or "Release file is not valid yet".

**Root cause**: DNS resolution inside proot is broken (common when `/etc/resolv.conf` is not bind-mounted correctly) or the system clock is wrong (so apt's signed-by verification fails because the Release file's date looks like it is in the future or past).

**Diagnosis**: `linuxify doctor --check network.dns,distro.ubuntu.package_manager_working`. `date` inside `linuxify shell` shows the proot's clock; if it differs from the Termux clock by more than a few seconds, clock skew is the issue.

**Fix**: For DNS, `linuxify config set run.bind_mounts '["/etc/resolv.conf"]'` ensures the host's resolver config is used. For clock skew, `linuxify run ntpd -gq` (if `ntpdate` is installed) or just `date -s "<correct time>"` inside the proot shell as a one-time fix.

### 3.19 "Doctor says OK but tool still fails"

**Symptom**: `linuxify doctor` is all green, but `linuxify run <pkg>` still fails.

**Root cause**: The default `standard` profile does not actually execute the tool — it only checks that the launcher exists and is executable. The tool may still fail at runtime due to a missing runtime dependency, a misconfiguration, or a network issue that only manifests when the tool tries to reach a specific endpoint.

**Diagnosis**: Re-run with `linuxify doctor --profile deep` (which runs the tool's `--version` and any declared health checks). If deep is also green, run the tool with `--debug`: `linuxify run <pkg> --debug` (or set `LINUXIFY_DEBUG=1`).

**Fix**: The `--debug` output will include the tool's stderr; that stderr is usually the actual error message. File an issue with `linuxify doctor --markdown` plus the `--debug` transcript.

## 4. Log Analysis

Linuxify's main log is at `~/.linuxify/logs/linuxify.log`. It is append-only, rotated at 5 MB (one rotated copy kept as `linuxify.log.1`), and never contains secrets (the logger redacts values of environment variables matching `*_TOKEN`, `*_KEY`, `API_*`, `*_SECRET` — see [../03-cli/cli-specification.md](../03-cli/cli-specification.md) §8).

The log format is one line per event, in a structured-but-human-readable form:

```
2025-01-15T14:32:11.123Z INFO  [bootstrap] stage 5 complete (linuxify home setup) duration=128ms
2025-01-15T14:32:11.456Z WARN  [doctor] check host.storage_free returned warn: only 1.8 GB free
2025-01-15T14:32:14.789Z ERROR [patcher] patch cline-001 failed verify: node exited with 1
2025-01-15T14:32:14.790Z ERROR [patcher] E_PATCH_VERIFY_FAILED patch_id=cline-001 file=node_modules/cline/dist/platform.js
```

The fields are: timestamp (ISO 8601 with milliseconds), level (`DEBUG`/`INFO`/`WARN`/`ERROR`), subsystem (in brackets), message, and structured key=value pairs. The error-code prefix `E_<SUBSYSTEM>_<DESCRIPTION>` (per [../02-architecture/system-architecture.md](../02-architecture/system-architecture.md) §9) appears on `ERROR` lines and is greppable.

Common `grep` recipes:

- `linuxify logs --grep "ERROR"` — show all errors.
- `linuxify logs --grep "E_BOOTSTRAP"` — show all bootstrap errors.
- `linuxify logs --grep "E_PATCH"` — show all patcher errors.
- `linuxify logs --since 1h --grep "WARN"` — show all warnings in the last hour.
- `linuxify logs --follow` — tail in real time (useful when reproducing an issue in another terminal).

The Doctor's history logs at `~/.linuxify/logs/doctor-<timestamp>.json` are JSON, not text, and are best inspected with `jq`:

```bash
# Show all checks that failed in the most recent doctor run
jq '.results[] | select(.status == "fail")' \
  ~/.linuxify/logs/doctor-$(ls ~/.linuxify/logs/ | grep -oP 'doctor-\K[^.]+' | tail -1).json

# Show the trend of a specific check over time
for f in ~/.linuxify/logs/doctor-*.json; do
  jq -r '"\(.timestamp) \(.results[] | select(.id == "runtime.node.version") | .status)"' "$f"
done
```

## 5. Crash Triage

When Linuxify itself crashes (not a managed tool, but the `linuxify` CLI), the triage process is:

1. **Capture the stack trace.** If the crash was an unhandled exception, the CLI prints a stack trace to stderr and writes the same trace to `~/.linuxify/logs/linuxify.log` with level `ERROR` and subsystem `core`. The trace includes the Linuxify version, the Node version, and the OS info.
2. **Re-run with `--debug`.** `linuxify <failing command> --debug` enables debug-level logging and includes the full environment, all spawned command lines, and all subprocess output. This is the input needed for a useful bug report.
3. **Check the doctor.** `linuxify doctor --profile deep` may reveal an environmental cause (e.g., corrupted rootfs, missing runtime) that triggered the crash.
4. **Generate a bug report body.** `linuxify doctor --markdown > issue-body.md` produces a ready-to-paste GitHub issue body (see §7) with all diagnostics pre-filled. Add the `--debug` transcript as an attached file or a `<details>` block.
5. **File the issue.** Use the bug-report issue template (see [../18-templates/github-templates.md](../18-templates/github-templates.md)) and paste the markdown body. The issue template auto-populates the Linuxify version, the Android version, and the device model from the doctor's output.

If the crash is reproducible only on a specific device or Android version, mention that explicitly. The maintainer team maintains a device test lab, and clear reproduction steps dramatically reduce the time to fix.

## 6. Performance Diagnosis

Slow `linuxify run` and slow `linuxify add` are the two most common performance complaints. Both have dedicated diagnostic paths.

For **slow `linuxify run`**, the first tool is `time linuxify run <pkg> --version`. This isolates the launcher overhead from the tool's own startup. A healthy number is 300-500 ms (proot startup + Node startup + tool's `--version` handler). If it is over 1 second, the bottleneck is almost always the launcher; run `linuxify run <pkg> --profile <pkg>` to print a phase-by-phase timing breakdown (proot spawn, env setup, exec, first-byte).

For **slow `linuxify add`**, the bottleneck is usually the network (downloading the package) or the patcher (AST parsing for large files). `linuxify add <pkg> --verbose` prints timing for each phase. If the network is the bottleneck, switch to a regional mirror (see §3.9). If the patcher is the bottleneck, check whether the patch type is `ast-js` or `ast-ts` — these are 10× slower than `regex` for large files. The patch author may be able to switch to a regex patch (see [../08-patcher/patcher-engine.md](../08-patcher/patcher-engine.md) §5).

For **slow `linuxify doctor`**, the most common cause is the network wave (when not cached). `linuxify doctor --profile standard` skips network checks by default. If even the standard profile is slow, check `~/.linuxify/cache/doctor-network.json` for a stuck cache entry, and run with `--no-cache` to bypass.

For **slow `linuxify shell` startup**, the cause is almost always proot's `--bind` processing. Audit the bind list with `linuxify config show` and remove any unnecessary entries. The `/sdcard` bind in particular is expensive because it has many files; if you only need a specific subdirectory, bind that instead.

## 7. Filing Bug Reports

`linuxify doctor --markdown > issue-body.md` produces a ready-to-paste GitHub issue body. The output includes:

- A header with the Linuxify version, the Android version, the device model (if available), and the active distro.
- The full doctor output (grouped by category, with all statuses).
- The contents of `~/.linuxify/config.toml` (with secrets redacted).
- The contents of `~/.linuxify/state.json`.
- The last 50 lines of `~/.linuxify/logs/linuxify.log`.
- A list of installed packages with versions and patch fingerprints.
- A "Reproduction steps" section left blank for the user to fill in.
- A "Expected behavior" and "Actual behavior" section, also blank.

The markdown output is designed to be self-contained: a maintainer should be able to understand the issue without asking follow-up questions. The user should review the output before posting to ensure no sensitive information slipped past the redaction filter (the filter is comprehensive, but a custom environment variable with an unusual name might not be caught).

The full template is documented in [../18-templates/github-templates.md](../18-templates/github-templates.md), and the issue-tracker workflow (triage labels, expected response time) is documented in [../16-community/contribution-guidelines.md](../16-community/contribution-guidelines.md). For security-sensitive issues, use the private disclosure process in [../13-security/security-model.md](../13-security/security-model.md) instead of the public issue tracker.
