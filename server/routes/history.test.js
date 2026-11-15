import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real history service (JSONL file) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-history-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: historyRoutes } = await import('./history.js');
const { logAction, clearHistory } = await import('../services/history.js');

const app = express();
app.use(express.json());
app.use('/api/history', historyRoutes);
app.use(errorMiddleware);

const get = (query = '') => request(app).get(`/api/history${query}`);

describe('History Routes', () => {
  beforeEach(async () => {
    await clearHistory();
  });

  describe('GET /api/history', () => {
    it('lists newest first with the default window and filters by action, target and success', async () => {
      await logAction('start', 'app', 'Alpha');
      await logAction('stop', 'app', 'Alpha', {}, false, 'boom');
      await logAction('start', 'cos', 'Beta');

      const all = await get();
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(3);
      expect(all.body.entries.map((e) => e.targetName)).toEqual(['Beta', 'Alpha', 'Alpha']);

      expect((await get('?action=start')).body.total).toBe(2);
      expect((await get('?target=cos')).body.entries.map((e) => e.targetName)).toEqual(['Beta']);
      const failed = await get('?success=false');
      expect(failed.body.entries).toEqual([expect.objectContaining({ action: 'stop', error: 'boom' })]);
    });

    it('applies limit and offset to the newest-first window', async () => {
      for (const name of ['a', 'b', 'c', 'd']) await logAction('start', 'app', name);

      const page = await get('?limit=2&offset=1');
      expect(page.body.total).toBe(4);
      expect(page.body.entries.map((e) => e.targetName)).toEqual(['c', 'b']);
    });

    it('rejects an out-of-range limit', async () => {
      expect((await get('?limit=0')).status).toBe(400);
      expect((await get('?limit=1001')).status).toBe(400);
    });
  });

  describe('GET /api/history/stats and /actions', () => {
    it('reports counts, success rate and the sorted unique action types', async () => {
      await logAction('stop', 'app', 'A');
      await logAction('start', 'app', 'A');
      await logAction('start', 'app', 'B', {}, false);

      const stats = (await request(app).get('/api/history/stats')).body;
      expect(stats).toMatchObject({ total: 3, byAction: { stop: 1, start: 2 }, successRate: '66.7', last24h: 3 });
      expect((await request(app).get('/api/history/actions')).body).toEqual(['start', 'stop']);
    });
  });

  describe('DELETE /api/history/:id', () => {
    it('deletes one entry and leaves the rest', async () => {
      const keep = await logAction('start', 'app', 'Keep');
      const drop = await logAction('start', 'app', 'Drop');

      const response = await request(app).delete(`/api/history/${drop.id}`);
      expect(response.status).toBe(200);
      expect((await get()).body.entries.map((e) => e.id)).toEqual([keep.id]);
    });

    it('returns 404 for an unknown entry', async () => {
      await logAction('start', 'app', 'Keep');
      const response = await request(app).delete('/api/history/h-nonexistent');
      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/not found/i);
      expect((await get()).body.total).toBe(1);
    });
  });

  describe('DELETE /api/history', () => {
    it.each(['abc', '-5', '0', '1e'])('rejects olderThanDays=%s with 400 and clears nothing', async (v) => {
      await logAction('start', 'app', 'Keep');
      expect((await request(app).delete(`/api/history?olderThanDays=${v}`)).status).toBe(400);
      expect((await get()).body.total).toBe(1);
    });

    it('clears all history', async () => {
      await logAction('start', 'app', 'A');
      await logAction('start', 'app', 'B');
      expect((await request(app).delete('/api/history')).status).toBe(200);
      expect((await get()).body).toEqual({ total: 0, entries: [] });
    });

    it('clears only entries older than the cutoff', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(Date.now() - 10 * 86400000));
        await logAction('start', 'app', 'Old');
        vi.useRealTimers();
        await logAction('start', 'app', 'Fresh');
      } finally {
        vi.useRealTimers();
      }

      expect((await request(app).delete('/api/history?olderThanDays=7')).status).toBe(200);
      expect((await get()).body.entries.map((e) => e.targetName)).toEqual(['Fresh']);
    });
  });
});
