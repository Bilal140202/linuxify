# Developer Setup Guide

> **Audience**: Contributors who want to hack on Linuxify itself — its CLI core, bootstrap manager, distro/runtime providers, doctor checks, patcher, launcher, registry client, plugin SDK, security module, or any other subsystem. This guide is also read by AI coding agents (Cline, Codex, Claude Code, Aider) setting up a dev environment to implement a feature or fix a bug.
>
> **Scope**: Cloning the repo, installing dependencies, running Linuxify from source, debugging, testing, working on a specific subsystem, adding new commands / doctor checks / patch types / distros, contributing changes back via PR, and the maintainer workflow. For the project's contribution norms (code style, DCO, review process), see [contribution-guidelines.md](./contribution-guidelines.md). For the source-tree layout, see [source-code-structure.md](../02-architecture/source-code-structure.md). For the canonical TypeScript types, see [type-reference.md](../02-architecture/type-reference.md). For test strategy, see [testing-strategy.md](../12-testing/testing-strategy.md).

## 1. Prerequisites

Linuxify is a TypeScript + Node.js project (per [ADR-003](../20-adrs/adr-003-typescript-cli-core.md)), so the prerequisites are modest. You need a development machine — Linux, macOS, or Windows Subsystem for Linux all work — with the following installed.

