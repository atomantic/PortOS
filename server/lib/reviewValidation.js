/**
 * Zod schema for the review-queue query.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { emptyToUndefined } from './zodCompat.js';

// GET /api/review/queue — pagination is opt-in so existing Review Hub clients
// keep receiving the legacy full-list envelope. Cursors are opaque and bounded
// before they reach the queue snapshot decoder.
export const reviewQueueQuerySchema = z.object({
  limit: z.preprocess(emptyToUndefined, z.coerce.number().int().min(1).max(100).optional()),
  cursor: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(4096).optional()),
  view: z.preprocess(emptyToUndefined, z.enum(['today', 'all', 'waiting', 'someday', 'history', 'snoozed']).optional()),
}).strict();
