/**
 * Read-only SQLCipher snapshot of a live Signal Desktop database (#11149).
 *
 * Signal Desktop keeps `sql/db.sqlite` in WAL mode. A copy of that main file
 * alone misses committed frames that have not been checkpointed, and a copy
 * taken while a checkpoint is running is not a transactional snapshot. Both
 * can look like a valid database and still drop messages.
 *
 * The SQLCipher connection holds one read transaction across the caller's
 * queries, preserving the source rowids and the live WAL view. It never
 * materializes a plaintext database or issues writes against the source. SQLite
 * can update reader marks in the WAL index; the main file and WAL stay intact.
 */
import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';

import { isRawHexKey } from '../lib/signalCrypto.js';

const require = createRequire(import.meta.url);

export const SQLCIPHER_DRIVER_PACKAGE = 'better-sqlite3-multiple-ciphers';

const BUSY_TIMEOUT_MS = 5000;

const SETUP_REMEDIATION = 'Signal sync needs the bundled SQLCipher driver (better-sqlite3-multiple-ciphers) and its shipped prebuild for this platform (macOS, Linux glibc or musl, and Windows; x64 and arm64). Reinstall server dependencies. Signal sync requires a consistent read of the live database.';
const AUTH_REMEDIATION = 'Signal database decryption failed — the key or SQLCipher format may have changed in this Signal version (not yet supported).';
const SNAPSHOT_REMEDIATION = 'Could not take one consistent read-only snapshot of the Signal database. Nothing was ingested and the sync cursor was left unchanged; retry when Signal is not checkpointing.';

function setupFailure(err) {
  const detail = err?.message || 'SQLCipher driver unavailable';
  return {
    ok: false,
    reason: 'setup',
    error: `SQLCipher driver unavailable: ${detail}`,
    remediation: SETUP_REMEDIATION,
  };
}

function authFailure(error) {
  return { ok: false, reason: 'auth', error, remediation: AUTH_REMEDIATION };
}

function snapshotFailure(error) {
  return { ok: false, reason: 'snapshot', error, remediation: SNAPSHOT_REMEDIATION };
}

function loadDefaultDriver() {
  return require(SQLCIPHER_DRIVER_PACKAGE);
}

function resolveConstructor(loaded) {
  if (typeof loaded === 'function') return loaded;
  if (loaded && typeof loaded.default === 'function') return loaded.default;
  return null;
}

function applyKey(db, key) {
  // isRawHexKey already accepted this value. Trim so a wrapped config key
  // cannot change the SQLCipher raw-key literal. The body is 64 hex chars.
  const hex = String(key).trim();
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.pragma('temp_store = MEMORY');
  db.pragma(`key="x'${hex}'"`);
}

function classifyDriverError(err) {
  if (err?.code === 'MODULE_NOT_FOUND' || err?.code === 'ERR_DLOPEN_FAILED') {
    // The package loads its native prebuild when the first connection opens.
    return setupFailure(err);
  }
  const message = err?.message || String(err);
  if (/not a database|hmac|cipher|encrypt|invalid key|file is not a database/i.test(message)) {
    return authFailure(`Signal database decryption failed: ${message}`);
  }
  return snapshotFailure(`Signal snapshot failed: ${message}`);
}

/**
 * Run readFn against one committed view of the live SQLCipher database.
 * Returns { ok: true, value } or a structured setup, auth or snapshot error.
 * loadDriver and onReadLocked let tests simulate a missing prebuild and an
 * overlapping checkpoint, respectively.
 */
export async function withConsistentSnapshot(sourcePath, key, readFn, options = {}) {
  if (!isRawHexKey(key)) {
    return authFailure('Signal SQLCipher key is not a 64-hex-char raw key');
  }

  let Database;
  try {
    const loaded = (options.loadDriver || loadDefaultDriver)();
    Database = resolveConstructor(loaded);
    if (!Database) throw new Error('driver did not export a database constructor');
  } catch (err) {
    return setupFailure(err);
  }

  let info;
  try {
    info = await stat(sourcePath);
  } catch (err) {
    const missing = err?.code === 'ENOENT';
    return {
      ok: false,
      reason: missing ? 'missing' : 'snapshot',
      error: missing ? `Signal database not found at ${sourcePath}` : `Cannot access ${sourcePath}: ${err?.message || err}`,
      remediation: missing
        ? 'Signal Desktop has no chat database yet (never opened, or a different profile).'
        : 'Could not read the Signal database file — check file permissions for the process running PortOS.',
    };
  }
  if (!info.isFile() || info.size === 0) {
    return snapshotFailure('Signal database snapshot is empty');
  }

  try {
    const holder = new Database(sourcePath, { readonly: true, fileMustExist: true });
    try {
      applyKey(holder, key);
      holder.exec('BEGIN');
      // Establish the read mark and validate the key before calling the reader.
      holder.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      if (options.onReadLocked) await options.onReadLocked();
      return { ok: true, value: await readFn(holder) };
    } finally {
      try {
        if (holder.inTransaction) holder.exec('ROLLBACK');
      } finally {
        holder.close();
      }
    }
  } catch (err) {
    return classifyDriverError(err);
  }
}
