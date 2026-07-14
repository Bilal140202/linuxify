#!/usr/bin/env node
/**
 * Linuxify CLI entry point — the file the `linuxify` bin script runs.
 *
 * @module linuxify/cli
 *
 * This file is intentionally tiny: it forwards `process.argv.slice(2)` to
 * {@link runCli} and translates the returned exit code into
 * `process.exitCode`. It does NOT call `process.exit` directly, because the
 * `no-process-exit` ESLint rule forbids it and because synchronous
 * `process.exit` would skip pending `setTimeout`/`fsync` work in the logger
 * and the state store's atomic-write path.
 *
 * The shebang line above makes the file directly executable on Unix; the
 * `bin` field in `package.json` points the `linuxify` symlink at this file
 * after `npm install`.
 *
 * @packageDocumentation
 */

import { runCli } from './router.js';

/**
 * Entry point. We import `process` lazily-equivalent from the global so the
 * file degrades gracefully if it is ever imported by tests that have
 * replaced `process.argv`.
 */
runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((err: unknown) => {
    // The router is supposed to catch every error and return a numeric exit
    // code. If it threw anyway, that's an internal bug — print it and
    // surface a non-zero exit code so CI catches it.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: linuxify crashed: ${msg}`);
    process.exitCode = 1;
  });
