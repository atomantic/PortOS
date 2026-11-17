/**
 * Pipeline canon-readiness routes — descriptive-integrity check for the canon
 * entities (characters/places/objects) an issue or series will actually render.
 * Read-only; powers the production sign-off gate (and the same check Series
 * Autopilot runs before drafting visuals).
 *
 *   GET /series/:id/canon-readiness  → { seriesId, ready, issues[], blockingIssues[], undescribed[] }
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import { checkSeriesCanonReadiness } from '../../services/pipeline/canonReadiness.js';
import { mapServiceError } from './shared.js';

const router = Router();

router.get('/series/:id/canon-readiness', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const report = await checkSeriesCanonReadiness(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(report);
}));

export default router;
