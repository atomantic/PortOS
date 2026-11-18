/**
 * CoS Workflow Routes — exposes the canonical scheduled-task workflow graph
 * (stages, nodes, dependency edges) for the Workflow visualizer tab.
 */

import { Router } from 'express';
import { getWorkflowGraph } from '../services/workflow.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { cosWorkflowQuerySchema } from '../lib/cos/cosValidation.js';

const router = Router();

router.get('/workflow', asyncHandler(async (req, res) => {
  const requestedHours = Number.parseInt(validateRequest(cosWorkflowQuerySchema, req.query).hours, 10);
  const horizonHours = [24, 168].includes(requestedHours) ? requestedHours : 24;
  const graph = await getWorkflowGraph({ horizonHours });
  res.json(graph);
}));

export default router;
