import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, readdir, stat } from 'fs/promises';
import { atomicWrite } from '../lib/fileUtils.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn()
}));

const registeredHandlers = {};
const cosEvents = {
  on: vi.fn((event, handler) => { registeredHandlers[event] = handler; })
};

vi.mock('./cosEvents.js', () => ({ cosEvents }));

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  ensureDir: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: {
    data: '/test/data',
    cos: '/test/data/cos',
    reports: '/test/data/cos/reports',
    root: '/test'
  },
  readJSONFile: vi.fn(async (path, fallback) => {
    try {
      return JSON.parse(await readFile(path));
    } catch {
      return fallback;
    }
  })
}));

const {
  createItem,
  getItems,
  getPendingCounts,
  completeItem,
  dismissItem,
  updateItem,
  deleteItem,
  getBriefing,
  bulkUpdateStatus,
  reviewEvents
} = await import('./review.js');

// `stat()` backs review.js's module-level items.json cache, which persists
// across every test in this file (it is process/module state, not a vitest
// mock). The default implementation below returns a fresh, never-repeating
// value on every call, so — absent a test explicitly overriding it — every
// `loadItems()` call in this file is a guaranteed cache MISS and re-reads via
// `readFile`, exactly matching this suite's pre-caching expectations. Tests
// that exercise the cache itself override `stat` locally to hold a value
// steady (a hit) or change it (a miss/invalidation).
let statCounter = 0;
const freshStat = () => Promise.resolve({ mtimeMs: ++statCounter, size: statCounter });

