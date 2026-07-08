/**
 * Signal Desktop database crypto (#2154) — pure, dependency-free helpers for
 * reading Signal's local SQLCipher-encrypted chat database.
 *
 * Two independent crypto schemes live here, both implemented against Node's
 * built-in `node:crypto` (zero new dependencies, per the PortOS dependency
 * policy — see docs/plans/2026-07-04-human-activity-tracking.md):
 *
 *  1. **SQLCipher 4 page decryption.** Signal stores its chat DB as a
 *     SQLCipher-4 file (`sql/db.sqlite`). `node:sqlite` cannot open it (no
 *     SQLCipher support), and shelling to a `sqlcipher` CLI would add an
 *     external tool dependency that most machines lack. Instead we decrypt the
 *     file page-by-page here (PBKDF2-SHA512 for the HMAC key + AES-256-CBC per
 *     page + HMAC-SHA512 verification) into a *plaintext* standard SQLite file,
 *     which the built-in `node:sqlite` then opens read-only. This keeps the read
 *     path self-contained and testable.
 *
 *  2. **Chromium `safeStorage` decryption.** Signal ≥6.2 no longer stores the DB
 *     key in plaintext; `config.json` carries an `encryptedKey` wrapped by
 *     Electron `safeStorage`, which on macOS is Chromium's `OSCrypt` scheme:
 *     AES-128-CBC with a key = PBKDF2-SHA1(keychainPassword, "saltysalt", 1003)
 *     and a fixed 16-space IV. The keychain read itself is a side effect (see
 *     services/signalSync.js); the pure AES/PBKDF2 math lives here.
 *
 * Everything in this file is pure (Buffers in, Buffers/objects out) so the
 * fragile crypto is unit-tested with round-trip fixtures — no real Signal
 * install required.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// SQLCipher 4 constants (the defaults Signal Desktop ships with)
// ---------------------------------------------------------------------------

export const SQLCIPHER_PAGE_SIZE = 4096;
export const SQLCIPHER_KDF_ITER = 256000; // PBKDF2-HMAC-SHA512 rounds for a passphrase key
export const SQLCIPHER_FAST_KDF_ITER = 2; // rounds for the derived HMAC key
export const SQLCIPHER_KEY_BYTES = 32; // AES-256
export const SQLCIPHER_SALT_BYTES = 16; // leading file salt
export const SQLCIPHER_IV_BYTES = 16; // per-page CBC IV
export const SQLCIPHER_HMAC_BYTES = 64; // HMAC-SHA512 output
export const SQLCIPHER_SALT_MASK = 0x3a; // HMAC salt is the file salt XOR this
// Reserve = IV + HMAC, already a multiple of the 16-byte AES block so no padding.
export const SQLCIPHER_RESERVE_BYTES = SQLCIPHER_IV_BYTES + SQLCIPHER_HMAC_BYTES; // 80
// A standard (plaintext) SQLite file begins with this 16-byte magic. SQLCipher
// overwrites page 1's first 16 bytes with the salt, so on decrypt we restore it.
export const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/**
 * Return true when `key` is a 64-character hex string — the "raw key" form Signal
 * stores (SQLCipher uses those 32 bytes directly as the AES key, skipping PBKDF2).
 */
export function isRawHexKey(key) {
  return typeof key === 'string' && /^[0-9a-fA-F]{64}$/.test(key.trim());
}

/**
 * Derive the SQLCipher encryption + HMAC keys from key material and the file salt.
 *
 * - Raw-key mode (Signal's case): `keyMaterial` is a 64-hex-char string → the
 *   encryption key is those 32 bytes verbatim (no PBKDF2).
 * - Passphrase mode: `keyMaterial` is any other string/Buffer → encryption key =
 *   PBKDF2-SHA512(passphrase, salt, 256000, 32).
 *
 * The HMAC key is ALWAYS PBKDF2-SHA512(encKey, salt XOR 0x3a, 2, 32) — SQLCipher's
 * "fast" derivation — regardless of mode.
 */
