import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { getShippedModelComparison } from '../services/modelComparison.js';

/** Read-only public dataset bundled with this PortOS release. */
export function createModelComparisonRoutes() {
  const router = Router();
  router.get('/', asyncHandler(async (_req, res) => {
    res.json(await getShippedModelComparison());
  }));
  return router;
}
