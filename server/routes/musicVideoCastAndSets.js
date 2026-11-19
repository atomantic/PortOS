/**
 * Cast and sets routes of the Music Video surface: catalog check-in, generation, image edits, feedback and approval (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { musicVideoCastSetsUseImageSchema, musicVideoCastSetsImageEditSchema, musicVideoCastSetsImageEditDecisionSchema, musicVideoShotReferenceRepairSchema, musicVideoCastAndSetsStartSchema, musicVideoCastAndSetsDirectionTextEditSchema, musicVideoCastAndSetsFeedbackSchema, musicVideoCastAndSetsFeedbackPlanSchema, musicVideoCastAndSetsFeedbackRenderSchema, musicVideoCastAndSetsImageNoteRemovalSchema, musicVideoCastAndSetsRegenerateSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { musicVideoCastAndSetsDirectionEditSchema } from '../lib/musicVideo/musicVideoValidation.js';
import { Router } from 'express';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { startCastAndSets, editCastAndSetsDirection, editCastAndSetsDirectionText, applyCastAndSetsFeedback, renderCastAndSetsFeedback, refreshCastAndSetsFeedbackRenderer, removeCastAndSetsFeedbackEntry, removeCastAndSetsImageFeedback, editCastAndSetsImage, previewCastAndSetsImageEdit, acceptCastAndSetsImageEdit, discardCastAndSetsImageEdit, regenerateCastAndSets, resumeCastAndSets, approveCastAndSets, useCastAndSetsImage, acknowledgeCastAndSetsImage, reinspectCastAndSetsImages, reconfirmCastAndSets, skipCastAndSets, discardCastAndSets, getCastAndSets, getCastAndSetsCastingChanges, useCatalogCheckin, rebuildCatalogGuide, repairShotReference } from '../services/musicVideo/castAndSetsService.js';

const router = Router();

// --- Cast & Sets check-in (runs before the shot plan) ---
// Start / regenerate / resume write the checkpoint and return at once; the
// direction call and the reference images advance in the background and
// report over `music-video:cast-and-sets`. Only these requests (or a
// production run the director started) begin work — nothing at boot does.
router.post('/:id/cast-and-sets/catalog', asyncHandler(async (req, res) => {
  res.json(await useCatalogCheckin(req.params.id));
}));

router.post('/:id/cast-and-sets/catalog/guide', asyncHandler(async (req, res) => {
  res.json(await rebuildCatalogGuide(req.params.id));
}));

router.post('/:id/cast-and-sets/catalog/repair-shot-reference', asyncHandler(async (req, res) => {
  const { problemId } = validateRequest(musicVideoShotReferenceRepairSchema, req.body);
  res.json(await repairShotReference(req.params.id, problemId));
}));

router.get('/:id/cast-and-sets', asyncHandler(async (req, res) => {
  res.json(await getCastAndSets(req.params.id));
}));

// Read-only: what changed in the linked Casting records since the sheet was built.
router.get('/:id/cast-and-sets/casting-changes', asyncHandler(async (req, res) => {
  res.json(await getCastAndSetsCastingChanges(req.params.id));
}));

router.post('/:id/cast-and-sets', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.status(202).json(await startCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/regenerate', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsRegenerateSchema, req.body || {});
  res.status(202).json(await regenerateCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/use-image', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastSetsUseImageSchema, req.body || {});
  res.status(202).json(await useCastAndSetsImage(req.params.id, input));
}));

router.post('/:id/cast-and-sets/edit-image-preview', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastSetsImageEditSchema, req.body || {});
  res.json(await previewCastAndSetsImageEdit(req.params.id, input));
}));

router.post('/:id/cast-and-sets/edit-image', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastSetsImageEditSchema, req.body || {});
  res.status(202).json(await editCastAndSetsImage(req.params.id, input));
}));

router.post('/:id/cast-and-sets/accept-image-edit', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastSetsImageEditDecisionSchema, req.body || {});
  res.status(202).json(await acceptCastAndSetsImageEdit(req.params.id, input));
}));

router.post('/:id/cast-and-sets/discard-image-edit', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastSetsImageEditDecisionSchema, req.body || {});
  res.json(await discardCastAndSetsImageEdit(req.params.id, input));
}));

router.patch('/:id/cast-and-sets/direction', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsDirectionEditSchema, req.body || {});
  res.status(202).json(await editCastAndSetsDirection(req.params.id, input));
}));

// Text-only (catalog check-ins): saves words, renders nothing.
router.patch('/:id/cast-and-sets/direction-text', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsDirectionTextEditSchema, req.body || {});
  res.json(await editCastAndSetsDirectionText(req.params.id, input));
}));

router.post('/:id/cast-and-sets/feedback', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsFeedbackSchema, req.body || {});
  res.status(202).json(await applyCastAndSetsFeedback(req.params.id, input));
}));

router.post('/:id/cast-and-sets/feedback/render', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsFeedbackRenderSchema, req.body || {});
  res.status(202).json(await renderCastAndSetsFeedback(req.params.id, input));
}));

router.post('/:id/cast-and-sets/feedback/refresh-renderer', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsFeedbackPlanSchema, req.body || {});
  res.status(202).json(await refreshCastAndSetsFeedbackRenderer(req.params.id, input));
}));

router.post('/:id/cast-and-sets/feedback/remove-image-note', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsImageNoteRemovalSchema, req.body || {});
  res.json(await removeCastAndSetsImageFeedback(req.params.id, input));
}));

router.delete('/:id/cast-and-sets/feedback/:feedbackId', asyncHandler(async (req, res) => {
  res.json(await removeCastAndSetsFeedbackEntry(req.params.id, req.params.feedbackId));
}));

// Start over: drop a check-in that is not approved (images stay in the gallery).
router.delete('/:id/cast-and-sets', asyncHandler(async (req, res) => {
  res.json(await discardCastAndSets(req.params.id));
}));

router.post('/:id/cast-and-sets/resume', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoCastAndSetsStartSchema, req.body || {});
  res.status(202).json(await resumeCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/inspect', asyncHandler(async (req, res) => {
  const { musicVideoCastSetsInspectSchema } = await import('../lib/musicVideo/musicVideoCastSetsInspectionValidation.js');
  const input = validateRequest(musicVideoCastSetsInspectSchema, req.body || {});
  res.json(await reinspectCastAndSetsImages(req.params.id, input));
}));

router.post('/:id/cast-and-sets/acknowledge-image', asyncHandler(async (req, res) => {
  const { musicVideoCastSetsAcknowledgeSchema } = await import('../lib/musicVideo/musicVideoCastSetsInspectionValidation.js');
  const input = validateRequest(musicVideoCastSetsAcknowledgeSchema, req.body || {});
  const reviewer = req.portosAuthContext.enabled ? await requireProductionReviewer(req) : { kind: 'local', label: 'Local operator' };
  res.json(await acknowledgeCastAndSetsImage(req.params.id, input, reviewer));
}));

router.post('/:id/cast-and-sets/approve', asyncHandler(async (req, res) => {
  const { musicVideoCatalogCheckinApprovalSchema } = await import('../lib/musicVideo/musicVideoCatalogCheckinValidation.js');
  const input = validateRequest(musicVideoCatalogCheckinApprovalSchema, req.body || {});
  res.json(await approveCastAndSets(req.params.id, input));
}));

// "Keep approved": an approved check-in whose concept, style, subjects or song
// changed since is re-stamped on the current inputs (#10141). No body.
router.post('/:id/cast-and-sets/reconfirm', asyncHandler(async (req, res) => {
  const { musicVideoCatalogCheckinApprovalSchema } = await import('../lib/musicVideo/musicVideoCatalogCheckinValidation.js');
  const input = validateRequest(musicVideoCatalogCheckinApprovalSchema, req.body || {});
  res.json(await reconfirmCastAndSets(req.params.id, input));
}));

router.post('/:id/cast-and-sets/skip', asyncHandler(async (req, res) => {
  res.json(await skipCastAndSets(req.params.id));
}));

export default router;
