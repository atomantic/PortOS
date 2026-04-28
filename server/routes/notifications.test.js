import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/notifications.js', () => ({
  getNotifications: vi.fn(),
  getUnreadCount: vi.fn(),
  getCountsByType: vi.fn(),
  markAsRead: vi.fn(),
  markAllAsRead: vi.fn(),
  removeNotification: vi.fn(),
  clearAll: vi.fn(),
  NOTIFICATION_TYPES: {
    MEMORY_APPROVAL: 'memory_approval',
    TASK_APPROVAL: 'task_approval'
  }
}));

import * as notifications from '../services/notifications.js';
import notificationsRoutes from './notifications.js';

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
  });

  describe('GET /api/notifications', () => {
    it('returns the notifications list with default options', async () => {
      notifications.getNotifications.mockResolvedValue({ items: [{ id: 'n1' }], total: 1 });
      const res = await request(buildApp()).get('/api/notifications');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ items: [{ id: 'n1' }], total: 1 });
      expect(notifications.getNotifications).toHaveBeenCalledWith({
        type: undefined,
        unreadOnly: false,
        limit: undefined
      });
    });

    it('parses query string options into the service call', async () => {
      notifications.getNotifications.mockResolvedValue({ items: [], total: 0 });
      const type = notifications.NOTIFICATION_TYPES.MEMORY_APPROVAL;
      await request(buildApp()).get(`/api/notifications?type=${type}&unreadOnly=true&limit=25`);
      expect(notifications.getNotifications).toHaveBeenCalledWith({
        type,
        unreadOnly: true,
        limit: 25
      });
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
