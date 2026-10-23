import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';
import { decryptSqlcipherDatabase, deriveSqlcipherKeys, sqlcipherPageHmac,
  SQLCIPHER_PAGE_SIZE, SQLCIPHER_RESERVE_BYTES, SQLCIPHER_SALT_BYTES,
  SQLCIPHER_IV_BYTES } from '../lib/signalCrypto.js';

const mocks = vi.hoisted(() => ({
  root: '', snapshots: [], recordEvents: vi.fn(), autoLogTouchpoints: vi.fn(),
  readFile: vi.fn(), execFile: vi.fn(),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  mocks.readFile.mockImplementation(actual.tryReadFile);
  return { ...actual, tryReadFile: mocks.readFile, dataPath: (...parts) => join(mocks.root, ...parts) };
});
vi.mock('../lib/childProcess.js', () => ({ execFile: mocks.execFile }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdtemp: async (...args) => {
    const path = await actual.mkdtemp(...args);
    mocks.snapshots.push(path);
    return path;
  } };
});
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({ signal: { enabled: true } })) }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));
vi.mock('./humanActivity.js', async (importOriginal) => ({
  ...await importOriginal(), recordEvents: mocks.recordEvents,
}));
vi.mock('./tribe.js', () => ({ autoLogTouchpoints: mocks.autoLogTouchpoints }));

import { checkSetup, runSync, readSyncState } from './signalSync.js';
import { getSettings } from './settings.js';
import { ServerError } from '../lib/errorHandler.js';

const KEY = 'ab'.repeat(32); // invented fixture key; never reads the keychain
const BODY = 'x'.repeat(512);
let encrypted;
let plaintext;

