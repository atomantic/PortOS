import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as humanActivity from '../services/humanActivity.js';

const router = Router();

const dayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const eventsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  source: z.string().max(64).optional(),
  kind: z.string().max(64).optional(),
  personId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

// Day view — all activity on a local calendar day plus an hourly histogram and
// source/kind tallies. `date` (YYYY-MM-DD) defaults to today in the user's tz;
// the URL is the source of truth for the selected day on the /timeline page.
router.get('/day', asyncHandler(async (req, res) => {
  const { date } = validateRequest(dayQuerySchema, req.query);
  const summary = await humanActivity.getDaySummary({ date });
  res.json(summary);
}));

// Filtered raw event list (from/to/source/kind/personId). Newest first.
router.get('/events', asyncHandler(async (req, res) => {
  const filters = validateRequest(eventsQuerySchema, req.query);
  const events = await humanActivity.listEvents(filters);
  res.json({ events });
}));

export default router;
