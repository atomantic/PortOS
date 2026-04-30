import express from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as reviewService from '../services/review.js';

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
