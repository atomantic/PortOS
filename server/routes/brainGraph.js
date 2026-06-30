/**
 * Brain Graph Routes
 *
 * Bounded knowledge-graph data for the visualization (search index + overview /
 * focused neighborhood).
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { brainGraphQuerySchema } from '../lib/brainValidation.js';
import {
  getBrainGraphSearchIndex,
  getBrainGraphOverview,
  getBrainGraphNeighborhood
} from '../services/brainGraph.js';

const router = Router();

/**
 * GET /api/brain/graph/search-index
 * Lightweight {id,label,brainType} list of every node, for the client search
 * box. No edges — cheap even at thousands of nodes.
 */
router.get('/graph/search-index', asyncHandler(async (_req, res) => {
  const data = await getBrainGraphSearchIndex();
  res.json(data);
}));

/**
 * GET /api/brain/graph?focus=<id>&limit=<n>
 * Bounded graph data for visualization. No `focus` → an overview of the most-
 * connected nodes; a `focus` → that node's neighborhood. Never the full graph
 * (which crashes the browser at scale).
 */
router.get('/graph', asyncHandler(async (req, res) => {
  const { focus, limit } = validateRequest(brainGraphQuerySchema, req.query);
  const data = focus
    ? await getBrainGraphNeighborhood({ focusId: focus, limit })
    : await getBrainGraphOverview({ limit });
  res.json(data);
}));

export default router;
