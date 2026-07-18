/**
 * Regression tests for runSync's cursor/persistence contract (#2151 review):
 *
 * - A persistence failure must NOT advance the ROWID cursor — skipping past
 *   unpersisted messages loses them permanently (the cursor never revisits a
 *   ROWID), while re-processing is a harmless no-op thanks to dedupe keys.
 * - Concurrent callers share one in-flight pass (re-entrancy guard).
 * - checkSetup distinguishes "chat.db doesn't exist" (ENOENT) from a real
 *   Full Disk Access denial — the FDA remediation can't help a Linux install.
 *
 * Uses a fixture chat.db built with the real Messages schema — no dependency
 * on ~/Library/Messages or Full Disk Access.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'path';
import { rmSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';

const { recordEventsMock, autoLogTouchpointsMock } = vi.hoisted(() => ({
  recordEventsMock: vi.fn(),
  autoLogTouchpointsMock: vi.fn(),
}));

const dataRoot = vi.hoisted(() => {
  // Inline mkdtemp to avoid importing helpers inside the hoisted block.
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join: joinPath } = require('path');
  return mkdtempSync(joinPath(tmpdir(), 'imessage-sync-test-'));
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { join: joinPath } = await import('path');
  return {
    ...actual,
    // imessageSync persists its cursor via dataPath(STATE_FILE) — redirect it
    // at the export level (proxying PATHS alone wouldn't reach the internal
    // binding dataPath closes over).
    dataPath: (...segments) => joinPath(dataRoot, ...segments),
  };
});

vi.mock('./humanActivity.js', async () => {
  const actual = await vi.importActual('./humanActivity.js');
  return { ...actual, recordEvents: recordEventsMock };
});

vi.mock('./tribe.js', () => ({
  autoLogTouchpoints: autoLogTouchpointsMock,
}));

import { runSync, checkSetup } from './imessageSync.js';

const APPLE_EPOCH_OFFSET_MS = 978307200000;
const FIXTURE_DB = join(dataRoot, 'fixture-chat.db');

function appleNs(utcMs) {
  return String(Math.round((utcMs - APPLE_EPOCH_OFFSET_MS) / 1000) * 1e9);
}

beforeAll(() => {
  const db = new DatabaseSync(FIXTURE_DB);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, date INTEGER, text TEXT, attributedBody BLOB, is_from_me INTEGER, service TEXT, handle_id INTEGER, associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  db.exec(`INSERT INTO handle VALUES (1,'+15551234567')`);
  db.exec(`INSERT INTO chat VALUES (1,'iMessage;-;+15551234567','+15551234567','Grace')`);
  db.exec(`INSERT INTO chat_handle_join VALUES (1,1)`);
  const insert = db.prepare('INSERT INTO message (ROWID,guid,date,text,is_from_me,service,handle_id) VALUES (?,?,?,?,?,?,?)');
  insert.run(10, 'G-10', appleNs(Date.UTC(2024, 2, 10, 15, 0, 0)), 'hey there', 0, 'iMessage', 1);
  insert.run(11, 'G-11', appleNs(Date.UTC(2024, 2, 10, 15, 1, 0)), 'reply', 1, 'iMessage', 0);
  db.exec('INSERT INTO chat_message_join VALUES (1,10),(1,11)');
  db.close();
  process.env.IMESSAGE_CHAT_DB = FIXTURE_DB;
});

afterAll(() => {
  delete process.env.IMESSAGE_CHAT_DB;
  rmSync(dataRoot, { recursive: true, force: true });
});

beforeEach(() => {
  recordEventsMock.mockReset();
  autoLogTouchpointsMock.mockReset();
  // Fresh cursor per test — remove the persisted state file.
  rmSync(join(dataRoot, 'imessage-sync-state.json'), { force: true });
});

describe('runSync cursor/persistence contract', () => {
  it('holds the cursor when persistence fails, then advances on the successful retry', async () => {
    recordEventsMock.mockRejectedValueOnce(new Error('pg down'));
    autoLogTouchpointsMock.mockResolvedValue({ created: 0, matched: 0 });

    const failed = await runSync();
    expect(failed.ok).toBe(false);
    expect(failed.cursorRowid).toBe(0); // held at the pre-pass cursor, not 11
    expect(failed.scanned).toBe(2);

    // Retry with persistence healthy — the SAME batch is re-read (cursor held)
    // and the cursor now advances to the max ROWID.
    recordEventsMock.mockResolvedValue({ recorded: 2, skipped: 0 });
    const ok = await runSync();
    expect(ok.ok).toBe(true);
    expect(ok.scanned).toBe(2); // re-scanned the held batch — nothing was lost
    expect(ok.cursorRowid).toBe(11);
    expect(ok.hasMore).toBe(false);
  });

  it('advances the cursor and reports counts on a clean pass', async () => {
    recordEventsMock.mockResolvedValue({ recorded: 2, skipped: 0 });
    autoLogTouchpointsMock.mockResolvedValue({ created: 1, matched: 1 });

    const result = await runSync();
    expect(result.ok).toBe(true);
    expect(result.cursorRowid).toBe(11);
    expect(result.recorded).toBe(2);
    expect(result.touchpointsCreated).toBe(1);

    // Incremental: a second pass starts past ROWID 11 and finds nothing.
    const second = await runSync();
    expect(second.scanned).toBe(0);
    expect(second.cursorRowid).toBe(11);
  });

  it('shares one in-flight pass across concurrent callers (re-entrancy guard)', async () => {
    let release;
    recordEventsMock.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ recorded: 2, skipped: 0 });
    }));
    autoLogTouchpointsMock.mockResolvedValue({ created: 0, matched: 0 });

    const first = runSync();
    const second = runSync(); // while the first is still awaiting persistence
    // Give the first call time to reach the pending recordEvents await.
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b); // same result object — the pass ran once
    expect(recordEventsMock).toHaveBeenCalledTimes(1);
  });
});

describe('checkSetup error classification', () => {
  it('does NOT claim Full Disk Access for a nonexistent chat.db (ENOENT)', async () => {
    const prev = process.env.IMESSAGE_CHAT_DB;
    process.env.IMESSAGE_CHAT_DB = join(dataRoot, 'does-not-exist', 'chat.db');
    const report = await checkSetup();
    process.env.IMESSAGE_CHAT_DB = prev;
    expect(report.ok).toBe(false);
    expect(report.fullDiskAccessRequired).toBe(false);
    expect(report.remediation).not.toContain('Full Disk Access');
  });

  it('reports ok with a message count for a readable chat.db', async () => {
    const report = await checkSetup();
    expect(report.ok).toBe(true);
    expect(report.messageCount).toBe(2);
  });
});
