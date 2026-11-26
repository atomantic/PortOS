/**
 * Consistent Signal capture (#11149). Builds a real SQLCipher WAL database with
 * the bundled driver — no live Signal profile. One message is checkpointed into
 * the main file; a second is committed while the writer stays open, so it exists
 * only in the WAL. Copying the main file alone must not be treated as caught up.
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { withConsistentSnapshot, SQLCIPHER_DRIVER_PACKAGE } from './signalSnapshot.js';

const require = createRequire(import.meta.url);
const Database = require(SQLCIPHER_DRIVER_PACKAGE);

const temps = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'signal-snapshot-test-'));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function applyKey(db, key) {
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.pragma(`key="x'${key}'"`);
}

/**
 * Encrypted WAL database. `writer` stays open so Signal-style autocheckpoint on
 * close cannot fold the second message into the main file.
 */
function buildLiveWal(dir) {
  const src = join(dir, 'db.sqlite');
  const key = randomBytes(32).toString('hex');
  const writer = new Database(src);
  applyKey(writer, key);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.pragma('busy_timeout = 200');
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
  const checkpoint = writer.pragma('wal_checkpoint(TRUNCATE)');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec(`INSERT INTO messages VALUES ('m2', 'c1', 'outgoing', 1700000001000, 1700000001000, 'wal-only')`);
  return { src, key, writer, checkpoint };
}

function messageIds(db) {
  return db.prepare('SELECT id FROM messages ORDER BY rowid').all().map(({ id }) => id);
}

describe('withConsistentSnapshot', () => {
  it('ingests the checkpointed row and the committed WAL-only row without modifying the source', async () => {
    const dir = scratch();
    const { src, key, writer } = buildLiveWal(dir);
    const wal = `${src}-wal`;
    expect(existsSync(wal)).toBe(true);
    expect(statSync(wal).size).toBeGreaterThan(32);

    const mainOnly = join(dir, 'main-only.sqlite');
    copyFileSync(src, mainOnly);
    const stale = new Database(mainOnly, { readonly: true, fileMustExist: true });
    applyKey(stale, key);
    const staleIds = messageIds(stale);
    const staleIntegrity = stale.pragma('integrity_check');
    stale.close();
    expect(staleIds).toEqual(['m1']);
    expect(staleIntegrity).toEqual([{ integrity_check: 'ok' }]);

    const before = { db: digest(src), wal: digest(wal), files: readdirSync(dir) };
    try {
      const snap = await withConsistentSnapshot(src, key, messageIds);
      expect(snap.ok, snap.error).toBe(true);
      expect(snap.value).toEqual(['m1', 'm2']);
      expect(readdirSync(dir)).toEqual(before.files);
      expect(digest(src)).toBe(before.db);
      expect(digest(wal)).toBe(before.wal);
    } finally {
      writer.close();
    }
  });

  it('keeps the original committed view while a writer commits and checkpoints', async () => {
    const dir = scratch();
    const { src, key, writer } = buildLiveWal(dir);
    try {
      const snap = await withConsistentSnapshot(src, key, messageIds, {
        onReadLocked() {
          writer.exec("INSERT INTO messages (id, body) VALUES ('m3', 'after-reader')");
          expect(writer.pragma('wal_checkpoint(RESTART)')).toEqual([expect.objectContaining({ busy: 1 })]);
        },
      });
      expect(snap).toEqual({ ok: true, value: ['m1', 'm2'] });
      expect(writer.pragma('wal_checkpoint(RESTART)')).toEqual([expect.objectContaining({ busy: 0 })]);
      expect(await withConsistentSnapshot(src, key, messageIds)).toEqual({
        ok: true, value: ['m1', 'm2', 'm3'],
      });
    } finally {
      writer.close();
    }
  });

  it('keeps source rowids after a delete so a newer WAL row stays above an old cursor', async () => {
    const dir = scratch();
    const src = join(dir, 'db.sqlite');
    const key = randomBytes(32).toString('hex');
    const writer = new Database(src);
    applyKey(writer, key);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec(`
      CREATE TABLE messages (id TEXT, body TEXT);
      INSERT INTO messages(rowid, id, body) VALUES (1, 'm1', 'old'), (2, 'm2', 'kept');
    `);
    writer.pragma('wal_checkpoint(TRUNCATE)');
    writer.exec(`
      DELETE FROM messages WHERE id = 'm1';
      INSERT INTO messages(rowid, id, body) VALUES (4, 'm4', 'wal-only');
    `);
    try {
      const snap = await withConsistentSnapshot(src, key, (db) =>
        db.prepare('SELECT rowid, id FROM messages WHERE rowid > ? ORDER BY rowid').all(1),
      );
      expect(snap).toEqual({
        ok: true,
        value: [
          { rowid: 2, id: 'm2' },
          { rowid: 4, id: 'm4' },
        ],
      });
    } finally {
      writer.close();
    }
  });

  it('reports setup failure when the driver package cannot load', async () => {
    const dir = scratch();
    const result = await withConsistentSnapshot(join(dir, 'missing.sqlite'), 'ab'.repeat(32), messageIds, {
      loadDriver() {
        throw new Error('no prebuild for this platform');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('setup');
    expect(result.remediation).toContain(SQLCIPHER_DRIVER_PACKAGE);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('redacts the home directory from missing database errors', async () => {
    const sourcePath = join(homedir(), 'Library', 'Application Support', 'Signal', 'missing.sqlite');
    const result = await withConsistentSnapshot(sourcePath, 'ab'.repeat(32), messageIds);
    expect(result.error).toContain('~/Library/Application Support/Signal/missing.sqlite');
    expect(result.error).not.toContain(homedir());
  });

  it('reports setup failure when opening the connection cannot load the native prebuild', async () => {
    const dir = scratch();
    const { src, key, writer } = buildLiveWal(dir);
    try {
      const result = await withConsistentSnapshot(src, key, messageIds, {
        loadDriver: () => function unavailableDriver() {
          throw Object.assign(new Error('no prebuild for this platform'), { code: 'MODULE_NOT_FOUND' });
        },
      });
      expect(result).toMatchObject({ ok: false, reason: 'setup' });
      expect(result.remediation).toContain(SQLCIPHER_DRIVER_PACKAGE);
    } finally {
      writer.close();
    }
  });

  it('closes the reader and releases the WAL lock after a read failure', async () => {
    const dir = scratch();
    const { src, key, writer } = buildLiveWal(dir);
    let reader;
    try {
      const result = await withConsistentSnapshot(src, key, (db) => {
        reader = db;
        return db.prepare('SELECT absent FROM messages').all();
      });
      expect(result).toMatchObject({ ok: false, reason: 'snapshot' });
      expect(reader.open).toBe(false);
      expect(writer.pragma('wal_checkpoint(RESTART)')).toEqual([expect.objectContaining({ busy: 0 })]);
    } finally {
      writer.close();
    }
  });

  it('rejects a bad key without leaving a temp copy or changing the source', async () => {
    const dir = scratch();
    const { src, writer } = buildLiveWal(dir);
    const wal = `${src}-wal`;
    const before = { db: digest(src), wal: digest(wal), files: readdirSync(dir) };
    try {
      const result = await withConsistentSnapshot(src, 'cd'.repeat(32), messageIds);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('auth');
      expect(digest(src)).toBe(before.db);
      expect(digest(wal)).toBe(before.wal);
      expect(readdirSync(dir)).toEqual(before.files);
    } finally {
      writer.close();
    }
  });
});
