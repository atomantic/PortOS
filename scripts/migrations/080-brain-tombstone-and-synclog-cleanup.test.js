import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { computeBrainCleanup } from './080-brain-tombstone-and-synclog-cleanup.js';

let rootDir;
let brainDir;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-080-'));
  brainDir = join(rootDir, 'data', 'brain');
  mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function writeLog(entries) {
  writeFileSync(join(brainDir, 'sync_log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}
function writeStore(type, records) {
  writeFileSync(join(brainDir, `${type}.json`), JSON.stringify({ records }, null, 2));
}
function readStore(type) {
  return JSON.parse(readFileSync(join(brainDir, `${type}.json`), 'utf-8'));
}
function readLogLines() {
  const p = join(brainDir, 'sync_log.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('migration 080 — brain tombstone + sync-log cleanup', () => {
  it('no-ops when there is no sync log', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
  });

  it('converts a ghost (live record with a newer matching delete) into a tombstone', async () => {
    // The links record is live, but the log shows it was deleted AFTER its create.
    writeStore('links', {
      'ghost-1': { url: 'https://x', updatedAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'peer-a' },
    });
    writeLog([
      { seq: 1, op: 'create', type: 'links', id: 'ghost-1', record: { url: 'https://x', updatedAt: '2026-01-01T00:00:00.000Z' }, originInstanceId: 'peer-a' },
      { seq: 2, op: 'delete', type: 'links', id: 'ghost-1', record: { updatedAt: '2026-01-02T00:00:00.000Z' }, originInstanceId: 'peer-a' },
    ]);

    await migration.up({ rootDir });

    const rec = readStore('links').records['ghost-1'];
    expect(rec._deleted).toBe(true);
    expect(rec.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    // deletedAt must equal updatedAt (the delete instant), matching the runtime
    // makeTombstone invariant — NOT the migration's own run time. Otherwise two
    // peers running the cleanup independently stamp different deletedAt values.
    expect(rec.deletedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('leaves a live record whose delete is OLDER than the record (legit re-create) alone', async () => {
    writeStore('people', {
      'p1': { name: 'Alice', updatedAt: '2026-02-01T00:00:00.000Z', originInstanceId: 'peer-a' },
    });
    writeLog([
      { seq: 1, op: 'delete', type: 'people', id: 'p1', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 2, op: 'create', type: 'people', id: 'p1', record: { name: 'Alice', updatedAt: '2026-02-01T00:00:00.000Z' } },
    ]);

    await migration.up({ rootDir });

    expect(readStore('people').records['p1']).toMatchObject({ name: 'Alice', updatedAt: '2026-02-01T00:00:00.000Z' });
    expect(readStore('people').records['p1']._deleted).toBeUndefined();
  });

  it('compacts the sync log to one terminal entry per (type,id) and preserves max seq', async () => {
    writeLog([
      { seq: 1, op: 'create', type: 'links', id: 'a', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 2, op: 'delete', type: 'links', id: 'a', record: { updatedAt: '2026-01-02T00:00:00.000Z' } },
      { seq: 3, op: 'create', type: 'links', id: 'a', record: { updatedAt: '2026-01-03T00:00:00.000Z' } },
      { seq: 4, op: 'create', type: 'people', id: 'b', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 5, op: 'delete', type: 'people', id: 'b', record: { updatedAt: '2026-01-05T00:00:00.000Z' } },
    ]);

    await migration.up({ rootDir });

    const lines = readLogLines();
    expect(lines).toHaveLength(2); // one terminal per (links/a) and (people/b)
    const maxSeq = Math.max(...lines.map((l) => l.seq));
    expect(maxSeq).toBe(5); // peer cursors stay valid — NOT renumbered to 0
    // Terminal entries are the last per key
    expect(lines.find((l) => l.id === 'a').seq).toBe(3);
    expect(lines.find((l) => l.id === 'b').seq).toBe(5);
  });

  it('keeps the DELETE as the terminal entry when a stale create has the highest seq (LWW, not seq-max)', async () => {
    // The ping-pong: original create (older updatedAt), the winning delete
    // (newest updatedAt), then a stale echoed create that re-uses the OLD
    // updatedAt but lands at the highest SEQ. A fresh peer must pull the delete,
    // not the stale create, or the record resurrects.
    writeLog([
      { seq: 1, op: 'create', type: 'links', id: 'x', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 2, op: 'delete', type: 'links', id: 'x', record: { updatedAt: '2026-01-02T00:00:00.000Z' } },
      { seq: 99, op: 'create', type: 'links', id: 'x', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
    ]);

    await migration.up({ rootDir });

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    const terminal = lines[0];
    expect(terminal.op).toBe('delete'); // LWW winner, NOT the seq-99 stale create
    expect(terminal.record.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(terminal.seq).toBe(99); // max seq preserved by stamping the winner
  });

  it('keeps the record LIVE when a create and an equal-timestamp delete replay to live (matches runtime LWW)', async () => {
    // Runtime applyRemoteRecord rejects a delete when existing.updatedAt >=
    // delete.updatedAt. So create@T then delete@T (same timestamp, delete later
    // in seq) leaves the record LIVE — the delete is rejected. The compacted log
    // must therefore keep the CREATE as terminal, not the delete; otherwise a
    // fresh peer would tombstone a record the runtime keeps alive.
    writeLog([
      { seq: 1, op: 'create', type: 'links', id: 'eq', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 2, op: 'delete', type: 'links', id: 'eq', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
    ]);

    await migration.up({ rootDir });

    const lines = readLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].op).toBe('create'); // incumbent wins the tie — record stays live
    expect(lines[0].seq).toBe(2); // max seq preserved by stamping the survivor
  });

  it('is idempotent — a second run is a no-op', async () => {
    writeStore('links', {
      'ghost-1': { url: 'https://x', updatedAt: '2026-01-01T00:00:00.000Z', originInstanceId: 'peer-a' },
    });
    writeLog([
      { seq: 1, op: 'create', type: 'links', id: 'ghost-1', record: { url: 'https://x', updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 2, op: 'delete', type: 'links', id: 'ghost-1', record: { updatedAt: '2026-01-02T00:00:00.000Z' } },
    ]);

    await migration.up({ rootDir });
    const storeAfter1 = readStore('links');
    const logAfter1 = readLogLines();

    await migration.up({ rootDir });
    expect(readStore('links')).toEqual(storeAfter1);
    expect(readLogLines()).toEqual(logAfter1);
  });

  it('computeBrainCleanup preserves the global max seq as a terminal entry', () => {
    const log = [
      { seq: 10, op: 'create', type: 'links', id: 'a', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 99, op: 'delete', type: 'links', id: 'a', record: { updatedAt: '2026-01-02T00:00:00.000Z' } },
    ];
    const { compactedLines } = computeBrainCleanup(log, {});
    const seqs = compactedLines.map((l) => JSON.parse(l).seq);
    expect(Math.max(...seqs)).toBe(99);
  });

  it('preserves max seq even when the highest-seq entry lacks type/id', () => {
    const log = [
      { seq: 10, op: 'create', type: 'links', id: 'a', record: { updatedAt: '2026-01-01T00:00:00.000Z' } },
      { seq: 200 }, // a malformed/typeless high-seq entry — must still anchor the cursor
    ];
    const { compactedLines } = computeBrainCleanup(log, {});
    const seqs = compactedLines.map((l) => JSON.parse(l).seq);
    expect(Math.max(...seqs)).toBe(200);
  });
});
