import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, readdir } from 'fs/promises';
import { atomicWrite } from '../lib/fileUtils.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn()
}));

const emit = vi.fn();
const reviewEvents = { emit };
const registeredHandlers = {};
const cosEvents = {
  on: vi.fn((event, handler) => { registeredHandlers[event] = handler; })
};

vi.mock('./cosEvents.js', () => ({ cosEvents }));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  PATHS: {
    data: '/test/data',
    cos: '/test/data/cos',
    reports: '/test/data/cos/reports',
    root: '/test'
  },
  readJSONFile: vi.fn(async (_path, fallback) => {
    try {
      return JSON.parse(await readFile());
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
  getBriefing
} = await import('./review.js');

describe('review service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });
});