export function deriveSqlcipherKeys(keyMaterial, salt) {
  if (!Buffer.isBuffer(salt) || salt.length !== SQLCIPHER_SALT_BYTES) {
    throw new Error(`SQLCipher salt must be ${SQLCIPHER_SALT_BYTES} bytes`);
  }
  let encKey;
  if (isRawHexKey(keyMaterial)) {
    encKey = Buffer.from(keyMaterial.trim(), 'hex');
  } else {
    const pass = Buffer.isBuffer(keyMaterial) ? keyMaterial : Buffer.from(String(keyMaterial), 'utf8');
    encKey = crypto.pbkdf2Sync(pass, salt, SQLCIPHER_KDF_ITER, SQLCIPHER_KEY_BYTES, 'sha512');
  }
  const hmacSalt = Buffer.from(salt.map((b) => b ^ SQLCIPHER_SALT_MASK));
  const hmacKey = crypto.pbkdf2Sync(encKey, hmacSalt, SQLCIPHER_FAST_KDF_ITER, SQLCIPHER_KEY_BYTES, 'sha512');
  return { encKey, hmacKey };
}

/**
 * Compute a SQLCipher page HMAC: HMAC-SHA512(hmacKey, cipherAndIv || pageNoLE32).
 * `cipherAndIv` is the page's encrypted body concatenated with its 16-byte IV
 * (exactly the bytes SQLCipher authenticates); the 1-based page number is
 * appended as a little-endian uint32 (SQLCipher's portable default).
 */
export function sqlcipherPageHmac(hmacKey, cipherAndIv, pageNo) {
  const pgno = Buffer.alloc(4);
  pgno.writeUInt32LE(pageNo >>> 0, 0);
  return crypto.createHmac('sha512', hmacKey)
    .update(cipherAndIv)
    .update(pgno)
    .digest();
}

/**
 * Decrypt a SQLCipher-4 database buffer to a plaintext standard-SQLite buffer.
 *
 * Returns `{ ok: true, plaintext: Buffer }` on success, or
 * `{ ok: false, error, reason }` on any failure (bad key, unexpected size, HMAC
 * mismatch) — NEVER throws, so callers surface a graceful "unsupported Signal
 * version" rather than crashing. `reason` is a machine code:
 *   - `empty`         — zero-length input
 *   - `too-small`     — smaller than one page
 *   - `bad-page-size` — length isn't a whole number of pages
 *   - `auth`          — page-1 HMAC mismatch (wrong key / not SQLCipher-4)
 *
 * By default every page's HMAC is verified. Verifying only page 1 is enough to
 * detect a wrong key, but full verification catches a corrupt/truncated copy too;
 * pass `{ verify: 'first' }` to check page 1 only for speed on huge DBs.
 */
export function decryptSqlcipherDatabase(buffer, keyMaterial, { verify = 'all' } = {}) {
  if (!buffer || buffer.length === 0) return { ok: false, error: 'Empty database file', reason: 'empty' };
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < SQLCIPHER_PAGE_SIZE) return { ok: false, error: 'Database smaller than one page', reason: 'too-small' };
  if (buf.length % SQLCIPHER_PAGE_SIZE !== 0) {
    return { ok: false, error: `Database length ${buf.length} is not a whole number of ${SQLCIPHER_PAGE_SIZE}-byte pages`, reason: 'bad-page-size' };
  }

  const salt = buf.subarray(0, SQLCIPHER_SALT_BYTES);
  let encKey;
  let hmacKey;
  try {
    ({ encKey, hmacKey } = deriveSqlcipherKeys(keyMaterial, salt));
  } catch (err) {
    return { ok: false, error: err?.message || 'Key derivation failed', reason: 'auth' };
  }

  const totalPages = buf.length / SQLCIPHER_PAGE_SIZE;
  const out = Buffer.alloc(buf.length);
  const bodyEndOffset = SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_BYTES; // where IV starts within a page

  for (let page = 1; page <= totalPages; page += 1) {
    const pageStart = (page - 1) * SQLCIPHER_PAGE_SIZE;
    const bodyStart = pageStart + (page === 1 ? SQLCIPHER_SALT_BYTES : 0);
    const ivStart = pageStart + bodyEndOffset;
    const ciphertext = buf.subarray(bodyStart, ivStart);
    const iv = buf.subarray(ivStart, ivStart + SQLCIPHER_IV_BYTES);

    // Verify the page HMAC over ciphertext||IV. Page 1 always; the rest when
    // verify==='all'. constant-time compare avoids a timing oracle (cheap here).
    if (page === 1 || verify === 'all') {
      const stored = buf.subarray(ivStart + SQLCIPHER_IV_BYTES, ivStart + SQLCIPHER_IV_BYTES + SQLCIPHER_HMAC_BYTES);
      const computed = sqlcipherPageHmac(hmacKey, buf.subarray(bodyStart, ivStart + SQLCIPHER_IV_BYTES), page);
      if (stored.length !== computed.length || !crypto.timingSafeEqual(stored, computed)) {
        return {
          ok: false,
          error: page === 1
            ? 'Page-1 HMAC mismatch — wrong key or not a SQLCipher-4 database'
            : `Page-${page} HMAC mismatch — database copy is corrupt or truncated`,
          reason: 'auth',
        };
      }
    }

    let plainBody;
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
      decipher.setAutoPadding(false); // SQLCipher pages are exact block multiples, no PKCS padding
      plainBody = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (err) {
      return { ok: false, error: `AES decrypt failed on page ${page}: ${err?.message || err}`, reason: 'auth' };
    }

    if (page === 1) {
      // Restore the 16-byte SQLite magic SQLCipher replaced with the salt, then
      // the decrypted body; the reserve region stays zero (SQLite ignores the
      // per-page reserved bytes declared in the header byte 20 it just decrypted).
      SQLITE_HEADER.copy(out, pageStart);
      plainBody.copy(out, pageStart + SQLCIPHER_SALT_BYTES);
    } else {
      plainBody.copy(out, pageStart);
    }
  }

  return { ok: true, plaintext: out };
}

