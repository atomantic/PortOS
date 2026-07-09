import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  isRawHexKey,
  deriveSqlcipherKeys,
  sqlcipherPageHmac,
  decryptSqlcipherDatabase,
  deriveSafeStorageKey,
  decryptSafeStorageValue,
  SQLCIPHER_PAGE_SIZE,
  SQLCIPHER_SALT_BYTES,
  SQLCIPHER_RESERVE_BYTES,
  SQLCIPHER_IV_BYTES,
  SQLITE_HEADER,
  SAFE_STORAGE_IV,
} from './signalCrypto.js';

// Re-implement SQLCipher-4 *encryption* here so the decryptor can be verified
// against a known-good round trip — no real Signal DB required. This mirrors the
// exact page layout decryptSqlcipherDatabase expects.
function encryptSqlcipherDatabase(plaintext, rawKeyHex, salt) {
  const { encKey, hmacKey } = deriveSqlcipherKeys(rawKeyHex, salt);
  const totalPages = plaintext.length / SQLCIPHER_PAGE_SIZE;
  const out = Buffer.alloc(plaintext.length);
  const bodyEndOffset = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_BYTES;
  for (let page = 1; page <= totalPages; page += 1) {
    const pageStart = (page - 1) * SQLCIPHER_PAGE_SIZE;
    const bodyStart = pageStart + (page === 1 ? SQLCIPHER_SALT_BYTES : 0);
    const body = plaintext.subarray(bodyStart, pageStart + bodyEndOffset);
    const iv = crypto.randomBytes(SQLCIPHER_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
    if (page === 1) salt.copy(out, pageStart);
    ciphertext.copy(out, bodyStart);
    iv.copy(out, pageStart + bodyEndOffset);
    const hmac = sqlcipherPageHmac(hmacKey, Buffer.concat([ciphertext, iv]), page);
    hmac.copy(out, pageStart + bodyEndOffset + SQLCIPHER_IV_BYTES);
  }
  return out;
}

// A plaintext "database" whose reserve regions are already zero and whose page 1
// begins with the SQLite magic — so a decrypt round trip is byte-identical (the
// decryptor restores the magic + zero-fills the reserve).
function makePlaintextDb(pages) {
  const buf = Buffer.alloc(pages * SQLCIPHER_PAGE_SIZE);
  const bodyEndOffset = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_BYTES;
  for (let page = 1; page <= pages; page += 1) {
    const pageStart = (page - 1) * SQLCIPHER_PAGE_SIZE;
    const bodyStart = pageStart + (page === 1 ? SQLCIPHER_SALT_BYTES : 0);
    // Deterministic body content so the assertion is meaningful.
    for (let i = bodyStart; i < pageStart + bodyEndOffset; i += 1) buf[i] = (i * 31 + 7) & 0xff;
    if (page === 1) SQLITE_HEADER.copy(buf, pageStart);
  }
  return buf;
}

describe('signalCrypto — SQLCipher key derivation', () => {
  it('detects a 64-hex-char raw key', () => {
    expect(isRawHexKey('a'.repeat(64))).toBe(true);
    expect(isRawHexKey('A0'.repeat(32))).toBe(true);
    expect(isRawHexKey('xyz')).toBe(false);
    expect(isRawHexKey('a'.repeat(63))).toBe(false);
    expect(isRawHexKey(null)).toBe(false);
  });

  it('uses the raw 32 bytes verbatim as the encryption key (no PBKDF2)', () => {
    const hex = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
    const salt = Buffer.alloc(16, 5);
    const { encKey } = deriveSqlcipherKeys(hex, salt);
    expect(encKey.toString('hex')).toBe(hex);
  });

  it('derives a distinct HMAC key via the fast 2-round PBKDF2 over the salt XOR 0x3a', () => {
    const hex = 'a'.repeat(64);
    const salt = Buffer.alloc(16, 9);
    const { encKey, hmacKey } = deriveSqlcipherKeys(hex, salt);
    const hmacSalt = Buffer.from(salt.map((b) => b ^ 0x3a));
    const expected = crypto.pbkdf2Sync(encKey, hmacSalt, 2, 32, 'sha512');
    expect(hmacKey.equals(expected)).toBe(true);
    expect(hmacKey.equals(encKey)).toBe(false);
  });

  it('rejects a wrong-length salt', () => {
    expect(() => deriveSqlcipherKeys('a'.repeat(64), Buffer.alloc(8))).toThrow();
  });
});

describe('signalCrypto — SQLCipher page decryption', () => {
  const rawKeyHex = crypto.randomBytes(32).toString('hex');

  it('round-trips a multi-page database to plaintext', () => {
    const salt = crypto.randomBytes(16);
    const plain = makePlaintextDb(3);
    const encrypted = encryptSqlcipherDatabase(plain, rawKeyHex, salt);
    // The encrypted page 1 leads with the salt, NOT the SQLite magic.
    expect(encrypted.subarray(0, 16).equals(salt)).toBe(true);
    const result = decryptSqlcipherDatabase(encrypted, rawKeyHex);
    expect(result.ok).toBe(true);
    expect(result.plaintext.subarray(0, 16).equals(SQLITE_HEADER)).toBe(true);
    expect(result.plaintext.equals(plain)).toBe(true);
  });

  it('fails cleanly (reason=auth) on the wrong key — never throws', () => {
    const salt = crypto.randomBytes(16);
    const encrypted = encryptSqlcipherDatabase(makePlaintextDb(1), rawKeyHex, salt);
    const wrong = crypto.randomBytes(32).toString('hex');
    const result = decryptSqlcipherDatabase(encrypted, wrong);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth');
  });

  it('reports empty / too-small / bad-page-size without throwing', () => {
    expect(decryptSqlcipherDatabase(Buffer.alloc(0), rawKeyHex).reason).toBe('empty');
    expect(decryptSqlcipherDatabase(Buffer.alloc(100), rawKeyHex).reason).toBe('too-small');
    expect(decryptSqlcipherDatabase(Buffer.alloc(SQLCIPHER_PAGE_SIZE + 10), rawKeyHex).reason).toBe('bad-page-size');
  });

  it('detects a corrupted (bit-flipped) page via HMAC in full-verify mode', () => {
    const salt = crypto.randomBytes(16);
    const encrypted = encryptSqlcipherDatabase(makePlaintextDb(2), rawKeyHex, salt);
    encrypted[SQLCIPHER_PAGE_SIZE + 20] ^= 0xff; // corrupt page 2 body
    const result = decryptSqlcipherDatabase(encrypted, rawKeyHex, { verify: 'all' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auth');
  });
});

describe('signalCrypto — Chromium safeStorage decryption', () => {
  const password = 'a-random-keychain-password';

  function encryptSafeStorage(plaintextStr, prefix = 'v10') {
    const key = deriveSafeStorageKey(password);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, SAFE_STORAGE_IV);
    const body = Buffer.concat([cipher.update(Buffer.from(plaintextStr, 'utf8')), cipher.final()]);
    return Buffer.concat([Buffer.from(prefix, 'latin1'), body]);
  }

  it('recovers the wrapped DB key string (v10)', () => {
    const dbKey = crypto.randomBytes(32).toString('hex');
    const blob = encryptSafeStorage(dbKey);
    const result = decryptSafeStorageValue(blob, password);
    expect(result.ok).toBe(true);
    expect(result.plaintext.toString('utf8')).toBe(dbKey);
  });

  it('recovers a v11-prefixed value too', () => {
    const blob = encryptSafeStorage('hello-signal', 'v11');
    const result = decryptSafeStorageValue(blob, password);
    expect(result.ok).toBe(true);
    expect(result.plaintext.toString('utf8')).toBe('hello-signal');
  });

  it('fails cleanly on a missing version prefix', () => {
    const result = decryptSafeStorageValue(Buffer.from('nope-not-versioned-aaaa'), password);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-prefix');
  });

  it('fails cleanly (reason=decrypt) on the wrong password — never throws', () => {
    const blob = encryptSafeStorage('secret');
    const result = decryptSafeStorageValue(blob, 'wrong-password');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('decrypt');
  });

  it('reports an empty value', () => {
    expect(decryptSafeStorageValue(Buffer.alloc(0), password).reason).toBe('empty');
  });
});
