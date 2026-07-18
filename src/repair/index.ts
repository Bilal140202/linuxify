/**
 * Public API surface for the `repair` module.
 *
 * @module linuxify/repair
 *
 * Re-exports the {@link RepairEngine} class, the repair types, and a factory
 * that wires the engine to the default doctor engine and state store. The
 * CLI's `linuxify repair` command imports from here; downstream subsystems
 * should too (`../repair` or `linuxify/repair`).
 *
 * @packageDocumentation
 */

import { DoctorEngine } from '../doctor/engine.js';
import { ALL_CHECKS } from '../doctor/checks/index.js';
import { getStatePath, StateStore } from '../state/index.js';

import { RepairEngine } from './engine.js';

export { RepairEngine } from './engine.js';
export type {
  RepairResult,
  RepairFixResult,
  RepairOptions,
  RepairEngineOptions,
  RepairExecFn,
} from './types.js';

/**
 * Cached default engine. Lazily created on first call to
 * {@link createRepairEngine} so importing the repair module does not pay the
 * cost of constructing the doctor engine (and so tests can swap the engine
 * by mutating this variable via `_resetRepairEngineForTests`).
 */
let _defaultEngine: RepairEngine | undefined;

/**
 * Create (or return the cached) default {@link RepairEngine}, wired to the
 * default {@link DoctorEngine} (built from {@link ALL_CHECKS}) and the
 * {@link StateStore} pointed at {@link getStatePath}.
 *
 * Tests that need a custom doctor or state store should construct their own
 * `new RepairEngine({ doctor, stateStore })`.
 *
 * @returns A shared {@link RepairEngine} instance.
 */
export function createRepairEngine(): RepairEngine {
  if (!_defaultEngine) {
    const doctor = new DoctorEngine({ checks: ALL_CHECKS });
    const stateStore = new StateStore(getStatePath());
    _defaultEngine = new RepairEngine({ doctor, stateStore });
  }
  return _defaultEngine;
}

/**
 * Reset the cached default engine. Exported for tests that want to
 * reconstruct the engine after swapping the doctor checks or the state
 * store; not part of the public repair API surface.
 *
 * @internal
 */
export function _resetRepairEngineForTests(): void {
  _defaultEngine = undefined;
}