// Build a genuinely queryable SQLite database with SQLCipher's 80-byte reserve.
// An empty SQLite page has no cells to relocate: changing its reserve and empty
// content-area pointer before creating tables makes SQLite allocate all later
// pages with the correct usable size. No external SQLCipher/Python dependency.
function createFixture() {
  const path = join(mocks.root, 'fixture.sqlite');
  let db = new DatabaseSync(path);
  db.exec('PRAGMA page_size=4096; VACUUM');
  db.close();
  const empty = readFileSync(path);
  empty[20] = SQLCIPHER_RESERVE_BYTES;
  empty.writeUInt16BE(SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_BYTES, 105);
  writeFileSync(path, empty);
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE conversations(id TEXT, e164 TEXT, type TEXT, name TEXT, profileName TEXT);
    CREATE TABLE messages(id TEXT, conversationId TEXT, type TEXT, sent_at INTEGER, received_at INTEGER, body TEXT);
    INSERT INTO conversations VALUES ('fixture-chat', '+15550000000', 'private', 'Example Contact', '');
  `);
  db.prepare('INSERT INTO messages(rowid, id, conversationId, type, sent_at, body) VALUES (?,?,?,?,?,?)')
    .run(8, 'fixture-message', 'fixture-chat', 'incoming', Date.UTC(2024, 5, 1, 12), BODY);
  expect(db.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
  db.close();
  return readFileSync(path);
}

// Encryption uses the production KDF pinned by signalCrypto's independent
// known-answer vectors; this fixture exercises service wiring, not KDF accuracy.
function encrypt(plain) {
  const salt = Buffer.alloc(SQLCIPHER_SALT_BYTES, 7);
  const { encKey, hmacKey } = deriveSqlcipherKeys(KEY, salt);
  const out = Buffer.alloc(plain.length);
  for (let page = 1; page <= plain.length / SQLCIPHER_PAGE_SIZE; page += 1) {
    const start = (page - 1) * SQLCIPHER_PAGE_SIZE;
    const bodyStart = start + (page === 1 ? SQLCIPHER_SALT_BYTES : 0);
    const end = start + SQLCIPHER_PAGE_SIZE - SQLCIPHER_RESERVE_BYTES;
    const iv = Buffer.alloc(SQLCIPHER_IV_BYTES, page);
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([cipher.update(plain.subarray(bodyStart, end)), cipher.final()]);
    if (page === 1) salt.copy(out, start);
    ciphertext.copy(out, bodyStart);
    iv.copy(out, end);
    sqlcipherPageHmac(hmacKey, Buffer.concat([ciphertext, iv]), page).copy(out, end + SQLCIPHER_IV_BYTES);
  }
  return out;
}

beforeEach(() => {
  getSettings.mockResolvedValue({ signal: { enabled: true } });
  mocks.readFile.mockClear();
  mocks.execFile.mockReset().mockImplementation((...args) => args.at(-1)(new Error('Unexpected keychain access')));
  mocks.root = createTempDataRoot('signal-auth-test-');
  mocks.snapshots = [];
  mkdirSync(join(mocks.root, 'sql'));
  writeFileSync(join(mocks.root, 'config.json'), JSON.stringify({ key: KEY }));
  vi.stubEnv('SIGNAL_DIR', mocks.root);
  vi.stubEnv('SIGNAL_CONFIG_PATH', join(mocks.root, 'config.json'));
  vi.stubEnv('SIGNAL_DB_PATH', join(mocks.root, 'sql', 'db.sqlite'));
  plaintext = createFixture();
  encrypted = encrypt(plaintext);
  writeFileSync(process.env.SIGNAL_DB_PATH, encrypted);
  mocks.recordEvents.mockReset().mockImplementation(async (events) => ({ recorded: events.length, skipped: 0 }));
  mocks.autoLogTouchpoints.mockReset().mockResolvedValue({ created: 1, matched: 1 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(mocks.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function expectSnapshotsRemoved() {
  expect(mocks.snapshots.length).toBeGreaterThan(0);
  expect(mocks.snapshots.every((path) => !existsSync(path))).toBe(true);
}

describe('Signal authenticated snapshot ingestion', () => {
  it.each([{}, { signal: { enabled: false } }])('refuses disabled sync and setup before any Signal file or keychain access (%j)', async (settings) => {
    getSettings.mockResolvedValue(settings);
    vi.stubEnv('SIGNAL_KEYCHAIN_PASSWORD', '');
    writeFileSync(join(mocks.root, 'config.json'), JSON.stringify({ encryptedKey: 'fixture-wrapped-key' }));

    const refusal = await runSync().catch((error) => error);
    expect(refusal).toBeInstanceOf(ServerError);
    expect(refusal).toMatchObject({ status: 409, code: 'SIGNAL_DISABLED' });
    expect(await checkSetup()).toEqual({ enabled: false });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.snapshots).toEqual([]);
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(mocks.autoLogTouchpoints).not.toHaveBeenCalled();
  });

  it('accepts a multipage database and does not reingest messages on replay', async () => {
    expect(plaintext.length).toBeGreaterThan(SQLCIPHER_PAGE_SIZE);
    expect(await checkSetup()).toMatchObject({ ok: true, messageCount: 1 });
    expect(await runSync()).toMatchObject({ ok: true, recorded: 1, cursorRowid: 8 });
    expect(mocks.recordEvents.mock.calls[0][0]).toMatchObject([
      { dedupeKey: 'signal:fixture-message', kind: 'message.received' },
    ]);
    expect(mocks.autoLogTouchpoints.mock.calls[0][0]).toHaveLength(1);
    expect(await runSync()).toMatchObject({ ok: true, recorded: 0, scanned: 0, cursorRowid: 8 });
    expect(mocks.recordEvents.mock.calls[1][0]).toEqual([]);
    expect((await readSyncState()).cursorRowid).toBe(8);
    expectSnapshotsRemoved();
  });

  it('refuses queryable later-page body corruption before writes and preserves the prior cursor', async () => {
    const statePath = join(mocks.root, 'signal-sync-state.json');
    const state = JSON.stringify({ cursorRowid: 7, lastRunAt: '2024-01-01T00:00:00Z', lastResult: { ok: true } });
    writeFileSync(statePath, state);
    // Flip a ciphertext bit well inside the long body, beyond page 1. CBC
    // damages text bytes while leaving the cell header and B-tree readable.
    const bodyOffset = plaintext.indexOf(Buffer.from(BODY));
    expect(bodyOffset).toBeGreaterThan(SQLCIPHER_PAGE_SIZE);
    encrypted[bodyOffset + 128] ^= 1;
    writeFileSync(process.env.SIGNAL_DB_PATH, encrypted);
    const partial = decryptSqlcipherDatabase(encrypted, KEY, { verify: 'first' });
    expect(partial.ok).toBe(true);
    const readablePath = join(mocks.root, 'damaged-readable.sqlite');
    writeFileSync(readablePath, partial.plaintext);
    const readable = new DatabaseSync(readablePath, { readOnly: true });
    try {
      expect(readable.prepare('PRAGMA integrity_check').get().integrity_check).toBe('ok');
      expect(readable.prepare('SELECT body FROM messages').get().body).not.toBe(BODY);
    } finally { readable.close(); }

    // verify:'first' still produces a readable database whose integrity_check
    // passes and whose body is wrong. The SQLCipher snapshot must refuse that
    // file (the driver reports the damaged page as malformed) and must not
    // ingest it or move the cursor. The old main-file copy named this as a
    // page HMAC mismatch; the snapshot failure is the same refusal.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const result of [await checkSetup(), await runSync()]) {
      expect(result.ok).toBe(false);
      expect(['auth', 'snapshot']).toContain(result.reason);
      expect(result.error).toMatch(/malformed|hmac|decryption failed|integrity/i);
      expect(result.remediation).toMatch(/left unchanged|Nothing was ingested|not yet supported/);
    }
    expect(mocks.recordEvents).not.toHaveBeenCalled();
    expect(mocks.autoLogTouchpoints).not.toHaveBeenCalled();
    expect(readFileSync(statePath, 'utf8')).toBe(state);
    expect((await readSyncState()).cursorRowid).toBe(7);
    expectSnapshotsRemoved();
  });
});
