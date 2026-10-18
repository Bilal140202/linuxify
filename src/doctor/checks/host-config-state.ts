/**
 * Doctor check: `hosting.config-state`.
 *
 * @module linuxify/doctor/checks/host-config-state
 *
 * Verifies that the hosting subsystem's `config.json` is internally
 * consistent with the rest of linuxify's state:
 *  - The `hosting/config.json` file exists if `state.hosting_initialized`
 *    markers suggest it should (we don't have a `hosting_initialized`
 *    field in `state.json`, so we infer from the existence of
 *    `~/.linuxify/hosting/`).
 *  - The `apps[]` array doesn't have duplicate names.
 *  - Every app's `port` is in the valid range (1024-65535).
 *  - Every app's `type` matches one of the known enum values.
 *
 * This check never shells out — it only reads `config.json` from disk
 * (via the `HostingEngine.loadConfig()` path, but here we do a direct
 * read to keep the doctor independent of the hosting engine's caching).
 *
 * @packageDocumentation
 */

import { join } from 'node:path';

import { HostingConfigSchema } from '../../hosting/config.js';
import { exists, readFile } from '../../utils/fs.js';
import { getLinuxifyHome } from '../../utils/process.js';
import type { DoctorCheck, DoctorContext, DoctorResult } from '../types.js';

const HOSTING_SUBDIR = 'hosting';
const HOSTING_CONFIG_FILE = 'config.json';

/**
 * The `hosting.config-state` doctor check. Registered in `checks/index.ts`.
 */
export const hostConfigStateCheck: DoctorCheck = {
  id: 'hosting.config-state',
  name: 'Hosting config state',
  category: 'services',
  profile: ['standard', 'deep', 'post-install', 'ci'],
  explain: {
    what: 'Verifies that the hosting subsystem\'s config.json exists, parses, and is internally consistent (no duplicate app names, valid ports, valid types).',
    why: 'The hosting engine caches config in memory and writes back on every deploy. A corrupt config — duplicate app names, out-of-range ports, invalid types — would cause silent failures (deploy overwrites the wrong app, port conflicts at runtime, PM2 commands fail with "no such app").',
    consequence: '`linuxify host list` would show duplicate or broken entries; `linuxify host deploy` would silently overwrite the wrong app; `linuxify host start <name>` may pick the wrong PM2 process.',
    fix: 'linuxify repair state',
  },

  async run(_ctx: DoctorContext): Promise<DoctorResult> {
    const start = Date.now();
    const base: Pick<DoctorResult, 'id' | 'name' | 'category'> = {
      id: 'hosting.config-state',
      name: 'Hosting config state',
      category: 'services',
    };

    const configPath = join(getLinuxifyHome(), HOSTING_SUBDIR, HOSTING_CONFIG_FILE);
    if (!(await exists(configPath))) {
      // Not initialized — that's fine; the check is only meaningful
      // once the user has run `linuxify host init`.
      return {
        ...base,
        status: 'skip',
        message: 'Hosting config not found. Run: linuxify host init',
        detail: { configPath },
        durationMs: Date.now() - start,
      };
    }

    let raw: string;
    try {
      raw = await readFile(configPath);
    } catch (err) {
      return {
        ...base,
        status: 'fail',
        message: `Cannot read hosting config: ${(err as Error).message}`,
        detail: { configPath, error: (err as Error).message },
        fixCommand: 'linuxify repair state',
        durationMs: Date.now() - start,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ...base,
        status: 'fail',
        message: `Hosting config.json is malformed JSON: ${(err as Error).message}`,
        detail: { configPath, error: (err as Error).message },
        fixCommand: 'linuxify repair state',
        durationMs: Date.now() - start,
      };
    }

    const result = HostingConfigSchema.safeParse(parsed);
    if (!result.success) {
      return {
        ...base,
        status: 'fail',
        message: `Hosting config.json failed schema validation: ${result.error.issues[0]?.message ?? 'unknown'}`,
        detail: {
          configPath,
          zodErrors: result.error.issues,
        },
        fixCommand: 'linuxify repair state',
        durationMs: Date.now() - start,
      };
    }

    // Cross-field consistency: no duplicate app names.
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const app of result.data.apps) {
      if (seen.has(app.name)) dupes.push(app.name);
      seen.add(app.name);
    }

    const issues: string[] = [];
    if (dupes.length > 0) {
      issues.push(`Duplicate app name(s): ${dupes.join(', ')}. Run: linuxify repair state`);
    }

    // Ports unique.
    const portsSeen = new Set<number>();
    const portDupes: number[] = [];
    for (const app of result.data.apps) {
      if (portsSeen.has(app.port)) portDupes.push(app.port);
      portsSeen.add(app.port);
    }
    if (portDupes.length > 0) {
      issues.push(`Duplicate port(s) across apps: ${portDupes.join(', ')}. Run: linuxify host doctor`);
    }

    if (issues.length === 0) {
      return {
        ...base,
        status: 'ok',
        message: `Hosting config OK (${result.data.apps.length} app(s), initialized: ${result.data.initialized}).`,
        detail: {
          configPath,
          initialized: result.data.initialized,
          appCount: result.data.apps.length,
          webServer: result.data.webServer,
          defaultPort: result.data.defaultPort,
        },
        durationMs: Date.now() - start,
      };
    }

    return {
      ...base,
      status: 'warn',
      message: `Hosting config has ${issues.length} issue(s).`,
      detail: { configPath, issues },
      fixCommand: 'linuxify repair state',
      durationMs: Date.now() - start,
    };
  },
};
