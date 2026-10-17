/**
 * Hosting subsystem — turns an Android phone into a hosting server.
 *
 * @module linuxify/hosting
 *
 * @packageDocumentation
 */

export { HostingEngine } from './engine.js';
export type { HostingConfig, DeployedApp } from './config.js';
export { detectProject } from './detect.js';
export type { ProjectType, DetectionResult } from './detect.js';
export { ServiceManager } from './services.js';
export type { ServiceType, ServiceStatus } from './services.js';
export { TunnelManager } from './expose.js';
export type { ExposureMethod, ExposureResult } from './expose.js';
export { ProcessManager } from './process-manager.js';
export { HostingConfigSchema } from './config.js';
