/**
 * Pipeline editorial routes — editorial roadmap / reader-emotion analysis,
 * per-issue and series-wide (batch with SSE progress).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validation.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as editorialAnalysis from '../../services/pipeline/editorialAnalysis.js';
import * as editorialRunner from '../../services/pipeline/editorialAnalysisRunner.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Editorial reader-emotion analysis — provider/model optional (falls through
// to the active or stage-pinned provider); `force` re-analyzes unchanged issues.
const editorialAnalyzeSchema = z.object({
  providerId: z.string().trim().max(80).optional(),
  model: z.string().trim().max(200).optional(),
  force: z.boolean().optional(),
});

// Aggregate roadmap (Plot / Character / Reader curves + character arcs + coverage)
router.get('/series/:id/editorial', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await editorialAnalysis.getSeriesEditorial(req.params.id));
}));

// Full per-issue snapshot (section-by-section emotion log + character arcs)
router.get('/issues/:id/editorial', asyncHandler(async (req, res) => {
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  const analysis = await editorialAnalysis.getIssueAnalysis(req.params.id);
  res.json(analysis || { issueId: req.params.id, status: 'none' });
}));

// Analyze ONE issue (synchronous — returns the finished snapshot)
router.post('/issues/:id/editorial/analyze', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialAnalyzeSchema, req.body ?? {});
  await issuesSvc.getIssue(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(await editorialAnalysis.analyzeIssue(req.params.id, body));
}));

// Analyze the whole series (batch — progress via SSE)
router.post('/series/:id/editorial/analyze', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialAnalyzeSchema, req.body ?? {});
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = await editorialRunner.startSeriesAnalysis(req.params.id, body);
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/editorial/analyze/progress`,
  });
}));

router.get('/series/:id/editorial/analyze/progress', (req, res) => {
  const attached = editorialRunner.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active editorial analysis for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight batch.
router.get('/series/:id/editorial/analyze/status', (req, res) => {
  res.json({ active: editorialRunner.isSeriesAnalysisActive(req.params.id) });
});

router.post('/series/:id/editorial/analyze/cancel', asyncHandler(async (req, res) => {
  const canceled = editorialRunner.cancelSeriesAnalysis(req.params.id);
  res.json({ canceled });
}));

export default router;
