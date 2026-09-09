/**
 * Universe relationship graph — the read model behind the Graph tab.
 *
 * Scoped under `/:id`, so mount order relative to crud.js doesn't matter.
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import { buildUniverseGraph } from '../../services/universeGraph.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Nodes + edges for one universe: canon entries, the links authored on them,
// the series/issues they appear in, and their rendered references. Read-only
// aggregation over records that already exist — no writes, no LLM calls.
router.get('/:id/graph', asyncHandler(async (req, res) => {
  const result = await buildUniverseGraph(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
