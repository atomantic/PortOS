import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real notifications service (JSON file) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-notifications-routes-') }));
afterAll(cleanupTempDataRoots);

const notifications = await import('../services/notifications.js');
const { PATHS } = await import('../lib/fileUtils.js');
const { default: notificationsRoutes } = await import('./notifications.js');

const { MEMORY_APPROVAL, TASK_APPROVAL, BRIEFING_READY } = notifications.NOTIFICATION_TYPES;

const note = (id, type, timestamp, read = false) => ({ id, type, title: id, read, timestamp });

// Write the file the service reads, then drop its cache so the next request loads it.
const seed = async (list) => {
  await mkdir(PATHS.data, { recursive: true });
  await writeFile(join(PATHS.data, 'notifications.json'), JSON.stringify({ version: 1, notifications: list }));
  notifications.invalidateCache();
};

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationsRoutes);
app.use(errorMiddleware);

const get = (path = '') => request(app).get(`/api/notifications${path}`);
const ids = (res) => res.body.map(({ id }) => id);

describe('notifications routes', () => {
  beforeEach(async () => {
    await seed([
      note('n1', MEMORY_APPROVAL, '2025-01-01T00:00:00.000Z'),
      note('n2', MEMORY_APPROVAL, '2025-01-02T00:00:00.000Z', true),
      note('n3', TASK_APPROVAL, '2025-01-03T00:00:00.000Z'),
      note('n4', MEMORY_APPROVAL, '2025-01-04T00:00:00.000Z'),
      note('n5', BRIEFING_READY, '2025-01-05T00:00:00.000Z'),
    ]);
  });

  describe('GET /api/notifications', () => {
    it('lists a bare array, newest first', async () => {
      const res = await get();
      expect(res.status).toBe(200);
      expect(ids(res)).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
    });

    it('returns the full visible unread count alongside the limited bell list', async () => {
      await seed([
        note('visible', MEMORY_APPROVAL, '2025-01-01T00:00:00.000Z'),
        note('newest', MEMORY_APPROVAL, '2025-01-02T00:00:00.000Z'),
        { ...note('hidden', TASK_APPROVAL, '2025-01-03T00:00:00.000Z'), historyHidden: true },
      ]);
      const res = await get('?limit=1&includeCount=true');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ notifications: [{ id: 'newest' }], count: 2 });
    });

    it('applies type and unreadOnly filters, then limit', async () => {
      expect(ids(await get(`?type=${MEMORY_APPROVAL}&unreadOnly=true`))).toEqual(['n4', 'n1']);
      expect(ids(await get(`?type=${MEMORY_APPROVAL}&unreadOnly=true&limit=1`))).toEqual(['n4']);
    });

    it.each(['limit=-1', 'limit=0', 'limit=1001', 'limit=abc', 'limit=1.5', 'type=invalid', 'type=a&type=b', 'unreadOnly=yes'])(
      'rejects %s with VALIDATION_ERROR',
      async (qs) => {
        const res = await get(`?${qs}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
    );
  });

  describe('counts', () => {
    it('reports the unread count and the counts grouped by type', async () => {
      expect((await get('/count')).body).toEqual({ count: 4 });
      expect((await get('/counts')).body).toEqual({
        total: 5,
        unread: 4,
        byType: { [MEMORY_APPROVAL]: 3, [TASK_APPROVAL]: 1, [BRIEFING_READY]: 1 },
      });
    });
  });

  describe('POST /api/notifications/:id/read', () => {
    it('marks one notification read, persisting it and lowering the unread count', async () => {
      const res = await request(app).post('/api/notifications/n1/read');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      expect(ids(await get('?unreadOnly=true'))).toEqual(['n5', 'n4', 'n3']);
      expect((await get('/count')).body).toEqual({ count: 3 });

      // The change reached disk, not just the in-memory cache.
      notifications.invalidateCache();
      expect((await get('/count')).body).toEqual({ count: 3 });
    });

    it('returns 404 when the notification is missing', async () => {
      expect((await request(app).post('/api/notifications/missing/read')).status).toBe(404);
    });
  });

  describe('POST /api/notifications/read-all', () => {
    it('marks every notification read', async () => {
      const res = await request(app).post('/api/notifications/read-all');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, updated: 4 });
      expect((await get('/count')).body).toEqual({ count: 0 });
      expect(ids(await get('?unreadOnly=true'))).toEqual([]);
    });
  });

  describe('DELETE /api/notifications/:id', () => {
    it('removes the notification from later lists and counts', async () => {
      const res = await request(app).delete('/api/notifications/n5');
      expect(res.status).toBe(200);
      expect(ids(await get())).toEqual(['n4', 'n3', 'n2', 'n1']);
      expect((await get('/counts')).body.total).toBe(4);
    });

    it('returns 404 when the notification is missing', async () => {
      expect((await request(app).delete('/api/notifications/missing')).status).toBe(404);
    });
  });

  describe('DELETE /api/notifications', () => {
    // Notifications whose source still owns an obligation (approvals) stay as hidden
    // history; everything else is dropped. Both leave the visible list empty.
    it('clears the visible list and the counts', async () => {
      const res = await request(app).delete('/api/notifications');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, cleared: 5 });
      expect(ids(await get())).toEqual([]);
      expect((await get('/counts')).body).toEqual({ total: 0, unread: 0, byType: {} });
    });
  });
});
