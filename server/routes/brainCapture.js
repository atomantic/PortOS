/**
 * Brain Capture & Inbox Routes
 *
 * Capture/classify thoughts and manage the inbox log (review, fix, retry, done).
 */

import { Router } from 'express';
import * as brainService from '../services/brain.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  captureInputSchema,
  resolveReviewInputSchema,
  fixInputSchema,
  updateInboxInputSchema,
  markInboxSentToCatalogSchema,
  inboxQuerySchema
} from '../lib/brainValidation.js';

const router = Router();

/**
 * POST /api/brain/capture
 * Capture a thought, classify it, and store it
 */
router.post('/capture', asyncHandler(async (req, res) => {
  const { text, providerOverride, modelOverride, creative } = validateRequest(captureInputSchema, req.body);
  const result = await brainService.captureThought(text, providerOverride, modelOverride, { creative });
  res.json(result);
}));

/**
 * GET /api/brain/inbox
 * Get inbox log entries with optional filters
 */
router.get('/inbox', asyncHandler(async (req, res) => {
  const data = validateRequest(inboxQuerySchema, req.query);
  const [entries, counts] = await Promise.all([
    brainService.getInboxLog(data),
    brainService.getInboxLogCounts(),
  ]);
  res.json({ entries, counts });
}));

/**
 * GET /api/brain/inbox/:id
 * Get a single inbox log entry
 */
router.get('/inbox/:id', asyncHandler(async (req, res) => {
  const entry = await brainService.getInboxLogById(req.params.id);
  if (!entry) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(entry);
}));

/**
 * POST /api/brain/review/resolve
 * Resolve a needs_review inbox item
 */
router.post('/review/resolve', asyncHandler(async (req, res) => {
  const { inboxLogId, destination, editedExtracted } = validateRequest(resolveReviewInputSchema, req.body);
  const result = await brainService.resolveReview(inboxLogId, destination, editedExtracted);
  res.json(result);
}));

/**
 * POST /api/brain/fix
 * Fix/correct a filed inbox item
 */
router.post('/fix', asyncHandler(async (req, res) => {
  const { inboxLogId, newDestination, updatedFields, note } = validateRequest(fixInputSchema, req.body);
  const result = await brainService.fixClassification(inboxLogId, newDestination, updatedFields, note);
  res.json(result);
}));

/**
 * POST /api/brain/inbox/:id/retry
 * Retry AI classification for a needs_review item
 */
router.post('/inbox/:id/retry', asyncHandler(async (req, res) => {
  const { providerOverride, modelOverride } = req.body || {};
  const result = await brainService.retryClassification(req.params.id, providerOverride, modelOverride);
  res.json(result);
}));

/**
 * POST /api/brain/inbox/:id/done
 * Mark an inbox entry as done
 */
router.post('/inbox/:id/done', asyncHandler(async (req, res) => {
  const result = await brainService.markInboxDone(req.params.id);
  if (!result) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * POST /api/brain/inbox/sent-to-catalog
 * Mark a batch of creative inbox notes as consumed by a committed catalog ingest.
 * Literal path — declared before the `/inbox/:id` routes so it isn't shadowed.
 */
router.post('/inbox/sent-to-catalog', asyncHandler(async (req, res) => {
  const { ids } = validateRequest(markInboxSentToCatalogSchema, req.body);
  const updated = await brainService.markInboxSentToCatalog(ids);
  res.json({ updated, count: updated.length });
}));

/**
 * PUT /api/brain/inbox/:id
 * Update an inbox entry (edit captured text)
 */
router.put('/inbox/:id', asyncHandler(async (req, res) => {
  const data = validateRequest(updateInboxInputSchema, req.body);
  const result = await brainService.updateInboxEntry(req.params.id, data);
  if (!result) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(result);
}));

/**
 * DELETE /api/brain/inbox/:id
 * Delete an inbox entry
 */
router.delete('/inbox/:id', asyncHandler(async (req, res) => {
  const deleted = await brainService.deleteInboxEntry(req.params.id);
  if (!deleted) {
    throw new ServerError('Inbox entry not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.status(204).send();
}));

export default router;
