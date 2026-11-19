/**
 * Production-review routes of the Music Video surface: the reviewed plan, shot binding, feedback and the proof render (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { Router } from 'express';
import { musicVideoProductionDraftSchema } from '../lib/musicVideo/musicVideoValidation.js';
import { musicVideoProductionApprovalSchema, musicVideoProductionProofSchema, musicVideoProductionImportSchema, musicVideoProductionFeedbackSchema, musicVideoProductionFeedbackResolutionSchema, musicVideoLyricAnchorSyncSchema, musicVideoProductionReviseSchema, musicVideoProductionRevertSchema, musicVideoDocumentShotsSchema, musicVideoAlignmentReviewSchema, musicVideoCastAndSetsStartSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { getProductionReview, getProductionReadiness, saveProductionDraft, prepareProductionReview, approveProductionReview, renderProductionProof, requireProductionReviewer, importProductionPlanning, bindProductionShot, addProductionFeedback, closeProductionFeedback, syncLyricAnchors, removeStaleStoryboardRows, reviseProductionFromFeedback, revertProductionInput, importDocumentShots, reverifyProductionAlignment } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';

const router = Router();

// Single-write review actions answer with `{ readiness, edit }` (and their own fields, such as
// `feedbackId`), never the whole project: `edit` is the board edit result (services/musicVideo/editResult.js)
// the open board patches in. API callers that want the whole record read `GET /:id`. Prepare,
// revise, proof, the text check and a plan import (it saves its source artifact first, so its diff
// base would be a revision the board never held) still answer with `{ project, readiness }`. They
// span several writes (or a long provider call), so no single before/after diff describes them: the
// tab reloads once on their change broadcast, which is the deliberate cost of these infrequent actions.
const EDIT = Object.freeze({ edit: true });

router.post('/:id/production-review/feedback', asyncHandler(async (req, res) => {
  res.json(await addProductionFeedback(req.params.id, validateRequest(musicVideoProductionFeedbackSchema, req.body), EDIT));
}));

router.post('/:id/production-review/feedback/resolve', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionFeedbackResolutionSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  res.json(await closeProductionFeedback(req.params.id, { feedbackId: input.feedbackId, resolution: input.resolution, reviewer }, EDIT));
}));

router.post('/:id/production-review/lyric-anchors', asyncHandler(async (req, res) => {
  res.json(await syncLyricAnchors(req.params.id, validateRequest(musicVideoLyricAnchorSyncSchema, req.body ?? {}), EDIT));
}));

router.delete('/:id/production-review/stale-rows', asyncHandler(async (req, res) => {
  res.json(await removeStaleStoryboardRows(req.params.id, EDIT));
}));

// An explicit click: the only provider call is the stage's own revision.
router.post('/:id/production-review/revise', asyncHandler(async (req, res) => {
  res.json(await reviseProductionFromFeedback(req.params.id, validateRequest(musicVideoProductionReviseSchema, req.body ?? {})));
}));

router.post('/:id/production-review/revert', asyncHandler(async (req, res) => {
  res.json(await revertProductionInput(req.params.id, validateRequest(musicVideoProductionRevertSchema, req.body), EDIT));
}));

// The overlay text quality pass: render the composition document at its text
// moments and flag collisions, cut-off, low contrast and phone-size text.
router.post('/:id/production-review/text-check', asyncHandler(async (req, res) => {
  const { startOverlayTextCheck } = await import('../services/musicVideo/overlayTextService.js');
  const { project, readiness } = await startOverlayTextCheck(req.params.id);
  res.status(202).json({ project, readiness });
}));

router.get('/:id/production-review', asyncHandler(async (req, res) => {
  res.json(await getProductionReview(req.params.id));
}));

// Readiness alone, for a board that holds the project without it (#16210): no whole-project reply.
router.get('/:id/production-review/readiness', asyncHandler(async (req, res) => {
  res.json(await getProductionReadiness(req.params.id));
}));

router.post('/:id/production-review/document-shots', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoDocumentShotsSchema, req.body);
  res.json(await importDocumentShots(req.params.id, input, EDIT));
}));

router.post('/:id/production-review/import', asyncHandler(async (req, res) => {
  const { source } = validateRequest(musicVideoProductionImportSchema, req.body);
  res.json(await importProductionPlanning(req.params.id, source));
}));

router.post('/:id/production-review/shots/:shotId/bind', asyncHandler(async (req, res) => {
  res.json(await bindProductionShot(req.params.id, req.params.shotId, EDIT));
}));

router.put('/:id/production-review', asyncHandler(async (req, res) => {
  res.json(await saveProductionDraft(req.params.id, validateRequest(musicVideoProductionDraftSchema, req.body), EDIT));
}));

router.post('/:id/production-review/prepare', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.json(await prepareProductionReview(req.params.id, input));
}));

router.post('/:id/production-review/alignment', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoAlignmentReviewSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  res.json(await reverifyProductionAlignment(req.params.id, { ...input, reviewer }, EDIT));
}));

router.post('/:id/production-review/approve', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoProductionApprovalSchema, req.body);
  const reviewer = await requireProductionReviewer(req);
  res.json(await approveProductionReview(req.params.id, { stage: input.stage, basis: input.basis, proofReview: input.proofReview, reviewer }, EDIT));
}));

router.post('/:id/production-review/proof', asyncHandler(async (req, res) => {
  res.status(202).json(await renderProductionProof(req.params.id, validateRequest(musicVideoProductionProofSchema, req.body)));
}));

export default router;
