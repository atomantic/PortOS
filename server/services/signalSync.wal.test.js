/**
 * Signal sync consumes the consistent snapshot (#11149): both the checkpointed
 * message and the committed WAL-only message are ingested, a second pass is a
 * no-op, and an authentication failure leaves the cursor and activity calls
 * untouched. The database is an encrypted fixture, not a live Signal profile.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordEventsMock, autoLogTouchpointsMock, snapshotDirs } = vi.hoisted(() => ({
  recordEventsMock: vi.fn(),
  autoLogTouchpointsMock: vi.fn(),
  snapshotDirs: [],
}));

const dataRoot = vi.hoisted(() => {
  const { mkdtempSync: mkdtemp } = require('node:fs');
  const { tmpdir: osTmp } = require('node:os');
  const { join: joinPath } = require('node:path');
  return mkdtemp(joinPath(osTmp(), 'signal-sync-wal-'));
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { join: joinPath } = await import('node:path');
  return {
    ...actual,
    dataPath: (...segments) => joinPath(dataRoot, ...segments),
  };
});

vi.mock('./humanActivity.js', async () => {
  const actual = await vi.importActual('./humanActivity.js');
  return { ...actual, recordEvents: recordEventsMock };
});

vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({ signal: { enabled: true } })) }));

vi.mock('./tribe.js', () => ({
  autoLogTouchpoints: autoLogTouchpointsMock,
}));

// Only this file's snapshot dirs. A global tmpdir scan races other Signal tests.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    mkdtemp: async (...args) => {
      const path = await actual.mkdtemp(...args);
      snapshotDirs.push(path);
      return path;
    },
  };
});

import { SQLCIPHER_DRIVER_PACKAGE } from './signalSnapshot.js';
import { runSync } from './signalSync.js';

const driverRequire = createRequire(import.meta.url);
const Database = driverRequire(SQLCIPHER_DRIVER_PACKAGE);

const dbDir = mkdtempSync(join(tmpdir(), 'signal-sync-wal-db-'));
const dbPath = join(dbDir, 'db.sqlite');
const configPath = join(dbDir, 'config.json');
const key = 'ab'.repeat(32);
let writer;

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function expectOwnSnapshotsRemoved() {
  expect(snapshotDirs.length).toBeGreaterThan(0);
  expect(snapshotDirs.every((path) => !existsSync(path))).toBe(true);
}

beforeAll(() => {
  writer = new Database(dbPath);
  writer.pragma(`cipher='sqlcipher'`);
  writer.pragma('legacy=4');
  writer.pragma(`key="x'${key}'"`);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, e164 TEXT, type TEXT, name TEXT, profileName TEXT
    );
    CREATE TABLE messages (
      id TEXT, conversationId TEXT, type TEXT, sent_at INTEGER, received_at INTEGER, body TEXT
    );
    INSERT INTO conversations VALUES ('c1', '+15551230001', 'private', 'Ada', 'Ada');
    INSERT INTO messages VALUES ('m1', 'c1', 'incoming', 1700000000000, 1700000000000, 'checkpointed');
  `);
  writer.pragma('wal_checkpoint(TRUNCATE)');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`INSERT INTO messages VALUES ('m2', 'c1', 'outgoing', 1700000001000, 1700000001000, 'wal-only')`);
  writeFileSync(configPath, JSON.stringify({ key }));
  process.env.SIGNAL_DB_PATH = dbPath;
  process.env.SIGNAL_CONFIG_PATH = configPath;
});

afterAll(() => {
  try { writer?.close(); } catch { /* already closed */ }
  delete process.env.SIGNAL_DB_PATH;
  delete process.env.SIGNAL_CONFIG_PATH;
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  recordEventsMock.mockReset();
  autoLogTouchpointsMock.mockReset();
  recordEventsMock.mockResolvedValue({ recorded: 2, skipped: 0 });
  autoLogTouchpointsMock.mockResolvedValue({ created: 1, matched: 1 });
  snapshotDirs.length = 0;
  rmSync(join(dataRoot, 'signal-sync-state.json'), { force: true });
  writeFileSync(configPath, JSON.stringify({ key }));
});

