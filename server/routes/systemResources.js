/**
 * System Resources — explicit storage report and AI-assisted cleanup triage.
 *
 * Both routes are POSTs because a report performs bounded, potentially slow
 * disk scans. Nothing runs at boot or merely because a dashboard widget polls.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { EFFORT_LEVELS } from '../lib/providerModels.js';
import { getSystemResourceReport, triageSystemResources } from '../services/systemResources.js';

const router = Router();
const emptyBodySchema = z.object({}).strict();

const blankToUndefined = (value) => {
  const trimmed = (value ?? '').trim();
  return trimmed || undefined;
};

export const systemResourceTriageSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().max(256).optional().transform(blankToUndefined),
  effort: z.string().max(64).optional().transform(blankToUndefined)
    .refine((value) => value === undefined || EFFORT_LEVELS.includes(value), 'Unsupported effort level'),
}).strict();

router.post('/report', asyncHandler(async (req, res) => {
  validateRequest(emptyBodySchema, req.body || {});
  res.json(await getSystemResourceReport({ force: true }));
}));

router.post('/triage', asyncHandler(async (req, res) => {
  const input = validateRequest(systemResourceTriageSchema, req.body || {});
  res.json(await triageSystemResources(input));
}));

export default router;
