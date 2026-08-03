/**
 * SystemState — single source of truth for "is Linuxify ready to use?"
 *
 * @module linuxify/system
 *
 * This is the state machine the user envisioned. Every `linuxify` invocation
 * starts by calling `assessSystemState()`, which returns one of:
 *
 *   - `not-initialized` → first run, need to bootstrap
 *   - `repairable`      → something is broken but auto-fixable (missing user,
 *                          missing distro, corrupt state)
 *   - `ready`           → everything works, launch the shell
 *   - `broken`          → something is wrong that we can't auto-fix
 *
 * The CLI's default entrypoint (`linuxify` with no args) uses this to decide
 * what to do WITHOUT requiring the user to know about `init`, `doctor`,
 * `repair`, or `shell`.
 *
 * @packageDocumentation
 */

export {
  assessSystemState,
  type SystemState,
  type SystemStateAssessment,
} from './state.js';
