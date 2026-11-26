/** Build catalog previz, greybox, photoreal and look-around assets. */

import {
  previzBuildJobStartSchema, previzBuildJobFinishSchema, catalogGreyboxDraftSchema,
  catalogGreyboxSaveSchema, catalogWorldSaveSchema, catalogGreyboxCaptureSchema,
  catalogGreyboxRenderSchema, catalogPhotorealCancelSchema, catalogPhotorealRenderSchema,
  catalogPhotorealOpenSchema, catalogPhotorealLookDraftSchema, catalogPhotorealLookSaveSchema,
  catalogPhotorealTextureIdSchema, catalogPhotorealTextureSearchSchema,
} from '../lib/catalog/catalogGreyboxValidation.js';
import { Router } from 'express';
import { catalogEvents } from '../services/catalog/catalogEvents.js';
import { projectToCanon } from '../services/catalog/catalogCanonProjection.js';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import {
  catalogLookAroundRenderSchema, catalogLookAroundClipParamsSchema,
  catalogLookAroundFramesSchema, catalogLookAroundAnglesSchema,
} from '../lib/catalog/catalogValidation.js';
import { listPrevizJobs, startPrevizJob, finishPrevizJob } from '../services/previzJobs.js';
import {
  captureGreyboxShot, draftGreybox, previewGreyboxPrompt, renderGreyboxShot, saveGreybox,
  saveWorld,
} from '../services/catalog/catalogGreybox.js';
import {
  cancelPhotorealRender, getPhotorealStatus, openPhotorealBlend, photorealBlendPath,
  startPhotorealRender,
} from '../services/catalog/catalogPhotoreal.js';
import { installTexture, listInstalledTextures, searchTextures } from '../services/photorealTextures.js';
import { draftPhotorealLook, previewPhotorealLookPrompt, savePhotorealLook } from '../services/catalog/catalogPhotorealLook.js';

const router = Router();

// Previz work in flight (greybox drafts, AI previz proposals) and recently finished.
router.get('/previz-jobs', (_req, res) => res.json(listPrevizJobs()));

// Build / Sync with shots runs in the browser; the page reports it here so other tabs and agents see it.
router.post('/previz-jobs', asyncHandler(async (req, res) => {
  const { projectId, label } = validateRequest(previzBuildJobStartSchema, req.body);
  res.status(201).json({ id: startPrevizJob({ kind: 'build', projectId, label }) });
}));
router.post('/previz-jobs/:id/finish', asyncHandler(async (req, res) => {
  const body = validateRequest(previzBuildJobFinishSchema, req.body || {});
  res.json({ finished: finishPrevizJob(req.params.id, body) });
}));

// Place greybox. Draft is a provider call on the user's tap (host-control gated
// like every write, see hostControlRoutes.js) and answers with a preview; save stores or clears it;
// capture attaches a rendered shot as a reference image.
router.post('/ingredients/:id/greybox/draft', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogGreyboxDraftSchema, req.body);
  res.json(await draftGreybox(req.params.id, body));
}));

router.post('/ingredients/:id/greybox/prompt', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogGreyboxDraftSchema, req.body);
  res.json(await previewGreyboxPrompt(req.params.id, body));
}));

router.put('/ingredients/:id/greybox', asyncHandler(async (req, res) => {
  const { greybox, source } = validateRequest(catalogGreyboxSaveSchema, req.body);
  const updated = await saveGreybox(req.params.id, greybox, { source });
  res.json(updated);
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
  // Same fan-out as PATCH: a linked universe's embedded place must not keep the
  // old layout, or its next Universe Builder edit would write it back.
  projectToCanon(updated.id, updated).catch((err) => {
    console.error(`🔁 catalog→canon projection failed for ${updated.id}: ${err.message}`);
  });
}));

// World map: places other environments and joins them with paths (lib/worldMap.js).
router.put('/ingredients/:id/world', asyncHandler(async (req, res) => {
  const { world, source } = validateRequest(catalogWorldSaveSchema, req.body);
  const updated = await saveWorld(req.params.id, world, { source });
  res.json(updated);
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
  projectToCanon(updated.id, updated).catch((err) => {
    console.error(`🔁 catalog→canon projection failed for ${updated.id}: ${err.message}`);
  });
}));

router.post('/ingredients/:id/greybox/shots/:shotId/capture', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogGreyboxCaptureSchema, req.body);
  const media = await captureGreyboxShot(req.params.id, req.params.shotId, body);
  res.status(201).json(media);
  catalogEvents.emit('primitive-changed', { ingredientId: req.params.id });
}));

router.post('/ingredients/:id/greybox/shots/:shotId/render', asyncHandler(async (req, res) => {
  validateRequest(catalogGreyboxRenderSchema, req.body ?? {});
  const media = await renderGreyboxShot(req.params.id, req.params.shotId);
  res.status(201).json(media);
  catalogEvents.emit('primitive-changed', { ingredientId: req.params.id });
}));

