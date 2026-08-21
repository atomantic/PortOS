/**
 * FableLoom REST surface — branching narratives.
 *
 * CRUD for looms/episodes/nodes plus the AI lanes (weave/branch/review/play)
 * and the deterministic graph validation. Every AI endpoint is a direct
 * user action in the same request (AI Provider Usage Policy). Scene images
 * ride the existing `/api/image-gen/generate` queue with a `fableLoom`
 * destination tag — there is no image endpoint here.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  branchSchema,
  episodeCreateSchema,
  episodePatchSchema,
  loomCreateSchema,
  loomPatchSchema,
  nodeCreateSchema,
  nodePatchSchema,
  playTurnSchema,
  reformatSchema,
  reviewSchema,
  weaveSchema,
} from '../lib/fableLoomValidation.js';
import { analyzeEpisodeGraph } from '../lib/fableLoomGraph.js';
import {
  addEpisode,
  addNode,
  branchNode,
  createLoom,
  deleteEpisode,
  deleteLoom,
  deleteNode,
  getLoom,
  listLoomSummaries,
  playTurn,
  reformatLoom,
  reviewEpisode,
  updateEpisode,
  updateLoom,
  updateNode,
  weaveEpisode,
} from '../services/fableLoom/index.js';

const router = Router();

// Summaries only — a woven episode carries pages of prose per node, and the
// index renders three counts. The full record comes from GET /:id.
router.get('/', asyncHandler(async (req, res) => {
  res.json(await listLoomSummaries());
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

// Deterministic graph validation — no LLM.
router.get('/:id/episodes/:episodeId/validate', asyncHandler(async (req, res) => {
  const loom = await getLoom(req.params.id);
  const episode = loom?.episodes.find((e) => e.id === req.params.episodeId);
  if (!episode) throw new ServerError('Episode not found', { status: 404, code: 'NOT_FOUND' });
  res.json(analyzeEpisodeGraph(episode));
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

// --- AI lanes ---------------------------------------------------------------

router.post('/:id/episodes/:episodeId/weave', asyncHandler(async (req, res) => {
  const input = validateRequest(weaveSchema, req.body);
  res.json(await weaveEpisode(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/nodes/:nodeId/branch', asyncHandler(async (req, res) => {
  const input = validateRequest(branchSchema, req.body);
  res.json(await branchNode(req.params.id, req.params.episodeId, req.params.nodeId, input));
}));

router.post('/:id/episodes/:episodeId/review', asyncHandler(async (req, res) => {
  const input = validateRequest(reviewSchema, req.body);
  res.json(await reviewEpisode(req.params.id, req.params.episodeId, input));
}));

router.post('/:id/episodes/:episodeId/play', asyncHandler(async (req, res) => {
  const input = validateRequest(playTurnSchema, req.body);
  res.json(await playTurn(req.params.id, req.params.episodeId, input));
}));

// Rewrite every scene of every episode into another format (prose ⇄ teleplay)
// and pin the loom to it. Loom-scoped rather than episode-scoped: a story
// half in screenplay and half in prose is never what the author meant.
router.post('/:id/reformat', asyncHandler(async (req, res) => {
  const input = validateRequest(reformatSchema, req.body);
  res.json(await reformatLoom(req.params.id, input));
}));

export default router;
