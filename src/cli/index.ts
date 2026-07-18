#!/usr/bin/env node
/**
 * Linuxify CLI entry point — the file the `linuxify` bin script runs.
 *
 * IMPROVEMENTS v0.1.0-alpha.2:
 * - Structured error output with telemetry crash reporting (FIX C3)
 * - Proper exit code handling without process.exit()
 * - JSON output support for CI integration
 */

import { runCli } from './router.js';
import { Output } from './output.js';
import { logger, flushLogs } from '../utils/log.js';
import { EXIT_CODES } from '../utils/constants.js';
import { isLinuxifyError } from '../utils/errors.js';

/**
 * Entry point. We import `process` lazily-equivalent from the global so the
 * file degrades gracefully if it is ever imported by tests that have
 * replaced `process.argv`.
 */
async function main(): Promise<void> {
  const output = new Output({ format: process.stdout.isTTY ? 'human' : 'json' });

  try {
    const exitCode = await runCli(process.argv.slice(2));
    process.exitCode = exitCode;
  } catch (err: unknown) {
    // FIX C3: Structured error handling with telemetry
    const msg = err instanceof Error ? err.message : String(err);
    const code = isLinuxifyError(err) ? err.exitCode : EXIT_CODES.INTERNAL_UNKNOWN;
    const errorCode = isLinuxifyError(err) ? err.code : 'E_INTERNAL_UNKNOWN';

    // Log to structured logger
    logger.error('Fatal crash in CLI router', {
      error: msg,
      code: errorCode,
      exitCode: code,
      stack: err instanceof Error ? err.stack : undefined,
    });

    // Emit structured error for CI/telemetry
    if (output.format === 'json') {
      output.error({
        success: false,
        error: {
          code: errorCode,
          message: msg,
          exitCode: code,
          docsUrl: isLinuxifyError(err) ? err.docsUrl : undefined,
          fixCommand: isLinuxifyError(err) ? err.fixCommand : undefined,
        },
      });
    } else {
      console.error(`Fatal: linuxify crashed: ${msg}`);
      if (isLinuxifyError(err) && err.fixCommand) {
        console.error(`\nTry: ${err.fixCommand}`);
      }
      if (isLinuxifyError(err) && err.docsUrl) {
        console.error(`Docs: ${err.docsUrl}`);
      }
    }

    // Flush logs before exit
    await flushLogs();
    process.exitCode = code;
  }
}

main();
