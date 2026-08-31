import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

// The suite runs against a REAL temp data dir rather than a mocked `readFile`,
// because the sync log is now served through a seq → byte-offset index: the
// offsets are only meaningful against real bytes on disk (#5441).
//
// The temp dir is allocated lazily on first PATHS read — brainSyncLog captures
// PATHS.brain at import time, before any top-level test assignment would run.
// `var` + a function declaration are hoisted (no TDZ), so the hoisted vi.mock
// factory can reference them safely.
var tempRoot; // eslint-disable-line no-var
function getTempRoot() {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'brainsynclog-test-'));
  return tempRoot;
}

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const proxy = makePathsProxy(actual, { dataRoot: () => getTempRoot() });
  return {
    ...proxy,
    atomicWrite: vi.fn(actual.atomicWrite)
  };
});

// Spy on createReadStream so the tests can assert WHICH bytes were read — that
// is the whole point of the index, and it is invisible from the return value.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

// appendFile is spied (not stubbed) so the one-write-per-batch contract stays
// assertable while the bytes still land on disk for the offset assertions.
vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

import { createReadStream } from 'fs';
import { appendFile } from 'fs/promises';
import { atomicWrite } from '../lib/fileUtils.js';
import {
  initSyncLog,
  getCurrentSeq,
  appendChange,
  appendChanges,
  getChangesSince,
  compactLog
} from './brainSyncLog.js';

const syncLogPath = () => join(getTempRoot(), 'brain', 'sync_log.jsonl');

/**
 * Byte offset at which line n+1 starts, found by locating newlines in the raw
 * bytes. Deliberately NOT `Buffer.byteLength(line) + 1` summing: that is the
 * production arithmetic, so it could not catch a shared miscount.
 */
const lineOffset = (n) => {
  const buf = readFileSync(syncLogPath());
  let at = -1;
  for (let i = 0; i < n; i++) at = buf.indexOf(0x0a, at + 1);
  return at + 1;
};

/** `start` passed to the most recent createReadStream call. */
const lastReadStart = () => {
  const calls = createReadStream.mock.calls;
  return calls[calls.length - 1]?.[1]?.start;
};

const writeLog = (content) => {
  mkdirSync(join(getTempRoot(), 'brain'), { recursive: true });
  writeFileSync(syncLogPath(), content);
};

afterAll(() => { if (tempRoot) rmSync(tempRoot, { recursive: true, force: true }); });

