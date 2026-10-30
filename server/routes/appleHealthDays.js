/**
 * DELETE /api/apple-health/days/:date
 *
 * A separate router from `/api/health`: remounting that router here would
 * publish every ingest route twice. The route graph binds a file's default
 * export, so this module's only router is the day delete.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { appleHealthDayParamSchema } from '../lib/appleHealthValidation.js';
import { deleteHealthDay } from '../services/appleHealthIngest.js';

const router = Router();

router.delete('/days/:date', asyncHandler(async (req, res) => {
  const { date } = validateRequest(appleHealthDayParamSchema, req.params);
  const removed = await deleteHealthDay(date);
  if (!removed) {
    throw new ServerError('Health day not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(removed);
}));

export default router;
