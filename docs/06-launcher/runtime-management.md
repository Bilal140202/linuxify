# Runtime Management

> **Audience**: AI coding agents implementing the runtime layer (Node, Python, Rust, Go, Bun, Deno) and human contributors debugging "the wrong Node version is being used" or "native module rebuild" issues.
>
> **Scope**: This document covers the runtime abstraction, the six built-in runtimes, per-package runtime pinning, installation strategy, upgrade strategy, discovery, custom runtimes, PATH management, compatibility notes, performance, and health checks. For the launcher shim that invokes a binary using a specific runtime, see [launcher-architecture.md](launcher-architecture.md). For the bootstrap stage that installs the default runtimes, see [../05-bootstrap/bootstrap-design.md](../05-bootstrap/bootstrap-design.md) §2 Stage 4.

## 1. What is a "Runtime"?

A "runtime" in Linuxify is the language interpreter or toolchain that a CLI depends on at execution time. `cline` is a Node.js application — it requires the `node` runtime. `aider` is a Python application — it requires the `python` runtime. `rg` (ripgrep) is a static binary — it requires no runtime at all. `cargo install`-installed CLIs require the `rust` toolchain at install time but not at run time (they compile to static binaries). The runtime layer manages these dependencies.

Linuxify supports multiple versions of each runtime installed side-by-side, per distro. This is necessary because different packages pin different versions: `cline` may require Node ≥ 20, `codex` may require Node ≥ 22, and an older package may require Node 18 for backward compatibility. Without side-by-side installs, the user would have to choose one Node version and accept that some packages would not work. With side-by-side installs, each package gets the version it needs, selected at invocation time by a per-package shim.

The runtime layer is intentionally distinct from the package layer. A package is "what the user wants to run" (e.g. `cline`); a runtime is "what the package needs to run" (e.g. `node 22.11.0`). The package YAML's `runtime:` and `runtime_min_version:` fields declare the dependency; the runtime layer resolves it. This separation lets Linuxify reuse a single Node install across many packages (rather than bundling Node with each one, npm-style), and lets users upgrade runtimes independently of packages.

Runtimes are scoped to a distro (see [../05-bootstrap/distro-management.md](../05-bootstrap/distro-management.md) §4). The same Node version installed in Ubuntu is not visible from Debian; this is intentional, to avoid ABI cross-talk between glibc and musl or between different glibc versions. The storage cost is real (~80 MB per runtime per distro) but bounded, and the correctness guarantee is worth it.

## 2. Runtime Provider Interface

Every runtime is implemented as a `RuntimeProvider`, defined in `runtime/provider.ts`. The interface is symmetric to `DistroProvider` (see [../05-bootstrap/distro-management.md](../05-bootstrap/distro-management.md) §1) but scoped to a single distro:

```ts
export interface RuntimeProvider {
  readonly name: string;             // "node", "python", "rust", "go", "bun", "deno"
  readonly displayName: string;      // "Node.js", "Python", "Rust", ...
  readonly defaultVersion: string;   // resolved at call time, e.g. "22.11.0"

  install(version: string, opts: InstallOptions): Promise<InstallResult>;
  uninstall(version: string, opts: UninstallOptions): Promise<UninstallResult>;

  list(): Promise<RuntimeVersion[]>;           // installed versions
  default(): Promise<RuntimeVersion>;          // current default
  setDefault(version: string): Promise<void>;

  exec(version: string, cmd: string[], opts: ExecOptions): Promise<ExecResult>;
  pathFor(version: string): string;            // absolute path to the runtime's bin dir

  // Health
  healthCheck(version: string): Promise<HealthResult>;
}
```

The provider is instantiated per (distro, runtime name) pair. The `pathFor(version)` method is the workhorse used by the launcher: given a version, it returns the absolute path to the runtime's `bin/` directory inside the distro (e.g. `/home/linuxify/.local/share/linuxify/runtimes/node/22.11.0/bin`). The launcher prepends this to `PATH` when invoking the package binary, ensuring the right version is used.

