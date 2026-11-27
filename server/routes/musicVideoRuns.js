/**
 * Long-running orchestration routes of the Music Video surface: revisions, dependency repairs, auto-review, production and autonomous runs (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { Router } from 'express';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  musicVideoAutoReviewResumeSchema,
  musicVideoAutoReviewStartSchema,
  musicVideoAutonomousResumeSchema,
  musicVideoAutonomousStartSchema,
  musicVideoDependencyRepairSchema,
  musicVideoProductionResumeSchema,
  musicVideoProductionStartSchema,
  musicVideoRevisionReleaseSchema,
  musicVideoRevisionStartSchema,
} from '../lib/musicVideo/routeValidation/runs.js';
import { getDependencyImpact, startDependencyRepair, startRevision, resumeRevision, cancelRevision, releaseRevisionSection } from '../services/musicVideo/revisionService.js';
import { startAutoReview, resumeAutoReview, stopAutoReview, cancelAutoReview } from '../services/musicVideo/autoReviewService.js';
import { startProduction, resumeProduction, stopProduction, cancelProduction } from '../services/musicVideo/productionService.js';
import { startAutonomousVideo, resumeAutonomousVideo, stopAutonomousVideo, cancelAutonomousVideo } from '../services/musicVideo/autonomousService.js';

const router = Router();

// --- Selective section revision (#8987) ---
// Reject the flagged sections of a reviewed draft (their selected takes clear)
// while every other section keeps its selection. Resume continues from the
// persisted checkpoint: sections still without a take come back as
// `needsGeneration` for the board to generate; once all hold one, the draft
// window re-renders. A section holding a take is never asked to generate again,
// so a render retry never re-submits paid generation.
router.get('/:id/dependency-impact', asyncHandler(async (req, res) => {
  res.json(await getDependencyImpact(req.params.id));
}));

router.post('/:id/dependency-repairs', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDependencyRepairSchema, req.body || {});
  res.status(201).json(await startDependencyRepair(req.params.id, input));
}));

router.post('/:id/excerpt/:excerptId/revisions', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoRevisionStartSchema, req.body || {});
  res.status(201).json(await startRevision(req.params.id, req.params.excerptId, input));
}));

router.post('/:id/revisions/:revisionId/resume', asyncHandler(async (req, res) => {
  res.json(await resumeRevision(req.params.id, req.params.revisionId));
}));

router.post('/:id/revisions/:revisionId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelRevision(req.params.id, req.params.revisionId));
}));

// A generation kickoff that failed client-side before reaching the queue
// (network error, a refused request) leaves its section claimed for the
// full lease with nothing running — clear the claim so the very next resume
// hands the section out again immediately (#9011).
router.post('/:id/revisions/:revisionId/release', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoRevisionReleaseSchema, req.body || {});
  res.json(await releaseRevisionSection(req.params.id, req.params.revisionId, input.sceneId));
}));

// --- Opt-in automatic review/retries (#8988) ---
// Start/resume write the checkpoint and return at once; the run advances in
// the background (render → review → revise → generate → re-render) and
// reports over the `music-video:auto-review` socket event. Only these
// explicit requests start or resume a run — nothing at boot does.
router.post('/:id/auto-reviews', asyncHandler(async (req, res) => {
  const { providerId, model, ...input } = validateRequest(musicVideoAutoReviewStartSchema, req.body || {});
  res.status(201).json(await startAutoReview(req.params.id, { ...input, reviewer: { providerId, model } }));
}));

router.post('/:id/auto-reviews/:runId/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoAutoReviewResumeSchema, req.body || {});
  res.json(await resumeAutoReview(req.params.id, req.params.runId, input));
}));

router.post('/:id/auto-reviews/:runId/stop', asyncHandler(async (req, res) => {
  res.json(await stopAutoReview(req.params.id, req.params.runId));
}));

router.post('/:id/auto-reviews/:runId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelAutoReview(req.params.id, req.params.runId));
}));

// --- Server-owned production run (#9066) ---
// Start/resume write the checkpoint and return at once; the run advances in
// the background (plan → frames → clips → reviewed draft → revisions) from
// queue completion events and reports over `music-video:production`. Only
// these explicit requests start or resume a run — nothing at boot does.
router.post('/:id/production-runs', asyncHandler(async (req, res) => {
  const { providerId, model, ...input } = validateRequest(musicVideoProductionStartSchema, req.body || {});
  res.status(201).json(await startProduction(req.params.id, { ...input, reviewer: { providerId, model } }));
}));

router.post('/:id/production-runs/:runId/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionResumeSchema, req.body || {});
  res.json(await resumeProduction(req.params.id, req.params.runId, input));
}));

router.post('/:id/production-runs/:runId/stop', asyncHandler(async (req, res) => {
  res.json(await stopProduction(req.params.id, req.params.runId));
}));

router.post('/:id/production-runs/:runId/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelProduction(req.params.id, req.params.runId));
}));

// --- Fully-autonomous run (one prompt → lyrics → Suno song → video) ---
// The alternate entry point: no track, style or board is picked up front. Start
// creates the project and returns at once; the run advances in the background
// (brief → lyrics → mood board → Suno → analysis → production) and reports over
// `music-video:autonomous`. Optional checkpoints park it for approval. Only these
// explicit requests (or the scheduled task) begin work — nothing at boot does.
// A non-empty `autoApprove` lets the run approve those Production review stages
// itself, and an `orchestrator` reviews and approves every stage for the operator.
// Bind either grant to the authenticated session; proof still needs review evidence.
const authorizeAutoApprove = async (req, autoApprove, orchestrator) => {
  if (autoApprove === undefined && !orchestrator) return false;
  return requireProductionReviewer(req);
};

router.post('/autonomous', asyncHandler(async (req, res) => {
  const { password: _password, ...input } = validateRequest(musicVideoAutonomousStartSchema, req.body || {});
  const autoApproveAuthorized = await authorizeAutoApprove(req, input.autoApprove, input.orchestrator);
  res.status(202).json(await startAutonomousVideo(input, { autoApproveAuthorized }));
}));

// Resume a parked/failed/interrupted run, or approve the checkpoint it waits on.
router.post('/:id/autonomous/resume', asyncHandler(async (req, res) => {
  const { password: _password, ...edits } = validateRequest(musicVideoAutonomousResumeSchema, req.body || {});
  const autoApproveAuthorized = await authorizeAutoApprove(req, edits.autoApprove);
  res.json(await resumeAutonomousVideo(req.params.id, edits, { autoApproveAuthorized }));
}));

router.post('/:id/autonomous/stop', asyncHandler(async (req, res) => {
  res.json(await stopAutonomousVideo(req.params.id));
}));

router.post('/:id/autonomous/cancel', asyncHandler(async (req, res) => {
  res.json(await cancelAutonomousVideo(req.params.id));
}));

export default router;
