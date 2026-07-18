import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { LinuxifyError, NetworkError } from '../../../src/utils/errors.js';
import { download, fetchJson, isReachable } from '../../../src/utils/net.js';

describe('utils/net', () => {
  let tmpDir: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'linuxify-net-test-'));
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('fetchJson', () => {
    it('parses JSON response from a mock fetch', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map([['content-type', 'application/json']]),
        text: async () => JSON.stringify({ hello: 'world', n: 42 }),
      };
      const fetchSpy = vi.fn().mockResolvedValue(mockResponse as unknown as Response);
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      const data = await fetchJson<{ hello: string; n: number }>('https://example.com/api');
      expect(data.hello).toBe('world');
      expect(data.n).toBe(42);
      expect(fetchSpy).toHaveBeenCalledOnce();
      const call = fetchSpy.mock.calls[0]!;
      expect(call[0]).toBe('https://example.com/api');
    });

    it('throws NetworkError on HTTP error status', async () => {
      const mockResponse = {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Map(),
        text: async () => 'not found',
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse as unknown as Response,
        ) as unknown as typeof globalThis.fetch;

      await expect(fetchJson('https://example.com/missing')).rejects.toBeInstanceOf(NetworkError);
    });

    it('throws NetworkError on non-JSON body', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: new Map(),
        text: async () => 'this is not json',
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse as unknown as Response,
        ) as unknown as typeof globalThis.fetch;

      await expect(fetchJson('https://example.com/text')).rejects.toBeInstanceOf(NetworkError);
      try {
        await fetchJson('https://example.com/text');
      } catch (e) {
        expect((e as NetworkError).code).toBe('E_NETWORK_GENERIC');
      }
    });

    it('throws NetworkError when fetch throws', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('connection refused')) as unknown as typeof globalThis.fetch;
      await expect(fetchJson('https://example.com/fail')).rejects.toBeInstanceOf(NetworkError);
    });
  });

  describe('isReachable', () => {
    it('returns true for 2xx response', async () => {
      const mockResponse = { ok: true, status: 200, statusText: 'OK', headers: new Map() };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse as unknown as Response,
        ) as unknown as typeof globalThis.fetch;

      expect(await isReachable('https://example.com', 1000)).toBe(true);
    });

    it('returns false for non-2xx response', async () => {
      const mockResponse = { ok: false, status: 500, statusText: 'ERR', headers: new Map() };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          mockResponse as unknown as Response,
        ) as unknown as typeof globalThis.fetch;

      expect(await isReachable('https://example.com', { timeoutMs: 1000 })).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;

      expect(await isReachable('https://example.com', 500)).toBe(false);
    });

    it('accepts an options object as second arg', async () => {
      const mockResponse = { ok: true, status: 200, statusText: 'OK', headers: new Map() };
      const fetchSpy = vi.fn().mockResolvedValue(mockResponse as unknown as Response);
      globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

      expect(
        await isReachable('https://example.com', { timeoutMs: 500, headers: { 'x-test': '1' } }),
      ).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
  });

  describe('download (with a real local HTTP server)', () => {
    let server: Server;
    let baseUrl: string;

    beforeEach(async () => {
      server = createServer((req, res) => {
        if (req.url === '/small') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end('hello-download');
        } else if (req.url === '/large') {
          res.writeHead(200, { 'content-length': '1024' });
          const buf = Buffer.alloc(1024, 65); // 1024 bytes of 'A'
          res.end(buf);
        } else {
          res.writeHead(404);
          res.end('not found');
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            baseUrl = `http://127.0.0.1:${addr.port}`;
          }
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    it('downloads a file to the destination', async () => {
      const dest = path.join(tmpDir, 'small.bin');
      await download(`${baseUrl}/small`, dest);
      expect(readFileSync(dest, 'utf8')).toBe('hello-download');
    });

    it('invokes onProgress with byte counts', async () => {
      const dest = path.join(tmpDir, 'large.bin');
      let lastDownloaded = 0;
      let lastTotal: number | null = null;
      await download(`${baseUrl}/large`, dest, {
        onProgress: (d, t) => {
          lastDownloaded = d;
          lastTotal = t;
        },
      });
      expect(lastDownloaded).toBe(1024);
      expect(lastTotal).toBe(1024);
      expect(readFileSync(dest).length).toBe(1024);
    });

    it('verifies sha256 when expectedSha256 is provided', async () => {
      const dest = path.join(tmpDir, 'verified.bin');
      const { createHash } = await import('node:crypto');
      const expected = createHash('sha256').update('hello-download').digest('hex');
      await download(`${baseUrl}/small`, dest, { expectedSha256: expected });
      expect(readFileSync(dest, 'utf8')).toBe('hello-download');
    });

    it('throws on sha256 mismatch', async () => {
      const dest = path.join(tmpDir, 'mismatch.bin');
      await expect(
        download(`${baseUrl}/small`, dest, { expectedSha256: '0'.repeat(64) }),
      ).rejects.toBeInstanceOf(LinuxifyError);
      // The temp file should be cleaned up; the destination should not exist.
      const { existsSync } = await import('node:fs');
      expect(existsSync(dest)).toBe(false);
    });

    it('throws NetworkError on 404', async () => {
      const dest = path.join(tmpDir, 'missing.bin');
      await expect(download(`${baseUrl}/missing`, dest)).rejects.toBeInstanceOf(NetworkError);
    });

    it('cleans up temp file on failure', async () => {
      const dest = path.join(tmpDir, 'cleanup.bin');
      try {
        await download(`${baseUrl}/missing`, dest);
      } catch {
        // expected
      }
      const { readdirSync } = await import('node:fs');
      const files = readdirSync(tmpDir);
      expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    });
  });
});