describe('runSync WAL snapshot', () => {
  it('ingests both committed messages once, then stays idempotent, without writing the source', async () => {
    const wal = `${dbPath}-wal`;
    const before = { db: digest(dbPath), wal: digest(wal) };

    const first = await runSync();
    expect(first.ok, first.error).toBe(true);
    expect(first.scanned).toBe(2);
    expect(first.cursorRowid).toBe(2);
    const recorded = recordEventsMock.mock.calls[0][0].map((row) => row.dedupeKey).sort();
    expect(recorded).toEqual(['signal:m1', 'signal:m2']);
    expect(digest(dbPath)).toBe(before.db);
    expect(digest(wal)).toBe(before.wal);
    expectOwnSnapshotsRemoved();

    const second = await runSync();
    expect(second.ok).toBe(true);
    expect(second.scanned).toBe(0);
    expect(second.cursorRowid).toBe(2);
    expect(recordEventsMock.mock.calls[1][0]).toEqual([]);
  });

  it('ingests a WAL message inserted after an older row was deleted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'signal-sync-rowid-'));
    const path = join(dir, 'db.sqlite');
    const local = new Database(path);
    local.pragma(`cipher='sqlcipher'`);
    local.pragma('legacy=4');
    local.pragma(`key="x'${key}'"`);
    local.pragma('journal_mode = WAL');
    local.pragma('wal_autocheckpoint = 0');
    local.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY, e164 TEXT, type TEXT, name TEXT, profileName TEXT
      );
      CREATE TABLE messages (
        id TEXT, conversationId TEXT, type TEXT, sent_at INTEGER, received_at INTEGER, body TEXT
      );
      INSERT INTO conversations VALUES ('c1', '+15551230001', 'private', 'Ada', 'Ada');
      INSERT INTO messages VALUES ('m1', 'c1', 'incoming', 1700000000000, 1700000000000, 'first');
      INSERT INTO messages VALUES ('m2', 'c1', 'outgoing', 1700000001000, 1700000001000, 'second');
    `);
    const previous = process.env.SIGNAL_DB_PATH;
    process.env.SIGNAL_DB_PATH = path;
    try {
      const first = await runSync();
      expect(first.ok, first.error).toBe(true);
      expect(first.cursorRowid).toBe(2);
      local.exec(`DELETE FROM messages WHERE id = 'm1'`);
      local.exec(`INSERT INTO messages VALUES ('m3', 'c1', 'incoming', 1700000002000, 1700000002000, 'after-delete')`);
      recordEventsMock.mockClear();
      const second = await runSync();
      expect(second.ok, second.error).toBe(true);
      expect(second.scanned).toBe(1);
      expect(second.cursorRowid).toBeGreaterThan(first.cursorRowid);
      expect(recordEventsMock.mock.calls[0][0].map((row) => row.dedupeKey)).toEqual(['signal:m3']);
    } finally {
      process.env.SIGNAL_DB_PATH = previous;
      local.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the cursor and activity calls untouched when the key is rejected', async () => {
    const first = await runSync();
    expect(first.ok, first.error).toBe(true);
    const calls = recordEventsMock.mock.calls.length;

    writeFileSync(configPath, JSON.stringify({ key: 'cd'.repeat(32) }));
    const failed = await runSync();
    expect(failed.ok).toBe(false);
    expect(failed.reason).toBe('auth');
    expect(failed.error).toMatch(/decryption failed/i);

    const state = JSON.parse(readFileSync(join(dataRoot, 'signal-sync-state.json'), 'utf8'));
    expect(state.cursorRowid).toBe(first.cursorRowid);
    expect(recordEventsMock.mock.calls.length).toBe(calls);
    expectOwnSnapshotsRemoved();
  });
});
