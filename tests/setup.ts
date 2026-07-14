// Vitest setup file - runs before every test file.
// Provides global mocks, test utilities, and environment configuration.

process.env.LINUXIFY_TEST_MODE = '1';
process.env.LINUXIFY_HOME = process.env.LINUXIFY_HOME || '/tmp/linuxify-test-home';
process.env.LINUXIFY_LOG_LEVEL = 'warn'; // quiet logs during tests unless explicitly enabled
process.env.LINUXIFY_TELEMETRY = '0';
process.env.NO_COLOR = '1';

import { vi } from 'vitest';

// Mock process.exit so tests can assert it was called without actually exiting.
global.process.exit = vi.fn() as unknown as typeof process.exit;

// Mock process.stdout.write and process.stderr.write for output assertions
// (only if tests want to capture them; otherwise passthrough).
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  return origStdoutWrite(chunk as string, ...(rest as []));
}) as typeof process.stdout.write;

process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
  return origStderrWrite(chunk as string, ...(rest as []));
}) as typeof process.stderr.write;
