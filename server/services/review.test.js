import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFile, readdir } from 'fs/promises';
import { atomicWrite } from '../lib/fileUtils.js';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  readdir: vi.fn()
}));

const emit = vi.fn();
const reviewEvents = { emit };
const cosEvents = { on: vi.fn() };

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
});
