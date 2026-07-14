/**
 * Default configuration values for Linuxify.
 *
 * The defaults are derived from {@link ConfigSchema} by parsing an empty input,
 * which lets Zod apply every `.default()` declared in the schema. This means
 * the defaults can never drift from the schema — adding a new field with a
 * default in the schema automatically appears here.
 *
 * The resulting object is the lowest layer in the override precedence ladder
 * (see `loader.ts`): every resolved config starts as a deep copy of
 * {@link DEFAULT_CONFIG} and is progressively overridden by the user file,
 * project-local file, environment variables, and CLI flags.
 *
 * @packageDocumentation
 */

import { ConfigSchema, type Config } from './schema.js';

/**
 * Fully-populated default config. Equal to `ConfigSchema.parse({})`. Callers
 * must treat this as read-only — mutation would corrupt the shared default
 * baseline. The loader always deep-merges onto a fresh copy before mutating.
 */
export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});
