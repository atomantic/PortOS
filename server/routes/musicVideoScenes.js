/**
 * Scene-slot routes of the Music Video surface: scene CRUD, ordering, splits and merges, frame/clip renders, and the take lifecycle (#16097).
 * Mounted from musicVideo.js at the position of its first route so match order
 * against the remaining routes is unchanged.
 */

import { musicVideoSceneCreateSchema, musicVideoSceneUpdateSchema } from '../lib/musicVideo/musicVideoValidation.js';
import { musicVideoColorMatchTakePatchSchema, musicVideoContinueShotSchema, musicVideoPoolUseSchema, musicVideoSceneReorderSchema, musicVideoVaryWipesSchema, musicVideoSceneSplitSchema, musicVideoLyricCutSchema, musicVideoSceneStartSchema, musicVideoSceneEndSchema, musicVideoSceneFrameRenderSchema, musicVideoSceneClipRenderSchema, musicVideoTakeInputSchema, musicVideoTakeReviewSchema, musicVideoPerformanceRepairSchema, musicVideoApproveFinalSchema, musicVideoUpgradeSchema, musicVideoTakeSelectSchema, musicVideoTakeMoveSchema } from '../lib/musicVideo/musicVideoRouteValidation.js';
import { renderShotDownload } from '../services/musicVideo/shotDownload.js';
import { Router } from 'express';
import { musicVideoImageTreatmentQuerySchema } from '../lib/musicVideo/musicVideoImageTreatmentValidation.js';
import { shotImageTreatmentAspect, shotTreatmentImages } from '../lib/musicVideo/musicVideoImageTreatments.js';
import { resolveGalleryImage } from '../lib/pathSafety.js';
import { readFile } from 'node:fs/promises';
import { getStoredProjectRecord } from '../services/musicVideo/projects.js';
import { z } from 'zod';
import { requireProductionReviewer } from '../services/musicVideo/productionReviewService.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { addProjectScene, updateScene, deleteScene, reorderProjectScenes, varyProjectWipes, splitProjectScene, cutProjectScenesOnLyrics, mergeProjectNextScene, mergeProjectPreviousScene, moveProjectSceneStart, moveProjectSceneEnd, appendSceneTakes, selectSceneTake, placeMediaPoolItem, reviewSceneTake, checkSceneTakePlate, rejectUnusedSceneTakes, swapProjectSceneFrames, moveSceneTake } from '../services/musicVideo/projectBoardEdits.js';
import { requireProject } from '../services/musicVideo/requireProject.js';
import { approveFinal, upgradeApproved } from '../services/musicVideo/finalUpgrade.js';
import { renderSceneClips, renderSceneFrames } from '../services/musicVideo/sceneCardRender.js';
import { takeAssetExists } from '../services/musicVideo/takeAsset.js';
import { renderedTakeCost } from '../services/musicVideo/renderSpend.js';

const router = Router();

// --- Draft excerpt render (#8986) ---
// This temporary export does not create a project excerpt or video history entry.
router.post('/:id/scenes/:sceneId/download', asyncHandler(async (req, res, next) => {
  const { basis } = validateRequest(z.object({ basis: z.string().max(100000) }), req.body);
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const result = await renderShotDownload(req.params.id, req.params.sceneId, controller.signal, basis);
  if (controller.signal.aborted) { await result.cleanup(); return; }
  res.download(result.path, 'music-video-shot.mp4', (err) => {
    result.cleanup().catch(() => {});
    if (err && !res.headersSent && !controller.signal.aborted) next(err);
  });
}));

router.post('/:id/scenes/:sceneId/performance-repair', asyncHandler(async (req, res) => {
  const input = validateRequest(musicVideoPerformanceRepairSchema, req.body || {});
  const { startPerformanceRepair } = await import('../services/musicVideo/performanceRepair.js');
  res.status(201).json(await startPerformanceRepair(req.params.id, req.params.sceneId, input));
}));

