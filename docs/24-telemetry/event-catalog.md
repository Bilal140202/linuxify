# Telemetry Event Catalog

> Path: `docs/24-telemetry/event-catalog.md`
> Audience: AI coding agents implementing the telemetry client or server, contributors adding new events, security engineers auditing what Linuxify emits.
> Related: [Telemetry & Privacy](./telemetry-privacy.md) · [Analytics](./analytics.md) · [Data Formats §14 Telemetry Queue](../02-architecture/data-formats.md#14-linuxifytelemetryqueuejsonl--telemetry-event-queue) · [CLI Specification §6 Exit Codes](../03-cli/cli-specification.md#6-exit-code-convention) · [System Architecture §9.2 Telemetry](../02-architecture/system-architecture.md#92-telemetry-opt-in) · [Security Model](../13-security/security-model.md) · [Privacy Compliance](./telemetry-privacy.md#9-privacy-compliance).

## 1. Event Structure

Every telemetry event Linuxify emits is a single JSON object, serialized as one line in `~/.linuxify/telemetry/queue.jsonl` (the on-disk queue; see [Data Formats §14](../02-architecture/data-formats.md#14-linuxifytelemetryqueuejsonl--telemetry-event-queue)). The envelope is fixed across all event types; only the `fields` object varies. The envelope fields are:

```typescript
interface TelemetryEvent {
  event_id: string;              // UUIDv7 (time-ordered, sortable, monotonically increasing)
  event_type: string;            // "<subsystem>.<action>", see §3
  event_schema_version: 1;       // bumped on breaking change to envelope or common fields
  timestamp: string;             // ISO 8601 UTC, millisecond precision
  linuxify_version: string;      // semver, e.g. "0.2.0"
  user_id: string;               // rotating UUIDv4 from state.json; "" if never opted in
  session_id: string;            // UUIDv7 per CLI process; same across events from one invocation
  os: {
    android_version: string;     // "14", "13", ...
    arch: string;                // "aarch64" | "armv7l" | "x86_64"
  };
  channel: "stable" | "beta" | "alpha";
  fields: Record<string, unknown>;  // event-specific; see §3
}
```

`event_id` is UUIDv7 rather than the UUIDv4 used in the older [telemetry-privacy.md](./telemetry-privacy.md) example, because v7 is time-ordered: events sort naturally by insertion time without a separate sequence counter, and a server receiving out-of-order batches can deduplicate by `event_id` without consulting a clock. The migration from v4 to v7 is invisible to consumers (both are 128-bit UUIDs in the same string format) and is purely a client-side quality-of-implementation improvement.

`session_id` is per-process: every `linuxify <command>` invocation generates one `session_id` and reuses it for every event emitted during that invocation. This lets the server reconstruct the sequence of events from a single command (e.g., `bootstrap.start` → `bootstrap.stage_complete` × N → `bootstrap.complete`) without relying on timestamps alone, which can be misleading on devices with skewed clocks.

The `os` object deliberately excludes device model, manufacturer, carrier, and any other hardware identifier — those would be fingerprinting vectors. The two fields present (`android_version` and `arch`) are the minimum needed to segment metrics by Android release and CPU architecture, which is required for the compat matrix (see [Analytics §8](./analytics.md#8-compat-matrix-live-view)) and for ARM-specific regression detection (see [ARM Considerations](../23-mobile/arm-considerations.md)).

## 2. Event Type Naming

Event types follow the `<subsystem>.<action>` convention. The subsystem is one of: `bootstrap`, `distro`, `runtime`, `package`, `patch`, `doctor`, `repair`, `run`, `update`, `self_update`, `sync`, `plugin`, `cli`, `error`, `crash`. The action is a verb or verb-phrase in `snake_case` describing what happened: `start`, `complete`, `failed`, `stage_complete`, `check_pass`, `check_warn`, `check_fail`, `invoked`, `thrown`, `uncaught`. The combination is unique: there is exactly one event type per `<subsystem>.<action>` pair, and the pair is the canonical identifier referenced in dashboards, alerts, and tests.

The naming is *intentionally* not a free-form string. A contributor adding a new event must add it to this catalog (§3) in the same PR that emits it; an event not in the catalog is a bug. This prevents event-type sprawl, where every contributor invents their own naming convention and the server ends up with `bootstrap.stage_done`, `bootstrap.stageCompleted`, and `bootstrap.STAGE_COMPLETE` all meaning the same thing. The catalog is the contract.

## 3. Event Catalog

The full catalog follows. Each entry lists: **name**, **when emitted**, **fields collected**, **fields NOT collected** (the privacy contract — these are the things the event explicitly does *not* send, even if they are technically available), and an **example**.

### Bootstrap subsystem

**`bootstrap.start`** — Emitted at the start of `linuxify init` (or `linuxify install`). Fields: `stages_planned` (number, 0-8), `resume` (boolean, whether this is a resume), `from_bundle` (boolean), `bundle_sha256` (string, only if `from_bundle=true`). NOT collected: user identity, hostname, install location. Example: `{"stages_planned": 9, "resume": false, "from_bundle": false}`.

**`bootstrap.stage_complete`** — Emitted at the end of each successful stage. Fields: `stage` (number 0-8), `stage_name` (string, e.g. "preflight"), `duration_ms` (number), `bytes_downloaded` (number, optional). NOT collected: mirror URL (could identify region), file paths. Example: `{"stage": 2, "stage_name": "distro_download", "duration_ms": 42180, "bytes_downloaded": 412318720}`.

**`bootstrap.stage_failed`** — Emitted when a stage fails. Fields: `stage`, `stage_name`, `duration_ms`, `error_code` (string, `E_<SUBSYSTEM>_<DESCRIPTION>` per [System Architecture §9.4](../02-architecture/system-architecture.md#94-error-handling)), `retryable` (boolean). NOT collected: error message (may contain user paths), file contents, network URLs. Example: `{"stage": 0, "stage_name": "preflight", "duration_ms": 412, "error_code": "E_BOOTSTRAP_FDROID_REQUIRED", "retryable": false}`.

**`bootstrap.complete`** — Emitted at the end of a successful bootstrap. Fields: `total_duration_ms`, `stages_completed` (number), `bytes_downloaded_total`. NOT collected: same as `stage_complete`. Example: `{"total_duration_ms": 824000, "stages_completed": 9, "bytes_downloaded_total": 580318720}`.

### Distro subsystem

**`distro.install_start`** — At the start of `linuxify use <new-distro>`. Fields: `distro` (string, e.g. "debian"), `arch` (string). NOT collected: mirror URL, rootfs URL. Example: `{"distro": "debian", "arch": "aarch64"}`.

**`distro.install_complete`** — On success. Fields: `distro`, `arch`, `duration_ms`, `rootfs_size_mb`. NOT collected: rootfs URL, mirror URL. Example: `{"distro": "debian", "arch": "aarch64", "duration_ms": 93000, "rootfs_size_mb": 384}`.

**`distro.uninstall`** — On `linuxify remove <distro>`. Fields: `distro`. NOT collected: file paths. Example: `{"distro": "debian"}`.

### Runtime subsystem

**`runtime.install_start`** — At the start of runtime install (e.g., `linuxify add node`). Fields: `runtime` (string), `version` (string). NOT collected: installer URL, source mirror. Example: `{"runtime": "node", "version": "22.11.0"}`.

**`runtime.install_complete`** — On success. Fields: `runtime`, `version`, `duration_ms`, `size_mb`. NOT collected: installer URL. Example: `{"runtime": "node", "version": "22.11.0", "duration_ms": 28000, "size_mb": 84}`.

**`runtime.uninstall`** — On runtime removal. Fields: `runtime`, `version`. NOT collected: file paths. Example: `{"runtime": "node", "version": "22.11.0"}`.

### Package subsystem

**`package.install_start`** — At the start of `linuxify add <pkg>`. Fields: `package_hash` (string, the salted hash per [telemetry-privacy.md §5](./telemetry-privacy.md#5-anonymization)), `version` (string, upstream version, not hashed — the registry already knows which versions exist). NOT collected: package args, install source URL (when from a private mirror), user-specified config. Example: `{"package_hash": "9f8d7c6b5a4c3d2e1f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e", "version": "1.2.0"}`.

**`package.install_complete`** — On success. Fields: `package_hash`, `version`, `duration_ms`, `patches_applied` (number), `launcher_kind` ("shell" | "direct" | "custom"). NOT collected: patch file contents, env var values. Example: `{"package_hash": "9f8d...", "version": "1.2.0", "duration_ms": 4280, "patches_applied": 2, "launcher_kind": "shell"}`.

**`package.install_failed`** — On failure. Fields: `package_hash`, `version`, `duration_ms`, `error_code`, `failed_stage` ("install" | "patch" | "verify" | "launcher"). NOT collected: error message, file paths. Example: `{"package_hash": "9f8d...", "version": "1.2.0", "duration_ms": 1820, "error_code": "E_PATCH_VERIFY_FAILED", "failed_stage": "patch"}`.

**`package.uninstall`** — On `linuxify remove <pkg>`. Fields: `package_hash`, `version`, `duration_ms`. NOT collected: file paths. Example: `{"package_hash": "9f8d...", "version": "1.2.0", "duration_ms": 380}`.

### Patch subsystem

**`patch.apply_start`** — Before applying a patch. Fields: `package_hash`, `patch_id` (string, e.g. "cline-001"), `patch_kind` ("regex" | "ast-js" | "ast-python" | "sed"). NOT collected: file path, find/replace contents. Example: `{"package_hash": "9f8d...", "patch_id": "cline-001", "patch_kind": "regex"}`.

**`patch.apply_complete`** — On success. Fields: `package_hash`, `patch_id`, `duration_ms`, `verified` (boolean). NOT collected: file path, file contents before/after. Example: `{"package_hash": "9f8d...", "patch_id": "cline-001", "duration_ms": 42, "verified": true}`.

**`patch.apply_failed`** — On failure. Fields: `package_hash`, `patch_id`, `duration_ms`, `error_code`, `failure_mode` ("find_not_found" | "verify_failed" | "io_error"). NOT collected: file path, find/replace contents, verify command output. Example: `{"package_hash": "9f8d...", "patch_id": "cline-001", "duration_ms": 18, "error_code": "E_PATCH_VERIFY_FAILED", "failure_mode": "verify_failed"}`.

**`patch.rollback`** — On `linuxify patch --rollback`. Fields: `package_hash`, `patch_id`, `duration_ms`, `success` (boolean). NOT collected: file path. Example: `{"package_hash": "9f8d...", "patch_id": "cline-001", "duration_ms": 12, "success": true}`.

### Doctor subsystem

**`doctor.run_start`** — At the start of `linuxify doctor`. Fields: `profile` ("default" | "ci" | "quick" | custom), `checks_planned` (number). NOT collected: nothing beyond envelope. Example: `{"profile": "default", "checks_planned": 16}`.

**`doctor.run_complete`** — On completion. Fields: `duration_ms`, `pass_count`, `warn_count`, `fail_count`, `missing_count`. NOT collected: check names (only counts — check names could reveal installed package list), check details. Example: `{"duration_ms": 1842, "pass_count": 14, "warn_count": 1, "fail_count": 0, "missing_count": 1}`.

**`doctor.check_pass`**, **`doctor.check_warn`**, **`doctor.check_fail`** — Per-check events (emitted only if the user opts in via `linuxify config telemetry.verbose_doctor true`; off by default to avoid event volume). Fields: `check_category` ("bootstrap" | "distro" | "runtime" | "package" | "patch" | "network" | "config"), `status` ("ok" | "warn" | "fail" | "missing"), `duration_ms`. NOT collected: check name (would reveal installed packages), check detail. Example: `{"check_category": "package", "status": "missing", "duration_ms": 4}`.

### Repair subsystem

**`repair.start`** — At the start of `linuxify repair`. Fields: `problems_found` (number). NOT collected: problem details. Example: `{"problems_found": 1}`.

**`repair.complete`** — On completion. Fields: `duration_ms`, `fixes_attempted`, `fixes_succeeded`, `fixes_failed`. NOT collected: fix commands, file paths. Example: `{"duration_ms": 8421, "fixes_attempted": 1, "fixes_succeeded": 1, "fixes_failed": 0}`.

**`repair.fix_applied`** — Per successful fix. Fields: `check_category`, `duration_ms`. NOT collected: check name, fix command. Example: `{"check_category": "package", "duration_ms": 7901}`.

**`repair.fix_failed`** — Per failed fix. Fields: `check_category`, `duration_ms`, `error_code`. NOT collected: error message, fix command, file paths. Example: `{"check_category": "package", "duration_ms": 120, "error_code": "E_PACKAGE_INSTALL_FAILED"}`.

### Run subsystem

**`run.start`** — At the start of `linuxify run <pkg>`. Fields: `package_hash`, `runtime` (string). NOT collected: args, env vars, working directory. Example: `{"package_hash": "9f8d...", "runtime": "node"}`.

**`run.complete`** — On clean exit. Fields: `package_hash`, `duration_ms`, `exit_code` (number, the wrapped tool's exit code, clamped to 0-255). NOT collected: stdout/stderr contents, args. Example: `{"package_hash": "9f8d...", "duration_ms": 42180, "exit_code": 0}`.

**`run.failed`** — On non-zero exit. Fields: `package_hash`, `duration_ms`, `exit_code`, `signal` (string, optional, e.g. "SIGTERM"). NOT collected: stdout/stderr, args, error messages. Example: `{"package_hash": "9f8d...", "duration_ms": 120, "exit_code": 1}`.

### Update / self-update subsystem

**`update.start`** — At the start of `linuxify update`. Fields: `from_commit` (string, registry commit SHA prefix). NOT collected: registry URL. Example: `{"from_commit": "abc1234"}`.

**`update.complete`** — On success. Fields: `to_commit` (string), `duration_ms`, `files_changed` (number). NOT collected: file paths. Example: `{"to_commit": "def5678", "duration_ms": 3200, "files_changed": 12}`.

**`update.failed`** — On failure. Fields: `duration_ms`, `error_code`, `stage` ("fetch" | "verify" | "apply"). NOT collected: error message, network URL. Example: `{"duration_ms": 1800, "error_code": "E_REGISTRY_SIGNATURE_INVALID", "stage": "verify"}`.

**`self_update.start`**, **`self_update.complete`**, **`self_update.failed`** — Same structure as `update.*` but for `linuxify self-update` (the CLI itself). `self_update.complete` adds `from_version` and `to_version` (semver strings). Example: `{"from_version": "0.2.0", "to_version": "0.2.1", "duration_ms": 12000}`.

### Sync subsystem (v2, future)

**`sync.start`**, **`sync.complete`**, **`sync.failed`** — Emitted by cloud sync (see [Cloud Sync](../19-future/cloud-sync.md)). Fields: `device_count`, `duration_ms`, `conflicts_resolved` (number). NOT collected: synced file contents, device names. Example: `{"device_count": 3, "duration_ms": 4200, "conflicts_resolved": 0}`.

### Plugin subsystem

**`plugin.load`** — When a plugin is loaded. Fields: `plugin_hash` (salted hash of plugin name), `version` (string). NOT collected: plugin name, plugin source URL, hook list. Example: `{"plugin_hash": "1a2b3c...", "version": "0.1.0"}`.

**`plugin.hook_invoked`** — When a plugin hook is called. Fields: `plugin_hash`, `hook` (string, one of the standard hook names from [Extension API](../10-plugin-sdk/extension-api.md)), `duration_ms`. NOT collected: hook arguments, hook return value. Example: `{"plugin_hash": "1a2b3c...", "hook": "preInstall", "duration_ms": 4}`.

**`plugin.hook_failed`** — When a plugin hook throws. Fields: `plugin_hash`, `hook`, `duration_ms`, `error_code`. NOT collected: error message, stack trace (may contain file paths). Example: `{"plugin_hash": "1a2b3c...", "hook": "postRun", "duration_ms": 12, "error_code": "E_PLUGIN_HOOK_THREW"}`.

### CLI subsystem

**`cli.invoked`** — Emitted at the start of every CLI invocation. Fields: `command` (string, the subcommand name, e.g. "add"), `duration_ms` (only on the matching `cli.invoked` event sent at exit — actually `cli.invoked` is emitted at exit so duration is known). NOT collected: args (the single most important privacy property — args may contain file paths, package names the user wants to keep private, model names, etc.), flags (with one exception: `--json` is recorded because it changes the output contract and is structurally meaningful), working directory. Example: `{"command": "add", "duration_ms": 4280, "json_output": false}`.

Because `cli.invoked` is high-volume (every invocation), it is sampled at 10% by default (see §7).

### Error and crash subsystem

**`error.thrown`** — Emitted when a structured error is thrown (any error with a `code`). Fields: `error_code` (string), `command` (string), `exit_code` (number). NOT collected: error message (the most important property — messages may contain user file paths, package names, network URLs), stack trace, error context. Example: `{"error_code": "E_PATCH_VERIFY_FAILED", "command": "add", "exit_code": 4}`.

**`crash.uncaught`** — Emitted when an uncaught exception reaches the top-level handler. Fields: `error_code` (string, "E_INTERNAL_UNCAUGHT" if no code), `command` (string), `stack_trace` (string, sanitized per §4), `exit_code` (number, always 70 = INTERNAL_ERR per [CLI Spec §6](../03-cli/cli-specification.md#6-exit-code-convention)). NOT collected: variable values referenced in the stack, file contents, env var values. Example: `{"error_code": "E_INTERNAL_UNCAUGHT", "command": "add", "stack_trace": "TypeError: Cannot read properties of undefined (reading 'name')\n    at Object.install (<internal>)\n    at process.processTicksAndRejections (<internal>)", "exit_code": 70}`.

## 4. Privacy Filter

Before an event is appended to the queue, it passes through `redact(event)` — a deterministic, side-effect-free function that strips or masks any value that could carry user data. The redaction rules are:

- **File paths** are replaced with `<path>`. A path is any string matching `^/` or containing `/` followed by a filename, or matching `~/.linuxify/...`. The replacement preserves structure: `/data/data/com.termux/files/home/.linuxify/patches/cline/001.json` becomes `<path>`.
- **Env var values** are replaced with `<redacted>`. Any value in a `fields.env` object (or any field named `env`, `environment`, `env_vars`) is replaced wholesale; env var *names* are preserved (the names are structural — `OPENAI_API_KEY` was set, but its value is secret).
- **Package args** are replaced with `<args>`. The `cli.invoked` event deliberately does not have an `args` field; if a future event type tried to add one, the redactor would replace the entire array with `["<args>"]` of the same length.
- **URLs with authentication** are stripped of credentials: `https://user:pass@host/path` becomes `https://<redacted>@host/path`.
- **Strings matching secret patterns** (`*_TOKEN`, `*_KEY`, `*_SECRET`, `API_*`, `Bearer *`, `gh[pousr]_*`, `AKIA...`) are replaced with `***REDACTED***`, using the same pattern list as the logger (see [CLI Spec §8](../03-cli/cli-specification.md#8-logging)).
- **Stack traces** (in `crash.uncaught` only) have every path replaced with `<path>` and every `<anonymous>` frame preserved. Line numbers are kept (they are not user-identifying).

The redactor is applied *after* the event is constructed, not at field-write time, so a contributor adding a new field does not need to remember to redact — the redactor catches it. The redactor is unit-tested against a corpus of known-leaky inputs (real paths, real env vars, real stack traces from prior bugs) and the test fails on any input that produces a leak.

## 5. Event Versioning

Every event has `event_schema_version` in its envelope (currently 1). The version covers the envelope and the common fields; per-event-type `fields` are versioned by adding a `_v2` suffix to the event type name (e.g., `package.install_complete_v2`) when a breaking change is made to that event's fields. This avoids the alternative of a single global version that bumps on any event's change (which would force the server to handle every combination).

The server accepts any event whose `event_schema_version` it knows about; events with a higher version than the server knows are stored unprocessed (the server keeps the raw JSON) and processed retroactively when the server is upgraded. This is the "raw storage + schema migration" pattern common to event-sourcing systems and is the right trade-off for telemetry, where the server must not drop events just because it is briefly older than the client.

Breaking changes that bump the version: removing a field, changing a field's type, changing a field's semantics (e.g., redefining `duration_ms` to include or exclude some phase). Non-breaking changes that do *not* bump the version: adding an optional field, adding a new value to an enum. The catalog documents every version bump with a changelog entry; the server's per-event-type handler is versioned to match.

## 6. Event Rate Limiting

The client enforces two rate limits to protect both the user's bandwidth and the server's capacity:

- **Daily limit: 1000 events per `user_id` per UTC day.** When the limit is reached, subsequent events are dropped and a single `telemetry.rate_limited` event is emitted (once, not per dropped event) so the server knows events were lost. The dropped events are not buffered for the next day; they are gone.
- **Per-minute limit: 100 events per `user_id` per minute.** A burst of events (e.g., a script invoking `linuxify` in a loop) is throttled by dropping excess events. The throttle is sliding-window.

These limits match the server-side limits documented in [Analytics §13](./analytics.md#13-anti-gaming); the client enforces them proactively so a misbehaving script does not get its events rejected at ingestion time. The server still enforces the same limits as a defense against clients that ignore the protocol.

## 7. Event Sampling

High-volume events are sampled client-side to keep the queue manageable and the server cost predictable. The sampling configuration is in `config.toml`:

```toml
[telemetry]
sample_rate = 0.1                  # default 10% for high-volume events
sampled_events = ["cli.invoked"]   # which events are subject to sampling
```

Sampling is deterministic per `event_id`: the client computes `hash(event_id) % 1000 / 1000.0 < sample_rate`. Because `event_id` is UUIDv7 (random suffix), the sample is uniformly random; because it is deterministic, a re-send of the same event (e.g., after a network failure) produces the same sampling decision (so the server's deduplication works). Sampled-out events are never written to the queue.

The default 10% rate for `cli.invoked` produces, for a heavy user invoking `linuxify` 100 times a day, 10 events per day — enough for statistically meaningful command-frequency analysis without flooding the queue. Low-volume events (everything except `cli.invoked`) are not sampled. The sampling rate is configurable per event type and per user; an enterprise monitoring its own usage can set `sample_rate = 1.0` to capture every event.

## 8. Local Queue Format

The on-disk queue is `~/.linuxify/telemetry/queue.jsonl`, specified in detail in [Data Formats §14](../02-architecture/data-formats.md#14-linuxifytelemetryqueuejsonl--telemetry-event-queue). Each line is one `TelemetryEvent` (§1) serialized as compact JSON (no whitespace between fields). The queue is appended to with `O_APPEND | O_SYNC` (every write is durable) so events survive a crash mid-queue. If the queue exceeds 10 MB (roughly 50,000 events), the oldest events are dropped and a `telemetry.queue_overflow` event is recorded.

The flush triggers are:

- **Time-based:** 24 hours since the last flush (per `telemetry.flush_interval_hours`).
- **Volume-based:** 1000 events queued (per `telemetry.batch_size`).
- **Explicit:** `linuxify telemetry flush` flushes immediately and synchronously.
- **CLI exit:** On CLI exit, a best-effort flush is attempted with a 2-second timeout. If the flush does not complete in 2 seconds, the events stay in the queue and will be flushed by the next trigger.

The flush is opportunistic: if the network is unreachable, the batch is left in the queue and retried with exponential backoff (60s, 5min, 30min, 2h, 24h) and then abandoned (events stay in queue forever, but the queue's 10 MB cap will eventually evict them). The user is warned via `linuxify doctor`'s `telemetry.queue_backlog` check if the queue has been unable to flush for more than 7 days.

## 9. Server Response and Retry

The flush is an HTTPS POST to `telemetry.endpoint` (default `https://telemetry.linuxify.sh/v2/events`) with a JSON body containing an array of up to `batch_size` events. The server's response codes:

- **200 OK** — all events accepted. The client deletes them from the queue.
- **207 Multi-Status** — partial acceptance. The response body lists per-event acceptance or rejection; rejected events are deleted from the queue (the server has decided they are malformed or rate-limited and retries will not help).
- **413 Payload Too Large** — the batch is larger than the server's max body size. The client halves the batch size for the next flush and retries immediately.
- **429 Too Many Requests** — server-side rate limit. The client honors the `Retry-After` header (or defaults to 60s) and leaves the events in the queue for the next flush.
- **5xx** — server error. The client retries up to 3 times with exponential backoff (5s, 30s, 2min). After 3 retries, the events stay in the queue for the next scheduled flush.

The client never deletes events from the queue until the server has explicitly accepted them (200 or 207). A network failure mid-flush leaves the events in the queue; a duplicate flush (after a network failure that the client thought was a failure but the server thought was a success) sends the same events again, and the server deduplicates by `event_id`. This deduplication is the reason `event_id` must be unique per event (UUIDv7 guarantees this) and is the foundation of the at-least-once delivery semantics.

## 10. Telemetry Disable

When telemetry is disabled (`telemetry.enabled = false` in config, or `--no-telemetry` flag for one command, or the user never opted in), the behavior is subtle: events are *collected in memory* but never written to the queue and never sent. This is so `linuxify telemetry show` can display exactly what *would* be sent if the user opted in — the transparency property documented in [telemetry-privacy.md §4](./telemetry-privacy.md#4-opt-in-mechanism). A user who is considering opting in can run `linuxify telemetry show` to see the events their usage would generate, and make an informed decision.

The in-memory collection has a small cap (100 events; oldest evicted) to avoid unbounded memory growth on a long-running script. The collected events are not redacted (redaction happens at queue-write time, which is skipped when disabled) but they are also not displayed by default — `linuxify telemetry show` runs the redactor over the in-memory events before displaying them, so the user sees the same redacted form the server would see. The raw (unredacted) in-memory events never leave the process and are discarded on exit.

`--no-telemetry` (the one-command flag) has the same effect: events for that command are collected in memory (so `linuxify telemetry show` after the command sees them) but not written to the queue. This is useful for one-off private operations (e.g., `linuxify run <pkg> --no-telemetry` when the user is doing something they would rather not even anonymously log) without disabling telemetry globally.

The `telemetry = false` setting in `[default]` of `config.toml` (per [CLI Spec §7](../03-cli/cli-specification.md#7-configuration-files)) is the persistent form of `--no-telemetry`. The two are equivalent in effect; the flag is for one-command override, the config is for persistent preference. A user who has telemetry enabled globally can use `--no-telemetry` for a single command without changing their config; a user who has telemetry disabled globally can use `--telemetry` for a single command to opt in for that command only.
