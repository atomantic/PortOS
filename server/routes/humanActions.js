/**
 * Human action plans — schedule steps only the person can take as Brain
 * threads with reminders (see services/humanActions.js).
 *
 * Mounted at /api/human-actions. Agents call POST /plans (via
 * `node scripts/portos-api.js`) to hand the person a dated, explicit step with
 * its ready-to-paste text instead of a chat message they'll lose.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { humanActionPlanSchema } from '../lib/humanActions.js';
import { listHumanActions, scheduleHumanActionPlan } from '../services/humanActions.js';

const router = Router();

const listQuerySchema = z.object({
  planKey: z.string().trim().min(1).max(40).optional(),
  includeDone: z.enum(['true', 'false']).optional(),
}).strict();

router.get('/', asyncHandler(async (req, res) => {
  const { planKey, includeDone } = validateRequest(listQuerySchema, req.query);
  res.json({ actions: await listHumanActions({ planKey: planKey || null, includeDone: includeDone === 'true' }) });
}));

router.post('/plans', asyncHandler(async (req, res) => {
  const plan = validateRequest(humanActionPlanSchema, req.body ?? {});
  res.status(201).json(await scheduleHumanActionPlan(plan));
}));

export default router;
