/**
 * Unit tests for the config loader in `src/config/loader.ts`.
 *
 * Each test gets a fresh temp directory and a clean LINUXIFY_* environment, so
 * the global setup.ts values (LINUXIFY_LOG_LEVEL=warn, LINUXIFY_TELEMETRY=0)
 * don't leak into override-layer assertions. `process.cwd` is mocked to the
 * temp dir so project-local `.linuxify.toml` detection is deterministic.
 */

import { mkdtemp, writeFile as fsWriteFile, stat, readFile as fsReadFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger to avoid the pino multistream initialization that opens a log
// file in ~/.linuxify/logs/ — irrelevant to config-loader semantics and flaky
// in CI where the home directory may not be writable. The mock provides the
// same Logger shape (warn/info/etc.) as no-ops.
vi.mock('../../../src/utils/log.js', () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => ({
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(),
      warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
      child: vi.fn(),
    })),
    level: 'info',
  },
}));

import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import { loadConfig, deepMerge } from '../../../src/config/loader.js';
import { ConfigError } from '../../../src/utils/errors.js';

// ============================================================================
// Env var management
// ============================================================================

/** Config-related env vars the loader reads. Cleared per-test, restored after. */
const LINUXIFY_ENV_KEYS = [
  'LINUXIFY_DISTRO',
  'LINUXIFY_TELEMETRY',
  'LINUXIFY_LOG_LEVEL',
  'LINUXIFY_LOCALE',
  'LINUXIFY_REGISTRY_URL',
  'LINUXIFY_CONFIG_PATH',
  'LINUXIFY_HOME',
] as const;

let envSnapshot: Record<string, string | undefined>;
let tempDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  // Snapshot & clear LINUXIFY_* env vars.
  envSnapshot = {};
  for (const key of LINUXIFY_ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }

  // Fresh temp dir per test.
  tempDir = await mkdtemp(join(tmpdir(), 'linuxify-cfg-'));

  // Mock process.cwd so project-local detection is deterministic.
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
});

