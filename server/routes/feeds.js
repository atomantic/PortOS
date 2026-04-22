/**
 * RSS/Atom Feed Routes
 *
 * REST API for managing feed subscriptions and reading items:
 *   GET    /api/feeds              — list subscribed feeds
 *   POST   /api/feeds              — add a feed subscription
 *   DELETE /api/feeds/:id          — remove a feed
 *   POST   /api/feeds/:id/refresh  — refresh a single feed
 *   POST   /api/feeds/refresh-all  — refresh all feeds
 *   GET    /api/feeds/items        — get feed items (query: feedId, unreadOnly)
 *   GET    /api/feeds/stats        — get feed statistics
 *   POST   /api/feeds/items/:id/read     — mark item as read
 *   POST   /api/feeds/items/read-all     — mark all items as read (query: feedId)
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, parsePagination } from '../lib/validation.js';
import * as feedsService from '../services/feeds.js';

const router = Router();

const addFeedSchema = z.object({
  url: z.string().url()
});

// GET /api/feeds — list all feeds with unread counts
router.get('/', asyncHandler(async (req, res) => {
  const feeds = await feedsService.getFeeds();
  res.json(feeds);
}));

// GET /api/feeds/stats — feed statistics
router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await feedsService.getFeedStats();
  res.json(stats);
}));

// GET /api/feeds/items — get feed items (supports limit/offset pagination, default limit 100)
router.get('/items', asyncHandler(async (req, res) => {
  const { feedId, unreadOnly } = req.query;
  const { limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });
  const items = await feedsService.getItems({
    feedId: feedId || undefined,
    unreadOnly: unreadOnly === 'true',
    limit,
    offset
  });
  res.json(items);
}));

// POST /api/feeds — add a new feed subscription
router.post('/', asyncHandler(async (req, res) => {
  const { url } = validateRequest(addFeedSchema, req.body);
  const result = await feedsService.addFeed(url);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.status(201).json(result.feed);
}));

// POST /api/feeds/refresh-all — refresh all feeds
router.post('/refresh-all', asyncHandler(async (req, res) => {
  const result = await feedsService.refreshAllFeeds();
  res.json(result);
}));

// POST /api/feeds/items/read-all — mark all items as read
router.post('/items/read-all', asyncHandler(async (req, res) => {
  const { feedId } = req.query;
  const result = await feedsService.markAllRead(feedId || undefined);
  res.json(result);
}));

// POST /api/feeds/items/:id/read — mark single item as read
router.post('/items/:id/read', asyncHandler(async (req, res) => {
  const result = await feedsService.markItemRead(req.params.id);
  if (result.error) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result);
}));

// POST /api/feeds/:id/refresh — refresh a single feed
router.post('/:id/refresh', asyncHandler(async (req, res) => {
  const result = await feedsService.refreshFeed(req.params.id);
  if (result.error) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result);
}));

// DELETE /api/feeds/:id — remove a feed subscription
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await feedsService.removeFeed(req.params.id);
  if (result.error) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result);
}));

export default router;
