/**
 * Zod schema for the review-queue query.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { emptyToUndefined } from './zodCompat.js';
import { MAX_REVIEW_QUEUE_SNOOZE_MS } from './reviewQueueLimits.js';

// GET /api/review/queue — pagination is opt-in so existing Review Hub clients
// keep receiving the legacy full-list envelope. Cursors are opaque and bounded
// before they reach the queue snapshot decoder.
export const reviewQueueQuerySchema = z.object({
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100).optional()),
  cursor: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(4096).optional()),
  view: z.preprocess(emptyToUndefined, z.enum(['today', 'all', 'waiting', 'someday', 'history', 'snoozed']).optional()),
}).strict();

export const createTodoSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().default('')
});

export const updateItemSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).optional()
});

export const bulkStatusSchema = z.object({
  status: z.enum(['completed', 'dismissed']),
  ids: z.array(z.string()).optional()
});

export const resolveQueueSchema = z.object({
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

export const deliverySchema = z.object({ id: z.string().min(1).max(500) });

export const triageQueueSchema = z.object({
  id: z.string().min(1).max(500),
  operation: z.enum(['snooze', 'unsnooze', 'dismiss']),
  snoozedUntil: z.string().datetime().optional(),
}).superRefine((value, context) => {
  if (value.operation === 'snooze' && !value.snoozedUntil) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'snoozedUntil is required for the snooze operation' });
  }
  if (value.operation === 'snooze' && value.snoozedUntil
    && Date.parse(value.snoozedUntil) - Date.now() > MAX_REVIEW_QUEUE_SNOOZE_MS) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'snoozedUntil cannot be more than 30 days in the future' });
  }
  if (value.operation !== 'snooze' && value.snoozedUntil !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['snoozedUntil'], message: 'snoozedUntil is only valid for the snooze operation' });
  }
});

export const promoteAskQueueSchema = z.object({
  id: z.string().min(1).max(500),
  target: z.enum(['brain', 'task', 'goal']),
  // Required when target === 'goal' (cross-field rule below); the row supplies
  // it from the goal picker. Ignored for brain/task.
  goalId: z.string().min(1).max(200).optional()
}).refine((v) => v.target !== 'goal' || !!v.goalId, {
  message: 'goalId is required when target is "goal"',
  path: ['goalId']
});
