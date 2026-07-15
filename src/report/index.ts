/**
 * Report subsystem — generates user-facing environment reports for bug filing,
 * support, and compatibility auditing.
 *
 * @module linuxify/report
 *
 * `linuxify report` is the single command users run when "something doesn't
 * work." It produces a deterministic, redacted, copy-pasteable summary of:
 *
 *   1. Host environment (Android version, Termux version, arch, kernel, storage)
 *   2. Linuxify install (version, bootstrap stage, active distro)
 *   3. Installed runtimes (Node, Python, Git versions per distro)
 *   4. Installed packages (name, version, status, last-run exit code if known)
 *   5. Doctor summary (pass/warn/fail counts, no PII)
 *   6. Compatibility assessment (per-package: works / needs-patch / broken)
 *
 * The report is the "fingerprint" the user pastes into a GitHub issue. It
 * replaces the manual version-listing ritual that every bug report currently
 * requires. See `docs/22-operations/troubleshooting.md` §7 and the user's
 * original feature request.
 *
 * Output formats:
 *   - `--text` (default): human-readable, ANSI-colored if TTY, plain otherwise
 *   - `--json`: machine-readable, stable schema `linuxify.report.v1`
 *   - `--markdown`: GitHub-issue-ready, wrapped in a fenced code block
 *   - `--fingerprint`: compact one-liner for log signatures
 *
 * Privacy:
 *   - No file paths beyond `~/.linuxify/` top-level
 *   - No env var values
 *   - No package arguments
 *   - No username, hostname, or device serial
 *   - Telemetry user_id is NOT included (would correlate reports to a user)
 *   - The report is safe to paste into a public GitHub issue
 *
 * @packageDocumentation
 */

export { generateReport, formatReport, type Report, type ReportFormat } from './generator.js';
export { fingerprintFromReport, formatFingerprint, type Fingerprint } from './fingerprint.js';
