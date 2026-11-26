/**
 * Pipeline series routes — Series CRUD (the long-lived narrative bible),
 * duplicate detection/merge, title-logo generation, the per-series issue
 * list/create pair, and season CRUD.
 */

import { Router } from 'express';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../../lib/queryValidation.js';
import {
  issuesListQuerySchema,
  seriesCreateSchema,
  seriesPatchSchema,
  arcFieldLockSchema,
  seasonCreateSchema,
  seasonPatchSchema,
  seasonDeleteSchema,
  issueCreateSchema,
  seriesMergeSchema,
  seriesMergeAIResolveSchema,
  seriesGenerateSchema,
  titleLogoGenerateSchema,
  voiceDiscoverSchema,
} from '../../lib/pipelineValidation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as issuesSvc from '../../services/pipeline/issues.js';
import * as seasonsSvc from '../../services/pipeline/seasons.js';
import { findDuplicateSeriesGroups, findSameNameSeries } from '../../services/duplicateDetection.js';
import { mergeSeries } from '../../services/recordMerge.js';
import { mergeFieldsWithAI } from '../../services/recordMergeAI.js';
import { generateSeriesTitleLogo } from '../../services/pipeline/seriesTitleLogo.js';
import { generateSeriesConcepts } from '../../services/pipeline/seriesGenerate.js';
import { discoverSeriesVoice } from '../../services/pipeline/seriesVoiceDiscover.js';
import { mapServiceError } from './shared.js';

const router = Router();

// =====================
// Series routes
// =====================

router.get('/series', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const series = await seriesSvc.listSeries();
  if (!isPaginationRequested(page)) return res.json(series);
  res.json(paginateArray(series, page, { defaultLimit: 50, maxLimit: 500 }));
}));

router.get('/series/names', asyncHandler(async (_req, res) => {
  res.json(await seriesSvc.listSeriesNames());
}));

router.get('/series/summaries', asyncHandler(async (_req, res) => {
  res.json(await seriesSvc.listSeriesSummaries());
}));

router.post('/series', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesCreateSchema, req.body ?? {});
  // Hierarchy invariant: every series belongs to exactly one universe. Enforce
  // it for all HTTP callers here (the UI already enforces it client-side).
  // The schema stays permissive (nullable) so the importer + mergeSeriesFromSync,
  // which call createSeries directly, can still land legacy orphans from peers.
  if (!body.universeId || !String(body.universeId).trim()) {
    throw new ServerError('A universe is required — a series must belong to a universe.', {
      status: 400, code: seriesSvc.ERR_VALIDATION,
    });
  }
  const created = await seriesSvc.createSeries(body);
  // Non-blocking same-name warning, scoped within the universe (route layer
  // only, so the importer's direct createSeries never pays for the scan).
  const duplicateName = await findSameNameSeries(created.name, created.universeId, { excludeId: created.id });
  res.status(201).json(duplicateName.length ? { ...created, _warnings: { duplicateName } } : created);
}));

// ---- Series duplicate resolution (static paths — keep BEFORE `/series/:id`) ----

router.get('/series/duplicates', asyncHandler(async (_req, res) => {
  res.json(await findDuplicateSeriesGroups());
}));

router.post('/series/merge/preview', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const preview = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { dryRun: true, fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(preview);
}));

