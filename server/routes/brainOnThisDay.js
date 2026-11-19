/**
 * On This Day route — past-year journal entries and Brain captures for the
 * dashboard widget. The server owns the timezone-correct date key (same
 * contract as /api/calendar/agenda).
 */

import { Router } from 'express';
import { getOnThisDay } from '../services/brainOnThisDay.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { limitQuerySchema, parsePagination } from '../lib/queryValidation.js';

const router = Router();

router.get('/on-this-day', asyncHandler(async (req, res) => {
  const { limit } = parsePagination(validateRequest(limitQuerySchema, req.query), { defaultLimit: 8, maxLimit: 20 });
  res.json(await getOnThisDay({ limit }));
}));

export default router;
