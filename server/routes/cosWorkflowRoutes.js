/**
 * CoS Workflow Routes — exposes the canonical scheduled-task workflow graph
 * (stages, nodes, dependency edges) for the Workflow visualizer tab.
 */

import { Router } from 'express';
import { getWorkflowGraph, WORKFLOW_STAGES } from '../services/workflow.js';
import { asyncHandler } from '../lib/errorHandler.js';

const router = Router();

router.get('/workflow', asyncHandler(async (req, res) => {
  const graph = await getWorkflowGraph();
  res.json(graph);
}));

router.get('/workflow/stages', (req, res) => {
  res.json({ stages: WORKFLOW_STAGES });
});

export default router;
