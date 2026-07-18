/**
 * Network utilities.
 *
 * @module linuxify/utils/net
 *
 * Wraps the global `fetch` for HTTP GET/JSON downloads with consistent
 * timeouts, retries, and User-Agent identification. SHA-256 verification is
 * built in to {@link download} so callers can pin an expected hash and get
 * an atomic verified file write in one call.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { DEFAULT_HTTP_TIMEOUT_MS, DOWNLOAD_CHUNK_SIZE } from './constants.js';
import { sha256File } from './crypto.js';
import { sha256 as sha256Sync } from './crypto.js';
import { LinuxifyError, NetworkError } from './errors.js';
import { getDefaultUserAgent } from './process.js';

/** Options accepted by {@link download}. */
export interface DownloadOptions {
  /** Expected SHA-256 hex digest; if set, the downloaded file is verified and a mismatch throws. */
  readonly expectedSha256?: string;
  /** Per-request timeout in milliseconds. Defaults to {@link DEFAULT_HTTP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Progress callback invoked with the cumulative byte count and total
   * bytes (if the server sent a `Content-Length` header). Called at most
   * once per chunk read.
   */
  readonly onProgress?: (downloaded: number, total: number | null) => void;
  /** Optional AbortSignal to cancel the download mid-stream. */
  readonly signal?: AbortSignal;
  /** Override the default User-Agent header. */
  readonly userAgent?: string;
}

/** Options accepted by {@link fetchJson} and {@link isReachable}. */
export interface FetchOptions {
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs?: number;
  /** Optional AbortSignal. */
  readonly signal?: AbortSignal;
  /** Override the default User-Agent. */
  readonly userAgent?: string;
  /** Extra headers to merge into the request. */
  readonly headers?: Record<string, string>;
}

/**
 * Download a URL to a local file. The download is streamed to a `.tmp`
 * sidecar and renamed into place on completion, so a crash or abort never
 * leaves a partial file at `dest`. If `expectedSha256` is set, the file is
 * hashed after the write and a mismatch removes the destination and throws.
 *
 * @param url - Source URL (HTTP or HTTPS).
 * @param dest - Destination file path. Parent directory must exist.
 * @param opts - Optional {@link DownloadOptions}.
 * @returns Resolves when the file is fully written (and verified, if `expectedSha256` was set).
 * @throws {NetworkError} on HTTP error, timeout, or connection failure.
 * @throws {LinuxifyError} with code `E_DOWNLOAD_HASH_MISMATCH` if the SHA-256 does not match.
 */
export async function download(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? getDefaultUserAgent();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Combine caller's signal with our timeout signal.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'user-agent': userAgent },
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    throw new NetworkError(`Failed to fetch ${url}: ${(err as Error).message}`, {
      cause: err,
      details: { url },
    });
  }
  clearTimeout(timer);

  if (!res.ok || !res.body) {
    throw new NetworkError(`HTTP ${res.status} ${res.statusText} for ${url}`, {
      details: { url, status: res.status, statusText: res.statusText },
    });
  }

  const total = res.headers.get('content-length');
  const totalNum = total ? Number.parseInt(total, 10) : null;
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);

  try {
    // Stream the response body to the temp file.
    const stream = Readable.fromWeb(res.body as ReadableStream<Uint8Array>);
    const writer = createWriteStream(tmpPath);
    let downloaded = 0;
    let lastReport = 0;
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      writer.write(buf);
      downloaded += buf.length;
      if (opts.onProgress && downloaded - lastReport >= DOWNLOAD_CHUNK_SIZE) {
        opts.onProgress(downloaded, totalNum);
        lastReport = downloaded;
      }
    }
    // Final progress report at 100%.
    if (opts.onProgress) opts.onProgress(downloaded, totalNum);

    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Verify hash BEFORE the rename so a mismatch never appears at `dest`.
    if (opts.expectedSha256) {
      const actual = await sha256File(tmpPath);
      const expected = opts.expectedSha256.toLowerCase();
      if (actual.toLowerCase() !== expected) {
        await unlink(tmpPath).catch(() => {});
        throw new LinuxifyError({
          code: 'E_DOWNLOAD_HASH_MISMATCH',
          message: `SHA-256 mismatch for ${url} (expected ${expected}, got ${actual})`,
          exitCode: 1,
          details: { url, expected, actual },
        });
      }
    }

    await rename(tmpPath, dest);
  } catch (err) {
    // Clean up the temp file on any failure path.
    await unlink(tmpPath).catch(() => {});
    if (err instanceof LinuxifyError) throw err;
    throw new NetworkError(`Download failed for ${url}: ${(err as Error).message}`, {
      cause: err,
      details: { url },
    });
  }
}