// The same deterministic processor feeds the draft preview and the final still.
router.get('/:id/scenes/:sceneId/image-treatment', asyncHandler(async (req, res) => {
  const { treatment } = validateRequest(musicVideoImageTreatmentQuerySchema, req.query);
  const project = await getStoredProjectRecord(req.params.id);
  const scene = project?.scenes?.find(shot => shot.sceneId === req.params.sceneId);
  const original = shotTreatmentImages(scene).some(image => image.id === treatment.imageId) ? resolveGalleryImage(treatment.imageId) : null;
  if (!original) throw new ServerError('This shot image is unavailable on this machine', { status: 404, code: 'NOT_FOUND' });
  const { renderImageTreatment } = await import('../services/musicVideo/imageTreatments.js');
  const preview = await renderImageTreatment(await readFile(original), treatment, { maxEdge: 1280, aspect: shotImageTreatmentAspect(project, scene, treatment.imageId) });
  res.set('Cache-Control', 'private, max-age=300').type('png').send(preview);
}));

// --- Director scene board ---
// Board edits answer with `edit`, the edit result (services/musicVideo/editResult.js): the shots and
// read-time state (take staleness, readiness, approvals) the edit changed, so the editing tab patches
// its copy and skips reading the whole project again (#16247). A full record is GET /:id.

// Draft-to-final upgrade (#16136): approve shots, then price or run the upgrade.
router.post('/:id/scenes/approve-final', asyncHandler(async (req, res) => {
  res.json(await approveFinal(req.params.id, validateRequest(musicVideoApproveFinalSchema, req.body ?? {}), { edit: true }));
}));

router.post('/:id/upgrade', asyncHandler(async (req, res) => {
  res.json(await upgradeApproved(req.params.id, validateRequest(musicVideoUpgradeSchema, req.body ?? {})));
}));

router.post('/:id/scenes', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoSceneCreateSchema, req.body);
  // The reply is the new scene, as before, with the edit result beside its fields.
  const { scene, edit } = await addProjectScene(req.params.id, data);
  res.status(201).json({ ...scene, edit });
}));

router.patch('/:id/scenes/:sceneId', asyncHandler(async (req, res) => {
  const data = validateRequest(musicVideoSceneUpdateSchema, req.body);
  // The reply is the saved scene, as before, with the edit result beside its fields.
  const { scene, edit } = await updateScene(req.params.id, req.params.sceneId, data);
  res.json({ ...scene, edit });
}));

router.delete('/:id/scenes/:sceneId', asyncHandler(async (req, res) => {
  const { edit } = await deleteScene(req.params.id, req.params.sceneId);
  res.json({ edit });
}));

// A non-repeating run of wipes over the cuts out of `count` shots from `fromSceneId` (musicVideoWipes.js).
router.post('/:id/scenes/vary-wipes', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoVaryWipesSchema, req.body ?? {});
  const { project, scenes, edit } = await varyProjectWipes(req.params.id, options);
  res.json({ scenes: scenes.map(({ sceneId, wipeOut, transitionOut }) => ({ sceneId, wipeOut, transitionOut: transitionOut ?? null })), updatedAt: project.updatedAt, edit });
}));

router.post('/:id/scenes/reorder', asyncHandler(async (req, res) => {
  const { sceneIds } = validateRequest(musicVideoSceneReorderSchema, req.body);
  const { edit } = await reorderProjectScenes(req.params.id, sceneIds);
  res.json({ edit });
}));

// Split a shot its backend cannot render in one take (#8977): a performance
// longer than the lip-sync window, a Grok cutaway longer than its longest clip.
// With `atSec`, cut it in two at that song time instead.
router.post('/:id/scenes/:sceneId/split', asyncHandler(async (req, res) => {
  const { backend, atSec } = validateRequest(musicVideoSceneSplitSchema, req.body ?? {});
  const { scenes, edit } = await splitProjectScene(req.params.id, req.params.sceneId, { backend, atSec });
  res.json({ scenes, edit });
}));

