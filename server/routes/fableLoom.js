/**
 * FableLoom REST surface — branching narratives.
 *
 * CRUD for looms/episodes/nodes plus the AI lanes (weave/branch/feedback/review/play),
 * the deterministic graph validation, and user-triggered fal.ai browser video automation.
 * Every AI endpoint is a direct user action in the same request (AI Provider Usage Policy).
 * Standard scene media rides the shared image/video generation queues with a `fableLoom`
 * destination tag, while fal.ai automation uses a dedicated serialized browser runner.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  branchSchema,
  episodeCreateSchema,
  episodePatchSchema,
  feedbackSchema,
  falVideoAutomationSchema,
  loomCreateSchema,
  loomListQuerySchema,
  loomPatchSchema,
  nodeCreateSchema,
  nodePatchSchema,
  outlineGenerateSchema,
  outlineReviewSchema,
  outlineValidateSchema,
  playTurnSchema,
  reformatSchema,
  reviewSchema,
  seriesPlanFeedbackSchema,
  seriesPlanGenerateSchema,
  seriesPlanReviewSchema,
  transitionCreateSchema,
  transitionPatchSchema,
  weaveSchema,
  hostedSessionCreateSchema,
  hostedSessionPatchSchema,
  productionPlanSchema,
  productionBatchCreateSchema,
  continuityReviewSchema,
  editorialAutopilotStartSchema,
  editorialRemediateSchema,
  playthroughReviewSchema,
} from '../lib/fableLoomValidation.js';
import { analyzeEpisodeGraph } from '../lib/fableLoomGraph.js';
import { analyzeSeriesStoryOutlines } from '../lib/fableLoomOutline.js';
import {
  inspectEpisodeProductionReadiness,
  inspectNodeProductionReadiness,
} from '../lib/fableLoomPlayback.js';
import { getUniverse } from '../services/universeBuilder.js';
import {
  addEpisode,
  addNode,
  addNodeTransition,
  branchNode,
  cancelEpisodeProductionBatch,
  checkHostedSessionReadiness,
  createHostedSession,
  createLoom,
  deleteEpisode,
  deleteLoom,
  deleteNode,
  deleteNodeTransition,
  endHostedSession,
  feedbackEpisode,
  feedbackSeriesPlan,
  generateEpisodeOutline,
  generateSeriesPlan,
  getFalVideoAutomation,
  getEpisodeProductionBatch,
  getHostedSession,
  getLoom,
  listLoomSummaries,
  planEpisodeProduction,
  playTurn,
  reformatEpisodeScenes,
  reviewEpisode,
  reviewEpisodeOutline,
  reviewEpisodeContinuity,
  resumeEpisodeProductionBatch,
  reviewSeriesPlan,
  reviewSeriesTeleplay,
  startEpisodeProductionBatch,
  startFalVideoAutomation,
  updateEpisode,
  updateHostedSession,
  updateLoom,
  updateNode,
  updateNodeTransition,
  validateEpisodeOutline,
  weaveEpisode,
  cancelFableLoomEditorialAutopilot,
  evaluateAndRemediateFableLoom,
  getFableLoomEditorialAutopilot,
  getLatestFableLoomEditorialAutopilot,
  publicFableLoomEditorialAutopilot,
  reviewFableLoomPlaythroughs,
  startFableLoomEditorialAutopilot,
} from '../services/fableLoom/index.js';

const router = Router();

// Summaries only — a woven episode carries pages of prose per node, and the
// index renders three counts. The full record comes from GET /:id.
// `?seriesId=` scopes the list to one pipeline series' linked looms (the series
// detail page's "Branching narratives" card). A blank value means "no filter",
// so a caller can build the query from a possibly-unset id.
router.get('/', asyncHandler(async (req, res) => {
  const { seriesId } = validateRequest(loomListQuerySchema, req.query);
  res.json(await listLoomSummaries({ seriesId: seriesId?.trim() || undefined }));
}));

// Linked universe/series refs are validated by the service (createLoom /
// updateLoom throw INVALID_UNIVERSE / INVALID_SERIES at 400).
router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(loomCreateSchema, req.body);
  res.status(201).json(await createLoom(input));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  res.json(loom);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(loomPatchSchema, req.body);
  res.json(await updateLoom(req.params.id, patch));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  await deleteLoom(req.params.id);
  res.json({ ok: true });
}));

// --- Series plan ------------------------------------------------------------

router.post('/:id/plan/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(seriesPlanGenerateSchema, req.body);
  res.json(await generateSeriesPlan(req.params.id, input));
}));

router.post('/:id/plan/review', asyncHandler(async (req, res) => {
  const input = validateRequest(seriesPlanReviewSchema, req.body);
  res.json(await reviewSeriesPlan(req.params.id, input));
}));

router.post('/:id/review-teleplay', asyncHandler(async (req, res) => {
  const input = validateRequest(reviewSchema, req.body);
  res.json(await reviewSeriesTeleplay(req.params.id, input));
}));

router.post('/:id/plan/feedback', asyncHandler(async (req, res) => {
  const input = validateRequest(seriesPlanFeedbackSchema, req.body);
  res.json(await feedbackSeriesPlan(req.params.id, input));
}));

// --- Whole-series editorial automation -------------------------------------

router.post('/:id/editorial/remediate', asyncHandler(async (req, res) => {
  const input = validateRequest(editorialRemediateSchema, req.body ?? {});
  res.json(await evaluateAndRemediateFableLoom(req.params.id, input));
}));

router.post('/:id/playtest', asyncHandler(async (req, res) => {
  const input = validateRequest(playthroughReviewSchema, req.body ?? {});
  res.json(await reviewFableLoomPlaythroughs(req.params.id, input));
}));

router.post('/:id/editorial/autopilot/start', asyncHandler(async (req, res) => {
  const input = validateRequest(editorialAutopilotStartSchema, req.body ?? {});
  const run = await startFableLoomEditorialAutopilot(req.params.id, input);
  res.status(run.alreadyRunning ? 200 : 202).json(publicFableLoomEditorialAutopilot(run));
}));

router.get('/:id/editorial/autopilot/status', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  const run = getLatestFableLoomEditorialAutopilot(req.params.id);
  res.json({ run: publicFableLoomEditorialAutopilot(run) });
}));

router.get('/:id/editorial/autopilot/:runId', asyncHandler(async (req, res) => {
  const run = getFableLoomEditorialAutopilot(req.params.runId);
  if (!run || run.loomId !== req.params.id) {
    throw new ServerError('Editorial autopilot run not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(publicFableLoomEditorialAutopilot(run));
}));

router.post('/:id/editorial/autopilot/:runId/cancel', asyncHandler(async (req, res) => {
  const run = getFableLoomEditorialAutopilot(req.params.runId);
  if (!run || run.loomId !== req.params.id) {
    throw new ServerError('Editorial autopilot run not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(publicFableLoomEditorialAutopilot(cancelFableLoomEditorialAutopilot(req.params.runId)));
}));

// --- Episodes ---------------------------------------------------------------

router.post('/:id/episodes', asyncHandler(async (req, res) => {
  const input = validateRequest(episodeCreateSchema, req.body);
  res.status(201).json(await addEpisode(req.params.id, input));
}));

router.patch('/:id/episodes/:episodeId', asyncHandler(async (req, res) => {
  const patch = validateRequest(episodePatchSchema, req.body);
  res.json(await updateEpisode(req.params.id, req.params.episodeId, patch));
}));

router.delete('/:id/episodes/:episodeId', asyncHandler(async (req, res) => {
  res.json(await deleteEpisode(req.params.id, req.params.episodeId));
}));

// Deterministic graph validation and production readiness — no LLM.
router.get('/:id/outlines/validate', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  if (!loom) throw new ServerError('Loom not found', { status: 404, code: 'NOT_FOUND' });
  res.json(analyzeSeriesStoryOutlines(loom));
}));

router.get('/:id/episodes/:episodeId/validate', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  const episode = loom?.episodes.find((e) => e.id === req.params.episodeId);
  if (!episode) throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  const universe = loom.universeId ? await getUniverse(loom.universeId).catch(() => null) : null;
  const graphAnalysis = analyzeEpisodeGraph(episode, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: episode.id === loom.episodes[0]?.id,
  });
  const productionReadiness = inspectEpisodeProductionReadiness(episode, { universe, loom });
  res.json({
    ...graphAnalysis,
    productionReadiness,
  });
}));

router.get('/:id/episodes/:episodeId/nodes/:nodeId/readiness', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  const episode = loom?.episodes.find((e) => e.id === req.params.episodeId);
  const node = episode?.nodes.find((n) => n.id === req.params.nodeId);
  if (!loom || !episode || !node) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const universe = loom.universeId ? await getUniverse(loom.universeId).catch(() => null) : null;
  res.json(inspectNodeProductionReadiness(node, { universe, loom }));
}));

// --- Nodes ------------------------------------------------------------------

router.post('/:id/episodes/:episodeId/nodes', asyncHandler(async (req, res) => {
  const input = validateRequest(nodeCreateSchema, req.body);
  res.status(201).json(await addNode(req.params.id, req.params.episodeId, input));
}));

router.patch('/:id/episodes/:episodeId/nodes/:nodeId', asyncHandler(async (req, res) => {
  const patch = validateRequest(nodePatchSchema, req.body);
  res.json(await updateNode(req.params.id, req.params.episodeId, req.params.nodeId, patch));
}));

router.delete('/:id/episodes/:episodeId/nodes/:nodeId', asyncHandler(async (req, res) => {
  res.json(await deleteNode(req.params.id, req.params.episodeId, req.params.nodeId));
}));

// The free fal.ai allowance is browser-only. A direct user click starts one
// serialized Playwright job against PortOS's persistent CDP browser; the job
// owns the eventual gallery write + scene attachment even if the page closes.
router.post('/:id/episodes/:episodeId/nodes/:nodeId/fal-video', asyncHandler(async (req, res) => {
  const input = validateRequest(falVideoAutomationSchema, req.body);
  res.status(202).json(await startFalVideoAutomation(
    req.params.id,
    req.params.episodeId,
    req.params.nodeId,
    input,
  ));
}));

router.get('/:id/episodes/:episodeId/nodes/:nodeId/fal-video/:jobId', asyncHandler(async (req, res) => {
  res.json(getFalVideoAutomation(
    req.params.id,
    req.params.episodeId,
    req.params.nodeId,
    req.params.jobId,
  ));
}));

// --- Transitions ------------------------------------------------------------
//
// One edge per request. The node PATCH still accepts a whole `transitions`
// array (unchanged, for clients that predate these routes) — but replaying the
// array to add one path means a second writer working off a stale snapshot
// drops the rows it never saw. POST answers with `{ loom, transition }` so the
// caller has the minted id without diffing the array; PATCH/DELETE answer with
// the loom, same as the node routes one level up.

router.post('/:id/episodes/:episodeId/nodes/:nodeId/transitions', asyncHandler(async (req, res) => {
  const input = validateRequest(transitionCreateSchema, req.body);
  res.status(201).json(await addNodeTransition(req.params.id, req.params.episodeId, req.params.nodeId, input));
}));

router.patch('/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId', asyncHandler(async (req, res) => {
  const patch = validateRequest(transitionPatchSchema, req.body);
  res.json(await updateNodeTransition(
    req.params.id, req.params.episodeId, req.params.nodeId, req.params.transitionId, patch,
  ));
}));

router.delete('/:id/episodes/:episodeId/nodes/:nodeId/transitions/:transitionId', asyncHandler(async (req, res) => {
  res.json(await deleteNodeTransition(
    req.params.id, req.params.episodeId, req.params.nodeId, req.params.transitionId,
  ));
}));

// --- AI lanes ---------------------------------------------------------------

router.post('/:id/episodes/:episodeId/weave', asyncHandler(async (req, res) => {
  const input = validateRequest(weaveSchema, req.body);
  res.json(await weaveEpisode(req.params.id, req.params.episodeId, input));
}));

// Story-first authoring: draft and review the small beat outline before the
// full teleplay graph is expanded. Validation is deterministic and persisted
// so the expansion button can enforce the same gate from every client.
router.post('/:id/episodes/:episodeId/outline/generate', asyncHandler(async (req, res) => {
  const input = validateRequest(outlineGenerateSchema, req.body);
  res.json(await generateEpisodeOutline(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/outline/validate', asyncHandler(async (req, res) => {
  validateRequest(outlineValidateSchema, req.body ?? {});
  res.json(await validateEpisodeOutline(req.params.id, req.params.episodeId));
}));

router.post('/:id/episodes/:episodeId/outline/review', asyncHandler(async (req, res) => {
  const input = validateRequest(outlineReviewSchema, req.body);
  res.json(await reviewEpisodeOutline(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/nodes/:nodeId/branch', asyncHandler(async (req, res) => {
  const input = validateRequest(branchSchema, req.body);
  res.json(await branchNode(req.params.id, req.params.episodeId, req.params.nodeId, input));
}));

router.post('/:id/episodes/:episodeId/review', asyncHandler(async (req, res) => {
  const input = validateRequest(reviewSchema, req.body);
  res.json(await reviewEpisode(req.params.id, req.params.episodeId, input));
}));

// Apply one conversational author instruction to the episode. The service
// keeps scene ids and graph membership stable while applying the model's
// sparse metadata/scene/path patches.
router.post('/:id/episodes/:episodeId/feedback', asyncHandler(async (req, res) => {
  const input = validateRequest(feedbackSchema, req.body);
  res.json(await feedbackEpisode(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/play', asyncHandler(async (req, res) => {
  const input = validateRequest(playTurnSchema, req.body);
  res.json(await playTurn(req.params.id, req.params.episodeId, input));
}));

// Rewrite ONE episode's scenes into another format (prose ⇄ teleplay). The
// caller walks the episodes; a whole-loom rewrite used to run tens of
// sequential provider calls behind one held request, long enough for a proxy or
// fetch timeout to kill the response mid-run (#4794). The invariant that a
// story is never half screenplay and half prose is kept by the service, which
// pins the loom to the format only once every episode is converted.
router.post('/:id/episodes/:episodeId/reformat', asyncHandler(async (req, res) => {
  const input = validateRequest(reformatSchema, req.body);
  res.json(await reformatEpisodeScenes(req.params.id, req.params.episodeId, input));
}));

// --- QR-Hosted Sessions -----------------------------------------------------

router.post('/:id/episodes/:episodeId/sessions/preflight', asyncHandler(async (req, res) => {
  res.json(await checkHostedSessionReadiness({ loomId: req.params.id, episodeId: req.params.episodeId }));
}));

router.post('/:id/episodes/:episodeId/sessions/host', asyncHandler(async (req, res) => {
  const input = validateRequest(hostedSessionCreateSchema, req.body);
  res.status(201).json(await createHostedSession(req.params.id, req.params.episodeId, input));
}));

router.get('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const session = getHostedSession(req.params.sessionId);
  if (!session) throw new ServerError('Session not found', { status: 404, code: 'NOT_FOUND' });
  res.json(session);
}));

router.patch('/sessions/:sessionId', asyncHandler(async (req, res) => {
  const patch = validateRequest(hostedSessionPatchSchema, req.body);
  res.json(updateHostedSession(req.params.sessionId, patch));
}));

router.delete('/sessions/:sessionId', asyncHandler(async (req, res) => {
  res.json(endHostedSession(req.params.sessionId, { reason: 'api_deleted' }));
}));

// --- Production Orchestration & Continuity Review ---------------------------

router.post('/:id/episodes/:episodeId/production/plan', asyncHandler(async (req, res) => {
  const input = validateRequest(productionPlanSchema, req.body ?? {});
  res.json(await planEpisodeProduction(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/production/batch', asyncHandler(async (req, res) => {
  const input = validateRequest(productionBatchCreateSchema, req.body ?? {});
  res.status(201).json(await startEpisodeProductionBatch(req.params.id, req.params.episodeId, input));
}));

router.get('/:id/episodes/:episodeId/production/batch/:runId', asyncHandler(async (req, res) => {
  const run = getEpisodeProductionBatch(req.params.runId);
  if (!run || run.loomId !== req.params.id || run.episodeId !== req.params.episodeId) {
    throw new ServerError('Batch production run not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(run);
}));

router.post('/:id/episodes/:episodeId/production/batch/:runId/cancel', asyncHandler(async (req, res) => {
  const run = getEpisodeProductionBatch(req.params.runId);
  if (!run || run.loomId !== req.params.id || run.episodeId !== req.params.episodeId) {
    throw new ServerError('Batch production run not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(await cancelEpisodeProductionBatch(req.params.runId));
}));

router.post('/:id/episodes/:episodeId/production/batch/:runId/resume', asyncHandler(async (req, res) => {
  const run = getEpisodeProductionBatch(req.params.runId);
  if (!run || run.loomId !== req.params.id || run.episodeId !== req.params.episodeId) {
    throw new ServerError('Batch production run not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(resumeEpisodeProductionBatch(req.params.runId));
}));

router.post('/:id/episodes/:episodeId/continuity/review', asyncHandler(async (req, res) => {
  validateRequest(continuityReviewSchema, req.body ?? {});
  res.json(await reviewEpisodeContinuity(req.params.id, req.params.episodeId));
}));

export default router;
