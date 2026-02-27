/**
 * Search Routes
 *
 * GET /api/search?q=<query>
 *   Fan-out keyword search across all PortOS data sources.
 *   Returns categorized results grouped by source.
 */

import { Router } from 'express';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest, searchQuerySchema } from '../lib/validation.js';
import { fanOutSearch } from '../services/search.js';

const router = Router();

// GET /api/search?q=<query>
router.get('/', asyncHandler(async (req, res) => {
  const { q } = validateRequest(searchQuerySchema, req.query);
  const sources = await fanOutSearch(q);
  res.json({ query: q, sources });
}));

export default router;