The `exec(version, cmd, opts)` method is used by `linuxify runtimes exec node 22 --version` and by the doctor's health checks. It is a convenience wrapper that constructs the right `PATH` and invokes the binary; it is not used by the launcher (which constructs the proot invocation directly).

## 3. Built-in Runtimes

Six runtimes ship with Linuxify v1. Each is implemented in `runtime/providers/<name>.ts`.

### node

The Node.js runtime. Installed via the official NodeSource binary tarball (e.g. `node-v22.11.0-linux-arm64.tar.xz`), not via `apt` (Termux's Ubuntu ships Node 18, too old for many AI CLIs) and not via `nvm` (which adds a shell-init cost we explicitly want to avoid — see §11). The default version is the current LTS (Long Term Support), resolved at install time from `https://nodejs.org/dist/index.json`.

Multiple Node versions are installed side-by-side under `~/.linuxify/distros/<active>/home/linuxify/.local/share/linuxify/runtimes/node/<version>/`. The `node`, `npm`, `npx`, and `corepack` binaries are symlinked into `~/.linuxify/bin/` for the default version only; non-default versions are invoked via `linuxify run node@<version>` or via the per-package shim (see §4).

Node is the most-installed runtime — nearly every AI CLI in the v1 registry is a Node application. It is therefore the most performance-sensitive: the launcher's cold-start cost is dominated by Node startup, and the runtime layer takes care to avoid any per-invocation overhead beyond what Node itself imposes.

### python

The Python runtime. Installed via the distro's apt: `python3`, `python3-pip`, `python3-venv`, `python3-dev`. The default version is whatever the distro ships (Python 3.12 in Ubuntu 24.04, Python 3.11 in Debian 12). For users who need a specific Python version not available via apt (e.g. Python 3.13 on Ubuntu 24.04), Linuxify supports installing via `pyenv` as an opt-in: `linuxify runtimes install python 3.13 --via pyenv`. pyenv builds Python from source, which takes ~10 minutes on a mid-range phone and requires `build-essential` to be installed (it is, by default, after bootstrap Stage 3).

The `python3` binary is symlinked into `~/.linuxify/bin/`. Per-package virtualenvs are created at `~/.linuxify/packages/<active>/<name>/venv/` and used by Python packages (e.g. `aider`) to isolate their dependencies.

### rust

The Rust toolchain. Installed via `rustup` (the official installer), which itself is installed via `curl https://sh.rustup.rs | sh -s -- -y --default-toolchain stable`. The default toolchain is `stable`; users can install `nightly` or a specific version (e.g. `1.74.0`) via `linuxify runtimes install rust 1.74.0`. rustup manages side-by-side versions natively, so Linuxify's job is mostly to invoke rustup correctly and to expose `cargo`, `rustc`, and `rustup` on the PATH.

Rust is rarely required at run time (Rust CLIs are typically distributed as static binaries), but it is required at install time for any package whose install command is `cargo install <name>`. The runtime layer ensures `cargo` is on the PATH during `linuxify add` for such packages.

### go

The Go toolchain. Installed via the official tarball from `go.dev/dl/` (e.g. `go1.23.0.linux-arm64.tar.gz`), extracted to `runtimes/go/<version>/`. The default version is the latest stable. Like Rust, Go is rarely required at run time (Go CLIs are static binaries) but is required at install time for `go install <name>` packages.

### bun

The Bun runtime. Installed via the official install script (`curl -fsSL https://bun.sh/install | bash`). Bun is interesting because it is itself a Node-compatible runtime (it can run most Node applications faster than Node can) and a package manager. Linuxify treats Bun as a separate runtime: packages must explicitly declare `runtime: bun` to use it, and Bun-installed packages do not share Node's `node_modules`. The default version is the latest stable from `bun.sh`.

Bun's aarch64 support is newer and slightly less tested than its x86_64 support. The doctor's `bun_compat` check (see §12) flags known issues.

### deno

The Deno runtime. Installed via the official install script (`curl -fsSL https://deno.land/install.sh | sh`). Like Bun, Deno is a separate runtime that packages must explicitly opt into. The default version is the latest stable from `deno.land`.

Deno's native module story is different from Node's (Deno has its own module system, not npm), so Deno-targeted packages are rare in v1. The runtime is included for completeness and because a small number of CLIs (notably `deno-lint`, `deno-fmt`) require it.

## 4. Per-package Runtime Pinning

Each package YAML declares its runtime requirements:

```yaml
# packages/cline.yml
name: cline
runtime: node
runtime_min_version: "20"
```

When `linuxify add cline` runs, it asks the runtime layer whether `node` with a version `≥ 20` is installed. Three outcomes:

- **A compatible version is installed and is the default**: no action. The package will use the default Node.
- **A compatible version is installed but is not the default**: the package is registered with that version explicitly (in `~/.linuxify/packages/<active>/cline.json`'s `runtime_version` field). The launcher uses this version when invoking `cline`, even though it is not the default for other packages.
- **No compatible version is installed**: the runtime layer installs the latest LTS that satisfies the constraint (e.g. for `runtime_min_version: "20"`, it installs Node 22 LTS). The package is registered with the newly-installed version.

The per-package shim is implemented in the launcher. When `linuxify run cline` constructs the proot invocation (see [launcher-architecture.md](launcher-architecture.md) §4 Step 5), it reads `runtime_version` from the package metadata and prepends the corresponding `runtimes/node/<version>/bin` to `PATH`. The package binary then sees the right Node version without any `nvm use`-style shell initialization.

Multiple packages pinning different Node versions is fine: `cline` can use Node 22 while `legacy-cli` uses Node 18, and the user never has to think about it. The only constraint is that two packages cannot share a `node_modules` directory if they use different Node versions (because native modules are version-specific); Linuxify handles this by giving each package its own `node_modules` (via `npm install -g <name>` into a per-package prefix, not into the global prefix).

## 5. Runtime Installation Strategy

Runtimes are installed into the proot distro at `/home/linuxify/.local/share/linuxify/runtimes/<name>/<version>/`. The path is inside the distro (not on the Termux host) because runtime binaries are linked against the distro's libc, and running them outside the proot would either fail (Alpine's musl binaries on Termux's bionic libc) or produce confusing ABI mismatches (Ubuntu's glibc binaries on Debian's slightly-older glibc).

```
~/.linuxify/distros/ubuntu/home/linuxify/.local/share/linuxify/runtimes/
├── node/
│   ├── 22.11.0/        # default
│   │   ├── bin/node, npm, npx, corepack
│   │   ├── lib/node_modules/
│   │   └── include/
│   └── 20.18.0/        # legacy, for older packages
│       └── ...
├── python/
│   └── 3.12.3/         # system Python via apt; version is the apt version
│       └── (symlinks to /usr/bin/python3 etc.)
├── rust/
│   └── stable/
│       └── (rustup-managed)
├── go/
│   └── 1.23.0/
└── bun/
    └── 1.1.0/
```

The launcher symlinks the default version's binaries into `~/.linuxify/bin/` (on the Termux host), so `node` and `python3` are invocable from a plain Termux shell. The symlinks point at paths inside the proot distro directory; they resolve correctly because Termux can read those paths (they are regular files, not bind mounts).

Runtimes are **not shared across distros** in v1. The same Node version installed in Ubuntu and Debian occupies ~160 MB total (80 MB per distro). This is the trade-off for the correctness guarantee: a Node binary built against Ubuntu's glibc 2.39 is not guaranteed to work against Debian's glibc 2.36 (and musl-based Alpine is right out). Sharing would require a `LD_LIBRARY_PATH` shim and a per-distro compat layer, which is fragile. The v2 plan includes a shared cache for major-version runtime binaries that are verified to work across distros (see [../15-roadmap/release-roadmap.md](../15-roadmap/release-roadmap.md)).

## 6. Runtime Upgrade Strategy

`linuxify upgrade-runtime <name>` upgrades the named runtime to the latest version that satisfies all installed packages' `runtime_min_version` constraints. For `node`, this means: find the latest LTS such that every installed package's `runtime_min_version` is `≤` that LTS. If a package pins Node ≥ 18 and another pins Node ≥ 22, the upgrade target is the latest 22.x LTS.

The upgrade flow:

1. Download the new runtime version (idempotent — skipped if already in `runtimes/node/<new-version>/`).
2. For Node: run `npm reinstall -g` for every globally-installed npm package, targeting the new Node version. This rebuilds native modules against the new Node's headers.
3. Update `state.json`'s `distros.<active>.runtimes.node.default_version` field.
4. Re-symlink `~/.linuxify/bin/node` to the new version.
5. Regenerate launchers (see [launcher-architecture.md](launcher-architecture.md) §12) so that packages using the default Node now use the new version.
6. Run the doctor's `runtime_health` check (see §12) to verify the upgrade.

Old runtime versions are kept on disk until `linuxify gc` runs. `gc` removes any runtime version that is not the default and is not referenced by any installed package. The user is prompted before removal; `--yes` skips the prompt.

For Python, upgrading is more delicate because the system Python (via apt) cannot be upgraded without upgrading the entire distro. Linuxify's `upgrade-runtime python` therefore only upgrades pip and setuptools (via `pip install --upgrade pip setuptools`), not Python itself. To get a newer Python, the user must either upgrade the distro (`linuxify upgrade` with `--distro`) or install via pyenv (§3).

For Rust, `upgrade-runtime rust` runs `rustup update stable`, which is rustup's native upgrade path. For Go, it downloads the latest tarball and updates the symlink. For Bun and Deno, it runs the official upgrade commands (`bun upgrade` and `deno upgrade`).

## 7. Runtime Discovery

`linuxify runtimes list` shows all installed runtimes per distro:

```
$ linuxify runtimes list
Distro: ubuntu (active)

node
  * 22.11.0  (default, LTS)   installed 2025-07-14
    20.18.0  (LTS)            installed 2025-07-15
    used by: cline, codex, aider

python
  * 3.12.3   (default, system)  installed 2025-07-14
    used by: aider, goose

rust
  * stable   (default)          installed 2025-07-16
    used by: (no packages; toolchain only)

go
    (not installed)

bun
    (not installed)

deno
    (not installed)
```

`linuxify runtimes default node 22` sets the default Node version to the latest installed 22.x. The command accepts a major (`22`), a major.minor (`22.11`), or a full version (`22.11.0`). If the requested version is not installed, Linuxify offers to install it.

`linuxify runtimes info node 22.11.0` prints detailed information about a specific runtime version: install date, size, packages using it, native modules installed, health-check status.

`linuxify runtimes list --orphans` shows runtime versions not referenced by any package — candidates for `linuxify gc`.

## 8. Custom Runtimes

A custom runtime is any runtime not in the built-in list. The most common use cases are:

- **Tailscale's `tailscaled` binary**, which is shipped as a static binary but which some users want to manage as a "runtime" so that `linuxify upgrade-runtime tailscale` works uniformly.
- **A custom-patched Node** for debugging (e.g. with extra logging compiled in).
- **A pre-release runtime** (e.g. Node 23 nightly) for testing.

A custom runtime is registered via a plugin (see [../10-plugin-sdk/plugin-sdk.md](../10-plugin-sdk/plugin-sdk.md)) that implements the `RuntimeProvider` interface. The plugin is loaded from `~/.linuxify/plugins/<name>/`, registered with the runtime layer, and becomes available via `linuxify runtimes install <name> <version>`.

Custom runtime plugins must declare a `trust: user-confirmed` field in their manifest (similar to custom distros — see [../05-bootstrap/distro-management.md](../05-bootstrap/distro-management.md) §7). The first time a user runs `linuxify runtimes install <custom-name>`, Linuxify prints a trust prompt and requires explicit confirmation.

## 9. PATH Management

The `PATH` inside the proot, as constructed by the launcher (see [launcher-architecture.md](launcher-architecture.md) §5), is:

```
/home/linuxify/.local/share/linuxify/runtimes/node/<pkg-version>/bin
/home/linuxify/.local/share/linuxify/runtimes/python/<pkg-version>/bin    (if package is Python)
/home/linuxify/.local/share/linuxify/runtimes/<other>/<pkg-version>/bin   (if applicable)
/usr/local/bin
/usr/bin
/bin
```

The runtime `bin/` directories are prepended in package-declared-runtime order, so the package's primary runtime wins. This ensures that `node` (invoked by a Node package) resolves to the Node version the package pinned, not the system Node.

System paths (`/usr/local/bin`, `/usr/bin`, `/bin`) come after. This means a package that shells out to `python3` will get the distro's system Python (3.12 on Ubuntu 24.04), not necessarily the Python the package itself was installed under. This is usually what the user wants, but if a package needs a specific Python on its PATH, the package YAML's `env:` block can override `PATH` explicitly.

Termux's `$PREFIX/bin` is intentionally **not** on the proot PATH. Including it would expose Termux binaries (which are linked against Android's bionic libc, not the distro's glibc/musl) inside the proot, where they would fail in confusing ways. The Termux home is still accessible via the `/home/linuxify/host` bind (see [launcher-architecture.md](launcher-architecture.md) §7), so users who need to invoke a Termux binary from inside the proot can do so via the absolute path.

## 10. Compatibility Notes

The headline compatibility issue is Node native modules. A native module (e.g. `better-sqlite3`, `sharp`, `canvas`, `bcrypt`) is a `.node` file compiled against a specific Node major version's V8 ABI. A module compiled against Node 20 will not load under Node 22 (the V8 ABI changed), and vice versa. The error message is typically `was compiled against a different Node.js version using NODE_MODULE_VERSION X` — confusing to users who do not know about NODE_MODULE_VERSION.

Linuxify handles this in two ways:

1. **At install time**: `linuxify add <pkg>` installs the package under the Node version the package will use at run time. `npm install -g <pkg>` is invoked with that specific Node's `npm`, so native modules are compiled against the right headers by default.
2. **At upgrade time**: `linuxify upgrade-runtime node` runs `npm reinstall -g` for every globally-installed package, targeting the new Node version. This rebuilds native modules against the new headers.

The doctor's `native_module_check` (see §12) detects mismatched NODE_MODULE_VERSIONs and suggests `linuxify patch <pkg>` (which re-runs `npm reinstall -g <pkg>` for that package).

Python C extensions have the same issue: a `pyd`/`.so` compiled against Python 3.11 will not load under Python 3.12. The fix is the same: reinstall the package under the new Python. Linuxify's `upgrade-runtime python` does not change the system Python (see §6), so this is rarely triggered in practice.

Rust binaries are static by default and have no analogous ABI issue. Go binaries are also static. Bun and Deno have their own module systems (Bun is Node-compatible; Deno is not) and do not share the Node native module problem.

A second compatibility issue is glibc-vs-musl, already documented in [../05-bootstrap/distro-management.md](../05-bootstrap/distro-management.md) §9. A Node binary built against glibc (Ubuntu/Debian/Arch) will not run under musl (Alpine), and native modules compiled under glibc will not load in a musl Node. The runtime layer does not attempt to paper over this; users on Alpine must use Alpine-built runtimes (Linuxify's Node install script detects the libc and fetches the correct variant).

## 11. Performance

The runtime layer's design is explicitly optimized to avoid per-invocation overhead. The traditional `nvm`-style approach — where each shell invocation runs `nvm use <version>` to set up `PATH` — adds 100–300 ms of shell startup time. Linuxify avoids this entirely.

The launcher (see [launcher-architecture.md](launcher-architecture.md) §4) computes the right `PATH` once, in TypeScript, and passes it to `proot-distro login` as a `--env PATH=...` flag. There is no shell init, no `nvm` invocation, no `eval` step. The package binary sees the right `PATH` from the moment it starts.

The cold-start cost of `node` itself (200–500 ms for a typical Node CLI) is not under Linuxify's control; it is a property of the V8 engine. The runtime layer does not attempt to mitigate this. Users who need faster startup for short-lived commands are encouraged to use Bun (which has a 30–50 ms startup) or to use the "Direct" launcher variant (see [launcher-architecture.md](launcher-architecture.md) §11) for trusted tools.

Runtime installation is a one-time cost: ~30 s for Node (download + extract), ~5 s for Python (apt install), ~60 s for Rust (rustup downloads the toolchain), ~30 s for Go, ~10 s for Bun, ~10 s for Deno. These are documented in [../05-bootstrap/bootstrap-design.md](../05-bootstrap/bootstrap-design.md) §5 and are not user-facing after bootstrap.

## 12. Health Checks

The doctor subsystem (see [../07-doctor/doctor-engine.md](../07-doctor/doctor-engine.md)) verifies each installed runtime via a per-runtime health check. The check definitions live in `runtime/health/<name>.ts` and follow a common structure:

```ts
// runtime/health/node.ts
export const nodeHealthCheck: HealthCheck = {
  id: "runtime:node",
  description: "Node.js runtime is installed and working",
  async run(ctx): Promise<HealthResult> {
    for (const version of ctx.installedVersions("node")) {
      const bin = ctx.pathFor("node", version, "node");
      // 1. Binary present?
      if (!await fs.pathExists(bin)) {
        return { status: "fail", message: `node ${version} binary missing at ${bin}` };
      }
      // 2. Can exec --version?
      const versionResult = await ctx.exec(bin, ["--version"]);
      if (versionResult.exitCode !== 0) {
        return { status: "fail", message: `node ${version} --version failed: ${versionResult.stderr}` };
      }
      // 3. Version matches expected?
      if (versionResult.stdout.trim() !== `v${version}`) {
        return { status: "warn", message: `node ${version} reports version ${versionResult.stdout.trim()}` };
      }
      // 4. Can exec a hello-world?
      const helloResult = await ctx.exec(bin, ["-e", "console.log('hello')"]);
      if (helloResult.exitCode !== 0 || helloResult.stdout.trim() !== "hello") {
        return { status: "fail", message: `node ${version} cannot run JS: ${helloResult.stderr}` };
      }
    }
    return { status: "ok" };
  },
};
```

The four-step pattern (binary present → `--version` works → version matches → can run a hello-world) is the same for every runtime, with runtime-specific hello-world code:

- **node**: `node -e "console.log('hello')"`
- **python**: `python3 -c "print('hello')"`
- **rust**: `rustc --version` (no hello-world because rustc does not run scripts; `cargo new && cargo run` is too slow for a health check)
- **go**: `go run - <<'EOF' package main; func main() { println("hello") } EOF`
- **bun**: `bun -e "console.log('hello')"`
- **deno**: `deno eval "console.log('hello')"`

In addition to the per-runtime check, the doctor runs a `native_module_check` for Node and Python that detects mismatched ABI versions (see §10) and a `runtime_default_check` that verifies the default version is set and is the version `state.json` claims it is.

The doctor's output (see [../05-bootstrap/bootstrap-design.md](../05-bootstrap/bootstrap-design.md) §1 for an example) shows each runtime as a single line: `✔  Node.js         v24.18.0` for a healthy runtime, `✖  Node.js         ABI mismatch (better-sqlite3 needs rebuild)` for an unhealthy one. The remediation hint is always specific: `Run: linuxify patch cline` or `Run: linuxify upgrade-runtime node`, never just "something is wrong."
