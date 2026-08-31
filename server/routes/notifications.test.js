import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fileUtils = vi.hoisted(() => ({
  ensureDir: vi.fn().mockResolvedValue(),
  readJSONFile: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue()
}));

const notificationMocks = vi.hoisted(() => ({
  getUnreadCount: vi.fn(),
  getCountsByType: vi.fn(),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  removeNotification: vi.fn(),
  clearAll: vi.fn()
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: '/mock/data' },
    ensureDir: fileUtils.ensureDir,
    readJSONFile: fileUtils.readJSONFile,
    atomicWrite: fileUtils.atomicWrite
  };
});

// Keep the route's mutation/count endpoints isolated, but retain the real list
// service so this boundary test cannot document a response shape the service
// does not return.
vi.mock('../services/notifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ...notificationMocks
}));

import * as notifications from '../services/notifications.js';
import notificationsRoutes from './notifications.js';

const NOTIFICATION_FIXTURE = {
  version: 1,
  notifications: [
    {
      id: 'n1',
      type: 'memory_approval',
      title: 'Memory review',
      read: false,
      timestamp: '2025-01-01T00:00:00.000Z'
    },
    {
      id: 'n2',
      type: 'memory_approval',
      title: 'Older memory review',
      read: true,
      timestamp: '2025-01-02T00:00:00.000Z'
    },
    {
      id: 'n3',
      type: 'task_approval',
      title: 'Task review',
      read: false,
      timestamp: '2025-01-03T00:00:00.000Z'
    },
    {
      id: 'n4',
      type: 'memory_approval',
      title: 'Newest memory review',
      read: false,
      timestamp: '2025-01-04T00:00:00.000Z'
    }
  ]
};

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('notifications routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fileUtils.readJSONFile.mockResolvedValue(JSON.parse(JSON.stringify(NOTIFICATION_FIXTURE)));
    notifications.invalidateCache();
  });

  describe('GET /api/notifications', () => {
    it('returns the real service list as a bare array with default options', async () => {
      const res = await request(buildApp()).get('/api/notifications');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.map(({ id }) => id)).toEqual(['n4', 'n3', 'n2', 'n1']);
    });

    it('applies type and unreadOnly filters through the real service', async () => {
      const type = notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL;
      const res = await request(buildApp()).get(`/api/notifications?type=${type}&unreadOnly=true`);

      expect(res.status).toBe(200);
      expect(res.body.map(({ id }) => id)).toEqual(['n4', 'n1']);
    });

    it('applies limit after the type and unreadOnly filters', async () => {
      const type = notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL;
      const res = await request(buildApp()).get(`/api/notifications?type=${type}&unreadOnly=true&limit=1`);

      expect(res.status).toBe(200);
      expect(res.body.map(({ id }) => id)).toEqual(['n4']);
    });
  });

  describe('GET /api/notifications/count', () => {
    it('returns the unread count', async () => {
      notifications.getUnreadCount.mockResolvedValue(7);
      const res = await request(buildApp()).get('/api/notifications/count');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 7 });
    });
  });

  describe('GET /api/notifications/counts', () => {
    it('returns counts grouped by type', async () => {
      const grouped = {
        [notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL]: 3,
        [notifications.NOTIFICATION_TYPES.TASK_APPROVAL]: 2
      };
      notifications.getCountsByType.mockResolvedValue(grouped);
      const res = await request(buildApp()).get('/api/notifications/counts');
      expect(res.status).toBe(200);
      expect(res.body).toEqual(grouped);
    });
  });

  describe('POST /api/notifications/:id/read', () => {
    it('marks a notification read on success', async () => {
      notifications.markAsRead.mockResolvedValue({ success: true, id: 'n1' });
      const res = await request(buildApp()).post('/api/notifications/n1/read');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(notifications.markAsRead).toHaveBeenCalledWith('n1');
    });

    it('returns 404 when the notification is missing', async () => {
      notifications.markAsRead.mockResolvedValue({ success: false, error: 'Not found' });
      const res = await request(buildApp()).post('/api/notifications/missing/read');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/notifications/read-all', () => {
    it('marks all notifications read', async () => {
      notifications.markAllAsRead.mockResolvedValue({ success: true, marked: 5 });
      const res = await request(buildApp()).post('/api/notifications/read-all');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, marked: 5 });
    });
  });

  describe('DELETE /api/notifications/:id', () => {
    it('removes the notification on success', async () => {
      notifications.removeNotification.mockResolvedValue({ success: true });
      const res = await request(buildApp()).delete('/api/notifications/n1');
      expect(res.status).toBe(200);
      expect(notifications.removeNotification).toHaveBeenCalledWith('n1');
    });

    it('returns 404 when the notification is missing', async () => {
      notifications.removeNotification.mockResolvedValue({ success: false, error: 'gone' });
      const res = await request(buildApp()).delete('/api/notifications/missing');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/notifications', () => {
    it('clears all notifications', async () => {
      notifications.clearAll.mockResolvedValue({ success: true, cleared: 12 });
      const res = await request(buildApp()).delete('/api/notifications');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, cleared: 12 });
    });
  });
});