describe('review service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stat.mockImplementation(freshStat);
  });

  describe('createItem', () => {
    it('creates a new review item', async () => {
      readFile.mockResolvedValue('[]');

      const item = await createItem({
        type: 'todo',
        title: 'Test todo',
        description: 'Test description'
      });

      expect(item.id).toBeDefined();
      expect(item.type).toBe('todo');
      expect(item.title).toBe('Test todo');
      expect(item.status).toBe('pending');
      expect(atomicWrite).toHaveBeenCalled();
    });

    it('throws on invalid item type', async () => {
      await expect(createItem({ type: 'invalid', title: 'test' })).rejects.toThrow('Invalid item type: invalid');
    });

    it('prevents duplicate alerts within 24 hours', async () => {
      const existingItems = [{
        id: '1',
        type: 'alert',
        title: 'Existing alert',
        status: 'pending',
        metadata: { referenceId: 'ref-123' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }];
      readFile.mockResolvedValue(JSON.stringify(existingItems));

      const item = await createItem({
        type: 'alert',
        title: 'Duplicate alert',
        metadata: { referenceId: 'ref-123' }
      });

      expect(item.id).toBe('1');
      expect(atomicWrite).not.toHaveBeenCalled();
    });
  });

  describe('getItems', () => {
    it('returns filtered items by status', async () => {
      const items = [
        { id: '1', type: 'todo', status: 'pending', createdAt: '2024-01-01T00:00:00Z' },
        { id: '2', type: 'alert', status: 'completed', createdAt: '2024-01-02T00:00:00Z' }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      const result = await getItems({ status: 'pending' });
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('1');
    });
  });

  describe('getPendingCounts', () => {
    it('counts pending items by type', async () => {
      const items = [
        { id: '1', type: 'todo', status: 'pending' },
        { id: '2', type: 'alert', status: 'pending' },
        { id: '3', type: 'alert', status: 'completed' }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      const counts = await getPendingCounts();
      expect(counts).toEqual({ total: 2, alert: 1, todo: 1, briefing: 0, cos: 0 });
    });
  });

  describe('status updates', () => {
    it('completes an item', async () => {
      const items = [{ id: '1', type: 'todo', title: 'Test', status: 'pending', createdAt: '', updatedAt: '' }];
      readFile.mockResolvedValue(JSON.stringify(items));

      const updated = await completeItem('1');
      expect(updated.status).toBe('completed');
      expect(atomicWrite).toHaveBeenCalled();
    });

    it('dismisses an item', async () => {
      const items = [{ id: '1', type: 'todo', title: 'Test', status: 'pending', createdAt: '', updatedAt: '' }];
      readFile.mockResolvedValue(JSON.stringify(items));

      const updated = await dismissItem('1');
      expect(updated.status).toBe('dismissed');
    });
  });

  describe('updateItem', () => {
    it('updates item title and description', async () => {
      const items = [{ id: '1', type: 'todo', title: 'Old', description: '', status: 'pending', createdAt: '', updatedAt: '' }];
      readFile.mockResolvedValue(JSON.stringify(items));

      const updated = await updateItem('1', { title: 'New', description: 'Desc' });
      expect(updated.title).toBe('New');
      expect(updated.description).toBe('Desc');
      expect(atomicWrite).toHaveBeenCalled();
    });
  });

  describe('deleteItem', () => {
    it('removes an item', async () => {
      readFile.mockResolvedValue(JSON.stringify([{ id: '1', type: 'todo', title: 'Delete me' }]));
      await deleteItem('1');
      const written = atomicWrite.mock.calls[0][1];
      expect(written).toHaveLength(0);
    });

    it('throws on non-existent item', async () => {
      readFile.mockResolvedValue('[]');
      await expect(deleteItem('missing')).rejects.toThrow('Review item not found: missing');
    });
  });

  describe('getBriefing', () => {
    it('returns latest CoS briefing content', async () => {
      readdir.mockResolvedValue(['2026-03-17-briefing.md', '2026-03-18-briefing.md']);
      readFile.mockResolvedValue('# Daily Briefing\n\nActual CoS content');

      const briefing = await getBriefing();
      expect(briefing.source).toBe('cos');
      expect(briefing.generatedAt).toBe('2026-03-18');
      expect(briefing.content).toContain('Actual CoS content');
    });

    it('returns none when no CoS briefing exists', async () => {
      readdir.mockResolvedValue([]);
      const briefing = await getBriefing();
      expect(briefing.source).toBe('none');
      expect(briefing.content).toContain('No CoS daily briefing found yet');
    });
  });

  describe('bulkUpdateStatus', () => {
    it('updates every pending item in a single write when no ids passed', async () => {
      const { bulkUpdateStatus } = await import('./review.js');
      const items = [
        { id: 'a', status: 'pending', metadata: {} },
        { id: 'b', status: 'pending', metadata: {} },
        { id: 'c', status: 'completed', metadata: {} }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      const updated = await bulkUpdateStatus({ status: 'dismissed' });

      expect(updated).toHaveLength(2);
      expect(atomicWrite).toHaveBeenCalledTimes(1);
      const written = atomicWrite.mock.calls[0][1];
      expect(written.find(i => i.id === 'a').status).toBe('dismissed');
      expect(written.find(i => i.id === 'b').status).toBe('dismissed');
      expect(written.find(i => i.id === 'c').status).toBe('completed');
    });

    it('only updates items whose ids are passed in', async () => {
      const { bulkUpdateStatus } = await import('./review.js');
      const items = [
        { id: 'a', status: 'pending', metadata: {} },
        { id: 'b', status: 'pending', metadata: {} }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      const updated = await bulkUpdateStatus({ status: 'completed', ids: ['a'] });

      expect(updated).toHaveLength(1);
      const written = atomicWrite.mock.calls[0][1];
      expect(written.find(i => i.id === 'a').status).toBe('completed');
      expect(written.find(i => i.id === 'b').status).toBe('pending');
    });

    it('skips the write entirely when nothing matches', async () => {
      const { bulkUpdateStatus } = await import('./review.js');
      readFile.mockResolvedValue(JSON.stringify([{ id: 'a', status: 'completed', metadata: {} }]));

      const updated = await bulkUpdateStatus({ status: 'dismissed' });

      expect(updated).toEqual([]);
      expect(atomicWrite).not.toHaveBeenCalled();
    });

    it('rejects invalid status values', async () => {
      const { bulkUpdateStatus } = await import('./review.js');
      await expect(bulkUpdateStatus({ status: 'bogus' })).rejects.toThrow('Invalid status');
    });
  });

  describe('cosEvents bridge', () => {
    it('auto-completes the matching review item when an agent finishes successfully', async () => {
      const handler = registeredHandlers['agent:completed'];
      expect(handler).toBeDefined();

      const items = [
        { id: 'r1', type: 'cos', status: 'pending', metadata: { referenceId: 'task-42', taskId: 'task-42' } },
        { id: 'r2', type: 'cos', status: 'pending', metadata: { referenceId: 'task-99', taskId: 'task-99' } }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      handler({ taskId: 'task-42', result: { success: true } });
      // Wait a tick for the async chain inside the handler to flush
      await new Promise(r => setImmediate(r));

      const written = atomicWrite.mock.calls[0][1];
      const updated = written.find(i => i.id === 'r1');
      const untouched = written.find(i => i.id === 'r2');
      expect(updated.status).toBe('completed');
      expect(untouched.status).toBe('pending');
    });

    it('does not auto-complete when the agent failed', async () => {
      const handler = registeredHandlers['agent:completed'];
      const items = [
        { id: 'r1', type: 'cos', status: 'pending', metadata: { referenceId: 'task-42', taskId: 'task-42' } }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      handler({ taskId: 'task-42', result: { success: false, error: 'boom' } });
      await new Promise(r => setImmediate(r));

      expect(atomicWrite).not.toHaveBeenCalled();
    });

    it('dismisses pending review items when their task is deleted', async () => {
      const handler = registeredHandlers['tasks:changed'];
      expect(handler).toBeDefined();

      const items = [
        { id: 'r1', type: 'cos', status: 'pending', metadata: { referenceId: 'task-42', taskId: 'task-42' } },
        { id: 'r2', type: 'cos', status: 'pending', metadata: { referenceId: 'task-99', taskId: 'task-99' } }
      ];
      readFile.mockResolvedValue(JSON.stringify(items));

      handler({ type: 'user', action: 'deleted', taskId: 'task-42' });
      await new Promise(r => setImmediate(r));

      const written = atomicWrite.mock.calls[0][1];
      expect(written.find(i => i.id === 'r1').status).toBe('dismissed');
      expect(written.find(i => i.id === 'r2').status).toBe('pending');
    });

    it('ignores non-deletion task changes', async () => {
      const handler = registeredHandlers['tasks:changed'];
      readFile.mockResolvedValue(JSON.stringify([
        { id: 'r1', type: 'cos', status: 'pending', metadata: { referenceId: 'task-42', taskId: 'task-42' } }
      ]));

      handler({ type: 'user', action: 'updated', task: { id: 'task-42' } });
      await new Promise(r => setImmediate(r));

      expect(atomicWrite).not.toHaveBeenCalled();
    });
  });

  describe('items.json read cache', () => {
    it('parses the file once across two consecutive getPendingCounts calls with no write between', async () => {
      stat.mockResolvedValue({ mtimeMs: 811001, size: 1 });
      readFile.mockResolvedValueOnce(JSON.stringify([{ id: 'a', type: 'todo', status: 'pending' }]));

      const first = await getPendingCounts();
      const second = await getPendingCounts();

      expect(first.total).toBe(1);
      expect(second.total).toBe(1);
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('detects an external rewrite (changed mtime/size) and re-parses', async () => {
      stat.mockResolvedValueOnce({ mtimeMs: 812001, size: 100 });
      readFile.mockResolvedValueOnce(JSON.stringify([{ id: 'a', type: 'todo', status: 'pending' }]));
      const first = await getPendingCounts();
      expect(first.total).toBe(1);

      // A different process rewrote items.json — stat now reports a new identity.
      stat.mockResolvedValueOnce({ mtimeMs: 812002, size: 140 });
      readFile.mockResolvedValueOnce(JSON.stringify([
        { id: 'a', type: 'todo', status: 'pending' },
        { id: 'b', type: 'alert', status: 'pending' }
      ]));
      const second = await getPendingCounts();

      expect(second.total).toBe(2);
      expect(readFile).toHaveBeenCalledTimes(2);
    });

    it('treats a missing items.json as an empty, cache-cleared list', async () => {
      const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      stat.mockRejectedValueOnce(enoent);

      const whileMissing = await getPendingCounts();
      expect(whileMissing.total).toBe(0);
      expect(readFile).not.toHaveBeenCalled();

      // The file reappears — the cleared cache must not keep reporting the
      // pre-deletion (or pre-existence) state.
      stat.mockResolvedValueOnce({ mtimeMs: 813001, size: 1 });
      readFile.mockResolvedValueOnce(JSON.stringify([{ id: 'a', type: 'todo', status: 'pending' }]));
      const afterRecreate = await getPendingCounts();
      expect(afterRecreate.total).toBe(1);
    });

    it('reflects a write in the very next read without a second parse', async () => {
      stat.mockResolvedValueOnce({ mtimeMs: 814001, size: 1 }); // loadItems() inside createItem
      readFile.mockResolvedValueOnce('[]');
      stat.mockResolvedValueOnce({ mtimeMs: 814002, size: 2 }); // saveItems' post-write stat
      stat.mockResolvedValueOnce({ mtimeMs: 814002, size: 2 }); // getPendingCounts' loadItems — same identity

      await createItem({ type: 'todo', title: 'First item' });
      const counts = await getPendingCounts();

      expect(counts.total).toBe(1);
      // Only createItem's own cache-miss read — getPendingCounts hit the
      // cache saveItems seeded from the write, not a re-parse.
      expect(readFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getItems merges archive.json', () => {
    it('includes archive for completed/dismissed and unfiltered queries, but not a pending-only query', async () => {
      stat.mockResolvedValue({ mtimeMs: 816001, size: 1 });
      const liveItems = [
        { id: 'live-pending', type: 'todo', status: 'pending', createdAt: '2026-01-01T00:00:00Z' },
        { id: 'live-completed', type: 'todo', status: 'completed', createdAt: '2026-01-02T00:00:00Z' }
      ];
      const archivedItems = [
        { id: 'archived-completed', type: 'todo', status: 'completed', createdAt: '2025-01-01T00:00:00Z' }
      ];
      readFile.mockImplementation((path) =>
        Promise.resolve(String(path).endsWith('archive.json') ? JSON.stringify(archivedItems) : JSON.stringify(liveItems)));

      const completedView = await getItems({ status: 'completed' });
      expect(completedView.map(i => i.id).sort()).toEqual(['archived-completed', 'live-completed']);

      const allView = await getItems({});
      expect(allView.map(i => i.id).sort()).toEqual(['archived-completed', 'live-completed', 'live-pending']);

      const pendingView = await getItems({ status: 'pending' });
      expect(pendingView.map(i => i.id)).toEqual(['live-pending']);
    });
  });

  describe('createItem duplicate check reaches the archive', () => {
    it('finds a duplicate alert in archive.json when the live scan misses', async () => {
      stat.mockResolvedValue({ mtimeMs: 817001, size: 1 });
      // Synthetic fixture: a real archived item is always >=30 days old and
      // could never actually land inside this 24h dedup window. This exists
      // to prove createItem's duplicate check reaches archive.json at all
      // when the live scan misses — not to model a realistic timestamp.
      const archivedAlert = {
        id: 'archived-1',
        type: 'alert',
        status: 'dismissed',
        metadata: { referenceId: 'ref-archived' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      readFile.mockImplementation((path) =>
        Promise.resolve(String(path).endsWith('archive.json') ? JSON.stringify([archivedAlert]) : '[]'));

      const item = await createItem({
        type: 'alert',
        title: 'New alert for same ref',
        metadata: { referenceId: 'ref-archived' }
      });

      expect(item.id).toBe('archived-1');
      expect(atomicWrite).not.toHaveBeenCalled();
    });
  });

  describe('retention', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('moves completed/dismissed items older than 30 days into archive.json and keeps pending/recent items in items.json', async () => {
      vi.useFakeTimers();
      // Push the clock far enough ahead that the 24h retention-interval gate
      // is guaranteed open, however recently an earlier test in this file
      // triggered a save — `lastRetentionAt` is module state shared across
      // the whole file, not reset between tests.
      vi.setSystemTime(Date.now() + 1000 * 60 * 60 * 24 * 400);

      const now = Date.now();
      const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
      const fixture = [
        { id: 'p1', type: 'todo', status: 'pending', metadata: {}, createdAt: old, updatedAt: old },
        { id: 'c-old', type: 'todo', status: 'completed', metadata: {}, createdAt: old, updatedAt: old },
        { id: 'd-old', type: 'alert', status: 'dismissed', metadata: {}, createdAt: old, updatedAt: old },
        { id: 'c-recent', type: 'todo', status: 'completed', metadata: {}, createdAt: recent, updatedAt: recent }
      ];

      stat.mockResolvedValue({ mtimeMs: 815001, size: 1 });
      readFile.mockImplementation((path) =>
        Promise.resolve(String(path).endsWith('archive.json') ? '[]' : JSON.stringify(fixture)));

      await createItem({ type: 'todo', title: 'trigger a save' });

      expect(atomicWrite).toHaveBeenCalledTimes(2);
      const [archivePath, archiveData] = atomicWrite.mock.calls[0];
      const [itemsPath, itemsData] = atomicWrite.mock.calls[1];

      expect(archivePath).toMatch(/archive\.json$/);
      expect(archiveData.map(i => i.id).sort()).toEqual(['c-old', 'd-old']);

      expect(itemsPath).toMatch(/items\.json$/);
      const survivingIds = itemsData.map(i => i.id);
      expect(survivingIds).toEqual(expect.arrayContaining(['p1', 'c-recent']));
      expect(survivingIds).not.toEqual(expect.arrayContaining(['c-old']));
      expect(survivingIds).not.toEqual(expect.arrayContaining(['d-old']));

      // getPendingCounts must still be correct post-retention, and served
      // from the cache saveItems just seeded rather than a fresh parse.
      const counts = await getPendingCounts();
      expect(counts.total).toBe(2); // p1 + the new item createItem just added
      expect(readFile).toHaveBeenCalledTimes(2); // items.json once + archive.json once — no third parse
    });
  });

  describe('bulkUpdateStatus events', () => {
    it('emits exactly one items:bulk-updated event and zero per-item item:updated events', async () => {
      const emitSpy = vi.spyOn(reviewEvents, 'emit');
      try {
        stat.mockResolvedValue({ mtimeMs: 818001, size: 1 });
        const items = [
          { id: 'a', status: 'pending', metadata: {} },
          { id: 'b', status: 'pending', metadata: {} },
          { id: 'c', status: 'completed', metadata: {} }
        ];
        readFile.mockResolvedValue(JSON.stringify(items));

        const updated = await bulkUpdateStatus({ status: 'dismissed' });

        expect(updated).toHaveLength(2);
        const bulkCalls = emitSpy.mock.calls.filter(([event]) => event === 'items:bulk-updated');
        const perItemCalls = emitSpy.mock.calls.filter(([event]) => event === 'item:updated');
        expect(bulkCalls).toHaveLength(1);
        expect(perItemCalls).toHaveLength(0);
        expect(bulkCalls[0][1]).toEqual({
          ids: expect.arrayContaining(['a', 'b']),
          status: 'dismissed',
          updatedAt: expect.any(String)
        });
        expect(bulkCalls[0][1].ids).toHaveLength(2);
      } finally {
        emitSpy.mockRestore();
      }
    });
  });
});