// CC0 photo textures for Photoreal looks. Poly Haven is reached only from these
// user actions: opening the picker searches, a tap downloads.
router.get('/photoreal/textures', asyncHandler(async (_req, res) => {
  res.json({ installed: await listInstalledTextures() });
}));

router.get('/photoreal/textures/search', asyncHandler(async (req, res) => {
  const { preset, q } = validateRequest(catalogPhotorealTextureSearchSchema, req.query);
  res.json({ results: await searchTextures({ preset, query: q }) });
}));

router.post('/photoreal/textures/:id/install', asyncHandler(async (req, res) => {
  res.json(await installTexture(validateRequest(catalogPhotorealTextureIdSchema, req.params.id)));
}));

// Photoreal: the place's greybox rebuilt in Blender and rendered from its saved
// cameras (host-control gated: runs the operator-checked Blender executable).
router.get('/ingredients/:id/photoreal', asyncHandler(async (req, res) => {
  res.json(await getPhotorealStatus(req.params.id));
}));

router.post('/ingredients/:id/photoreal/render', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPhotorealRenderSchema, req.body);
  res.status(202).json(await startPhotorealRender(req.params.id, body));
}));

router.post('/ingredients/:id/photoreal/cancel', asyncHandler(async (req, res) => {
  const { jobId } = validateRequest(catalogPhotorealCancelSchema, req.body ?? {});
  res.json(await cancelPhotorealRender(req.params.id, jobId));
}));

// Photoreal look (materials, lights, atmosphere): AI draft is a preview only.
router.post('/ingredients/:id/photoreal/look/draft', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPhotorealLookDraftSchema, req.body);
  res.json(await draftPhotorealLook(req.params.id, body));
}));

router.post('/ingredients/:id/photoreal/look/prompt', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogPhotorealLookDraftSchema, req.body);
  res.json(await previewPhotorealLookPrompt(req.params.id, body));
}));

router.put('/ingredients/:id/photoreal/look', asyncHandler(async (req, res) => {
  const { look, source } = validateRequest(catalogPhotorealLookSaveSchema, req.body);
  const updated = await savePhotorealLook(req.params.id, look, { source });
  res.json(updated);
  catalogEvents.emit('primitive-changed', { ingredientId: updated.id });
  projectToCanon(updated.id, updated).catch((err) => {
    console.error(`🔁 catalog→canon projection failed for ${updated.id}: ${err.message}`);
  });
}));

// Builds a missing scene without rendering, then opens it in the checked Blender.
router.post('/ingredients/:id/photoreal/open', asyncHandler(async (req, res) => {
  validateRequest(catalogPhotorealOpenSchema, req.body || {});
  res.json(await openPhotorealBlend(req.params.id));
}));

router.get('/ingredients/:id/photoreal/blend', asyncHandler(async (req, res) => {
  const path = await photorealBlendPath(req.params.id);
  if (!path) throw new ServerError('No Blender scene has been built for this place yet.', { status: 404, code: 'NOT_FOUND' });
  res.download(path, 'blockout.blend');
}));

// Look around (#16145): one rotating-camera clip of a place's main plate becomes matching angle plates.
// The render previews its prompt and price (`dryRun`); nothing attaches to the place until angles are kept.
router.get('/ingredients/:id/look-around', asyncHandler(async (req, res) => {
  const { getLookAround } = await import('../services/catalog/catalogLookAround.js');
  res.json(await getLookAround(req.params.id));
}));

router.post('/ingredients/:id/look-around', asyncHandler(async (req, res) => {
  const body = validateRequest(catalogLookAroundRenderSchema, req.body ?? {});
  const { startLookAround } = await import('../services/catalog/catalogLookAround.js');
  res.status(body.dryRun ? 200 : 202).json(await startLookAround(req.params.id, body));
}));

// A POST, not a GET: scoring decodes the clip with ffmpeg, and writes are host-control gated.
router.post('/ingredients/:id/look-around/:clipId/frames', asyncHandler(async (req, res) => {
  const { id, clipId } = validateRequest(catalogLookAroundClipParamsSchema, req.params);
  validateRequest(catalogLookAroundFramesSchema, req.body ?? {});
  const { scoreLookAroundClip } = await import('../services/catalog/catalogLookAround.js');
  res.json(await scoreLookAroundClip(id, clipId));
}));

router.post('/ingredients/:id/look-around/:clipId/angles', asyncHandler(async (req, res) => {
  const { id, clipId } = validateRequest(catalogLookAroundClipParamsSchema, req.params);
  const body = validateRequest(catalogLookAroundAnglesSchema, req.body ?? {});
  const { saveLookAroundAngles } = await import('../services/catalog/catalogLookAround.js');
  const result = await saveLookAroundAngles(id, clipId, body);
  res.status(result.dryRun ? 200 : 201).json(result);
  if (!result.dryRun) catalogEvents.emit('primitive-changed', { ingredientId: id });
}));

export default router;