// ---------------------------------------------------------------------------
// Chromium safeStorage (macOS OSCrypt) — decrypt Signal's wrapped `encryptedKey`
// ---------------------------------------------------------------------------

export const SAFE_STORAGE_SALT = 'saltysalt';
export const SAFE_STORAGE_ITER_MACOS = 1003; // Chromium's macOS PBKDF2 rounds
export const SAFE_STORAGE_KEY_BYTES = 16; // AES-128
export const SAFE_STORAGE_IV = Buffer.alloc(16, ' '.charCodeAt(0)); // 16 spaces

/**
 * Derive the AES-128 key Chromium/Electron `safeStorage` uses on macOS from the
 * "Signal Safe Storage" keychain password: PBKDF2-SHA1(password, "saltysalt",
 * 1003, 16).
 */
export function deriveSafeStorageKey(password) {
  const pass = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf8');
  return crypto.pbkdf2Sync(pass, SAFE_STORAGE_SALT, SAFE_STORAGE_ITER_MACOS, SAFE_STORAGE_KEY_BYTES, 'sha1');
}

/**
 * Decrypt an Electron `safeStorage` value (Signal's `config.json.encryptedKey`,
 * stored as hex) given the keychain password. The blob is a 3-byte version tag
 * (`v10`/`v11`) followed by AES-128-CBC ciphertext with a fixed 16-space IV.
 *
 * Returns `{ ok: true, plaintext: Buffer }` (the plaintext is Signal's 64-hex-char
 * DB key) or `{ ok: false, error, reason }` — never throws. `reason`:
 *   - `empty`          — no ciphertext
 *   - `bad-prefix`     — missing the `v1x` version tag
 *   - `decrypt`        — wrong password / bad padding
 */
export function decryptSafeStorageValue(encrypted, password) {
  if (!encrypted || encrypted.length === 0) return { ok: false, error: 'Empty encryptedKey', reason: 'empty' };
  const buf = Buffer.isBuffer(encrypted) ? encrypted : Buffer.from(encrypted);
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') {
    return { ok: false, error: `Unrecognized safeStorage version prefix "${prefix}"`, reason: 'bad-prefix' };
  }
  const ciphertext = buf.subarray(3);
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    return { ok: false, error: 'safeStorage ciphertext is empty or not block-aligned', reason: 'decrypt' };
  }
  const key = deriveSafeStorageKey(password);
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, SAFE_STORAGE_IV);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { ok: true, plaintext };
  } catch (err) {
    return { ok: false, error: `safeStorage decrypt failed (wrong keychain password?): ${err?.message || err}`, reason: 'decrypt' };
  }
}
