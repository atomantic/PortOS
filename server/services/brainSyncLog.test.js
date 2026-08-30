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
  return makePathsProxy(actual, { dataRoot: () => getTempRoot() });
});

// Spy on createReadStream so the tests can assert WHICH bytes were read — that
// is the whole point of the index, and it is invisible from the return value.
vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

import { createReadStream } from 'fs';
import {
  initSyncLog,
  getCurrentSeq,
  appendChange,
  appendChanges,
  getChangesSince,
  compactLog
} from './brainSyncLog.js';

const syncLogPath = () => join(getTempRoot(), 'brain', 'sync_log.jsonl');

/** Byte offset of the (1-based) nth line of the on-disk log. */
const lineOffset = (n) => {
  const lines = readFileSync(syncLogPath(), 'utf8').split('\n').slice(0, n);
  return lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
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
      for (let i = 0; i < 5; i++) {
        await appendChange('create', 'people', `p${i}`, { name: `Person ${i}` }, 'inst-1');
      }

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

    it('keeps appending at the right offset after compaction', async () => {
      for (let i = 0; i < 4; i++) {
        await appendChange('create', 'people', `p${i}`, { name: `Person ${i}` }, 'inst-1');
      }
      await compactLog(3);
      await appendChange('create', 'people', 'p5', { name: 'Person 5' }, 'inst-1');

      vi.clearAllMocks();
      const result = await getChangesSince(4);
      expect(lastReadStart()).toBe(lineOffset(2));
      expect(result.changes.map(c => c.seq)).toEqual([5]);
    });
  });
});