- **Node.js 20+** (recommend 22 LTS). Linuxify's CLI core runs on Node LTS, and the same runtime is used inside the proot for the tools Linuxify manages. Using a newer Node locally is fine for development; the CI matrix tests against 20, 22, and 24 to catch version-specific regressions. Use `nvm` or `fnm` to manage Node versions; do not rely on the system Node on macOS or Windows, which is often stale or updated without warning. The repo's `.nvmrc` pins the Node version CI uses; `nvm use` will pick it up automatically in any clone.
- **Git**, with your `user.name` and `user.email` configured (required for the DCO sign-off — see [contribution-guidelines §18](./contribution-guidelines.md)). Linuxify follows the [Conventional Commits](https://www.conventionalcommits.org/) spec, so a recent Git (2.20+) is helpful for the commit-message hooks but not strictly required. Git LFS is not used.
- **A code editor with TypeScript support.** VS Code is recommended because the repo ships with workspace settings, recommended extensions (ESLint, Prettier, Vitest runner, Mermaid preview), and launch configs that work out of the box. JetBrains IDEs (WebStorm, IntelliJ with the Node plugin) work fine too; Vim/Emacs/Neovim contributors are welcome but should install the TypeScript LSP and ESLint LSP manually. Whichever editor you choose, install the ESLint and Prettier integrations so formatting issues are caught at edit time rather than at `npm run lint` time.
- **Docker** (for the E2E test suite and for running tests in a containerised Termux). The E2E tests use a Docker image that mimics Termux's filesystem layout so tests can run on any host OS. Without Docker, `npm run test:e2e` will skip with a warning; unit and integration tests still work. On macOS, both Docker Desktop and Colima work; on Linux, plain `docker` (or `podman` with the docker alias) is fine.
- **Termux** (only if you want to do full Android-specific testing on a real device or emulator). Most development does not require Termux — the unit and integration tests are designed to run on a dev laptop. Termux is only needed for testing Android-specific code paths (proot invocation, Termux:API integration, Android version detection, `process.platform === 'android'` patching). Install Termux from F-Droid; the Play Store build is outdated and explicitly unsupported.
- **Optionally, a real Android device.** A Pixel or Samsung device running Android 12+ is the reference test target. A Chromebook running Android 11+ also works. The device is only needed for final pre-release smoke testing; day-to-day development does not require it. Plug the device in over USB and enable USB debugging if you want to run `npm run test:android`.

The repo's `.nvmrc` pins the Node version CI uses; `nvm use` will pick it up automatically. The `package.json` `engines` field declares the minimum Node version; npm will warn (but not block) if you are on an older version. Do not develop on Node 18 or earlier — some dependencies use features only available in 20+, and CI does not test those versions.

## 2. Initial Setup

The initial setup is intentionally five commands. After cloning, `npm install` resolves dependencies, `npm run build` compiles TypeScript to JavaScript (into `dist/`), and `npm link` symlinks the `linuxify` binary into your global Node bin directory so `linuxify` invokes your dev build.

```bash
git clone https://github.com/linuxify/linuxify.git
cd linuxify
npm install
npm run build
npm link
```

Verify the install:

```bash
linuxify --version
# Should print something like: 0.5.0-dev (linked from /path/to/linuxify)
```

If `linuxify --version` prints the npm-installed stable version instead of your dev version, your shell's PATH is finding the global `linuxify` before the `npm link` symlink. Fix with `hash -r` (bash) or `rehash` (zsh), or by uninstalling the global version (`npm uninstall -g linuxify`). The dev build's `--version` output includes the `(linked from …)` suffix specifically so you can tell at a glance which build you are running.

Now run the standard checks to make sure everything works:

```bash
npm run lint           # ESLint, should exit 0
npm run typecheck      # tsc --noEmit, should exit 0
npm test               # Vitest unit + integration tests, should exit 0
npm run test:e2e       # E2E tests, requires Docker
```

If any of these fail on a fresh clone, please file a bug — the maintainers treat "fresh clone, all tests pass" as a CI invariant. If you are on an unusual platform (Windows without WSL, FreeBSD, etc.), the E2E tests may legitimately fail; the unit and integration tests should still pass.

## 3. Repo Tour

The repository layout follows the [target layout](../../.agent-context.md) from the project context, with the source code under `src/` and tests under `tests/`. The high-level structure is documented in detail in [source-code-structure.md](../02-architecture/source-code-structure.md); a condensed view follows.

```
linuxify/
├── README.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md, LICENSE, CHANGELOG.md
├── .agent-context.md                  # shared project context for agents
├── .github/                           # CI workflows, issue/PR templates
├── docs/                              # this documentation set
├── src/                               # TypeScript source
│   ├── cli/                           # CLI entry point, command router, commands
│   │   ├── commands/                  # one file per subcommand
│   │   ├── router.ts                  # arg parsing, dispatch
│   │   └── rendering.ts               # table/json/markdown output
│   ├── bootstrap/                     # bootstrap manager (Stages 0-8)
│   ├── distros/                       # DistroProvider implementations
│   │   ├── backends/{ubuntu,debian,arch,alpine}.ts
│   │   └── provider.ts                # DistroProvider interface
│   ├── runtimes/                      # RuntimeProvider implementations
│   │   ├── backends/{node,python,rust,go,bun,deno}.ts
│   │   └── provider.ts                # RuntimeProvider interface
│   ├── packages/                      # package manager, resolver, manifest
│   ├── doctor/                        # doctor engine, checks
│   ├── patcher/                       # patcher engine, types
│   ├── launcher/                      # launcher generator, shell template
│   ├── registry/                      # registry client (git v1, HTTP v2)
│   ├── plugins/                       # plugin loader, hook dispatcher
│   ├── security/                      # signing, verification, key rotation
│   ├── telemetry/                     # opt-in telemetry queue
│   ├── config/                        # config.toml schema, loader, saver
│   ├── state/                         # state.json, manifest.json, runtimes.json
│   ├── logging/                       # redaction filter, rotation
│   └── util/                          # fs, network, lock, atomic-write
├── tests/                             # Vitest test suite (mirrors src/)
├── packages/                          # package YAML definitions (shipped with CLI)
├── migrations/                        # one file per version migration
├── locales/                           # i18n locale files
├── scripts/                           # build, release, dev scripts
└── registry/                          # registry-side tooling (separate repo in v2)
```

Each subsystem under `src/` has a corresponding doc in `docs/` — see [system-architecture §3](../02-architecture/system-architecture.md) for the component map. The tests mirror the `src/` structure: `tests/unit/cli/commands/` tests `src/cli/commands/`, `tests/unit/patcher/types/` tests `src/patcher/types/`, and so on. This 1:1 mapping is enforced by a custom ESLint rule (`linuxify/test-mirrors-src`) so it is impossible to "lose" a test file. For the full module boundary contract and the import-dependency rules, see [source-code-structure §2](../02-architecture/source-code-structure.md).

## 4. Running Linuxify From Source

There are two modes for running Linuxify from source during development, and you will use both depending on what you are doing. Choose based on the iteration speed you need.

### 4.1 Linked mode

`npm link` (run once during initial setup) creates a global symlink pointing at your dev checkout's `dist/cli.js`. After that, every `linuxify` invocation in any shell runs your dev build. To reflect source changes, rebuild with `npm run build` and re-run the command. Linked mode is best for "make a change, run the CLI, see the output" iteration.

```bash
# In one terminal, after editing source:
npm run build && linuxify doctor

# Or as a one-liner:
npm run build && linuxify <args>
```

The downside is the manual `npm run build` step. For faster iteration, use watch mode.

### 4.2 Watch mode

`npm run dev` runs `tsc --watch`, which rebuilds `dist/` incrementally on every source file save (typically under 200 ms for a one-file change). Combined with `linuxify` invocations in another terminal, this gives you sub-second edit-test cycles. Watch mode is the recommended day-to-day workflow.

```bash
# Terminal 1:
npm run dev
# Terminal 2 (after each save):
linuxify <args>
```

For changes that touch only runtime-evaluated code (for example a function body inside an already-imported module), `tsc --watch`'s incremental rebuild is enough — no Linuxify restart needed. For changes that touch the CLI entry point or the module graph, you must re-run `linuxify` to pick them up. There is no hot-reload; Linuxify is a short-lived CLI process, so "restart" is just "run the command again". For the full build pipeline (tsup bundler, single-file vs multi-file tarball, .deb packaging), see [source-code-structure §10–§11](../02-architecture/source-code-structure.md).

## 5. Debugging

Linuxify is a CLI, so debugging is mostly "run the command, read the output, repeat". For deeper inspection, several tools are available.

### 5.1 Logging

```bash
LINUXIFY_LOG_LEVEL=debug linuxify <command>
# Or persistently:
linuxify config log.level debug
```

The log level hierarchy is `error > warn > info > debug > trace`. Logs go to `~/.linuxify/logs/linuxify.log` (rotated at 5 MB, six rotations kept) and to stderr when `LINUXIFY_LOG_LEVEL=debug` is set. Logs never contain secrets — the [logger has a redaction filter](../02-architecture/system-architecture.md) for keys matching `*_TOKEN`, `*_KEY`, `API_*`, `*_SECRET`. The redaction is applied at the pino transport layer, so it cannot be bypassed by a sloppy log call.

### 5.2 VS Code launch configs

The repo ships with `.vscode/launch.json` containing four configs:

- **Run CLI with args** — prompts for args, runs `linuxify <args>` under the VS Code debugger. Set breakpoints in `src/`, hit F5.
- **Run current test file** — runs the test file currently open in the editor under the debugger.
- **Run all tests** — runs the full Vitest suite under the debugger (slow but useful for debugging test infrastructure).
- **Attach to running CLI** — starts `node --inspect` and attaches; useful when the CLI is launched from outside VS Code (for example from a Termux shell via remote debugging).

To use these, open the Run and Debug panel (Ctrl+Shift+D / Cmd+Shift+D), pick a config from the dropdown, hit F5.

### 5.3 Inspector

For non-VS-Code editors or for debugging a Linuxify process launched from outside the editor:

```bash
node --inspect $(which linuxify) <command>
# Then open chrome://inspect in Chrome and click "inspect"
```

`--inspect-brk` waits for the debugger to attach before running, useful for debugging startup code (config load, state load, plugin load). The inspector stays attached for the entire CLI invocation; since Linuxify is a short-lived process, this is normally the whole debugging session.

### 5.4 Stack traces

In dev mode (`npm link`'d install), stack traces are always full — no shortening, no `... N more` elision. In production (npm/pkg install), stack traces are shortened to the top 5 frames. This is controlled by the `NODE_ENV` env var: `NODE_ENV=development` enables full traces, `NODE_ENV=production` enables shortening. If a user reports a stack trace that looks truncated, ask them to re-run with `NODE_ENV=development linuxify <command>` and paste the full trace.

## 6. Testing Workflow

Linuxify uses [Vitest](https://vitest.dev/) as its test runner (per [testing-strategy §3](../12-testing/testing-strategy.md)). Tests are tagged with `@unit`, `@integration`, `@slow`, `@android-only`, or `@e2e` to control which subset runs in which context.

```bash
npm test                              # unit + integration (default)
npm test -- --filter <pattern>        # filter by name pattern
npm run test:watch                    # watch mode, reruns on save
npm run test:coverage                 # coverage report (lcov + html)
npm run test:e2e                      # @e2e tests, requires Docker
npm run test:e2e -- --filter <pattern>
npm run test:bench                    # @slow benchmarks (see performance-budget)
npx vitest path/to/test.test.ts       # run a single test file directly
npx vitest --reporter=verbose         # verbose output
```

The coverage target is 80% line coverage for `src/` overall, with higher targets for sensitive paths (`src/patcher/`, `src/security/`, `src/state/` — 95%+). Coverage is enforced by CI; a PR that drops coverage below the target cannot merge. Open `coverage/index.html` in a browser to see the per-file breakdown and uncovered lines.

For test-writing conventions (shared fixtures, deterministic clocks, no shared mutable state), see [testing-strategy §4](../12-testing/testing-strategy.md). The two custom ESLint rules `linuxify/no-shared-state-in-tests` and `linuxify/no-clock-in-tests` enforce the most important conventions automatically. Tests must not depend on wall-clock time (use `vi.useFakeTimers()`); tests must not share mutable state across cases (each test creates its own fixtures).

## 7. Working on a Specific Subsystem

If you are picking up an issue in a specific subsystem, here is where to start for each. The pattern is: read the entry file to understand the public API, read the key types to understand the data model, look at the test file to see how the subsystem is exercised, and check the common pitfalls. The full type definitions for every interface below are in [type-reference.md](../02-architecture/type-reference.md).

### 7.1 CLI (commands, router, rendering)

- **Entry**: `src/cli/router.ts` — the command dispatcher. Reads `src/cli/commands/index.ts` to know which commands exist.
- **Key types**: `Command` interface (each command implements `register(program: Command): void`), `CliContext` (passed to every command handler, carries config + state + logger + telemetry).
- **Tests**: `tests/unit/cli/commands/`.
- **Pitfalls**: do not call `process.exit()` directly from a command handler; throw a `LinuxifyError` with the right exit code and let the router handle it. Do not write to stdout directly; use the `rendering` module so `--json` and `--markdown` output flags work consistently. The router never catches `LinuxifyError` — it only translates it into the right exit code and human-readable message.

### 7.2 Bootstrap (Stages 0-8)

- **Entry**: `src/bootstrap/manager.ts`. Stage implementations live in `src/bootstrap/stages/` (one file per stage, `stage0.ts` through `stage8.ts`).
- **Key types**: `BootstrapContext`, `StageResult`, `BootstrapProgress`.
- **Tests**: `tests/integration/bootstrap/` (uses a fake proot to avoid actually downloading Ubuntu rootfs).
- **Pitfalls**: each stage must be idempotent — re-running `linuxify init` after a successful init should be a no-op (or a fast verification pass). Each stage must write its marker file (`~/.linuxify/.bootstrap/stage-N.done`) only after the stage fully completes; a stage that partially completes writes `stage-N.failed` instead. See [bootstrap-design §2](../05-bootstrap/bootstrap-design.md).

### 7.3 Distros

- **Entry**: `src/distros/provider.ts` (interface), `src/distros/manager.ts` (orchestration), `src/distros/backends/<name>.ts` (per-distro implementation).
- **Key types**: `DistroProvider` interface (12 methods: install/uninstall/start/stop/exec/shell/info/update/snapshot/restore + readonly `name`/`version`/`packageManager`).
- **Tests**: `tests/unit/distros/` for the manager and provider interface; `tests/integration/distros/` for per-distro tests (these may require real proot).
- **Pitfalls**: the proot invocation is distro-specific — Alpine needs `--rootfs` flag set differently from Ubuntu, Arch needs `/etc/pacman.conf` patched, etc. Always test against a real proot for non-trivial changes; unit tests with mocked proot will not catch invocation bugs.

### 7.4 Runtimes

- **Entry**: `src/runtimes/provider.ts` (interface), `src/runtimes/manager.ts`, `src/runtimes/backends/<name>.ts`.
- **Key types**: `RuntimeProvider` (8 methods: install/uninstall/list/default/setDefault/exec/pathFor/healthCheck).
- **Tests**: `tests/unit/runtimes/`.
- **Pitfalls**: runtime installations are distro-specific — Node is installed via NodeSource apt repo on Ubuntu/Debian, via pacman on Arch, via apk on Alpine. The backend must declare which distros it supports and refuse to install on others with a clear error message (`E_RUNTIME_DISTRO_UNSUPPORTED`).

### 7.5 Packages

- **Entry**: `src/packages/manager.ts`.
- **Key types**: `PackageDefinition`, `ManifestEntry`, `ResolvedPackage`.
- **Tests**: `tests/unit/packages/` (resolver, schema validation); `tests/integration/packages/` (real install + patch flow with a fake proot).
- **Pitfalls**: the package manager acquires the global `~/.linuxify/.lock` before any state-mutating operation. Do not bypass this lock — concurrent `linuxify add` calls will corrupt state. The schema validation (`src/packages/schema.ts`) is the first line of defence against bad YAML; do not weaken it without a corresponding ADR. See [package-spec](../09-registry/package-spec.md).

### 7.6 Patcher

- **Entry**: `src/patcher/engine.ts`.
- **Key types**: `PatchDefinition`, `PatchRecord`, `PatchType` (`'regex' | 'ast-js' | 'ast-ts' | 'sed' | 'python-ast' | 'shell' | 'binary'`).
- **Tests**: `tests/unit/patcher/` — extensive; the patcher is security-sensitive (a malicious patch could exfiltrate data) so it has the highest coverage target in the repo (95%+).
- **Pitfalls**: every patch must record a reverse patch in `~/.linuxify/patches/<pkg>/<n>.json` for rollback. Forgetting the reverse patch means `linuxify patch --rollback` cannot undo your patch. Patches must be idempotent — re-applying an already-applied patch must be a no-op, not a double-application. See [patcher-engine §3](../08-patcher/patcher-engine.md).

### 7.7 Doctor

- **Entry**: `src/doctor/engine.ts`.
- **Key types**: `DoctorCheck`, `DoctorResult` (`{ status: 'ok'|'warn'|'fail'|'missing'|'skip', message, fixCommand?, fixDocs? }`), `DoctorContext`.
- **Tests**: `tests/unit/doctor/`.
- **Pitfalls**: independent checks must actually be independent — do not have one check depend on the result of another (the engine runs independent checks in parallel). Each check's `fix_command` must be safe to run automatically if marked `safe: true`; checks requiring user confirmation must be `safe: false`. See [doctor-engine §3](../07-doctor/doctor-engine.md).

### 7.8 Launcher

- **Entry**: `src/launcher/generator.ts`.
- **Key types**: `LauncherSpec`, `LauncherVariant` (`'standard' | 'direct' | 'custom'`).
- **Tests**: `tests/unit/launcher/`.
- **Pitfalls**: the launcher template (`assets/launcher-template.sh`) is a POSIX shell script that runs on Termux's `mksh` — do not use Bash-specific features like `[[ ]]` or process substitution. Signal forwarding (SIGINT, SIGTERM) is critical; a launcher that swallows Ctrl+C will leave proot children running. See [launcher-architecture §2](../06-launcher/launcher-architecture.md).

### 7.9 Plugins

- **Entry**: `src/plugins/loader.ts`, `src/plugins/dispatcher.ts`.
- **Key types**: `Plugin`, `PluginManifest`, `HookName` (`'preInstall' | 'postInstall' | 'prePatch' | 'postPatch' | 'preRun' | 'postRun' | 'doctor' | 'bootstrap' | 'command'`).
- **Tests**: `tests/unit/plugins/`.
- **Pitfalls**: plugins run in the same Node process as the CLI core; a crashing plugin is caught and logged but must not crash the core (fail-soft contract). The hook dispatcher must timeout plugin calls (default 30 s) so a hung plugin does not hang the CLI. See [plugin-sdk §3](../10-plugin-sdk/plugin-sdk.md).

### 7.10 Registry client

- **Entry**: `src/registry/client.ts` (HTTP v2 client), `src/registry/git-client.ts` (git v1 client).
- **Key types**: `RegistryConfig`, `PackageVersion`, `Signature`, `TrustStore`.
- **Tests**: `tests/unit/registry/` (mocked HTTP/git); `tests/integration/registry/` (against a local fake registry server).
- **Pitfalls**: every package YAML returned by the registry must have its Ed25519 signature verified before being written to `~/.linuxify/registry/`. A signature verification failure is `E_REGISTRY_SIGNATURE_INVALID` and aborts the update — never fall back to "use unsigned data". See [registry-format](../09-registry/registry-format.md).

### 7.11 Telemetry

- **Entry**: `src/telemetry/queue.ts`, `src/telemetry/sender.ts`.
- **Key types**: `TelemetryEvent`, `TelemetryConfig`.
- **Tests**: `tests/unit/telemetry/`.
- **Pitfalls**: telemetry is opt-in and off-by-default (per [ADR-005](../20-adrs/adr-005-opt-in-telemetry.md)). Never send telemetry events before checking the config. The queue at `~/.linuxify/telemetry/queue.jsonl` is fsync'd after each event to survive crashes; do not batch writes in memory. Events must be redacted of any user-identifying data before queuing. See [telemetry-privacy](../24-telemetry/telemetry-privacy.md).

### 7.12 Security

- **Entry**: `src/security/signing.ts`, `src/security/verification.ts`, `src/security/keys.ts`.
- **Key types**: `Signature`, `SigningKey`, `TrustStore`.
- **Tests**: `tests/unit/security/` — extensive; the security module has the second-highest coverage target after the patcher.
- **Pitfalls**: never log private keys or signing operations' inputs. Key rotation is a 30-day overlap window (per [registry-format §10](../09-registry/registry-format.md)) — make sure old keys remain valid for verification of historically-signed packages. The 2-of-3 maintainer quorum for key rotation is enforced server-side; the client just verifies against the published key set. See [security-model](../13-security/security-model.md) and [key-management](../13-security/key-management.md).

## 8. Adding a New Command

To add a new `linuxify <command>` subcommand, follow these six steps.

1. **Create the command file** at `src/cli/commands/<name>.ts`. The file exports a default object implementing the `Command` interface, which has a single method `register(program: Command): void` (where `Command` is Commander.js's type). Inside `register`, call `program.command('<name>')`, chain `.description()`, `.option()`, `.action()` as needed.
2. **Register the command** in `src/cli/commands/index.ts`. This file imports every command and exports an array; the router iterates the array and calls `register()` on each.
3. **Add the docs** in [docs/03-cli/command-reference.md](../03-cli/command-reference.md). Each command has a section with synopsis, options, examples, exit codes, and cross-links to relevant architecture docs.
4. **Add tests** in `tests/unit/cli/commands/<name>.test.ts`. Test that the command registers, that it parses args correctly, that it returns the right exit codes for success and error cases, and that it produces the expected output (stdout, stderr, json, markdown).
5. **Add a CHANGELOG entry** under the `[Unreleased]` section, using the Conventional Commits type (`feat:` for new commands, `fix:` for bug-fix commands).
6. **Commit and PR** per [§13 below](#13-commit--pr).

Example minimal command skeleton:

```typescript
// src/cli/commands/hello.ts
import type { Command } from '../types';
import { LinuxifyError } from '../errors';

export default {
  register(program: Command): void {
    program
      .command('hello')
      .description('Print a greeting')
      .option('-n, --name <name>', 'name to greet', 'world')
      .action((opts) => {
        if (opts.name === 'error') {
          throw new LinuxifyError('E_HELLO_BAD_NAME', 'name cannot be "error"', 1);
        }
        console.log(`Hello, ${opts.name}!`);
      });
  },
};
```

## 9. Adding a New Doctor Check

To add a new `linuxify doctor` check (for example to verify a new runtime or a new package-level invariant), follow these five steps.

1. **Create the check file** at `src/doctor/checks/<name>.ts`. The file exports a default object implementing `DoctorCheck`, which has an `id`, `name`, `category`, `severity` (`'info' | 'warn' | 'fail'`), and a single method `check(ctx: DoctorContext): Promise<DoctorResult>`. The `DoctorContext` carries config, state, and a logger. The check must not throw — if it fails internally, return a `DoctorResult` with `status: 'fail'` and a remediation hint. See [doctor-engine §4](../07-doctor/doctor-engine.md).
2. **Register the check** in `src/doctor/checks/index.ts` and add it to the appropriate [profile](../07-doctor/doctor-engine.md) (`default`, `ci`, or `quick`). The `ci` profile elevates `warn` to `fail` to fail-fast in CI; do not put optional checks in `ci` unless you want CI to fail when they trigger.
3. **Add tests** in `tests/unit/doctor/checks/<name>.test.ts`. Cover the happy path (`status: 'ok'`), the warning path, the failure path, and any edge cases (for example what happens when the runtime is missing entirely). Tests must not depend on the host's actual environment — mock the proot, the runtime, and the package state.
4. **Update the docs** in [doctor-engine.md](../07-doctor/doctor-engine.md) — add the check to the check catalog table with its ID, severity, fix command, and a one-line description. Also update [diagnostics.md](../07-doctor/diagnostics.md) if the check exposes new diagnostic output.
5. **Add a CHANGELOG entry** under `[Unreleased]` as `feat(doctor): <check name> check`.

See [doctor-engine §3](../07-doctor/doctor-engine.md) for the full check schema including `fix_command`, `fix_severity`, and the `safe: true | false` flag that controls whether `linuxify repair` will auto-apply the fix.

## 10. Adding a New Patch Type

To add a new patcher type (for example a new AST-based patcher for a language Linuxify does not yet support), follow these four steps.

1. **Create the type file** at `src/patcher/types/<name>.ts`. The file exports a default object implementing `PatchTypeHandler`, which has a single method `apply(patch: PatchDefinition, fileContent: string): Promise<string>`. The method takes the patch definition (with `find`, `replace`, `condition` fields) and the current file content, and returns the modified content. Throw `PatchVerifyFailed` if the patch cannot be applied (for example `find` does not match) or `PatchConflict` if applying the patch would conflict with a previously-applied patch.
2. **Register the type** in `src/patcher/types/index.ts`. The patcher engine looks up types by name (`'regex'`, `'ast-js'`, `'ast-ts'`, `'sed'`, `'python-ast'`, `'shell'`, `'binary'`, and your new type). The union is intentionally open (`string & {}` in TypeScript) so plugins can register additional types at runtime — see [type-reference §8](../02-architecture/type-reference.md).
3. **Add tests** in `tests/unit/patcher/types/<name>.test.ts`. Use sample files from `tests/fixtures/patcher/` — there are fixture files for each language. Test idempotency (applying twice is a no-op), test rollback (the reverse patch undoes the patch), test the failure paths (`PatchVerifyFailed`, `PatchConflict`).
4. **Update the docs** in [patcher-engine.md](../08-patcher/patcher-engine.md) — add the type to the type catalog with its supported file extensions, limitations, and an example.

## 11. Adding a New Distro

To add a new distro backend (for example Fedora, openSUSE, Kali), follow these five steps.

1. **Create the distro file** at `src/distros/backends/<name>.ts`. The file exports a class implementing `DistroProvider` (the 12-method interface defined in [type-reference §5](../02-architecture/type-reference.md)). The `install` method downloads the rootfs (typically from the distro's official image server), unpacks it into `~/.linuxify/distros/<name>/`, and writes the `installed` marker file. The `enter`/`shell`/`exec` methods spawn proot with the right invocation for this distro.
2. **Add a manifest YAML** in `distro-manifests/<name>.yml` declaring available versions, download URLs, checksums, and minimum proot-distro version. The manifest is what `linuxify distros list` reads.
3. **Register the distro** in `src/distros/index.ts`. The distro manager imports each backend and registers it; new distros appear automatically in `linuxify distros list`.
4. **Add tests** in `tests/integration/distros/<name>.test.ts`. These tests require a real proot and are tagged `@integration` and `@slow`. They install the distro, run `linuxify shell -- echo hello`, and verify the output. CI runs these on aarch64 only (x86_64 distro tests are best-effort).
5. **Update the docs** in [distro-management.md](../05-bootstrap/distro-management.md) and [glossary.md](../21-reference/glossary.md) (add the new distro to the supported-distros list).

See [ADR-006](../20-adrs/adr-006-distro-provider-abstraction.md) for the rationale behind the `DistroProvider` abstraction. The same pattern applies to adding a new runtime backend (`src/runtimes/backends/<name>.ts` implementing `RuntimeProvider`), but runtime backends typically do not need a manifest YAML because runtimes are installed from upstream package managers rather than downloaded as rootfs tarballs.

## 12. Working on Docs

Docs are in `docs/`, written in Markdown, with Mermaid diagrams rendered natively on GitHub. The docs follow the [style guidelines in `.agent-context.md §11`](../../.agent-context.md): ≥150–200 words per section, ≥3 sentences per paragraph, example-rich, cross-linked, capitalise "Linuxify" (project) lowercase `linuxify` (CLI).

To preview docs locally:

```bash
npm run docs:preview
# Starts a local mkdocs server at http://localhost:8000
# Hot-reloads on save.
```

All PRs that change user-visible behaviour must update docs in the same PR. Doc-only PRs (typos, new guides, translations) are welcome and typically merge faster than code PRs because the review burden is lower. When adding a new doc file, also update `docs/INDEX.md` to include it in the navigation hub. The numbering scheme (`NN-category/file.md`) is intentional — two-digit prefixes group related docs and make the directory listing readable; do not renumber existing files without coordinating with maintainers (other docs cross-link by path).

The docs are written for a mixed audience of human contributors and AI coding agents. When writing or editing docs, prefer concrete examples over abstract description, prefer full command transcripts over partial ones, and prefer explicit assumptions over implicit ones. An AI agent reading your doc should be able to execute the described procedure without guessing; a human reader should be able to understand the *why* behind each step.

## 13. Commit & PR

The commit and PR process is fully specified in [contribution-guidelines §5–§6](./contribution-guidelines.md). The short version:

- **Branch**: `feat/<short-desc>` for features, `fix/<issue#>-<desc>` for bug fixes, `docs/<desc>` for doc-only changes. Keep branch names lowercase, hyphen-separated.
- **Commit**: Conventional Commits format (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`). Sign off on every commit with `git commit -s` (DCO sign-off — see [contribution-guidelines §18](./contribution-guidelines.md)). The DCO is enforced by a GitHub Action; unsigned commits cannot merge.
- **Push**: `git push -u origin <branch>`.
- **PR**: open against `main`, fill out the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) completely, link the issue you are fixing (or open one if none exists), request review from a maintainer (the CODEOWNERS file auto-assigns based on touched paths).
- **CI**: must pass before review. CI runs lint, typecheck, unit + integration tests on Node 20/22/24, and (nightly) the E2E and benchmark suites. A failing CI blocks merge.
- **Review**: one maintainer approval for non-sensitive paths, two approvals for sensitive paths (`src/patcher/`, `src/registry/`, `src/security/`, `migrations/`). See [contribution-guidelines §2](./contribution-guidelines.md).

```bash
# Typical feature commit flow
git checkout -b feat/add-foo-command
# (make changes, add tests, update docs)
git add src/cli/commands/foo.ts tests/unit/cli/commands/foo.test.ts \
        docs/03-cli/command-reference.md CHANGELOG.md
git commit -s -m "feat(cli): add foo command for bar-ing baz"
git push -u origin feat/add-foo-command
# Open PR against main
```

## 14. Maintainer Workflow

For maintainers (after a PR is approved and merged), the workflow is:

1. **Squash merge** to `main` via the GitHub UI. The squash commit message should be the Conventional Commit message from the PR (the PR template pre-fills this). Do not rebase-merge; the linear history of squash-merges is what makes `CHANGELOG.md` generation work.
2. **Delete the branch**. GitHub does this automatically if configured; otherwise delete manually. Branch deletion keeps the branch list short and signals to the contributor that their work is merged.
3. **Update the issue**: close it if the PR fully resolves it, or comment if partial. Add the issue to the appropriate milestone if it is part of a release.
4. **If release**: tag the release commit (`git tag v0.5.0`), push the tag (`git push --tags`), and CI auto-publishes to npm, the Termux repo, and GitHub Releases per [release-pipeline §5](../14-cicd/release-pipeline.md). The release manager monitors the release health dashboard for 24 hours post-release per [analytics §9](../24-telemetry/analytics.md). For a patch release, the same flow applies with a `v0.5.1` tag.

Maintainers also rotate through triage duty (see [contribution-guidelines §19](./contribution-guidelines.md)). The triager's job is to apply labels, request more information on incomplete bug reports, and merge obvious doc-only PRs without waiting for full review.

## 15. Getting Help

If you get stuck, there are several escalation paths. Use them — the maintainers would rather answer a question than see you struggle silently and submit a frustrated PR.

- **Discord `#dev` channel** — fastest response. Maintainers and other contributors hang out there. Ask anything; there are no dumb questions. The `#dev` channel is for development questions; for end-user support use `#support`.
- **Office hours** — monthly, announced in Discord and on the blog. A maintainer is available for 1–2 hours for pairing, design discussion, or PR review. Show up with a question or a work-in-progress PR.
- **Pair with a maintainer on your first PR** — explicitly offered in [contribution-guidelines §1](./contribution-guidelines.md). Mention `@linuxify/mentors` on your PR or in Discord to be paired. The maintainer will help you navigate the codebase, the CI, and the review process.
- **GitHub Discussions** — for design questions that benefit from async, threaded discussion. Tagged `design`, `help-wanted`, or `question`. Discussions often become the seed for an ADR.
- **AI coding agents** — if you are an AI coding agent (Cline, Codex, Claude Code, Aider) working on a Linuxify contribution, the human you are working with is responsible for the PR. Have them review and sign off before opening the PR. The `.agent-context.md` file in the repo root is your spec; read it in full before making changes. The [AI build guide](../00-executive/ai-build-guide.md) is also required reading for agents — it documents the conventions agents must follow when contributing.
