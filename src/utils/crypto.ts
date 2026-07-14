/**
 * Cryptographic utilities.
 *
 * @module linuxify/utils/crypto
 *
 * Wraps `node:crypto` for hashing, random IDs, and AES-256-GCM symmetric
 * encryption (the latter reserved for the future cloud-sync feature; v1
 * does not call `encrypt`/`decrypt` outside tests).
 *
 * All hash functions return lowercase hex digests. The `randomId` function
 * generates UUIDv7-style time-ordered identifiers (48-bit unix-ms timestamp
 * + version + random) so that IDs created in quick succession still sort
 * lexicographically by creation time.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes as nodeRandomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { createReadStream } from 'node:fs';

import { LinuxifyError } from './errors.js';

/**
 * Compute the SHA-256 hex digest of a string or buffer.
 *
 * @param data - The input to hash. Strings are encoded as UTF-8.
 * @returns Lowercase 64-character hex digest.
 */
export function sha256(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Stream a file through SHA-256 without loading it into memory. Used to
 * verify downloaded rootfs tarballs (often >500 MB) and patch backups.
 *
 * @param filePath - Path to the file to hash.
 * @returns Lowercase 64-character hex digest.
 * @throws {LinuxifyError} with code `E_CRYPTO_HASH_FAILED` if the file cannot be read.
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err: Error) => {
      reject(
        new LinuxifyError({
          code: 'E_CRYPTO_HASH_FAILED',
          message: `Failed to hash file: ${filePath}`,
          details: { path: filePath },
          cause: err,
        }),
      );
    });
  });
}

/**
 * Verify that a file's SHA-256 matches an expected digest. The comparison
 * is constant-time via `crypto.timingSafeEqual` to defend against timing
 * attacks (relevant if the digest is ever attacker-influenced).
 *
 * @param filePath - Path to the file to verify.
 * @param expected - Expected lowercase hex digest. Empty string returns `false`.
 * @returns `true` if the file's SHA-256 equals `expected`.
 */
export async function verifySha256(filePath: string, expected: string): Promise<boolean> {
  if (!expected) return false;
  const actual = await sha256File(filePath);
  return safeEqualHex(actual.toLowerCase(), expected.toLowerCase());
}

/**
 * Constant-time comparison of two hex strings of equal length. Returns
 * `false` if lengths differ (so callers should length-check first).
 */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0 || a.length % 2 !== 0) {
    return false;
  }
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  // timingSafeEqual requires equal-length buffers and returns 1 or 0.
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Return `n` cryptographically-strong random bytes.
 *
 * @param n - Number of bytes (must be >= 0).
 * @returns A `Buffer` of length `n`.
 * @throws {LinuxifyError} with code `E_CRYPTO_RANDOM_FAILED` if `n < 0`.
 */
export function randomBytes(n: number): Buffer {
  if (n < 0) {
    throw new LinuxifyError({
      code: 'E_CRYPTO_RANDOM_FAILED',
      message: `randomBytes: length must be >= 0, got ${n}`,
      details: { requested: n },
    });
  }
  return nodeRandomBytes(n);
}

/**
 * Generate a UUIDv7-style time-ordered identifier.
 *
 * Layout (per the UUIDv7 draft, 36 chars with hyphens):
 *   - bits 0-47  (12 hex chars): unix milliseconds, big-endian
 *   - bits 48-51 (4 bits)      : version `7`
 *   - bits 52-63 (12 bits)     : random
 *   - bits 64-65 (2 bits)      : variant `10`
 *   - bits 66-127 (62 bits)    : random
 *
 * The timestamp means IDs created within the same millisecond still
 * differ in the random tail, but IDs created across milliseconds sort
 * lexicographically by creation time — useful for log/event IDs.
 *
 * @returns A 36-character UUIDv7 string (lowercase hex).
 */
