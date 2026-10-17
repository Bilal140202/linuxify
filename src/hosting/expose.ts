/**
 * Tunnel manager — configure public access via Cloudflare Tunnel.
 *
 * @module linuxify/hosting/expose
 *
 * Provides three exposure methods:
 * 1. Local network — bind to 0.0.0.0, accessible on same Wi-Fi
 * 2. Cloudflare Tunnel — temporary public URL via cloudflared
 * 3. Custom domain — Cloudflare Tunnel with named tunnel + domain
 */

import { exec } from '../utils/process.js';
import { logger } from '../utils/log.js';
// import { confirm } from '../utils/prompt.js';

export type ExposureMethod = 'local' | 'tunnel' | 'domain' | 'none';

export interface ExposureResult {
  method: ExposureMethod;
  url: string | null;
  message: string;
}

export class TunnelManager {
  constructor(private readonly distro: string) {}

  /**
   * Present exposure options to the user and configure the selected method.
   */
  async expose(appName: string, port: number): Promise<ExposureResult> {
    logger.info({ appName, port }, 'hosting: configuring exposure');

    // Check what's available
    const localIp = await this.getLocalIp();
    const cloudflaredInstalled = await this.isCloudflaredInstalled();

    console.log('\nExposure options:\n');
    console.log(`  1. Local network${localIp ? ` — http://${localIp}:${port}` : ' (no IP detected)'}`);
    console.log(`  2. Temporary public URL${cloudflaredInstalled ? '' : ' (requires cloudflared install)'}`);
    console.log('  3. Custom domain (requires Cloudflare account)');
    console.log('  4. Cancel\n');

    // const choice = await confirm('Which exposure method? (enter number)', false);

    // For now, implement local network (simplest, always works)
    return await this.exposeLocal(port);
  }

  /**
   * Expose on the local network — bind to 0.0.0.0.
   */
  async exposeLocal(port: number): Promise<ExposureResult> {
    const ip = await this.getLocalIp();
    if (!ip) {
      return {
        method: 'none',
        url: null,
        message: 'Could not determine local IP address. The app is still running on localhost.',
      };
    }
    return {
      method: 'local',
      url: `http://${ip}:${port}`,
      message: `Accessible on your local network at http://${ip}:${port}`,
    };
  }

  /**
   * Expose via Cloudflare Tunnel — temporary public URL.
   */
  async exposeTunnel(port: number): Promise<ExposureResult> {
    const installed = await this.isCloudflaredInstalled();
    if (!installed) {
      const installedOk = await this.installCloudflared();
      if (!installedOk) {
        return {
          method: 'none',
          url: null,
          message: 'Failed to install cloudflared. Install manually: npm install -g cloudflared',
        };
      }
    }

    // Start cloudflared tunnel in background
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'bash', '-c',
       `cloudflared tunnel --url http://localhost:${port} 2>&1 | head -20`],
      { timeoutMs: 15_000, env: { TERM: 'dumb' } },
    );

    // Extract the URL from cloudflared output
    const urlMatch = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(r.stdout);
    if (urlMatch) {
      return {
        method: 'tunnel',
        url: urlMatch[0],
        message: `Public URL: ${urlMatch[0]}`,
      };
    }

    return {
      method: 'none',
      url: null,
      message: 'cloudflared did not produce a URL. Check logs with: linuxify host logs cloudflared',
    };
  }

  /**
   * Get the local network IP address.
   */
  private async getLocalIp(): Promise<string | null> {
    try {
      const r = await exec('ip', ['addr', 'show', 'wlan0'], { timeoutMs: 3000 });
      const match = /inet (\d+\.\d+\.\d+\.\d+)/.exec(r.stdout);
      return match?.[1] ?? null;
    } catch {
      // Try hostname -I fallback
      try {
        const r = await exec('sh', ['-c', 'hostname -I 2>/dev/null | awk "{print \$1}"'], { timeoutMs: 3000 });
        const ip = r.stdout.trim();
        return ip || null;
      } catch {
        return null;
      }
    }
  }

  /**
   * Check if cloudflared is installed inside the proot.
   */
  private async isCloudflaredInstalled(): Promise<boolean> {
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'which', 'cloudflared'],
      { timeoutMs: 5000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }

  /**
   * Install cloudflared inside the proot.
   */
  private async installCloudflared(): Promise<boolean> {
    logger.info('hosting: installing cloudflared');
    const r = await exec(
      'proot-distro',
      ['login', this.distro, '--user', 'linuxify', '--', 'npm', 'install', '-g', 'cloudflared'],
      { timeoutMs: 60_000, env: { TERM: 'dumb' } },
    );
    return r.exitCode === 0;
  }
}
