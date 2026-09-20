import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { reviewQueueQuerySchema, validateRequest } from '../lib/validation.js';
import * as reviewService from '../services/review.js';
import { buildQueue, resolveQueueItem, triageQueueItem, promoteAskQueueItem } from '../services/reviewQueue.js';

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
// attention, including source-owned review obligations and actionable
// notifications.
router.get('/queue', asyncHandler(async (req, res) => {
  const { limit, cursor, view } = validateRequest(reviewQueueQuerySchema, req.query);
  const queue = await buildQueue({ limit, cursor, query: { ...(view ? { view } : {}) } });
  res.json(queue);
}));

const resolveQueueSchema = z.object({
  id: z.string().min(1).max(500),
  operation: z.enum(['resolve', 'approve', 'reject', 'complete', 'reopen', 'rate']).optional(),
  rating: z.enum(['positive', 'negative', 'neutral']).optional(),
  comment: z.string().max(5000).optional(),
}).superRefine((value, context) => {
  if (value.operation === 'rate' && !value.rating) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['rating'], message: 'rating is required for the rate operation' });
  }
  if (value.operation !== 'rate' && (value.rating !== undefined || value.comment !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['operation'], message: 'rating and comment are only valid for the rate operation' });
  }
});

// POST /api/review/queue/resolve — accept a single cross-domain queue row in
// place. Source-owned approvals carry an explicit operation so the mutation
// revalidates the owning domain instead of using generic Review completion.
router.post('/queue/resolve', asyncHandler(async (req, res) => {
  const { id, operation, rating, comment } = validateRequest(resolveQueueSchema, req.body);
  const input = { ...(rating ? { rating } : {}), ...(comment !== undefined ? { comment } : {}) };
  const result = operation
    ? (Object.keys(input).length ? await resolveQueueItem(id, operation, input) : await resolveQueueItem(id, operation))
    : await resolveQueueItem(id);
  res.json(result);
}));

const triageQueueSchema = z.object({
  id: z.string().min(1).max(500),
  operation: z.enum(['snooze', 'unsnooze', 'dismiss']),
  snoozedUntil: z.string().datetime().optional(),
}).superRefine((value, context) => {
  if (value.operation === 'snooze' && !value.snoozedUntil) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'snoozedUntil is required for the snooze operation' });
  }
  if (value.operation !== 'snooze' && value.snoozedUntil !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'snoozedUntil is only valid for the snooze operation' });
  }
});

// POST /api/review/queue/triage — persist a presentation-only decision after
// the queue service re-reads the source and its current capabilities.
router.post('/queue/triage', asyncHandler(async (req, res) => {
  const { id, operation, snoozedUntil } = validateRequest(triageQueueSchema, req.body);
  const result = await triageQueueItem(id, operation, snoozedUntil ? { snoozedUntil } : {});
  res.json(result);
}));

const promoteAskQueueSchema = z.object({
  id: z.string().min(1).max(500),
  target: z.enum(['brain', 'task', 'goal']),
  // Required when target === 'goal' (cross-field rule below); the row supplies
  // it from the goal picker. Ignored for brain/task.
  goalId: z.string().min(1).max(200).optional()
}).refine((v) => v.target !== 'goal' || !!v.goalId, {
  message: 'goalId is required when target is "goal"',
  path: ['goalId']
});

// POST /api/review/queue/promote-ask — promote an Ask row's latest assistant
// answer into Brain, a CoS task, or a Goal's progress, in place, without
// leaving the Review Hub. The `id` is the row's `ask:<conversationId>`; the
// service finds the latest assistant turn so the client doesn't track turn ids.
// Goal promotion supplies a `goalId` picked inline from the row's goalOptions.
router.post('/queue/promote-ask', asyncHandler(async (req, res) => {
  const { id, target, goalId } = validateRequest(promoteAskQueueSchema, req.body);
  const result = await promoteAskQueueItem(id, target, goalId);
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