/**
 * GET a URL and parse the response as JSON.
 *
 * @typeParam T - The expected shape of the parsed JSON.
 * @param url - Source URL.
 * @param opts - Optional {@link FetchOptions}.
 * @returns The parsed JSON, typed as `T` (unchecked cast).
 * @throws {NetworkError} on HTTP error or non-JSON response.
 */
export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? getDefaultUserAgent();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': userAgent,
        ...opts.headers,
      },
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    throw new NetworkError(`Failed to fetch ${url}: ${(err as Error).message}`, {
      cause: err,
      details: { url },
    });
  }
  clearTimeout(timer);

  if (!res.ok) {
    throw new NetworkError(`HTTP ${res.status} ${res.statusText} for ${url}`, {
      details: { url, status: res.status, statusText: res.statusText },
    });
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    throw new NetworkError(`Failed to read response body from ${url}: ${(err as Error).message}`, {
      cause: err,
      details: { url },
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new NetworkError(`Failed to parse JSON from ${url}: ${(err as Error).message}`, {
      cause: err,
      details: { url, bodyPreview: text.slice(0, 200) },
    });
  }
}

/**
 * Probe whether a URL is reachable via an HTTP HEAD request with a short
 * timeout. Returns `true` for any 2xx response, `false` for any network
 * error or non-2xx response. Never throws.
 *
 * Accepts either a numeric timeout (for backward compatibility) or an
 * options object (for consistency with {@link fetchJson}).
 *
 * @param url - The URL to probe.
 * @param timeoutOrOpts - Either a timeout in milliseconds (default 5000)
 *   or an options object `{ timeoutMs?, signal?, userAgent? }`.
 * @returns `true` if the server responded with 2xx, `false` otherwise.
 */
export async function isReachable(
  url: string,
  timeoutOrOpts: number | FetchOptions = 5000,
): Promise<boolean> {
  const opts: FetchOptions =
    typeof timeoutOrOpts === 'number' ? { timeoutMs: timeoutOrOpts } : timeoutOrOpts;
  const timeoutMs = opts.timeoutMs ?? 5000;
  const userAgent = opts.userAgent ?? getDefaultUserAgent();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'user-agent': userAgent, ...opts.headers },
      redirect: 'follow',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the SHA-256 of a string. Re-exported here so callers that need
 * both networking and hashing can import from a single module.
 *
 * @param data - The input to hash.
 * @returns Lowercase hex digest.
 */
export function hashString(data: string | Buffer): string {
  return sha256Sync(data);
}

/**
 * Ensure the parent directory of `filePath` exists (mkdir -p).
 *
 * @param filePath - A file path; the parent directory is created.
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true }).catch(() => {});
}

/**
 * Stat-or-zero helper. Returns the file size in bytes, or `0` if the path
 * does not exist or is inaccessible.
 *
 * @param p - Path to stat.
 * @returns File size in bytes, or `0`.
 */
export async function fileSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Remove a path recursively. Used internally to clean up partial
 * downloads; exposed because the launcher/registry may also need it.
 *
 * @param p - Path to remove.
 */
export async function removeQuietly(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true }).catch(() => {});
}
