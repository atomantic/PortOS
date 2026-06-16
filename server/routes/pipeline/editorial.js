/**
 * Pipeline editorial routes — editorial roadmap / reader-emotion analysis,
 * per-issue and series-wide (batch with SSE progress).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest, editorialCheckConfigSchema, editorialChecksRunSchema } from '../../lib/validation.js';
import { getCheck, resolveCheckState } from '../../lib/editorial/index.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as editorialAnalysis from '../../services/pipeline/editorialAnalysis.js';
import * as editorialRunner from '../../services/pipeline/editorialAnalysisRunner.js';
import * as checkRunner from '../../services/pipeline/editorial/checkRunner.js';
import { getSettings, updateSettingsWith } from '../../services/settings.js';
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

// ---------------------------------------------------------------------------
// Editorial checks (#1284) — registry-driven editorial review.
// ---------------------------------------------------------------------------

// The full check catalog merged with persisted enable/config state.
router.get('/editorial/checks', asyncHandler(async (req, res) => {
  const settings = await getSettings();
  res.json({ checks: resolveCheckState(settings) });
}));

// Enable/disable a check or update its config. Config is validated against the
// check's own Zod schema before persisting (the wire shape is gated by
// editorialCheckConfigSchema first).
router.patch('/editorial/checks/:id', asyncHandler(async (req, res) => {
  const check = getCheck(req.params.id);
  if (!check) throw new ServerError(`Unknown editorial check: ${req.params.id}`, { status: 404 });
  const body = validateRequest(editorialCheckConfigSchema, req.body ?? {});
  if (body.config !== undefined) {
    const parsed = check.configSchema.safeParse(body.config);
    if (!parsed.success) {
      throw new ServerError(`Invalid config for ${check.id}: ${parsed.error.issues?.[0]?.message || 'validation failed'}`, { status: 400 });
    }
  }
  const updated = await updateSettingsWith((current) => {
    const slice = current.pipelineEditorialChecks && typeof current.pipelineEditorialChecks === 'object'
      ? current.pipelineEditorialChecks : {};
    const checks = slice.checks && typeof slice.checks === 'object' ? slice.checks : {};
    const prev = checks[check.id] && typeof checks[check.id] === 'object' ? checks[check.id] : {};
    const nextEntry = { ...prev };
    if (body.enabled !== undefined) nextEntry.enabled = body.enabled;
    if (body.config !== undefined) nextEntry.config = body.config;
    return { ...current, pipelineEditorialChecks: { ...slice, checks: { ...checks, [check.id]: nextEntry } } };
  });
  res.json(resolveCheckState(updated).find((r) => r.id === check.id));
}));

// Run all enabled checks (or a named subset) for a series — progress via SSE.
router.post('/series/:id/editorial/checks/run', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialChecksRunSchema, req.body ?? {});
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const result = checkRunner.startEditorialChecksRun(req.params.id, {
    checkIds: body.checkIds,
    providerOverride: body.providerId,
    modelOverride: body.model,
  });
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/editorial/checks/run/progress`,
  });
}));

router.get('/series/:id/editorial/checks/run/progress', (req, res) => {
  const attached = checkRunner.attachClient(req.params.id, res);
  if (!attached) {
    throw new ServerError('No active editorial checks run for this series', { status: 404 });
  }
});

// Lightweight probe so a (re)mounting client can re-attach to an in-flight run.
router.get('/series/:id/editorial/checks/run/status', (req, res) => {
  res.json({ active: checkRunner.isEditorialChecksActive(req.params.id) });
});

router.post('/series/:id/editorial/checks/run/cancel', asyncHandler(async (req, res) => {
  res.json({ canceled: checkRunner.cancelEditorialChecks(req.params.id) });
}));

export default router;