afterEach(() => {
  // Restore env.
  for (const key of LINUXIFY_ENV_KEYS) {
    if (envSnapshot[key] === undefined) delete process.env[key];
    else process.env[key] = envSnapshot[key];
  }
  cwdSpy.mockRestore();
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Write a TOML string to a fresh file inside `tempDir` and return its path.
 * The filename is `config.toml` by default; pass a name to override.
 */
async function writeTempConfig(
  toml: string,
  name = 'config.toml',
): Promise<string> {
  const p = join(tempDir, name);
  await fsWriteFile(p, toml, 'utf8');
  return p;
}

/** Resolve a path inside the per-test tempDir. */
function inTempDir(name: string): string {
  return join(tempDir, name);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('loadConfig — first-run seeding', () => {
  it('returns DEFAULT_CONFIG when no file exists and seeds the file', async () => {
    const configPath = inTempDir('config.toml');
    expect(await fileExists(configPath)).toBe(false);

    const config = await loadConfig({ configPath });

    // Result equals defaults (no env, no file, no project-local).
    expect(config).toEqual(DEFAULT_CONFIG);
    // File was created.
    expect(await fileExists(configPath)).toBe(true);
  });

  it('writes the file atomically with mode 0600', async () => {
    const configPath = inTempDir('config.toml');
    await loadConfig({ configPath });

    const s = await stat(configPath);
    expect(s.mode & 0o777).toBe(0o600);
  });

  it('creates parent directories if missing (ensureDir)', async () => {
    const configPath = inTempDir('nested/deep/config.toml');
    await loadConfig({ configPath });
    expect(await fileExists(configPath)).toBe(true);
  });

  it('seeded file content parses back to DEFAULT_CONFIG', async () => {
    const configPath = inTempDir('config.toml');
    await loadConfig({ configPath });

    const content = await fsReadFile(configPath, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    expect(parsed.config_schema_version).toBe(1);
    expect(parsed.bootstrap).toMatchObject({
      distro: 'ubuntu',
      parallel_downloads: 4,
      locale: 'en_US.UTF-8',
      timezone: 'UTC',
    });
    expect(parsed.distro).toEqual({ default: 'ubuntu' });
    expect(parsed.telemetry).toMatchObject({
      enabled: false,
      endpoint: 'https://telemetry.linuxify.sh/v2',
      sample_rate: 0.1,
    });
  });
});

describe('loadConfig — custom path', () => {
  it('loads from an explicit configPath', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
distro = "debian"
`);
    const config = await loadConfig({ configPath });
    expect(config.bootstrap.distro).toBe('debian');
  });

  it('honors LINUXIFY_CONFIG_PATH env var when no explicit path given', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
distro = "arch"
`);
    process.env.LINUXIFY_CONFIG_PATH = configPath;
    const config = await loadConfig();
    expect(config.bootstrap.distro).toBe('arch');
  });

  it('explicit configPath wins over LINUXIFY_CONFIG_PATH', async () => {
    const envPath = await writeTempConfig(`
[bootstrap]
distro = "from-env"
`, 'env.toml');
    const explicitPath = await writeTempConfig(`
[bootstrap]
distro = "from-opts"
`, 'explicit.toml');
    process.env.LINUXIFY_CONFIG_PATH = envPath;
    const config = await loadConfig({ configPath: explicitPath });
    expect(config.bootstrap.distro).toBe('from-opts');
  });
});

describe('loadConfig — override layers', () => {
  it('file values override defaults', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
parallel_downloads = 16
distro = "arch"

[telemetry]
enabled = true
`);
    const config = await loadConfig({ configPath });
    expect(config.bootstrap.parallel_downloads).toBe(16);
    expect(config.bootstrap.distro).toBe('arch');
    expect(config.telemetry.enabled).toBe(true);
    // Untouched fields keep defaults.
    expect(config.bootstrap.locale).toBe('en_US.UTF-8');
    expect(config.distro.default).toBe('ubuntu');
  });

  it('env vars override file values', async () => {
    process.env.LINUXIFY_DISTRO = 'alpine';
    process.env.LINUXIFY_TELEMETRY = 'true';
    process.env.LINUXIFY_LOG_LEVEL = 'debug';
    process.env.LINUXIFY_LOCALE = 'fr';
    process.env.LINUXIFY_REGISTRY_URL = 'https://github.com/myfork/registry';

    const configPath = await writeTempConfig(`
[distro]
default = "ubuntu"

[telemetry]
enabled = false

[logging]
level = "info"

[i18n]
locale = "en"

[registry]
url = "https://github.com/linuxify/registry"
`);
    const config = await loadConfig({ configPath });
    expect(config.distro.default).toBe('alpine');
    expect(config.telemetry.enabled).toBe(true);
    expect(config.logging.level).toBe('debug');
    expect(config.i18n.locale).toBe('fr');
    expect(config.registry.url).toBe('https://github.com/myfork/registry');
  });

  it('env var LINUXIFY_TELEMETRY accepts "1" as true', async () => {
    process.env.LINUXIFY_TELEMETRY = '1';
    const config = await loadConfig({ configPath: inTempDir('config.toml') });
    expect(config.telemetry.enabled).toBe(true);
  });

  it('env var LINUXIFY_TELEMETRY accepts "0" as false', async () => {
    process.env.LINUXIFY_TELEMETRY = '0';
    const config = await loadConfig({ configPath: inTempDir('config.toml') });
    expect(config.telemetry.enabled).toBe(false);
  });

  it('env var LINUXIFY_TELEMETRY rejects invalid bool with ConfigError', async () => {
    process.env.LINUXIFY_TELEMETRY = 'maybe';
    await expect(
      loadConfig({ configPath: inTempDir('config.toml') }),
    ).rejects.toThrow();
    try {
      await loadConfig({ configPath: inTempDir('config.toml') });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CONFIG_ENV_INVALID_BOOL');
    }
  });

  it('empty-string env vars are ignored (treated as unset)', async () => {
    process.env.LINUXIFY_DISTRO = '';
    const config = await loadConfig({ configPath: inTempDir('config.toml') });
    expect(config.distro.default).toBe('ubuntu'); // default, not empty string
  });

  it('CLI flags override env vars (highest precedence)', async () => {
    process.env.LINUXIFY_DISTRO = 'from-env';
    const config = await loadConfig({
      configPath: inTempDir('config.toml'),
      flags: { distro: { default: 'from-flag' } },
    });
    expect(config.distro.default).toBe('from-flag');
  });

  it('precedence ladder: defaults < file < env < flags', async () => {
    // Default distro.default = 'ubuntu'.
    const configPath = await writeTempConfig(`
[distro]
default = "debian"
`);
    // File says debian.
    const cfgFile = await loadConfig({ configPath });
    expect(cfgFile.distro.default).toBe('debian');

    // Env overrides file.
    process.env.LINUXIFY_DISTRO = 'arch';
    const cfgEnv = await loadConfig({ configPath });
    expect(cfgEnv.distro.default).toBe('arch');

    // Flag overrides env.
    const cfgFlag = await loadConfig({
      configPath,
      flags: { distro: { default: 'alpine' } },
    });
    expect(cfgFlag.distro.default).toBe('alpine');
  });
});

describe('loadConfig — deep merge', () => {
  it('nested section is merged, not replaced (file adds one key, defaults keep others)', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
parallel_downloads = 8
`);
    const config = await loadConfig({ configPath });
    expect(config.bootstrap.parallel_downloads).toBe(8); // from file
    expect(config.bootstrap.distro).toBe('ubuntu'); // from default
    expect(config.bootstrap.locale).toBe('en_US.UTF-8'); // from default
    expect(config.bootstrap.timezone).toBe('UTC'); // from default
    expect(config.bootstrap.runtimes).toEqual([]); // from default
  });

  it('arrays are replaced, not concatenated', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
runtimes = ["rust"]
[experimental]
features = ["ast_patcher"]
`);
    const config = await loadConfig({ configPath });
    expect(config.bootstrap.runtimes).toEqual(['rust']); // replaced, not ["rust", ...defaults]
    expect(config.experimental.features).toEqual(['ast_patcher']);
  });

  it('deepMerge helper: plain objects merge recursively', () => {
    const base = { a: 1, b: { x: 1, y: 2 } };
    const merged = deepMerge(base, { b: { y: 99, z: 3 } });
    expect(merged).toEqual({ a: 1, b: { x: 1, y: 99, z: 3 } });
  });

  it('deepMerge helper: arrays replace', () => {
    const base = { list: [1, 2, 3] };
    const merged = deepMerge(base, { list: [4] });
    expect(merged).toEqual({ list: [4] });
  });

  it('deepMerge helper: primitives replace', () => {
    const base = { n: 1, s: 'a' };
    const merged = deepMerge(base, { n: 2, s: 'b' });
    expect(merged).toEqual({ n: 2, s: 'b' });
  });

  it('deepMerge helper: undefined and null override values are skipped', () => {
    const base = { a: 1, b: 2 };
    const merged = deepMerge(base, { a: undefined, b: null });
    expect(merged).toEqual({ a: 1, b: 2 });
  });

  it('deepMerge does not mutate base', () => {
    const base = { a: 1, nested: { x: 1 } };
    const frozen = JSON.parse(JSON.stringify(base));
    deepMerge(base, { nested: { y: 2 } });
    expect(base).toEqual(frozen);
  });
});

describe('loadConfig — profile selection', () => {
  it('applies the selected profile as an overlay', async () => {
    const configPath = await writeTempConfig(`
[distro]
default = "ubuntu"

[telemetry]
enabled = false

[profiles.work]
distro = { default = "arch" }
telemetry = { enabled = true }
`);
    const config = await loadConfig({ configPath, profile: 'work' });
    expect(config.distro.default).toBe('arch'); // from profile
    expect(config.telemetry.enabled).toBe(true); // from profile
  });

  it('profile overrides file non-profile settings', async () => {
    // The file says distro=debian, but the profile says distro=arch.
    // Profile is applied after the file is read, so arch wins.
    const configPath = await writeTempConfig(`
[distro]
default = "debian"

[profiles.work]
distro = { default = "arch" }
`);
    const config = await loadConfig({ configPath, profile: 'work' });
    expect(config.distro.default).toBe('arch');
  });

  it('returns unchanged config when profile is not found (with warning)', async () => {
    const configPath = await writeTempConfig(`
[distro]
default = "ubuntu"
`);
    const config = await loadConfig({ configPath, profile: 'nonexistent' });
    expect(config.distro.default).toBe('ubuntu');
  });

  it('profile values are deep-merged, not wholesale replaced', async () => {
    // File sets bootstrap.parallel_downloads=8 and a profile sets only
    // bootstrap.distro. After profile application, both should be present.
    const configPath = await writeTempConfig(`
[bootstrap]
parallel_downloads = 8

[profiles.dev]
bootstrap = { distro = "arch" }
`);
    const config = await loadConfig({ configPath, profile: 'dev' });
    expect(config.bootstrap.distro).toBe('arch'); // from profile
    expect(config.bootstrap.parallel_downloads).toBe(8); // preserved from file
  });

  it('profile loses to env vars and CLI flags', async () => {
    const configPath = await writeTempConfig(`
[profiles.work]
distro = { default = "arch" }
`);
    process.env.LINUXIFY_DISTRO = 'alpine';
    const cfgEnv = await loadConfig({ configPath, profile: 'work' });
    expect(cfgEnv.distro.default).toBe('alpine'); // env wins over profile

    const cfgFlag = await loadConfig({
      configPath,
      profile: 'work',
      flags: { distro: { default: 'debian' } },
    });
    expect(cfgFlag.distro.default).toBe('debian'); // flag wins
  });
});

describe('loadConfig — project-local .linuxify.toml', () => {
  it('honors allowed sections (runtime, i18n, experimental) from .linuxify.toml', async () => {
    const configPath = await writeTempConfig(`
[runtime]
node_default_version = "lts"
`);
    await writeTempConfig(`
[runtime]
node_default_version = "22.11.0"

[i18n]
locale = "fr"

[experimental]
features = ["ast_patcher"]
`, '.linuxify.toml');

    const config = await loadConfig({ configPath });
    // Project-local overrides file.
    expect(config.runtime.node_default_version).toBe('22.11.0');
    expect(config.i18n.locale).toBe('fr');
    expect(config.experimental.features).toEqual(['ast_patcher']);
  });

  it('rejects [bootstrap] in .linuxify.toml with E_CONFIG_PROJECT_FILE_TOO_BROAD', async () => {
    const configPath = await writeTempConfig('');
    await writeTempConfig(`
[bootstrap]
distro = "debian"
`, '.linuxify.toml');

    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CONFIG_PROJECT_FILE_TOO_BROAD');
      expect((e as ConfigError).details?.forbidden).toContain('bootstrap');
    }
  });

  it('rejects [telemetry] in .linuxify.toml', async () => {
    const configPath = await writeTempConfig('');
    await writeTempConfig(`
[telemetry]
enabled = true
`, '.linuxify.toml');

    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CONFIG_PROJECT_FILE_TOO_BROAD');
      expect((e as ConfigError).details?.forbidden).toContain('telemetry');
    }
  });

  it('rejects [sync] in .linuxify.toml', async () => {
    const configPath = await writeTempConfig('');
    await writeTempConfig(`
[sync]
enabled = true
`, '.linuxify.toml');
    await expect(loadConfig({ configPath })).rejects.toThrow();
  });

  it('rejects [registry] in .linuxify.toml', async () => {
    const configPath = await writeTempConfig('');
    await writeTempConfig(`
[registry]
url = "https://evil.example.com"
`, '.linuxify.toml');
    await expect(loadConfig({ configPath })).rejects.toThrow();
  });

  it('rejects [distro] in .linuxify.toml (not in allowed subset)', async () => {
    const configPath = await writeTempConfig('');
    await writeTempConfig(`
[distro]
default = "arch"
`, '.linuxify.toml');
    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CONFIG_PROJECT_FILE_TOO_BROAD');
    }
  });

  it('project-local overrides user config file', async () => {
    const configPath = await writeTempConfig(`
[runtime]
node_default_version = "lts"
python_default_version = "3.11"

[i18n]
locale = "en"
`);
    await writeTempConfig(`
[runtime]
node_default_version = "22.11.0"

[i18n]
locale = "fr"
`, '.linuxify.toml');

    const config = await loadConfig({ configPath });
    // Project-local overrides file for the keys it sets.
    expect(config.runtime.node_default_version).toBe('22.11.0');
    expect(config.i18n.locale).toBe('fr');
    // Untouched keys are preserved (deep merge, not replace).
    expect(config.runtime.python_default_version).toBe('3.11');
  });

  it('absence of .linuxify.toml is a no-op', async () => {
    // No .linuxify.toml in tempDir.
    const configPath = await writeTempConfig(`
[distro]
default = "ubuntu"
`);
    const config = await loadConfig({ configPath });
    expect(config.distro.default).toBe('ubuntu');
  });
});

describe('loadConfig — validation failures', () => {
  it('throws ConfigError (E_CONFIG_INVALID) on schema violation in file', async () => {
    const configPath = await writeTempConfig(`
[logging]
level = "verbose"
`);
    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CONFIG_INVALID');
      expect((e as ConfigError).details?.issues).toBeDefined();
    }
  });

  it('throws ConfigError on wrong-type field', async () => {
    const configPath = await writeTempConfig(`
[bootstrap]
parallel_downloads = "not-a-number"
`);
    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect((e as ConfigError).code).toBe('E_CONFIG_INVALID');
    }
  });

  it('throws ConfigError on sample_rate out of range', async () => {
    const configPath = await writeTempConfig(`
[telemetry]
sample_rate = 2.5
`);
    await expect(loadConfig({ configPath })).rejects.toThrow();
  });

  it('throws ConfigError on unknown top-level section in file', async () => {
    const configPath = await writeTempConfig(`
[bogus_section]
key = "value"
`);
    await expect(loadConfig({ configPath })).rejects.toThrow();
  });

  it('throws ConfigError (E_CONFIG_PARSE_FAILED) on malformed TOML', async () => {
    const configPath = await writeTempConfig(`
[bootstrap
distro = "ubuntu"
`); // missing closing bracket
    await expect(loadConfig({ configPath })).rejects.toThrow();
    try {
      await loadConfig({ configPath });
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).code).toBe('E_CONFIG_PARSE_FAILED');
    }
  });

  it('CLI flags that produce invalid config also throw', async () => {
    // flags can introduce invalid values; the final safeParse catches them.
    await expect(
      loadConfig({
        configPath: inTempDir('config.toml'),
        flags: {
          logging: { level: 'not-a-real-level' as never },
        },
      }),
    ).rejects.toThrow();
  });
});

describe('loadConfig — end-to-end shape', () => {
  it('returns a Config with every section populated', async () => {
    const config = await loadConfig({ configPath: inTempDir('config.toml') });
    expect(config).toHaveProperty('config_schema_version', 1);
    expect(config).toHaveProperty('bootstrap');
    expect(config).toHaveProperty('distro');
    expect(config).toHaveProperty('runtime');
    expect(config).toHaveProperty('telemetry');
    expect(config).toHaveProperty('sync');
    expect(config).toHaveProperty('registry');
    expect(config).toHaveProperty('logging');
    expect(config).toHaveProperty('i18n');
    expect(config).toHaveProperty('profiles');
    expect(config).toHaveProperty('experimental');
  });
});
