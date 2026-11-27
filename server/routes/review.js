import express from 'express';
import { reviewItemsQuerySchema } from '../lib/queryValidation.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import * as reviewService from '../services/review.js';
import { claimQueueDelivery } from '../services/reviewQueueDelivery.js';
import { buildQueue, resolveQueueItem, triageQueueItem, promoteAskQueueItem } from '../services/reviewQueue.js';
import {
  reviewQueueQuerySchema,
  createTodoSchema,
  updateItemSchema,
  bulkStatusSchema,
  resolveQueueSchema,
  deliverySchema,
  triageQueueSchema,
  promoteAskQueueSchema,
} from '../lib/reviewValidation.js';

const router = express.Router();

// GET /api/review/items — optional status/type filters and limit/offset pagination.
router.get('/items', asyncHandler(async (req, res) => {
  const query = validateRequest(reviewItemsQuerySchema, req.query);
  res.json(await reviewService.getItems(query));
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
// attention, including source-owned review obligations and actionable
// notifications.
router.get('/queue', asyncHandler(async (req, res) => {
  const { limit, cursor, view } = validateRequest(reviewQueueQuerySchema, req.query);
  const queue = await buildQueue({ limit, cursor, query: { ...(view ? { view } : {}) } });
  res.json(queue);
}));

router.post('/queue/delivery', asyncHandler(async (req, res) => {
  const { id } = validateRequest(deliverySchema, req.body);
  res.json(await claimQueueDelivery(id, 'toast'));
}));

// POST /api/review/queue/resolve — accept a single cross-domain queue row in
// place. Source-owned approvals carry an explicit operation so the mutation
// revalidates the owning domain instead of using generic Review completion.
router.post('/queue/resolve', asyncHandler(async (req, res) => {
  const { id, operation, rating, comment } = validateRequest(resolveQueueSchema, req.body);
  const input = { ...(rating ? { rating } : {}), ...(comment !== undefined ? { comment } : {}) };
  const result = operation
    ? (Object.keys(input).length ? await resolveQueueItem(id, operation, input) : await resolveQueueItem(id, operation))
    : await resolveQueueItem(id);
  reviewService.reviewEvents.emit('queue:changed');
  res.json(result);
}));

// POST /api/review/queue/triage — persist a presentation-only decision after
// the queue service re-reads the source and its current capabilities.
router.post('/queue/triage', asyncHandler(async (req, res) => {
  const { id, operation, snoozedUntil } = validateRequest(triageQueueSchema, req.body);
  const result = await triageQueueItem(id, operation, snoozedUntil ? { snoozedUntil } : {});
  reviewService.reviewEvents.emit('queue:changed');
  res.json(result);
}));

// POST /api/review/queue/promote-ask — promote an Ask row's latest assistant
// answer into Brain, a CoS task, or a Goal's progress, in place, without
// leaving the Review Hub. The `id` is the row's `ask:<conversationId>`; the
// service finds the latest assistant turn so the client doesn't track turn ids.
// Goal promotion supplies a `goalId` picked inline from the row's goalOptions.
router.post('/queue/promote-ask', asyncHandler(async (req, res) => {
  const { id, target, goalId } = validateRequest(promoteAskQueueSchema, req.body);
  const result = await promoteAskQueueItem(id, target, goalId);
  reviewService.reviewEvents.emit('queue:changed');
  res.json(result);
}));

// POST /api/review/todo — legacy compatibility endpoint. New Actions quick-add
// writes Brain threads; existing clients keep this endpoint and store shape.
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
