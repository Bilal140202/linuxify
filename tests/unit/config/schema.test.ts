/**
 * Unit tests for the Zod config schema in `src/config/schema.ts`.
 *
 * These tests exercise the schema directly (no file I/O, no env vars, no
 * loader) so failures localize to either the schema or the test, never to the
 * loader's override layering.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG } from '../../../src/config/defaults.js';
import {
  ConfigSchema,
  ProfileSchema,
  ProjectLocalSchema,
  BootstrapSchema,
  LoggingSchema,
  TelemetrySchema,
  PROJECT_LOCAL_ALLOWED_SECTIONS,
  PROJECT_LOCAL_FORBIDDEN_SECTIONS,
} from '../../../src/config/schema.js';

describe('ConfigSchema', () => {
  describe('accepts valid configs', () => {
    it('parses an empty object into a fully-defaulted Config', () => {
      const result = ConfigSchema.parse({});
      expect(result.config_schema_version).toBe(1);
      expect(result.bootstrap.distro).toBe('ubuntu');
      expect(result.bootstrap.parallel_downloads).toBe(4);
      expect(result.bootstrap.locale).toBe('en_US.UTF-8');
      expect(result.bootstrap.timezone).toBe('UTC');
      expect(result.bootstrap.runtimes).toEqual([]);
      expect(result.distro.default).toBe('ubuntu');
      expect(result.runtime.node_default_version).toBe('lts');
      expect(result.runtime.python_default_version).toBe('3.12');
      expect(result.telemetry.enabled).toBe(false);
      expect(result.telemetry.endpoint).toBe('https://telemetry.linuxify.sh/v2');
      expect(result.telemetry.sample_rate).toBe(0.1);
      expect(result.sync.enabled).toBe(false);
      expect(result.sync.endpoint).toBe('https://sync.linuxify.sh');
      expect(result.registry.url).toBe('https://github.com/linuxify/registry');
      expect(result.registry.branch).toBe('main');
      expect(result.registry.trust_self_signed).toBe(false);
      expect(result.logging.level).toBe('info');
      expect(result.logging.file_enabled).toBe(true);
      expect(result.logging.console_enabled).toBe(true);
      expect(result.i18n.locale).toBe('en');
      expect(result.profiles).toEqual({});
      expect(result.experimental.features).toEqual([]);
    });

    it('parses a fully-populated config without losing values', () => {
      const input = {
        config_schema_version: 1,
        bootstrap: {
          distro: 'debian',
          mirror: 'https://mirror.example.com/debian/',
          runtimes: ['rust', 'go'],
          parallel_downloads: 8,
          locale: 'fr_FR.UTF-8',
          timezone: 'Europe/Paris',
        },
        distro: { default: 'debian' },
        runtime: {
          node_default_version: '22.11.0',
          python_default_version: '3.13',
        },
        telemetry: {
          enabled: true,
          user_id: 'abc-123',
          endpoint: 'https://custom.example.com/v2',
          sample_rate: 0.5,
        },
        sync: {
          enabled: true,
          endpoint: 'https://sync.example.com',
          device_name: 'laptop',
        },
        registry: {
          url: 'https://github.com/myfork/registry',
          branch: 'develop',
          trust_self_signed: true,
        },
        logging: {
          level: 'debug',
          file_enabled: false,
          console_enabled: true,
        },
        i18n: { locale: 'pt_BR' },
        profiles: {
          work: {
            distro: { default: 'arch' },
            telemetry: { enabled: false },
          },
        },
        experimental: { features: ['ast_patcher', 'plugin_sandbox'] },
      };

      const result = ConfigSchema.parse(input);
      expect(result.bootstrap.distro).toBe('debian');
      expect(result.bootstrap.mirror).toBe('https://mirror.example.com/debian/');
      expect(result.bootstrap.runtimes).toEqual(['rust', 'go']);
      expect(result.bootstrap.parallel_downloads).toBe(8);
      expect(result.runtime.node_default_version).toBe('22.11.0');
      expect(result.telemetry.enabled).toBe(true);
      expect(result.telemetry.user_id).toBe('abc-123');
      expect(result.sync.device_name).toBe('laptop');
      expect(result.registry.trust_self_signed).toBe(true);
      expect(result.logging.level).toBe('debug');
      expect(result.logging.file_enabled).toBe(false);
      expect(result.i18n.locale).toBe('pt_BR');
      expect(result.profiles.work?.distro?.default).toBe('arch');
      expect(result.profiles.work?.telemetry?.enabled).toBe(false);
      expect(result.experimental.features).toEqual(['ast_patcher', 'plugin_sandbox']);
    });

    it('applies section-level defaults when a section is absent', () => {
      const result = ConfigSchema.parse({ bootstrap: { distro: 'arch' } });
      expect(result.bootstrap.distro).toBe('arch');
      // Other bootstrap fields fall back to defaults.
      expect(result.bootstrap.parallel_downloads).toBe(4);
      expect(result.distro.default).toBe('ubuntu'); // untouched section
    });

    it('accepts a partial bootstrap section (mirror optional)', () => {
      const result = ConfigSchema.parse({
        bootstrap: { mirror: 'https://mirror.example.com' },
      });
      expect(result.bootstrap.mirror).toBe('https://mirror.example.com');
      expect(result.bootstrap.distro).toBe('ubuntu'); // default
    });

    it('accepts sample_rate at boundaries (0 and 1)', () => {
      const r0 = ConfigSchema.parse({ telemetry: { sample_rate: 0 } });
      const r1 = ConfigSchema.parse({ telemetry: { sample_rate: 1 } });
      expect(r0.telemetry.sample_rate).toBe(0);
      expect(r1.telemetry.sample_rate).toBe(1);
    });
  });

  describe('rejects invalid configs', () => {
    it('rejects wrong type for parallel_downloads (string instead of number)', () => {
      const result = ConfigSchema.safeParse({
        bootstrap: { parallel_downloads: '4' },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues.find((i) =>
          i.path.join('.').includes('parallel_downloads'),
        );
        expect(issue).toBeDefined();
      }
    });

    it('rejects wrong type for telemetry.enabled (string instead of boolean)', () => {
      const result = ConfigSchema.safeParse({
        telemetry: { enabled: 'yes' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown top-level keys (.strict())', () => {
      const result = ConfigSchema.safeParse({
        bogus_top_level: 'no',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(
          result.error.issues.some(
            (i) =>
              i.message.toLowerCase().includes('unrecognized') ||
              i.message.toLowerCase().includes('unknown'),
          ),
        ).toBe(true);
      }
    });

    it('rejects unknown nested keys (.strict() on sections)', () => {
      const result = ConfigSchema.safeParse({
        bootstrap: { bogus_field: 'no' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown nested keys in telemetry section', () => {
      const result = ConfigSchema.safeParse({
        telemetry: { secret_token: 'abc' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid enum for logging.level', () => {
      const result = ConfigSchema.safeParse({
        logging: { level: 'verbose' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects sample_rate outside [0, 1]', () => {
      const tooHigh = ConfigSchema.safeParse({
        telemetry: { sample_rate: 1.5 },
      });
      const tooLow = ConfigSchema.safeParse({
        telemetry: { sample_rate: -0.1 },
      });
      expect(tooHigh.success).toBe(false);
      expect(tooLow.success).toBe(false);
    });

    it('rejects parallel_downloads outside [1, 64]', () => {
      expect(
        ConfigSchema.safeParse({ bootstrap: { parallel_downloads: 0 } }).success,
      ).toBe(false);
      expect(
        ConfigSchema.safeParse({ bootstrap: { parallel_downloads: 65 } }).success,
      ).toBe(false);
    });

    it('rejects parallel_downloads that is not an integer', () => {
      expect(
        ConfigSchema.safeParse({ bootstrap: { parallel_downloads: 2.5 } }).success,
      ).toBe(false);
    });

    it('rejects config_schema_version other than 1', () => {
      expect(
        ConfigSchema.safeParse({ config_schema_version: 2 }).success,
      ).toBe(false);
      expect(
        ConfigSchema.safeParse({ config_schema_version: '1' }).success,
      ).toBe(false);
    });

    it('rejects runtimes that is not an array of strings', () => {
      expect(
        ConfigSchema.safeParse({ bootstrap: { runtimes: 'rust' } }).success,
      ).toBe(false);
      expect(
        ConfigSchema.safeParse({ bootstrap: { runtimes: [1, 2] } }).success,
      ).toBe(false);
    });

    it('rejects profiles values that are not objects', () => {
      const result = ConfigSchema.safeParse({
        profiles: { work: 'not-an-object' },
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown sections inside a profile (.strict())', () => {
      const result = ConfigSchema.safeParse({
        profiles: {
          work: { bogus_section: { foo: 1 } },
        },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('DEFAULT_CONFIG', () => {
    it('is a valid Config (round-trips through the schema)', () => {
      const result = ConfigSchema.safeParse(DEFAULT_CONFIG);
      expect(result.success).toBe(true);
    });

    it('matches ConfigSchema.parse({})', () => {
      expect(DEFAULT_CONFIG).toEqual(ConfigSchema.parse({}));
    });
  });
});

describe('ProfileSchema', () => {
  it('accepts an empty profile', () => {
    const result = ProfileSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a profile with multiple sections', () => {
    const result = ProfileSchema.safeParse({
      distro: { default: 'arch' },
      telemetry: { enabled: false },
      runtime: { node_default_version: '22.11.0' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts nested profiles (composition)', () => {
    const result = ProfileSchema.safeParse({
      profiles: {
        sub: { distro: { default: 'alpine' } },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profiles?.sub?.distro?.default).toBe('alpine');
    }
  });

  it('rejects unknown sections', () => {
    const result = ProfileSchema.safeParse({ bogus: { x: 1 } });
    expect(result.success).toBe(false);
  });
});

describe('section schemas (direct)', () => {
  it('BootstrapSchema applies defaults', () => {
    const r = BootstrapSchema.parse({});
    expect(r.distro).toBe('ubuntu');
    expect(r.parallel_downloads).toBe(4);
  });

  it('LoggingSchema rejects invalid level', () => {
    expect(LoggingSchema.safeParse({ level: 'verbose' }).success).toBe(false);
  });

  it('TelemetrySchema rejects sample_rate > 1', () => {
    expect(TelemetrySchema.safeParse({ sample_rate: 2 }).success).toBe(false);
  });
});

describe('ProjectLocalSchema', () => {
  it('accepts an empty project-local file', () => {
    expect(ProjectLocalSchema.safeParse({}).success).toBe(true);
  });

  it('accepts the allowed sections (runtime, i18n, experimental)', () => {
    const r = ProjectLocalSchema.safeParse({
      runtime: { node_default_version: '22.11.0' },
      i18n: { locale: 'fr' },
      experimental: { features: ['ast_patcher'] },
    });
    expect(r.success).toBe(true);
  });

  it('rejects every forbidden section', () => {
    for (const section of PROJECT_LOCAL_FORBIDDEN_SECTIONS) {
      const input: Record<string, unknown> = { [section]: {} };
      const r = ProjectLocalSchema.safeParse(input);
      expect(r.success, `expected ${section} to be rejected`).toBe(false);
    }
  });

  it('exposes an allowed-sections list containing runtime, i18n, experimental', () => {
    expect([...PROJECT_LOCAL_ALLOWED_SECTIONS]).toEqual([
      'runtime',
      'i18n',
      'experimental',
    ]);
  });

  it('allows the cosmetic config_schema_version field', () => {
    expect(
      ProjectLocalSchema.safeParse({ config_schema_version: 1 }).success,
    ).toBe(true);
  });

  it('rejects config_schema_version != 1', () => {
    expect(
      ProjectLocalSchema.safeParse({ config_schema_version: 2 }).success,
    ).toBe(false);
  });
});
