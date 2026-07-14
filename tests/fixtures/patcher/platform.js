/**
 * Sample fixture file for patcher tests: a tiny Node.js module with a
 * `process.platform === "linux"` check that needs patching to also
 * accept `"android"`. Mirrors the canonical Cline platform-check
 * example from docs/08-patcher/patcher-engine.md §16.1.
 */

'use strict';

function isLinux() {
  return process.platform === 'linux';
}

function isArm64() {
  return process.arch === 'arm64';
}

module.exports = { isLinux, isArm64 };
