/**
 * Diagnostics engine — maps stderr patterns to specific diagnoses + fixes.
 *
 * @module linuxify/diagnostics
 *
 * This is the "AI mechanic" layer. When a command fails, instead of reporting
 * a generic "X failed" message, the diagnostics engine inspects the error
 * output and produces a specific diagnosis:
 *
 *   1. WHAT went wrong (plain English)
 *   2. WHY it likely happened (root cause)
 *   3. EVIDENCE (the matching stderr pattern)
 *   4. REPAIR (the exact command to fix it)
 *   5. CONFIDENCE (0-1, how sure we are)
 *
 * Patterns are hand-authored based on real bug reports. Each pattern is a
 * regex matched against stderr (and stdout). The first match wins.
 *
 * Example:
 *   stderr: "bad interpreter: /data/data/com.termux/files/usr/bin/python3.13: No such file or directory"
 *   diagnosis: {
 *     what: "proot-distro is broken — its shebang points to a Python version that no longer exists",
 *     why: "This happens after a Termux Python upgrade (e.g., 3.13 → 3.14). The proot-distro script still has the old interpreter path in its first line.",
 *     repair: "pkg reinstall proot-distro",
 *     confidence: 0.99,
 *   }
 *
 * @packageDocumentation
 */

export { diagnoseError, formatDiagnosis } from './engine.js';
export { builtinPatterns } from './patterns.js';
export { type StderrPattern, type Diagnosis, type DiagnosticContext } from './types.js';
