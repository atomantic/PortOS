/**
 * Notifications API Routes
 */

import { Router } from 'express';
import * as notifications from '../services/notifications.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';

const router = Router();

// GET /api/notifications - List all notifications
router.get('/', asyncHandler(async (req, res) => {
  const options = {
    type: req.query.type,
    unreadOnly: req.query.unreadOnly === 'true',
    limit: req.query.limit ? parseInt(req.query.limit) : undefined
  };

  const result = await notifications.getNotifications(options);
  res.json(result);
}));

// GET /api/notifications/count - Get unread count
router.get('/count', asyncHandler(async (req, res) => {
  const count = await notifications.getUnreadCount();
  res.json({ count });
}));

// GET /api/notifications/counts - Get counts by type
router.get('/counts', asyncHandler(async (req, res) => {
  const counts = await notifications.getCountsByType();
  res.json(counts);
}));

// POST /api/notifications/:id/read - Mark as read
router.post('/:id/read', asyncHandler(async (req, res) => {
  const result = await notifications.markAsRead(req.params.id);
  if (!result.success) {
    throw new ServerError(result.error, { status: 404 });
  }
  res.json(result);
}));

// POST /api/notifications/read-all - Mark all as read
router.post('/read-all', asyncHandler(async (req, res) => {
  const result = await notifications.markAllAsRead();
  res.json(result);
}));

// DELETE /api/notifications/:id - Remove a notification
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await notifications.removeNotification(req.params.id);
  if (!result.success) {
    throw new ServerError(result.error, { status: 404 });
  }
  res.json(result);
}));

// DELETE /api/notifications - Clear all notifications
router.delete('/', asyncHandler(async (req, res) => {
  const result = await notifications.clearAll();
  res.json(result);
}));

export default router;