router.post('/series/merge', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeSchema, req.body ?? {});
  const result = await mergeSeries(body.survivorId, body.loserId, body.fieldChoices, { fieldOverrides: body.fieldOverrides })
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Ask the configured AI provider to merge specific conflicting text fields
// into a single unified value per field. Same shape as the universe-side
// /universe-builder/merge/ai-resolve route.
router.post('/series/merge/ai-resolve', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesMergeAIResolveSchema, req.body ?? {});
  const [survivor, loser] = await Promise.all([
    seriesSvc.getSeries(body.survivorId).catch((err) => { throw mapServiceError(err); }),
    seriesSvc.getSeries(body.loserId).catch((err) => { throw mapServiceError(err); }),
  ]);
  const result = await mergeFieldsWithAI({
    kind: 'series',
    survivor,
    loser,
    fields: body.fields,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

// Multi-concept series ideation (#2180, CWQE Phase 15): invent SEVERAL distinct
// candidate concepts from a universe, under an anti-generic banlist, WITHOUT
// persisting — the New Series form presents them for the user to pick (deep-
// linkable selection). The rejected candidates live in run history so the user
// can switch without regenerating. Static path: keep BEFORE `/series/:id`.
router.post('/series/generate-concept', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesGenerateSchema, req.body ?? {});
  const result = await generateSeriesConcepts(body.universeId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.get('/series/:id', asyncHandler(async (req, res) => {
  const s = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.patch('/series/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(seriesPatchSchema, req.body ?? {});
  const s = await seriesSvc.updateSeries(req.params.id, body).catch((err) => { throw mapServiceError(err); });
  if ('name' in body || 'universeId' in body) {
    const duplicateName = await findSameNameSeries(s.name, s.universeId, { excludeId: req.params.id });
    if (duplicateName.length) { res.json({ ...s, _warnings: { duplicateName } }); return; }
  }
  res.json(s);
}));

router.patch('/series/:id/arc-fields/:field/lock', asyncHandler(async (req, res) => {
  const body = validateRequest(arcFieldLockSchema, req.body ?? {});
  const s = await seriesSvc.setArcFieldLock(req.params.id, req.params.field, body.locked)
    .catch((err) => { throw mapServiceError(err); });
  res.json(s);
}));

router.delete('/series/:id', asyncHandler(async (req, res) => {
  const r = await seriesSvc.deleteSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  res.json(r);
}));

// Generate (or regenerate) the series.titleLogo description via the
// `pipeline-series-title-logo` stage. Returns the updated series so the
// client can swap state without a follow-up GET.
router.post('/series/:id/generate-title-logo', asyncHandler(async (req, res) => {
  const body = validateRequest(titleLogoGenerateSchema, req.body ?? {});
  const result = await generateSeriesTitleLogo(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Voice discovery (#2179, CWQE Phase 14): write the same scene beat in several
// distinct registers so the author picks the series voice by ear. Returns the
// candidate passages WITHOUT persisting — the user's pick is committed via the
// ordinary series PATCH (styleGuide.voiceExemplars). Reuses the LLM
// provider/model override shape.
router.post('/series/:id/discover-voice', asyncHandler(async (req, res) => {
  const body = validateRequest(voiceDiscoverSchema, req.body ?? {});
  const result = await discoverSeriesVoice(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

router.get('/series/:id/issues', asyncHandler(async (req, res) => {
  // Validate the series exists so a typo returns 404 instead of [] (less
  // confusing for the UI).
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const hasPagination = req.query.offset !== undefined || req.query.limit !== undefined;
  // List endpoints strip per-stage runHistory; the UI never renders it on
  // these views and a maxed-out issue can otherwise ship ~12MB of payload.
  // Detail reads (`GET /issues/:id`) stay on the full shape.
  if (hasPagination) {
    const { offset, limit } = validateRequest(issuesListQuerySchema, req.query);
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, offset, limit, paginated: true, withHistory: false }));
  } else {
    res.json(await issuesSvc.listIssues({ seriesId: req.params.id, withHistory: false }));
  }
}));

router.post('/series/:id/issues', asyncHandler(async (req, res) => {
  const series = await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(issueCreateSchema, req.body ?? {});
  if (body.seasonId) {
    const target = (Array.isArray(series.seasons) ? series.seasons : []).find((s) => s.id === body.seasonId);
    if (!target) {
      throw new ServerError(`Season not found: ${body.seasonId}`, { status: 400, code: 'PIPELINE_SEASON_NOT_FOUND' });
    }
    if (target.locked === true) {
      throw new ServerError(`Season "${target.title || target.number}" is locked — unlock it before adding issues`, {
        status: 409, code: issuesSvc.ERR_SEASON_LOCKED,
      });
    }
  }
  const created = await issuesSvc.createIssue({ ...body, seriesId: req.params.id }, { preloadedSeries: series });
  res.status(201).json(created);
}));

// =====================
// Season routes — Phase 2 of Story Arc Planning. Seasons live inside
// `series.seasons[]` but get their own resource so a single-season edit
// doesn't have to re-PATCH the entire series record.
// =====================

router.get('/series/:id/seasons', asyncHandler(async (req, res) => {
  const seasons = await seasonsSvc.listSeasons(req.params.id)
    .catch((err) => { throw mapServiceError(err); });
  res.json(seasons);
}));

router.post('/series/:id/seasons', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(seasonCreateSchema, req.body ?? {});
  const created = await seasonsSvc.createSeason(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.status(201).json(created);
}));

router.patch('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  const body = validateRequest(seasonPatchSchema, req.body ?? {});
  const updated = await seasonsSvc.updateSeason(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(updated);
}));

router.delete('/series/:id/seasons/:seasonId', asyncHandler(async (req, res) => {
  // Reassign target arrives via the request body so HTTP DELETE stays valid;
  // a query-param fallback would invite the same content twice in different
  // shapes. Body is optional — omitting it un-groups every child issue.
  const body = validateRequest(seasonDeleteSchema, req.body ?? {});
  const result = await seasonsSvc.deleteSeason(req.params.id, req.params.seasonId, {
    reassignTo: body.reassignTo ?? null,
  }).catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
