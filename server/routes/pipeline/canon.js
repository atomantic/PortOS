/**
 * Pipeline canon-readiness routes — descriptive-integrity check for the canon
 * entities (characters/places/objects) an issue or series will actually render.
 * Read-only; powers the production sign-off gate (and the same check Series
 * Autopilot runs before drafting visuals).
 *
 *   GET /issues/:id/canon-readiness  → { issueId, referenced, none[], thin[], ready }
 *   GET /series/:id/canon-readiness  → { seriesId, ready, issues[], blockingIssues[], undescribed[] }
 */

import { Router } from 'express';
import { asyncHandler } from '../../lib/errorHandler.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import { checkIssueCanonReadiness, checkSeriesCanonReadiness } from '../../services/pipeline/canonReadiness.js';
import { mapServiceError } from './shared.js';

const router = Router();

router.get('/issues/:id/canon-readiness', asyncHandler(async (req, res) => {
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const report = await checkIssueCanonReadiness(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(report);
}));

router.get('/series/:id/canon-readiness', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const report = await checkSeriesCanonReadiness(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(report);
}));

export default router;