// Cut the board on sung words: one shot per phrase or per word over the chosen lyric lines (#14820).
router.post('/:id/scenes/cut-on-lyrics', asyncHandler(async (req, res) => {
  const { cueIds, mode } = validateRequest(musicVideoLyricCutSchema, req.body ?? {});
  const { scenes, skipped, laidOut, edit } = await cutProjectScenesOnLyrics(req.params.id, { cueIds, mode });
  res.json({ scenes, skipped, laidOut, edit });
}));

// Merge a scene with the next one — the inverse of split.
router.post('/:id/scenes/:sceneId/merge-next', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(musicVideoSceneSplitSchema, req.body ?? {});
  const { scene, edit } = await mergeProjectNextScene(req.params.id, req.params.sceneId, { backend });
  res.json({ scene, edit });
}));

// Merge a scene over the previous one: it starts where the previous one did, which is removed.
router.post('/:id/scenes/:sceneId/merge-previous', asyncHandler(async (req, res) => {
  const { backend } = validateRequest(musicVideoSceneSplitSchema, req.body ?? {});
  const { scene, edit } = await mergeProjectPreviousScene(req.params.id, req.params.sceneId, { backend });
  res.json({ scene, edit });
}));

router.post('/:id/scenes/:sceneId/frame', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  const options = validateRequest(musicVideoSceneFrameRenderSchema, req.body ?? {});
  res.json(await renderSceneFrames(project, { sceneId: req.params.sceneId, ...options }));
}));

router.post('/:id/scenes/:sceneId/clip', asyncHandler(async (req, res) => {
  const project = await requireProject(req.params.id);
  const options = validateRequest(musicVideoSceneClipRenderSchema, req.body ?? {});
  res.json(await renderSceneClips(project, { sceneId: req.params.sceneId, ...options }));
}));

// Move a shot's start; the shot before it ends at the same time, so the cut between them moves.
router.post('/:id/scenes/:sceneId/start', asyncHandler(async (req, res) => {
  const { startSec } = validateRequest(musicVideoSceneStartSchema, req.body ?? {});
  const { scene, previous, edit } = await moveProjectSceneStart(req.params.id, req.params.sceneId, { startSec });
  res.json({ scene, previous, edit });
}));

// Move a shot's end; the next shot starts at the same time, so it grows or shrinks to meet it.
router.post('/:id/scenes/:sceneId/end', asyncHandler(async (req, res) => {
  const { endSec } = validateRequest(musicVideoSceneEndSchema, req.body ?? {});
  const { scene, next, edit } = await moveProjectSceneEnd(req.params.id, req.params.sceneId, { endSec });
  res.json({ scene, next, edit });
}));

// Add one candidate take to a scene: the synchronous image lane's inline
// render, or an asset the director imports from the gallery.
router.post('/:id/scenes/:sceneId/takes', asyncHandler(async (req, res) => {
  const { kind, assetId, source = 'imported', provider, originalName, use, sourceImageId, inputAssets, castInputs, replaceSelection, expectedSelection } = validateRequest(musicVideoTakeInputSchema, req.body);
  if (!(await takeAssetExists(kind, assetId))) {
    throw new ServerError(`${kind === 'video' ? 'Video' : 'Image'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  for (const imageId of [sourceImageId, ...(inputAssets || []).map((input) => input.assetId)].filter(Boolean)) {
    if (!(await takeAssetExists('image', imageId))) throw new ServerError('Dependency image not found', { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
  }
  const { scene, appended, edit } = await appendSceneTakes(req.params.id, req.params.sceneId, [{
    kind, assetId, source, provider: provider ?? (source === 'generated' ? 'portos' : null), originalName, use, sourceImageId, inputAssets, castInputs, replaceSelection, expectedSelection,
    ...(await renderedTakeCost(req.params.id, kind, assetId)),
  }]);
  res.status(201).json({ scene, take: appended[0], edit });
}));

// Continuing shot: the previous shot's last on-screen frame becomes this scene's start frame.
router.post('/:id/scenes/:sceneId/continue-from-previous', asyncHandler(async (req, res) => {
  const { keepStillAsEnd } = validateRequest(musicVideoContinueShotSchema, req.body ?? {});
  const { continueFromPreviousShot } = await import('../services/musicVideo/continueShot.js');
  res.json(await continueFromPreviousShot(req.params.id, req.params.sceneId, { keepStillAsEnd }));
}));

router.post('/:id/scenes/:sceneId/takes/use', asyncHandler(async (req, res) => {
  const { kind, assetId, withAssetId } = validateRequest(musicVideoPoolUseSchema, req.body);
  const otherKind = kind === 'video' ? 'image' : 'video';
  for (const [assetKind, id] of [[kind, assetId], [otherKind, withAssetId]]) {
    if (id && !(await takeAssetExists(assetKind, id))) {
      throw new ServerError(`${assetKind === 'video' ? 'Video' : 'Image'} not found in this install's media library`, { status: 400, code: 'TAKE_ASSET_NOT_FOUND' });
    }
  }
  res.json(await placeMediaPoolItem(req.params.id, req.params.sceneId, { kind, assetId, withAssetId }));
}));