export function randomId(): string {
  const ts = Date.now();
  const tsHex = ts.toString(16).padStart(12, '0'); // 48 bits = 12 hex chars

  // 10 random bytes: 2 bytes for rand_a (after stripping the 4-bit version),
  // 8 bytes for rand_b (after stripping the 2-bit variant).
  const rand = nodeRandomBytes(10);
  // rand_a: take 2 bytes, mask top 4 bits to 0, OR in version 7 in top nibble.
  const randAByte0 = (rand[0]! & 0x0f) | 0x70;
  const randA = randAByte0.toString(16).padStart(2, '0') + rand[1]!.toString(16).padStart(2, '0');
  // rand_b: 8 bytes; first byte masked: top 2 bits = 10, rest random.
  const randBByte0 = (rand[2]! & 0x3f) | 0x80;
  const randB =
    randBByte0.toString(16).padStart(2, '0') +
    Array.from(rand.subarray(3, 10))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  return `${tsHex.slice(0, 8)}-${tsHex.slice(8, 12)}-${randA}-${randB.slice(0, 4)}-${randB.slice(4)}`;
}

/**
 * Generate a v4 UUID. Wrapper around `crypto.randomUUID`; kept as an export
 * so callers don't pull in `node:crypto` directly.
 *
 * @returns A 36-character UUIDv4 string.
 */
export function uuidV4(): string {
  return randomUUID();
}

/**
 * Encrypt a string with AES-256-GCM using a 32-byte key.
 *
 * Output format (string, base64url-encoded for portability):
 *   - bytes 0-11  : 12-byte GCM IV (nonce)
 *   - bytes 12-27 : 16-byte GCM auth tag
 *   - bytes 28+   : ciphertext
 *
 * The same key must be supplied to {@link decrypt}. The key is derived
 * elsewhere (callers should not pass raw passwords); v1 does not use this
 * for any persisted data.
 *
 * @param data - Plaintext to encrypt.
 * @param key  - 32-byte key (Buffer or UTF-8 string). If not 32 bytes, throws.
 * @returns Base64url-encoded `iv || tag || ciphertext`.
 * @throws {LinuxifyError} with code `E_CRYPTO_ENCRYPT_FAILED` on any failure.
 */
export function encrypt(data: string, key: string | Buffer): string {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (keyBuf.length !== 32) {
    throw new LinuxifyError({
      code: 'E_CRYPTO_ENCRYPT_FAILED',
      message: `AES-256-GCM requires a 32-byte key, got ${keyBuf.length}`,
      details: { keyLength: keyBuf.length },
    });
  }
  try {
    const iv = nodeRandomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
    const ct = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64url');
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_CRYPTO_ENCRYPT_FAILED',
      message: `Encryption failed: ${(err as Error).message}`,
      cause: err,
    });
  }
}

/**
 * Decrypt a string produced by {@link encrypt}. Throws if the auth tag
 * does not verify (tampering or wrong key).
 *
 * @param encoded - Base64url-encoded `iv || tag || ciphertext`.
 * @param key     - The same 32-byte key passed to `encrypt`.
 * @returns The original plaintext.
 * @throws {LinuxifyError} with code `E_CRYPTO_DECRYPT_FAILED` on any failure.
 */
export function decrypt(encoded: string, key: string | Buffer): string {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  if (keyBuf.length !== 32) {
    throw new LinuxifyError({
      code: 'E_CRYPTO_DECRYPT_FAILED',
      message: `AES-256-GCM requires a 32-byte key, got ${keyBuf.length}`,
      details: { keyLength: keyBuf.length },
    });
  }
  try {
    const buf = Buffer.from(encoded, 'base64url');
    if (buf.length < 28) {
      throw new Error(`ciphertext too short: ${buf.length} bytes`);
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (err) {
    throw new LinuxifyError({
      code: 'E_CRYPTO_DECRYPT_FAILED',
      message: `Decryption failed: ${(err as Error).message}`,
      cause: err,
    });
  }
}
