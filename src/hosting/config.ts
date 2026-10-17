/**
 * Hosting configuration schema and types.
 *
 * @module linuxify/hosting/config
 */

import { z } from 'zod';

/**
 * Schema for a deployed application entry.
 */
export const DeployedAppSchema = z.object({
  name: z.string().min(1),
  type: z.enum(['static', 'node', 'python', 'php', 'nextjs', 'vite']),
  path: z.string(),                    // absolute path inside proot
  port: z.number().int().min(1).max(65535),
  pid: z.number().int().nullable(),    // PM2 process ID, null if stopped
  status: z.enum(['running', 'stopped', 'failed', 'deploying']),
  startedAt: z.string().nullable(),     // ISO timestamp
  framework: z.string().optional(),
  autoDeployed: z.boolean().default(false),
});

/**
 * Schema for the hosting config file (~/.linuxify/hosting/config.json).
 */
export const HostingConfigSchema = z.object({
  schema_version: z.literal(1).default(1),
  initialized: z.boolean().default(false),
  initializedAt: z.string().nullable().default(null),
  webServer: z.enum(['nginx', 'caddy']).default('nginx'),
  processManager: z.literal('pm2').default('pm2'),
  apps: z.array(DeployedAppSchema).default([]),
  installedServices: z.array(z.enum(['postgres', 'mariadb', 'redis'])).default([]),
  defaultPort: z.number().int().min(1024).max(65535).default(8080),
});

/** Inferred type for the hosting config. */
export type HostingConfig = z.infer<typeof HostingConfigSchema>;

/** Inferred type for a deployed app. */
export type DeployedApp = z.infer<typeof DeployedAppSchema>;

/**
 * Default config written by `host init`.
 */
export const DEFAULT_HOSTING_CONFIG: HostingConfig = {
  schema_version: 1,
  initialized: false,
  initializedAt: null,
  webServer: 'nginx',
  processManager: 'pm2',
  apps: [],
  installedServices: [],
  defaultPort: 8080,
};
