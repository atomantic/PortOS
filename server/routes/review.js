import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as reviewService from '../services/review.js';
import { buildQueue, resolveQueueItem, promoteAskQueueItem } from '../services/reviewQueue.js';

const router = express.Router();

const createTodoSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().default('')
});

const updateItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional()
});

const bulkStatusSchema = z.object({
  status: z.enum(['completed', 'dismissed']),
  ids: z.array(z.string()).optional()
});

// GET /api/review/items — list all items (optional ?status=pending&type=todo filters)
router.get('/items', asyncHandler(async (req, res) => {
  const { status, type } = req.query;
  const items = await reviewService.getItems({ status, type });
  res.json(items);
}));

// GET /api/review/counts — get pending item counts by type
router.get('/counts', asyncHandler(async (req, res) => {
  const counts = await reviewService.getPendingCounts();
  res.json(counts);
}));

// GET /api/review/briefing — get daily briefing content
router.get('/briefing', asyncHandler(async (req, res) => {
  const briefing = await reviewService.getBriefing();
  res.json(briefing);
}));

// GET /api/review/queue — cross-domain live aggregator of items needing
// attention (brain inbox, ask answers, CoS approvals, drafts, health, backups)
router.get('/queue', asyncHandler(async (req, res) => {
  const queue = await buildQueue();
  res.json(queue);
}));

const resolveQueueSchema = z.object({
  id: z.string().min(1).max(500)
});

// POST /api/review/queue/resolve — accept a single cross-domain queue row in
// place (mark a Brain inbox item done, approve a CoS task or message draft)
// without leaving the Review Hub. Sources with no clean one-click resolve
// (Ask, health, backup) have no inline action and 400 here. The `id` is the
// row's `<source>:<rawId>` — the service dispatches to that source's primitive.
router.post('/queue/resolve', asyncHandler(async (req, res) => {
  const { id } = validateRequest(resolveQueueSchema, req.body);
  const result = await resolveQueueItem(id);
  res.json(result);
}));

const promoteAskQueueSchema = z.object({
  id: z.string().min(1).max(500),
  target: z.enum(['brain', 'task'])
});

// POST /api/review/queue/promote-ask — promote an Ask row's latest assistant
// answer into Brain or a CoS task, in place, without leaving the Review Hub.
// The `id` is the row's `ask:<conversationId>`; the service finds the latest
// assistant turn so the client doesn't track turn ids. Goal targets stay a
// drill-down (they need a goalId choice the queue row can't supply).
router.post('/queue/promote-ask', asyncHandler(async (req, res) => {
  const { id, target } = validateRequest(promoteAskQueueSchema, req.body);
  const result = await promoteAskQueueItem(id, target);
  res.json(result);
}));

// POST /api/review/todo — create a user todo
router.post('/todo', asyncHandler(async (req, res) => {
  const data = validateRequest(createTodoSchema, req.body);
  const item = await reviewService.createItem({
    type: 'todo',
    title: data.title,
    description: data.description
  });
  res.status(201).json(item);
}));

// PATCH /api/review/items/:id — update title/description
router.patch('/items/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateItemSchema, req.body);
  const item = await reviewService.updateItem(req.params.id, data);
  res.json(item);
}));

// POST /api/review/items/:id/complete — mark as completed
router.post('/items/:id/complete', asyncHandler(async (req, res) => {
  const item = await reviewService.completeItem(req.params.id);
  res.json(item);
}));

// POST /api/review/items/:id/dismiss — dismiss an item
router.post('/items/:id/dismiss', asyncHandler(async (req, res) => {
  const item = await reviewService.dismissItem(req.params.id);
  res.json(item);
}));

// POST /api/review/items/bulk-status — bulk update many items in one write
router.post('/items/bulk-status', asyncHandler(async (req, res) => {
  const data = validateRequest(bulkStatusSchema, req.body);
  const updated = await reviewService.bulkUpdateStatus(data);
  res.json({ updated: updated.length, items: updated });
}));

// DELETE /api/review/items/:id — delete an item
router.delete('/items/:id', asyncHandler(async (req, res) => {
  await reviewService.deleteItem(req.params.id);
  res.status(204).end();
}));

export default router;
