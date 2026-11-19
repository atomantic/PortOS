/**
 * Client Error Reporter Routes
 *
 * POST /api/client-errors — receive a browser-side error report. Aggregation
 * (rate-limit + dedup + redaction) happens in services/clientErrors.js; the
 * response surfaces accepted/duplicate/rate-limited so the client can log it
 * but never retry — duplicates are expected during render storms.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { recordClientError } from '../services/clientErrors.js';
import { clientErrorReportSchema } from '../lib/clientErrorValidation.js';

const router = Router();

router.post('/', asyncHandler(async (req, res) => {
  const payload = validateRequest(clientErrorReportSchema, req.body);
  const result = await recordClientError(payload);
  res.status(202).json(result);
}));

export default router;
