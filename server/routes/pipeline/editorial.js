/**
 * Pipeline editorial routes — editorial roadmap / reader-emotion analysis,
 * per-issue and series-wide (batch with SSE progress).
 */

import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import {
  validateRequest,
  editorialCheckConfigSchema,
  editorialChecksRunSchema,
  editorialCustomCheckCreateSchema,
  editorialCustomCheckUpdateSchema,
} from '../../lib/validation.js';
import {
  resolveCheckState,
  readChecksSlice,
  readReadinessGate,
  getCheckById,
  readCustomCheckDefs,
  isCustomCheckId,
  CUSTOM_CHECK_ID_PREFIX,
} from '../../lib/editorial/index.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as editorialAnalysis from '../../services/pipeline/editorialAnalysis.js';
import * as editorialRunner from '../../services/pipeline/editorialAnalysisRunner.js';
import * as checkRunner from '../../services/pipeline/editorial/checkRunner.js';
import { getSeriesHealth, READINESS_GATES, DEFAULT_READINESS_GATE } from '../../services/pipeline/editorialScore.js';
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

// ---------------------------------------------------------------------------
// Editorial health score + revision-trend tracking (#1316).
// ---------------------------------------------------------------------------

// Editorial health for a series: the transparent severity-weighted score (per
// series + per issue), the readiness signal, and the revision trend +
// regressions. Reads the same manuscript-review findings the triage view shows.
router.get('/series/:id/editorial/health', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const settings = await getSettings();
  const gate = readReadinessGate(settings) || DEFAULT_READINESS_GATE;
  res.json(await getSeriesHealth(req.params.id, { gate }));
}));

// Set the editorial-health readiness gate (the convergence signal the autopilot
// loop + UI read as "manuscript clean"). Persists into the same
// `pipelineEditorialChecks` settings slice as the per-check enable/config state.
const readinessGateSchema = z.object({ readinessGate: z.enum([...READINESS_GATES]) }).strict();
router.patch('/editorial/readiness-gate', asyncHandler(async (req, res) => {
  const body = validateRequest(readinessGateSchema, req.body ?? {});
  const updated = await updateSettingsWith((current) => {
    const slice = current.pipelineEditorialChecks && typeof current.pipelineEditorialChecks === 'object'
      ? current.pipelineEditorialChecks : {};
    return { ...current, pipelineEditorialChecks: { ...slice, readinessGate: body.readinessGate } };
  });
  res.json({ readinessGate: readReadinessGate(updated) || DEFAULT_READINESS_GATE });
}));

// Enable/disable a check or update its config. Config is validated against the
// check's own Zod schema before persisting (the wire shape is gated by
// editorialCheckConfigSchema first).
router.patch('/editorial/checks/:id', asyncHandler(async (req, res) => {
  // Resolve against built-ins + custom checks so a custom check's enable/config
  // override goes through the same path as a built-in's (#1346).
  const settings = await getSettings();
  const check = getCheckById(settings, req.params.id);
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
    const checks = readChecksSlice(current);
    const prev = checks[check.id] && typeof checks[check.id] === 'object' ? checks[check.id] : {};
    const nextEntry = { ...prev };
    if (body.enabled !== undefined) nextEntry.enabled = body.enabled;
    if (body.config !== undefined) nextEntry.config = body.config;
    return { ...current, pipelineEditorialChecks: { ...slice, checks: { ...checks, [check.id]: nextEntry } } };
  });
  res.json(resolveCheckState(updated).find((r) => r.id === check.id));
}));

// ---------------------------------------------------------------------------
// User-defined checks (#1346) — author LLM checks (name + prompt + scope) with
// no code change. The DEFINITION lives in settings.pipelineEditorialChecks.
// customChecks[]; enable/config still flow through PATCH /editorial/checks/:id.
// ---------------------------------------------------------------------------

const editorialChecksSlice = (current) =>
  (current.pipelineEditorialChecks && typeof current.pipelineEditorialChecks === 'object'
    ? current.pipelineEditorialChecks : {});

// Create a custom check. Returns its resolved catalog row (so the UI can append
// it without a refetch).
router.post('/editorial/custom-checks', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialCustomCheckCreateSchema, req.body ?? {});
  const id = `${CUSTOM_CHECK_ID_PREFIX}${randomUUID()}`;
  const now = new Date().toISOString();
  const def = { id, ...body, createdAt: now, updatedAt: now };
  const updated = await updateSettingsWith((current) => {
    const slice = editorialChecksSlice(current);
    const defs = Array.isArray(slice.customChecks) ? slice.customChecks : [];
    return { ...current, pipelineEditorialChecks: { ...slice, customChecks: [...defs, def] } };
  });
  res.status(201).json(resolveCheckState(updated).find((r) => r.id === id));
}));

// Edit a custom check's definition (label / prompt / scope / category / severity).
router.patch('/editorial/custom-checks/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isCustomCheckId(id)) throw new ServerError('Not a custom check id', { status: 400 });
  const body = validateRequest(editorialCustomCheckUpdateSchema, req.body ?? {});
  const settings = await getSettings();
  if (!readCustomCheckDefs(settings).some((d) => d?.id === id)) {
    throw new ServerError(`Unknown custom check: ${id}`, { status: 404 });
  }
  const updated = await updateSettingsWith((current) => {
    const slice = editorialChecksSlice(current);
    const defs = Array.isArray(slice.customChecks) ? slice.customChecks : [];
    // Preserve id + createdAt; apply only the supplied fields; stamp updatedAt.
    // `body` carries only the fields the caller actually supplied (the update
    // schema has no defaults), so an omitted field is left unchanged.
    const next = defs.map((d) => (d?.id === id
      ? { ...d, ...body, id: d.id, createdAt: d.createdAt, updatedAt: new Date().toISOString() }
      : d));
    return { ...current, pipelineEditorialChecks: { ...slice, customChecks: next } };
  });
  res.json(resolveCheckState(updated).find((r) => r.id === id));
}));

// Delete a custom check — drops both its definition and its enable/config override.
router.delete('/editorial/custom-checks/:id', asyncHandler(async (req, res) => {
  const id = req.params.id;
  if (!isCustomCheckId(id)) throw new ServerError('Not a custom check id', { status: 400 });
  const settings = await getSettings();
  if (!readCustomCheckDefs(settings).some((d) => d?.id === id)) {
    throw new ServerError(`Unknown custom check: ${id}`, { status: 404 });
  }
  await updateSettingsWith((current) => {
    const slice = editorialChecksSlice(current);
    const defs = Array.isArray(slice.customChecks) ? slice.customChecks : [];
    const checks = readChecksSlice(current);
    const { [id]: _removed, ...remainingChecks } = checks;
    return {
      ...current,
      pipelineEditorialChecks: {
        ...slice,
        customChecks: defs.filter((d) => d?.id !== id),
        checks: remainingChecks,
      },
    };
  });
  res.json({ deleted: true, id });
}));

// Run all enabled checks (or a named subset) for a series — progress via SSE.
router.post('/series/:id/editorial/checks/run', asyncHandler(async (req, res) => {
  const body = validateRequest(editorialChecksRunSchema, req.body ?? {});
  // Reject unknown check ids up front — otherwise a typo'd subset is silently
  // filtered to a zero-check run that reports success (PATCH 404s unknown ids too).
  if (body.checkIds?.length) {
    const settings = await getSettings();
    const unknown = body.checkIds.filter((id) => !getCheckById(settings, id));
    if (unknown.length) {
      throw new ServerError(`Unknown editorial check(s): ${unknown.join(', ')}`, { status: 400 });
    }
  }
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
