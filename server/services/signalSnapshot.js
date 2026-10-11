/**
 * Read-only SQLCipher snapshot of a live Signal Desktop database (#11149).
 *
 * Signal Desktop keeps `sql/db.sqlite` in WAL mode. A copy of that main file
 * alone misses committed frames that have not been checkpointed, and a copy
 * taken while a checkpoint is running is not a transactional snapshot. Both
 * can look like a valid database and still drop messages.
 *
 * Capture opens the source with the bundled SQLCipher driver
 * (`better-sqlite3-multiple-ciphers`, SQLCipher 4 compatibility, raw 64-hex
 * key — the same key form Signal uses). One connection holds a deferred read
 * transaction so a checkpoint cannot discard frames mid-capture. A second
 * read-only connection materializes that committed view with SQLite
 * `VACUUM INTO`, which includes WAL frames and works against a read-only
 * source. `backup()` is not used: this driver rejects an encrypted source
 * backing up into a plaintext target, and it does not ship `sqlcipher_export`.
 *
 * The private copy is then `rekey`ed with an empty key, which yields a
 * standard plaintext SQLite file. Rekey runs only on that copy. The source is
 * opened `readonly` and this module never issues `wal_checkpoint`,
 * `journal_mode`, or any other write against it. The WAL index may record a
 * reader mark; the database file and the WAL must stay byte-identical.
 *
 * If the driver cannot be loaded, or the snapshot is not a single integrity-
 * clean committed view, the result is an explicit failure. Callers leave the
 * ingestion cursor where it was. Temporary files are removed on failure;
 * the caller removes them after a successful read.
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isRawHexKey } from '../lib/signalCrypto.js';

const require = createRequire(import.meta.url);

export const SQLCIPHER_DRIVER_PACKAGE = 'better-sqlite3-multiple-ciphers';

const SQLITE_MAGIC = 'SQLite format 3\0';
const BUSY_TIMEOUT_MS = 5000;

const SETUP_REMEDIATION = 'Signal snapshot capture needs the bundled SQLCipher driver (better-sqlite3-multiple-ciphers) and its shipped prebuild for this platform (macOS, Linux glibc or musl, and Windows; x64 and arm64). Reinstall server dependencies. PortOS will not ingest a partial copy of the live database.';
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

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function applyKey(db, key) {
  // isRawHexKey already accepted this value. Trim so a wrapped config key
  // cannot change the SQLCipher raw-key literal. The body is 64 hex chars.
  const hex = String(key).trim();
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.pragma(`key="x'${hex}'"`);
}

function openReadonly(Database, sourcePath) {
  return new Database(sourcePath, { readonly: true, fileMustExist: true });
}

function classifyDriverError(err) {
  const message = err?.message || String(err);
  if (/not a database|hmac|cipher|encrypt|invalid key|file is not a database/i.test(message)) {
    return authFailure(`Signal database decryption failed: ${message}`);
  }
  return snapshotFailure(`Signal snapshot failed: ${message}`);
}

async function closeQuietly(db) {
  if (!db) return;
  try {
    if (db.inTransaction) db.exec('ROLLBACK');
  } catch { /* already closed or no transaction */ }
  try { db.close(); } catch { /* already closed */ }
}

/**
 * Materialize a private plaintext snapshot of `sourcePath`.
 *
 * `options.loadDriver` overrides the package load (tests for a missing
 * prebuild). `options.tmpRoot` relocates the temp directory. `options.onReadLocked`
 * runs while the source read transaction is held, so a test can checkpoint
 * concurrently. Returns `{ ok: true, plaintextPath, tmpDir }` or
 * `{ ok: false, reason, error, remediation }`. Never throws.
 */
export async function captureConsistentSnapshot(sourcePath, key, options = {}) {
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

  const tmp = await mkdtemp(join(options.tmpRoot || tmpdir(), 'portos-signal-'));
  const plainPath = join(tmp, 'db.plain.sqlite');
  let holder;
  let exporter;
  let owned;
  let plain;
  try {
    holder = openReadonly(Database, sourcePath);
    applyKey(holder, key);
    holder.exec('BEGIN');
    // Establishes the read mark and rejects a wrong key before any export.
    holder.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    if (options.onReadLocked) await options.onReadLocked();

    exporter = openReadonly(Database, sourcePath);
    applyKey(exporter, key);
    exporter.exec(`VACUUM INTO ${sqlLiteral(plainPath)}`);
    exporter.close();
    exporter = null;
    holder.exec('ROLLBACK');
    holder.close();
    holder = null;

    owned = new Database(plainPath, { fileMustExist: true });
    applyKey(owned, key);
    owned.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    owned.pragma(`rekey=''`);
    owned.close();
    owned = null;

    const header = await readFile(plainPath);
    if (header.length < 16 || header.subarray(0, 16).toString('latin1') !== SQLITE_MAGIC) {
      await rm(tmp, { recursive: true, force: true });
      return snapshotFailure('Signal snapshot export did not produce a plaintext database');
    }

    plain = new Database(plainPath, { readonly: true, fileMustExist: true });
    const check = plain.pragma('integrity_check');
    plain.close();
    plain = null;
    const clean = Array.isArray(check) && check.length === 1 && check[0]?.integrity_check === 'ok';
    if (!clean) {
      await rm(tmp, { recursive: true, force: true });
      return snapshotFailure('Signal snapshot failed integrity check');
    }
    return { ok: true, plaintextPath: plainPath, tmpDir: tmp };
  } catch (err) {
    await closeQuietly(plain);
    await closeQuietly(owned);
    await closeQuietly(exporter);
    await closeQuietly(holder);
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return classifyDriverError(err);
  }
}
