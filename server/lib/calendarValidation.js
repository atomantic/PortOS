/**
 * Zod schemas for the calendar daily-review and auto-configure routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { optionalString } from './sharedSchemas.js';

// Smaller single-purpose bodies
// GET /api/calendar/review/:date — bounded page of the day's events. The
// defaults reproduce the legacy single-page response.
export const dailyReviewQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});

export const calendarAutoConfigureBodySchema = z.object({
  email: optionalString,
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});
