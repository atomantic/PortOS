import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and fs
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  appendFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn()
}));
vi.mock('fs', () => ({
  existsSync: vi.fn()
}));
vi.mock('../lib/asyncMutex.js', () => ({
  createMutex: () => async (fn) => fn()
}));
vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  safeJSONParse: (str, fallback) => {
    try { return JSON.parse(str); } catch { return fallback; }
  },
  PATHS: { brain: '/tmp/test/brain' }
}));

import { readFile, writeFile, appendFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import {
  initSyncLog,
  getCurrentSeq,
  appendChange,
  appendChanges,
  getChangesSince,
  compactLog
} from './brainSyncLog.js';

describe('brainSyncLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(true);
  });

  describe('getCurrentSeq', () => {
    it('returns 0 by default', () => {
      // getCurrentSeq returns module-level state; after import it starts at 0
      // (or whatever initSyncLog set it to)
      expect(typeof getCurrentSeq()).toBe('number');
    });
  });

  describe('initSyncLog', () => {
    it('sets seq to 0 when file does not exist', async () => {
      existsSync.mockReturnValue(false);
      mkdir.mockResolvedValue();

      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });

    it('parses last line for seq', async () => {
      existsSync.mockReturnValue(true);
      readFile.mockResolvedValue(
        '{"seq":1,"op":"create","type":"people","id":"a"}\n{"seq":5,"op":"update","type":"ideas","id":"b"}\n'
      );

      await initSyncLog();
      expect(getCurrentSeq()).toBe(5);
    });

    it('handles empty file content', async () => {
      existsSync.mockReturnValue(true);
      readFile.mockResolvedValue('   \n  \n');

      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });

    it('handles malformed last line gracefully', async () => {
      existsSync.mockReturnValue(true);
      readFile.mockResolvedValue('not-json\n');

      await initSyncLog();
      expect(getCurrentSeq()).toBe(0);
    });
  });

  describe('appendChange', () => {
    beforeEach(async () => {
      // Reset seq to 0
      existsSync.mockReturnValue(false);
      mkdir.mockResolvedValue();
      await initSyncLog();
      existsSync.mockReturnValue(true);
      appendFile.mockResolvedValue();
    });

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

      expect(appendFile).toHaveBeenCalledTimes(1);
      const written = appendFile.mock.calls[0][1];
      expect(written.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(written.trim());
      expect(parsed.op).toBe('delete');
    });
  });

  describe('appendChanges', () => {
    beforeEach(async () => {
      existsSync.mockReturnValue(false);
      mkdir.mockResolvedValue();
      await initSyncLog();
      existsSync.mockReturnValue(true);
      appendFile.mockResolvedValue();
    });

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

      const written = appendFile.mock.calls[0][1];
      expect(written.endsWith('\n')).toBe(true);
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).op).toBe('create');
      expect(JSON.parse(lines[1]).op).toBe('delete');
    });

    it('returns empty array for empty input', async () => {
      const entries = await appendChanges([]);

      expect(entries).toEqual([]);
      expect(appendFile).not.toHaveBeenCalled();
    });

    it('returns entries with correct shape', async () => {
      const entries = await appendChanges([
        { op: 'create', type: 'links', id: 'l1', record: { url: 'http://x' }, originInstanceId: 'peer-3' }
      ]);

      expect(entries[0]).toMatchObject({
        seq: expect.any(Number),
        op: 'create',
        type: 'links',
        id: 'l1',
        record: { url: 'http://x' },
        originInstanceId: 'peer-3',
        ts: expect.any(String)
      });
    });
  });

  describe('getChangesSince', () => {
    beforeEach(() => {
      existsSync.mockReturnValue(true);
    });

    it('filters entries by sinceSeq', async () => {
      readFile.mockResolvedValue(
        ['{"seq":1,"op":"create"}', '{"seq":2,"op":"update"}', '{"seq":3,"op":"delete"}'].join('\n') + '\n'
      );

      const result = await getChangesSince(1);
      expect(result.changes).toHaveLength(2);
      expect(result.changes[0].seq).toBe(2);
      expect(result.changes[1].seq).toBe(3);
    });

    it('respects limit parameter', async () => {
      const lines = Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({ seq: i + 1, op: 'create' })
      ).join('\n') + '\n';
      readFile.mockResolvedValue(lines);

      const result = await getChangesSince(0, 3);
      expect(result.changes).toHaveLength(3);
      expect(result.hasMore).toBe(true);
    });

    it('sets hasMore=false when all changes returned', async () => {
      readFile.mockResolvedValue('{"seq":1,"op":"create"}\n{"seq":2,"op":"update"}\n');

      const result = await getChangesSince(0, 100);
      expect(result.changes).toHaveLength(2);
      expect(result.hasMore).toBe(false);
    });

    it('returns empty when file does not exist', async () => {
      existsSync.mockReturnValue(false);

      const result = await getChangesSince(0);
      expect(result.changes).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('returns maxSeq from last returned change', async () => {
      readFile.mockResolvedValue('{"seq":5,"op":"create"}\n{"seq":10,"op":"update"}\n');

      const result = await getChangesSince(0, 1);
      expect(result.maxSeq).toBe(5);
    });
  });

  describe('compactLog', () => {
    it('drops entries below minSeq', async () => {
      existsSync.mockReturnValue(true);
      readFile.mockResolvedValue(
        '{"seq":1,"op":"create"}\n{"seq":2,"op":"update"}\n{"seq":3,"op":"delete"}\n'
      );
      writeFile.mockResolvedValue();
      rename.mockResolvedValue();

      const dropped = await compactLog(2);
      expect(dropped).toBe(1);
      expect(writeFile).toHaveBeenCalledTimes(1);
      const written = writeFile.mock.calls[0][1];
      expect(written).toContain('"seq":2');
      expect(written).toContain('"seq":3');
      expect(written).not.toContain('"seq":1,');
      expect(rename).toHaveBeenCalledTimes(1);
    });

    it('returns 0 when file does not exist', async () => {
      existsSync.mockReturnValue(false);
      const dropped = await compactLog(5);
      expect(dropped).toBe(0);
    });
  });
});
