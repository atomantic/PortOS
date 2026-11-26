/**
 * Pipeline arc-planning routes — Phase 3 of Story Arc Planning. LLM-driven
 * passes that propose (and optionally commit) arc-level metadata, season
 * outlines, per-episode breakdowns, volume beat sheets, verification, and
 * the back-derive-from-manuscript flow.
 */

import { Router } from 'express';
import {
  arcGenerateSchema,
  seasonEpisodesGenerateSchema,
  arcVerifySchema,
  volumeVerifySchema,
  volumeBeatsGenerateSchema,
  arcResolveSchema,
  arcDeriveSchema,
  arcDeriveCommitSchema,
} from '../../lib/pipelineValidation.js';
import { asyncHandler, ServerError } from '../../lib/errorHandler.js';
import { validateRequest } from '../../lib/validateRequest.js';
import * as seriesSvc from '../../services/pipeline/series.js';
import * as arcPlanner from '../../services/pipeline/arcPlanner.js';
import * as volumeBeatsRunner from '../../services/pipeline/volumeBeatsRunner.js';
import { mapServiceError } from './shared.js';

const router = Router();

// Top-of-arc generation: proposes `series.arc` + `series.seasons[]` from the
// series bible. With `commit: true` persists the result in one shot; default
// returns a preview the UI can confirm before writing.
router.post('/series/:id/arc/generate', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcGenerateSchema, req.body ?? {});
  const result = await arcPlanner.generateArcOverview(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  let series = null;
  if (body.commit) {
    const cur = await seriesSvc.getSeries(req.params.id)
      .catch((err) => { throw mapServiceError(err); });
    const committed = await arcPlanner.commitSeasonsWithRemap(cur, {
      arc: result.arc,
      seasons: result.seasons,
    }).catch((err) => { throw mapServiceError(err); });
    series = committed.series;
  }
  res.json({
    arc: result.arc,
    seasons: result.seasons,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
    committed: !!body.commit,
    series,
  });
}));

// Per-season episode generation. Proposes (and optionally commits) the
// per-episode breakdown for one season. With `commit: true`, creates one
// issue per episode with the season pointer + arcPosition pre-filled.
router.post('/series/:id/seasons/:seasonId/episodes/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(seasonEpisodesGenerateSchema, req.body ?? {});
  const result = await arcPlanner.generateSeasonEpisodes(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });

  let createdIssues = [];
  let bibleExtracted = null;
  if (body.commit) {
    // Create one issue per episode under this season. The issue sanitizer
    // already accepts `seasonId` + `arcPosition`; the shared helper owns the
    // per-episode → createIssue mapping so the Story Builder's batch path
    // mints identical issue shapes.
    // Fetch the series once and thread it through both the issue-creation
    // batch (so each createIssue's renumber pass skips a redundant read) and
    // the continuity extraction below.
    const series = await seriesSvc.getSeries(req.params.id).catch(() => null);
    createdIssues = await arcPlanner.commitEpisodesToIssues(
      req.params.id, req.params.seasonId, result.episodes, { preloadedSeries: series },
    );

    // Non-fatal: episode creation already succeeded, so a noisy extraction
    // failure must not invalidate the user's accepted breakdown. Phase B.4:
    // canon lives on the linked universe — orphan series (no universeId)
    // skip extraction.
    bibleExtracted = await arcPlanner.extractEpisodeCanon({
      series,
      episodes: result.episodes,
      providerOverride: body.providerOverride,
      modelOverride: body.modelOverride,
    });
  }

  res.json({
    season: result.season,
    episodes: result.episodes,
    runId: result.runId,
    providerId: result.providerId,
    model: result.model,
    committed: !!body.commit,
    createdIssues,
    bibleExtracted,
  });
}));

router.post('/series/:id/arc/verify', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcVerifySchema, req.body ?? {});
  const result = await arcPlanner.verifyArc(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Per-volume verify — the deeper, narrower counterpart to /arc/verify.
// Runs the pipeline-volume-verify prompt over a single season's issues,
// going to beat depth when issues have beats and falling back to synopsis
// depth otherwise so a partially-expanded volume can still be validated.
router.post('/series/:id/seasons/:seasonId/verify', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(volumeVerifySchema, req.body ?? {});
  const result = await arcPlanner.verifyVolume(req.params.id, req.params.seasonId, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Sequential beat-sheet (idea stage) generator for every issue in a volume.
// Runs serially so each issue's prompt sees the prior issue's freshly-written
// beats via buildIdeaContextAugment; SSE streams per-issue progress. Pairs
// naturally with the volume verify pass — generate-then-validate is the
// expected workflow.
router.post('/series/:id/seasons/:seasonId/generate-beats', asyncHandler(async (req, res) => {
  const body = validateRequest(volumeBeatsGenerateSchema, req.body ?? {});
  const result = await volumeBeatsRunner.startVolumeBeatsRun(
    req.params.id,
    req.params.seasonId,
    {
      mode: body.mode,
      providerId: body.providerOverride,
      model: body.modelOverride,
    },
  ).catch((err) => { throw mapServiceError(err); });
  res.json({
    ...result,
    sseUrl: `/api/pipeline/series/${req.params.id}/seasons/${req.params.seasonId}/generate-beats/progress`,
  });
}));

router.get('/series/:id/seasons/:seasonId/generate-beats/progress', (req, res) => {
  const attached = volumeBeatsRunner.attachClient(req.params.seasonId, res);
  if (!attached) {
    throw new ServerError('No active beat-sheet run for this volume', { status: 404 });
  }
});

router.post('/series/:id/seasons/:seasonId/generate-beats/cancel', asyncHandler(async (req, res) => {
  const canceled = volumeBeatsRunner.cancelVolumeBeatsRun(req.params.seasonId);
  res.json({ canceled });
}));

// Auto-resolve verification findings. Persists the LLM's patched arc + season
// outlines in one call. Per-episode issue records are not touched.
router.post('/series/:id/arc/resolve-issues', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcResolveSchema, req.body ?? {});
  const result = await arcPlanner.resolveVerifyIssues(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Back-derive arc + bible + single-volume restructure from the EXISTING issue
// manuscripts ("I imported a finished graphic novel, reconstruct its spine").
// Read-only preview the UI shows for review/edit before the commit route.
router.post('/series/:id/arc/derive-from-manuscript', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcDeriveSchema, req.body ?? {});
  const result = await arcPlanner.deriveFromManuscript(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

// Apply the (possibly edited) derive preview: bible + single volume + per-issue
// synopses. The LLM is NOT re-run — the confirmed proposal is in the body.
router.post('/series/:id/arc/derive-from-manuscript/commit', asyncHandler(async (req, res) => {
  await seriesSvc.getSeries(req.params.id).catch((err) => { throw mapServiceError(err); });
  const body = validateRequest(arcDeriveCommitSchema, req.body ?? {});
  const result = await arcPlanner.commitDerivedManuscript(req.params.id, body)
    .catch((err) => { throw mapServiceError(err); });
  res.json(result);
}));

export default router;
