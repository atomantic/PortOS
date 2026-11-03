import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import {
  musicVideoCameoCreateSchema, musicVideoCameoLinkSchema, musicVideoCameoReferenceRemoveSchema,
  musicVideoCameoReferencesAddSchema, musicVideoCameoStillFromShotSchema, musicVideoCameoUnlinkSchema, musicVideoCameoUpdateSchema,
  musicVideoCameoVariantCreateSchema, musicVideoCameoVariantUpdateSchema,
} from '../lib/musicVideoValidation.js';
import { MUSIC_VIDEO_CAMEO_ID_PATTERN, MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN } from '../lib/musicVideoCameos.js';
import {
  addCameoReferences, addCameoVariant, createCameos, deleteCameo, deleteCameoVariant, linkCameoShots,
  removeCameoReference, unlinkCameoShots, updateCameo, updateCameoVariant, useShotStillForCameo,
} from '../services/musicVideo/cameos.js';

// Music Video cameo roster (#14821): mounted under /api/music-video ahead of the main router.
const router = Router();

const cameoParams = z.object({ id: z.string().min(1).max(200), cameoId: z.string().regex(MUSIC_VIDEO_CAMEO_ID_PATTERN) }).strict();
const variantParams = cameoParams.extend({ variantId: z.string().regex(MUSIC_VIDEO_CAMEO_VARIANT_ID_PATTERN) }).strict();

router.post('/:id/cameos', asyncHandler(async (req, res) => {
  const { cameos } = validateRequest(musicVideoCameoCreateSchema, req.body ?? {});
  res.status(201).json(await createCameos(req.params.id, cameos));
}));

router.patch('/:id/cameos/:cameoId', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  res.json(await updateCameo(id, cameoId, validateRequest(musicVideoCameoUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/cameos/:cameoId', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  res.json(await deleteCameo(id, cameoId));
}));

router.post('/:id/cameos/:cameoId/references', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  const { references } = validateRequest(musicVideoCameoReferencesAddSchema, req.body ?? {});
  res.json(await addCameoReferences(id, cameoId, references));
}));

router.post('/:id/cameos/:cameoId/references/remove', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  const { imageId } = validateRequest(musicVideoCameoReferenceRemoveSchema, req.body ?? {});
  res.json(await removeCameoReference(id, cameoId, imageId));
}));

router.post('/:id/cameos/:cameoId/variants', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  res.status(201).json(await addCameoVariant(id, cameoId, validateRequest(musicVideoCameoVariantCreateSchema, req.body ?? {})));
}));

router.patch('/:id/cameos/:cameoId/variants/:variantId', asyncHandler(async (req, res) => {
  const { id, cameoId, variantId } = validateRequest(variantParams, req.params);
  res.json(await updateCameoVariant(id, cameoId, variantId, validateRequest(musicVideoCameoVariantUpdateSchema, req.body ?? {})));
}));

router.delete('/:id/cameos/:cameoId/variants/:variantId', asyncHandler(async (req, res) => {
  const { id, cameoId, variantId } = validateRequest(variantParams, req.params);
  res.json(await deleteCameoVariant(id, cameoId, variantId));
}));

router.post('/:id/cameos/:cameoId/shots', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  res.json(await linkCameoShots(id, cameoId, validateRequest(musicVideoCameoLinkSchema, req.body ?? {})));
}));

router.post('/:id/cameos/:cameoId/still-from-shot', asyncHandler(async (req, res) => {
  const { id, cameoId } = validateRequest(cameoParams, req.params);
  res.json(await useShotStillForCameo(id, cameoId, validateRequest(musicVideoCameoStillFromShotSchema, req.body ?? {})));
}));

router.post('/:id/cameo-links/clear', asyncHandler(async (req, res) => {
  res.json(await unlinkCameoShots(req.params.id, validateRequest(musicVideoCameoUnlinkSchema, req.body ?? {})));
}));

export default router;
