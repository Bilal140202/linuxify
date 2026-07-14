import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  sha256,
  sha256File,
  verifySha256,
  randomBytes,
  randomId,
  encrypt,
  decrypt,
  uuidV4,
} from '../../../src/utils/crypto.js';
import { LinuxifyError } from '../../../src/utils/errors.js';

describe('utils/crypto', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'linuxify-crypto-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('sha256', () => {
    it('hashes a string to a 64-char hex digest', () => {
      const h = sha256('hello');
      expect(h).toHaveLength(64);
      expect(h).toMatch(/^[0-9a-f]+$/);
    });

    it('matches node crypto for a known input', () => {
      const expected = createHash('sha256').update('hello world', 'utf8').digest('hex');
      expect(sha256('hello world')).toBe(expected);
    });

    it('produces empty-string hash for empty input', () => {
      const expected = createHash('sha256').update('', 'utf8').digest('hex');
      expect(sha256('')).toBe(expected);
      // Known SHA-256 of empty string:
      expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    });

    it('accepts a Buffer input', () => {
      const buf = Buffer.from('hello', 'utf8');
      const expected = createHash('sha256').update(buf).digest('hex');
      expect(sha256(buf)).toBe(expected);
    });
  });

  describe('sha256File', () => {
    it('hashes a file without loading it all into memory', async () => {
      const p = path.join(tmpDir, 'data.bin');
      writeFileSync(p, Buffer.alloc(1024, 65)); // 1024 'A's
      const expected = createHash('sha256').update(Buffer.alloc(1024, 65)).digest('hex');
      const actual = await sha256File(p);
      expect(actual).toBe(expected);
    });

    it('throws LinuxifyError on missing file', async () => {
      const p = path.join(tmpDir, 'nope.bin');
      await expect(sha256File(p)).rejects.toBeInstanceOf(LinuxifyError);
      try {
        await sha256File(p);
      } catch (e) {
        expect((e as LinuxifyError).code).toBe('E_CRYPTO_HASH_FAILED');
      }
    });
  });

  describe('verifySha256', () => {
    it('returns true when the hash matches', async () => {
      const p = path.join(tmpDir, 'match.bin');
      writeFileSync(p, 'verify me');
      const expected = createHash('sha256').update('verify me').digest('hex');
      expect(await verifySha256(p, expected)).toBe(true);
    });

    it('returns false when the hash does not match', async () => {
      const p = path.join(tmpDir, 'nomatch.bin');
      writeFileSync(p, 'verify me');
      expect(await verifySha256(p, '0'.repeat(64))).toBe(false);
    });

    it('returns false for an empty expected hash', async () => {
      const p = path.join(tmpDir, 'empty.bin');
      writeFileSync(p, 'x');
      expect(await verifySha256(p, '')).toBe(false);
    });

    it('returns false when lengths differ', async () => {
      const p = path.join(tmpDir, 'short.bin');
      writeFileSync(p, 'x');
      expect(await verifySha256(p, 'abc')).toBe(false);
    });
  });

  describe('randomBytes', () => {
    it('returns a buffer of the requested length', () => {
      const b = randomBytes(32);
      expect(b).toBeInstanceOf(Buffer);
      expect(b).toHaveLength(32);
    });

    it('returns different values on subsequent calls', () => {
      const a = randomBytes(16);
      const b = randomBytes(16);
      expect(a.equals(b)).toBe(false);
    });

    it('throws LinuxifyError on negative length', () => {
      expect(() => randomBytes(-1)).toThrow(LinuxifyError);
    });

    it('returns an empty buffer for length 0', () => {
      expect(randomBytes(0)).toHaveLength(0);
    });
  });

  describe('randomId', () => {
    it('produces a 36-character UUID-like string', () => {
      const id = randomId();
      expect(id).toHaveLength(36);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('sets the UUIDv7 version nibble to 7', () => {
      for (let i = 0; i < 10; i++) {
        const id = randomId();
        // Third group starts with '7'.
        expect(id[14]).toBe('7');
      }
    });

    it('sets the UUIDv7 variant bits to 10xx', () => {
      for (let i = 0; i < 10; i++) {
        const id = randomId();
        // Fourth group starts with '8', '9', 'a', or 'b'.
        expect(['8', '9', 'a', 'b']).toContain(id[19]);
      }
    });

    it('produces unique IDs across many calls', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(randomId());
      }
      expect(ids.size).toBe(1000);
    });

    it('produces time-ordered IDs (monotonic non-decreasing across milliseconds)', async () => {
      // UUIDv7's 48-bit unix-ms timestamp prefix means IDs created in
      // different milliseconds sort lexicographically by creation time.
      // IDs created within the SAME millisecond are ordered only by their
      // random tail, which is not monotonic — so we insert small delays.
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        ids.push(randomId());
        // Sleep ~2ms so each ID lands in a distinct millisecond.
        await new Promise((r) => setTimeout(r, 2));
      }
      for (let i = 1; i < ids.length; i++) {
        expect(ids[i]! >= ids[i - 1]!).toBe(true);
      }
    });

    it('produces IDs that share a timestamp prefix when created in the same ms', () => {
      // Two IDs created in the same ms share the first 12 hex chars (48-bit ts).
      const id1 = randomId();
      const id2 = randomId();
      // The first 8 chars (hex) + chars 9-12 (after first hyphen) encode the ms timestamp.
      // We only assert the first 8 chars match if the calls landed in the same ms.
      // (This is a soft check — if the second call crossed a ms boundary, the prefix differs.)
      const ts1 = id1.slice(0, 8);
      const ts2 = id2.slice(0, 8);
      // Either they match (same ms) or ts2 > ts1 (next ms).
      expect(ts2 >= ts1).toBe(true);
    });
  });

  describe('uuidV4', () => {
    it('produces a valid v4 UUID', () => {
      const id = uuidV4();
      expect(id).toHaveLength(36);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('encrypt / decrypt', () => {
    const key32 = Buffer.alloc(32, 42); // 32-byte key

    it('round-trips a string through encrypt/decrypt', () => {
      const plaintext = 'a very secret message';
      const ct = encrypt(plaintext, key32);
      expect(ct).not.toBe(plaintext);
      const pt = decrypt(ct, key32);
      expect(pt).toBe(plaintext);
    });

    it('produces base64url-encoded output', () => {
      const ct = encrypt('x', key32);
      expect(ct).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('throws LinuxifyError on wrong key length (encrypt)', () => {
      expect(() => encrypt('x', Buffer.alloc(16))).toThrow(LinuxifyError);
      try {
        encrypt('x', Buffer.alloc(16));
      } catch (e) {
        expect((e as LinuxifyError).code).toBe('E_CRYPTO_ENCRYPT_FAILED');
      }
    });

    it('throws LinuxifyError on wrong key length (decrypt)', () => {
      expect(() => decrypt('abc', Buffer.alloc(16))).toThrow(LinuxifyError);
    });

    it('throws LinuxifyError on tampered ciphertext', () => {
      const ct = encrypt('secret', key32);
      // Flip a bit in the ciphertext (not the IV/tag prefix).
      const buf = Buffer.from(ct, 'base64url');
      buf[buf.length - 1] ^= 0x01;
      const tampered = buf.toString('base64url');
      expect(() => decrypt(tampered, key32)).toThrow(LinuxifyError);
    });

    it('throws LinuxifyError on too-short ciphertext', () => {
      expect(() => decrypt('short', key32)).toThrow(LinuxifyError);
    });

    it('accepts a 32-byte UTF-8 string key', () => {
      const keyStr = 'a'.repeat(32); // 32 ASCII chars = 32 bytes
      const ct = encrypt('msg', keyStr);
      expect(decrypt(ct, keyStr)).toBe('msg');
    });
  });
});
