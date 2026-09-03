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

// ---------------------------------------------------------------------------
// Known-answer vectors (KAT)
//
// signalCrypto implements two formats it does NOT own — SQLCipher-4 and
// Chromium's macOS OSCrypt/safeStorage — so "correct" means "matches what
// SQLCipher / Signal Desktop actually wrote on disk", not "round-trips against
// itself". Every value below was produced by an INDEPENDENT tool (the exact
// command is quoted above each one) and pasted as a literal. Never regenerate
// them with deriveSafeStorageKey/deriveSqlcipherKeys: a wrong constant would
// then be applied to both halves and the assertion would pass anyway. Each
// command was additionally cross-checked against `openssl kdf ... PBKDF2`.
// ---------------------------------------------------------------------------

// Inputs the vectors were generated from (also the inputs the assertions feed
// back into the production functions).
const KAT_KEYCHAIN_PASSWORD = 'a-random-keychain-password';
const KAT_SQLCIPHER_PASSPHRASE = 'correct horse battery staple';
const KAT_SQLCIPHER_SALT = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const KAT_RAW_KEY_HEX = 'a'.repeat(64);
const KAT_RAW_KEY_SALT = Buffer.alloc(16, 9);

const KAT = {
  // python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha1', b'a-random-keychain-password', b'saltysalt', 1003, 16).hex())"
  safeStorageKey: '5f7c922c2a8d144bfd90534c281820ee',

  // python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha512', b'correct horse battery staple', bytes.fromhex('000102030405060708090a0b0c0d0e0f'), 256000, 32).hex())"
  sqlcipherPassphraseEncKey: '2c6ee106931bbdc6ea7e33497f04526ccbe4fb541379d36a506a65eabed0d8e2',

  // HMAC salt is the file salt XOR 0x3a → 3f3e3d3c3b3a39383736353433323130
  // python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha512', bytes.fromhex('2c6ee106931bbdc6ea7e33497f04526ccbe4fb541379d36a506a65eabed0d8e2'), bytes.fromhex('3f3e3d3c3b3a39383736353433323130'), 2, 32).hex())"
  sqlcipherPassphraseHmacKey: 'cb8c37560a8a82af03be930057ace6a4115e87b6df6385b1df6c1edabd4a1813',

  // Raw-key mode: encKey is the 32 bytes of 'a'.repeat(64) verbatim, file salt is
  // 16 x 0x09 → HMAC salt 16 x 0x33.
  // python3 -c "import hashlib; print(hashlib.pbkdf2_hmac('sha512', bytes.fromhex('aa'*16), bytes.fromhex('33'*16), 2, 32).hex())"
  sqlcipherRawHmacKey: '3108bc4e02b717113520682a69e67022b92e37416c26b9ae904bb7ca3ae94182',
};

// Re-implement SQLCipher-4 *encryption* here so the decryptor can be verified
// against a known-good round trip — no real Signal DB required. This mirrors the
// exact page layout decryptSqlcipherDatabase expects.
//
// This deliberately reuses the PRODUCTION deriveSqlcipherKeys: the fixture must
// be keyed identically to the decryptor for the round trip to mean anything. The
// KAT block above is what makes that safe — it pins the derivation itself to an
// externally computed answer, so a wrong constant can no longer cancel out
// across both halves of this round trip.
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
    const { encKey, hmacKey } = deriveSqlcipherKeys(KAT_RAW_KEY_HEX, KAT_RAW_KEY_SALT);
    // Asserted against the externally generated vector, NOT a local re-derivation
    // with the implementation's own constants.
    expect(hmacKey.toString('hex')).toBe(KAT.sqlcipherRawHmacKey);
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
  const password = KAT_KEYCHAIN_PASSWORD;

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

describe('signalCrypto — known-answer vectors', () => {
  it('derives the Chromium safeStorage key (known-answer vector)', () => {
    // Pins SAFE_STORAGE_SALT, SAFE_STORAGE_ITER_MACOS (1003), the SHA-1 digest
    // and the 16-byte AES-128 key length — all invisible to a round-trip test.
    expect(deriveSafeStorageKey(KAT_KEYCHAIN_PASSWORD).toString('hex')).toBe(KAT.safeStorageKey);
  });

  it('derives the SQLCipher-4 passphrase key with the slow KDF (known-answer vector)', () => {
    // The only test that reaches the non-raw-key branch of deriveSqlcipherKeys.
    // Pins SQLCIPHER_KDF_ITER (256000), the SHA-512 digest and the 32-byte key
    // length; the HMAC half additionally pins the 0x3a salt mask.
    const { encKey, hmacKey } = deriveSqlcipherKeys(KAT_SQLCIPHER_PASSPHRASE, KAT_SQLCIPHER_SALT);
    expect(encKey.toString('hex')).toBe(KAT.sqlcipherPassphraseEncKey);
    expect(hmacKey.toString('hex')).toBe(KAT.sqlcipherPassphraseHmacKey);
  });

  it('a wrong iteration count, digest, or salt mask fails the known-answer vectors (bypass probe)', () => {
    // Proves the vectors are sensitive to the constants they guard — i.e. that
    // they were not accidentally regenerated from the implementation.
    const offByOne = crypto.pbkdf2Sync(KAT_KEYCHAIN_PASSWORD, 'saltysalt', 1002, 16, 'sha1');
    expect(offByOne.toString('hex')).not.toBe(KAT.safeStorageKey);
    const wrongDigest = crypto.pbkdf2Sync(KAT_KEYCHAIN_PASSWORD, 'saltysalt', 1003, 16, 'sha256');
    expect(wrongDigest.toString('hex')).not.toBe(KAT.safeStorageKey);
    const wrongMask = crypto.pbkdf2Sync(
      Buffer.from(KAT_RAW_KEY_HEX, 'hex'),
      Buffer.from(KAT_RAW_KEY_SALT.map((b) => b ^ 0x3b)),
      2,
      32,
      'sha512',
    );
    expect(wrongMask.toString('hex')).not.toBe(KAT.sqlcipherRawHmacKey);
  });
});