router.post('/:id/scenes/:sceneId/takes/:takeId/select', asyncHandler(async (req, res) => {
  const options = validateRequest(musicVideoTakeSelectSchema, req.body ?? {});
  // The saved scene with the edit result beside its fields (see the scene PATCH).
  const { scene, edit } = await selectSceneTake(req.params.id, req.params.sceneId, req.params.takeId, options);
  res.json({ ...scene, edit });
}));

// Move one of the shot's unselected takes to another shot, to organize takes → { scene, target, take, edit }.
router.post('/:id/scenes/:sceneId/takes/:takeId/move', asyncHandler(async (req, res) => {
  const { toSceneId } = validateRequest(musicVideoTakeMoveSchema, req.body ?? {});
  res.json(await moveSceneTake(req.params.id, req.params.sceneId, req.params.takeId, { toSceneId }));
}));

// No body: marks the shot's unselected takes rejected, keeping their files.
router.post('/:id/scenes/:sceneId/takes/reject-unused', asyncHandler(async (req, res) => {
  res.json(await rejectUnusedSceneTakes(req.params.id, req.params.sceneId));
}));

// No body: the shot's start frame becomes its end frame and the end frame its start, prompts included.
router.post('/:id/scenes/:sceneId/swap-frames', asyncHandler(async (req, res) => {
  const { scene, edit } = await swapProjectSceneFrames(req.params.id, req.params.sceneId);
  res.json({ ...scene, edit });
}));

// No body: a vision model checks this frame take against its shot (user-started) → the scene.
router.post('/:id/scenes/:sceneId/takes/:takeId/check', asyncHandler(async (req, res) => {
  const { scene, edit } = await checkSceneTakePlate(req.params.id, req.params.sceneId, req.params.takeId);
  res.json({ ...scene, edit });
}));

router.patch('/:id/scenes/:sceneId/takes/:takeId/color-match', asyncHandler(async (req, res) => {
  const patch = validateRequest(musicVideoColorMatchTakePatchSchema, req.body ?? {});
  const { updateTakeColorMatch } = await import('../services/musicVideo/shotColorMatch.js');
  res.json(await updateTakeColorMatch(req.params.id, req.params.sceneId, req.params.takeId, patch));
}));

router.patch('/:id/scenes/:sceneId/takes/:takeId', asyncHandler(async (req, res) => {
  const review = validateRequest(musicVideoTakeReviewSchema, req.body);
  if (review.acknowledgeRenderQuality || review.confirmFrame || review.acceptCharacterReferences) review.reviewer = req.portosAuthContext.enabled ? await requireProductionReviewer(req) : { kind: 'local', label: 'Local operator' };
  const { scene, edit } = await reviewSceneTake(req.params.id, req.params.sceneId, req.params.takeId, review);
  res.json({ ...scene, edit });
}));

export default router;