describe('brainSyncLog', () => {
  beforeEach(async () => {
    rmSync(syncLogPath(), { force: true });
    await initSyncLog();
    vi.clearAllMocks();
  });

  describe('getCurrentSeq', () => {
    it('returns 0 for a fresh log', () => {
      expect(getCurrentSeq()).toBe(0);
    });
  });

  describe('initSyncLog', () => {
    it('sets seq to 0 when file does not exist', async () => {
      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });

    it('parses last line for seq', async () => {
      writeLog(
        '{"seq":1,"op":"create","type":"people","id":"a"}\n{"seq":5,"op":"update","type":"ideas","id":"b"}\n'
      );

      await initSyncLog();
      expect(getCurrentSeq()).toBe(5);
    });

    it('handles empty file content', async () => {
      writeLog('   \n  \n');

      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });

    it('handles malformed last line gracefully', async () => {
      writeLog('not-json\n');

      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });

    it('recovers the last complete seq when the file ends in a partial line', async () => {
      // A crash mid-append leaves an unterminated tail; boot must still report
      // the last entry that was fully written.
      writeLog('{"seq":1,"op":"create"}\n{"seq":2,"op":"update"}\n{"seq":3,"op":"del');

      await initSyncLog();
      expect(getCurrentSeq()).toBe(2);
    });

    it('appends after an unterminated tail without reusing its byte range', async () => {
      writeLog('{"seq":1,"op":"create"}\n{"seq":2,"op":"upd');
      await initSyncLog();

      // seq 2 was never fully written, so it is not indexed and not reserved.
      const entry = await appendChange('create', 'people', 'p1', { name: 'Alice' }, 'inst-1');
      expect(entry.seq).toBe(2);

      vi.clearAllMocks();
      const result = await getChangesSince(1);
      expect(result.changes.map(c => c.seq)).toEqual([2]);
      expect(result.changes[0].record).toEqual({ name: 'Alice' });

      // …and the entry must survive a restart. If the append had been
      // concatenated onto the fragment, the merged line would not parse and
      // seq 2 would be re-minted for a different record on the next write.
      await initSyncLog();
      expect(getCurrentSeq()).toBe(2);
      const afterRestart = await getChangesSince(1);
      expect(afterRestart.changes.map(c => c.seq)).toEqual([2]);
      expect(afterRestart.changes[0].record).toEqual({ name: 'Alice' });
    });
  });

  describe('appendChange', () => {
    it('increments seq monotonically', async () => {
      const e1 = await appendChange('create', 'people', 'id1', { name: 'Alice' }, 'inst-1');
      const e2 = await appendChange('update', 'people', 'id1', { name: 'Bob' }, 'inst-1');

      expect(e1.seq).toBe(1);
      expect(e2.seq).toBe(2);
    });

    it('returns correct entry shape', async () => {
      const entry = await appendChange('create', 'ideas', 'id-42', { title: 'Idea' }, 'inst-abc');

      expect(entry).toMatchObject({
        seq: expect.any(Number),
        op: 'create',
        type: 'ideas',
        id: 'id-42',
        record: { title: 'Idea' },
        originInstanceId: 'inst-abc',
        ts: expect.any(String)
      });
    });

    it('appends JSON line to file', async () => {
      await appendChange('delete', 'projects', 'p-1', null, 'inst-1');

      const written = readFileSync(syncLogPath(), 'utf8');
      expect(written.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(written.trim());
      expect(parsed.op).toBe('delete');
    });
  });

  describe('appendChanges', () => {
    it('increments seq across all entries in the batch', async () => {
      const entries = await appendChanges([
        { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'inst-1' },
        { op: 'update', type: 'ideas', id: 'i1', record: { title: 'B' }, originInstanceId: 'inst-1' },
        { op: 'delete', type: 'projects', id: 'pr1', record: null, originInstanceId: 'inst-2' }
      ]);

      expect(entries).toHaveLength(3);
      expect(entries[0].seq).toBe(1);
      expect(entries[1].seq).toBe(2);
      expect(entries[2].seq).toBe(3);
      expect(getCurrentSeq()).toBe(3);
    });

    it('makes a single appendFile call for the entire batch', async () => {
      await appendChanges([
        { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'inst-1' },
        { op: 'update', type: 'people', id: 'p2', record: { name: 'B' }, originInstanceId: 'inst-1' }
      ]);

      expect(appendFile).toHaveBeenCalledTimes(1);
    });

    it('writes newline-separated JSON entries ending with newline', async () => {
      await appendChanges([
        { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'inst-1' },
        { op: 'delete', type: 'ideas', id: 'i1', record: null, originInstanceId: 'inst-2' }
      ]);

      const written = readFileSync(syncLogPath(), 'utf8');
      expect(written.endsWith('\n')).toBe(true);
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).op).toBe('create');
      expect(JSON.parse(lines[1]).op).toBe('delete');
    });

    it('returns empty array for empty input', async () => {
      const entries = await appendChanges([]);

      expect(entries).toEqual([]);
      expect(getCurrentSeq()).toBe(0);
      expect(appendFile).not.toHaveBeenCalled();
    });

    it('returns entries with correct shape', async () => {
      const entries = await appendChanges([
        { op: 'create', type: 'links', id: 'l1', record: { url: 'http://example.com' }, originInstanceId: 'peer-3' }
      ]);

      expect(entries[0]).toMatchObject({
        seq: expect.any(Number),
        op: 'create',
        type: 'links',
        id: 'l1',
        record: { url: 'http://example.com' },
        originInstanceId: 'peer-3',
        ts: expect.any(String)
      });
    });
  });

  describe('getChangesSince', () => {
    it('filters entries by sinceSeq', async () => {
      writeLog(
        ['{"seq":1,"op":"create"}', '{"seq":2,"op":"update"}', '{"seq":3,"op":"delete"}'].join('\n') + '\n'
      );
      await initSyncLog();

      const result = await getChangesSince(1);
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0].seq).toBe(2);
      expect(result.changes[1].seq).toBe(3);
    });

    it('respects limit parameter', async () => {
      writeLog(
        Array.from({ length: 10 }, (_, i) => JSON.stringify({ seq: i + 1, op: 'create' })).join('\n') + '\n'
      );
      await initSyncLog();

      const result = await getChangesSince(0, 3);
      expect(result.changes).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it('sets hasMore=false when all changes returned', async () => {
      writeLog('{"seq":1,"op":"create"}\n{"seq":2,"op":"update"}\n');
      await initSyncLog();

      const result = await getChangesSince(0, 100);
      expect(result.changes).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it('returns empty when file does not exist', async () => {
      const result = await getChangesSince(0);
      expect(result.changes).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('returns maxSeq from last returned change', async () => {
      writeLog('{"seq":5,"op":"create"}\n{"seq":10,"op":"update"}\n');
      await initSyncLog();

      const result = await getChangesSince(0, 1);
      expect(result.maxSeq).toBe(5);
    });

    it('reads only from the first entry after sinceSeq, never the head of the file', async () => {
      for (let i = 0; i < 6; i++) {
        await appendChange('create', 'people', `p${i}`, { name: `Person ${i}` }, 'inst-1');
      }
      const expectedStart = lineOffset(4);

      vi.clearAllMocks();
      const result = await getChangesSince(4);

      expect(result.changes.map(c => c.seq)).toEqual([5, 6]);
      expect(createReadStream).toHaveBeenCalledTimes(1);
      expect(lastReadStart()).toBe(expectedStart);
      expect(expectedStart).toBeGreaterThan(0);
    });

    it('does not read the file at all when nothing is newer than sinceSeq', async () => {
      await appendChange('create', 'people', 'p1', { name: 'Alice' }, 'inst-1');

      vi.clearAllMocks();
      const result = await getChangesSince(1);

      expect(result).toEqual({ changes: [], maxSeq: 1, hasMore: false });
      expect(createReadStream).not.toHaveBeenCalled();
    });

    it('keeps offsets correct across multi-byte UTF-8 records', async () => {
      await appendChange('create', 'captures', 'c1', { capturedText: '🧠 first — naïve' }, 'inst-1');
      await appendChange('create', 'captures', 'c2', { capturedText: '🚀 second — résumé' }, 'inst-1');
      await appendChange('create', 'captures', 'c3', { capturedText: '🎯 third' }, 'inst-1');
      const expectedStart = lineOffset(1);

      vi.clearAllMocks();
      const result = await getChangesSince(1);

      expect(lastReadStart()).toBe(expectedStart);
      expect(result.changes.map(c => c.seq)).toEqual([2, 3]);
      expect(result.changes[0].record.capturedText).toBe('🚀 second — résumé');
      expect(result.changes[1].record.capturedText).toBe('🎯 third');
    });

    it('serves entries appended after the index was built', async () => {
      await appendChanges([
        { op: 'create', type: 'people', id: 'p1', record: { name: 'A' }, originInstanceId: 'inst-1' },
        { op: 'create', type: 'people', id: 'p2', record: { name: 'B' }, originInstanceId: 'inst-1' }
      ]);
      await appendChange('update', 'people', 'p2', { name: 'B2' }, 'inst-1');
      const expectedStart = lineOffset(2);

      vi.clearAllMocks();
      const result = await getChangesSince(2);

      expect(lastReadStart()).toBe(expectedStart);
      expect(result.changes.map(c => c.seq)).toEqual([3]);
      expect(result.maxSeq).toBe(3);
      expect(result.hasMore).toBe(false);
    });

    it('serializes concurrent appends so seqs and offsets stay consistent', async () => {
      const appended = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          appendChange('create', 'people', `p${i}`, { name: `Person ${i}` }, 'inst-1')
        )
      );

      expect(appended.map(e => e.seq).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);

      vi.clearAllMocks();
      const all = await getChangesSince(0);
      expect(all.changes.map(c => c.seq)).toEqual([1, 2, 3, 4, 5]);

      // Every indexed offset must land exactly on its line's first byte.
      for (let n = 0; n < 5; n++) {
        vi.clearAllMocks();
        const window = await getChangesSince(n);
        expect(lastReadStart()).toBe(lineOffset(n));
        expect(window.changes[0].seq).toBe(n + 1);
      }
    });
  });

  describe('compactLog', () => {
    it('drops entries below minSeq', async () => {
      writeLog('{"seq":1,"op":"create"}\n{"seq":2,"op":"update"}\n{"seq":3,"op":"delete"}\n');
      await initSyncLog();

      const dropped = await compactLog(2);
      expect(dropped).toBe(1);
      const written = readFileSync(syncLogPath(), 'utf8');
      expect(written).toContain('"seq":2');
      expect(written).toContain('"seq":3');
      expect(written).not.toContain('"seq":1,');
    });

    it('returns 0 when file does not exist', async () => {
      const dropped = await compactLog(5);
      expect(dropped).toBe(0);
    });

    it('serves reads from the rebuilt index immediately after compaction', async () => {
      await appendChange('create', 'people', 'p0', { name: 'Person 0 v1' }, 'inst-1');
      await appendChange('update', 'people', 'p0', { name: 'Person 0 v2' }, 'inst-1');
      await appendChange('update', 'people', 'p0', { name: 'Person 0 v3' }, 'inst-1');
      await appendChange('create', 'people', 'p1', { name: 'Person 1' }, 'inst-1');
      await appendChange('create', 'people', 'p2', { name: 'Person 2' }, 'inst-1');

      expect(await compactLog(3)).toBe(2);

      vi.clearAllMocks();
      const fromZero = await getChangesSince(0);
      expect(fromZero.changes.map(c => c.seq)).toEqual([3, 4, 5]);
      expect(lastReadStart()).toBe(0);

      vi.clearAllMocks();
      const fromThree = await getChangesSince(3);
      expect(fromThree.changes.map(c => c.seq)).toEqual([4, 5]);
      expect(lastReadStart()).toBe(lineOffset(1));
    });

    it('keeps a retained line with no seq out of the index', async () => {
      // A seq-less line is retained in the file (it is not below minSeq), but
      // indexing it would put a non-number into the ascending seq array and
      // break the binary search — hiding every earlier entry from peers.
      writeLog('{"seq":1,"op":"create"}\n{"note":"no seq"}\n{"seq":3,"op":"delete"}\n');
      await initSyncLog();

      expect(await compactLog(0)).toBe(0);

      expect((await getChangesSince(0)).changes.map(c => c.seq)).toEqual([1, 3]);
      expect((await getChangesSince(1)).changes.map(c => c.seq)).toEqual([3]);
    });

    it('keeps appending at the right offset after compaction', async () => {
      await appendChange('create', 'people', 'p0', { name: 'Person 0 v1' }, 'inst-1');
      await appendChange('update', 'people', 'p0', { name: 'Person 0 v2' }, 'inst-1');
      await appendChange('create', 'people', 'p1', { name: 'Person 1' }, 'inst-1');
      await appendChange('create', 'people', 'p2', { name: 'Person 2' }, 'inst-1');
      await compactLog(3);
      await appendChange('create', 'people', 'p3', { name: 'Person 3' }, 'inst-1');

      vi.clearAllMocks();
      const result = await getChangesSince(4);
      expect(lastReadStart()).toBe(lineOffset(2));
      expect(result.changes.map(c => c.seq)).toEqual([5]);
    });

    it('prunes intermediate update churn to terminal survivors and preserves max seq on installs with no peers (#5439)', async () => {
      await appendChange('create', 'people', 'p0', { name: 'Person 0 v1', updatedAt: '2026-01-01T00:00:00.000Z' }, 'inst-1');
      await appendChange('update', 'people', 'p0', { name: 'Person 0 v2', updatedAt: '2026-01-02T00:00:00.000Z' }, 'inst-1');
      await appendChange('update', 'people', 'p0', { name: 'Person 0 v3', updatedAt: '2026-01-03T00:00:00.000Z' }, 'inst-1');
      await appendChange('create', 'people', 'p1', { name: 'Person 1', updatedAt: '2026-01-01T00:00:00.000Z' }, 'inst-1');
      await appendChange('delete', 'people', 'p1', { updatedAt: '2026-01-04T00:00:00.000Z' }, 'inst-1');
      await appendChange('create', 'people', 'p2', { name: 'Person 2', updatedAt: '2026-01-05T00:00:00.000Z' }, 'inst-1');
      expect(getCurrentSeq()).toBe(6);

      // Compact with floor 0 (compatibility-preserving compaction representation)
      const dropped = await compactLog(0);
      expect(dropped).toBe(3); // 2 intermediate p0 updates + 1 p1 create superseded by delete

      // Verify file on disk contains the 3 terminal survivors
      const lines = readFileSync(syncLogPath(), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3);
      const parsed = lines.map(l => JSON.parse(l));
      expect(parsed.map(p => ({ id: p.id, op: p.op }))).toEqual([
        { id: 'p0', op: 'update' },
        { id: 'p1', op: 'delete' },
        { id: 'p2', op: 'create' }
      ]);
      expect(parsed.map(p => p.seq)).toEqual([3, 5, 6]);

      // All active entities are available for delta pulls (e.g. pre-#1077 / fresh peers)
      const deltaResult = await getChangesSince(0);
      expect(deltaResult.changes).toHaveLength(3);

      // Simulate restart: re-initialize the log
      await initSyncLog();
      expect(getCurrentSeq()).toBe(6);

      // Subsequent appends continue monotonic sequence numbers
      const nextEntry = await appendChange('create', 'people', 'p3', { name: 'Person 3' }, 'inst-1');
      expect(nextEntry.seq).toBe(7);
      expect(getCurrentSeq()).toBe(7);
    });

    it('returns 0 and does not call atomicWrite when no entries are dropped (#5439)', async () => {
      for (let i = 0; i < 3; i++) {
        await appendChange('create', 'people', `p${i}`, { name: `Person ${i}`, updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }, 'inst-1');
      }
      atomicWrite.mockClear();

      // Calling compactLog with minSeq <= 1 drops nothing
      const dropped = await compactLog(1);
      expect(dropped).toBe(0);
      expect(atomicWrite).not.toHaveBeenCalled();
    });

    it('determines compaction floor strictly under mutex from durable state after a failed append', async () => {
      for (let i = 0; i < 3; i++) {
        await appendChange('create', 'people', `p${i}`, { name: `Person ${i}`, updatedAt: `2026-01-0${i + 1}T00:00:00.000Z` }, 'inst-1');
      }
      expect(getCurrentSeq()).toBe(3);

      // Simulate appendFile disk failure during appendChange
      appendFile.mockRejectedValueOnce(new Error('Disk I/O error'));
      await expect(appendChange('create', 'people', 'p3', { name: 'Person 3' }, 'inst-1')).rejects.toThrow('Disk I/O error');

      // In-memory currentSeq was reserved/incremented to 4, but disk holds up to seq 3
      expect(getCurrentSeq()).toBe(4);

      // Compacting under mutex re-syncs durable state from disk and does NOT wipe the log
      const dropped = await compactLog(4);
      expect(dropped).toBe(0);

      // All 3 durable entries on disk remain intact
      const lines = readFileSync(syncLogPath(), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(getCurrentSeq()).toBe(3);

      // Sequence recovery across restart recovers the durable seq 3
      await initSyncLog();
      expect(getCurrentSeq()).toBe(3);
      const next = await appendChange('create', 'people', 'p3', { name: 'Person 3' }, 'inst-1');
      expect(next.seq).toBe(4);
    });

    it('replays LWW rules correctly in terminal compaction', async () => {
      writeLog(
        '{"seq":1,"op":"create","type":"links","id":"x","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n' +
        '{"seq":2,"op":"delete","type":"links","id":"x","record":{"updatedAt":"2026-01-02T00:00:00.000Z"}}\n' +
        '{"seq":99,"op":"create","type":"links","id":"x","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n'
      );
      await initSyncLog();
      expect(await compactLog(0)).toBe(2);

      const lines = readFileSync(syncLogPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].op).toBe('delete'); // LWW winner
      expect(lines[0].record.updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(lines[0].seq).toBe(99); // max seq preserved
    });

    it('preserves pre-floor LWW winner before verbatim tail when tail is stale under positive floor', async () => {
      // seq 1: create links x (Jan-01)
      // seq 2: delete links x (Jan-02) -> winning delete
      // seq 99: stale create links x (Jan-01) -> stale echoed create in tail
      writeLog(
        '{"seq":1,"op":"create","type":"links","id":"x","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n' +
        '{"seq":2,"op":"delete","type":"links","id":"x","record":{"updatedAt":"2026-01-02T00:00:00.000Z"}}\n' +
        '{"seq":99,"op":"create","type":"links","id":"x","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n'
      );
      await initSyncLog();

      // Compact with positive floor (50). Tail (seq >= 50) is kept verbatim,
      // and seq 2 (delete Jan-02) is preserved before the tail so a fresh peer
      // replaying from since=0 rejects the stale create and avoids resurrecting the record.
      const dropped = await compactLog(50);
      expect(dropped).toBe(1); // seq 1 is dropped, seq 2 and seq 99 are kept

      const lines = readFileSync(syncLogPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].seq).toBe(2);
      expect(lines[0].op).toBe('delete');
      expect(lines[0].record.updatedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(lines[1].seq).toBe(99);
      expect(lines[1].op).toBe('create');

      // A fresh peer pulling from since=0 gets seq 2 (delete) then seq 99 (stale create)
      const fromZero = await getChangesSince(0);
      expect(fromZero.changes.map(c => c.seq)).toEqual([2, 99]);
    });

    it('applies mixed LWW outcomes across indexed tail entries', async () => {
      writeLog(
        '{"seq":1,"op":"create","type":"links","id":"x","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n' +
        '{"seq":2,"op":"delete","type":"links","id":"x","record":{"updatedAt":"2026-01-02T00:00:00.000Z"}}\n' +
        '{"seq":3,"op":"create","type":"links","id":"y","record":{"updatedAt":"2026-01-01T00:00:00.000Z"}}\n' +
        '{"seq":4,"op":"delete","type":"links","id":"y","record":{"updatedAt":"2026-01-03T00:00:00.000Z"}}\n' +
        '{"seq":50,"op":"update","type":"links","id":"x","record":{"updatedAt":"2026-01-01T12:00:00.000Z"}}\n' +
        '{"seq":51,"op":"create","type":"links","id":"y","record":{"updatedAt":"2026-01-04T00:00:00.000Z"}}\n' +
        '{"seq":52,"op":"update","type":"links","id":"x","record":{"updatedAt":"2026-01-01T18:00:00.000Z"}}\n'
      );
      await initSyncLog();

      expect(await compactLog(50)).toBe(3);

      const lines = readFileSync(syncLogPath(), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.map(line => line.seq)).toEqual([2, 50, 51, 52]);
      expect(lines[0].id).toBe('x');
      expect(lines[0].op).toBe('delete');
    });
  });
});
