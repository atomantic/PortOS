/**
 * Music Video spend routes (#16506): the project's render spend by lane, and the manual
 * adjustments a user makes to true it up against a provider's balance.
 */
import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { musicVideoSpendAdjustmentSchema } from '../lib/musicVideo/routeValidation/misc.js';
import { projectSpend } from '../lib/musicVideo/musicVideoSpend.js';
import { currentRun } from '../lib/musicVideo/musicVideoSummary.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { adjustProjectSpend, removeProjectSpendAdjustment } from '../services/musicVideo/renderSpend.js';

const router = Router();

const spendResponse = (project, renderSpend) => {
  const withLedger = { ...project, renderSpend };
  return { renderSpend, spend: projectSpend(withLedger, currentRun(withLedger)) };
};

router.post('/:id/spend/adjustments', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoSpendAdjustmentSchema, req.body ?? {});
  const project = await requireProject(req.params.id);
  const { adjustment, renderSpend } = await adjustProjectSpend(project, input);
  res.status(201).json({ adjustment, ...spendResponse(project, renderSpend) });
}));

router.delete('/:id/spend/adjustments/:adjustmentId', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  const { renderSpend } = await removeProjectSpendAdjustment(project, req.params.adjustmentId);
  res.json(spendResponse(project, renderSpend));
}));

export default router;
