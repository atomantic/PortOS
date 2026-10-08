import { Router } from 'express';
import { join } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { PATHS, pathExists } from '../lib/fileUtils.js';
import {
  musicVideoCharacterStyleParamsSchema, musicVideoCharacterStyleReferenceSchema,
} from '../lib/musicVideoValidation.js';
import {
  getCharacterStyleDetail, listCharacterStyles, setCharacterStyleReferenceImage,
} from '../services/musicVideo/characterStyles.js';

// Built-in Music Video character styles (server/lib/musicVideoCharacterStyles.js).
// A project loads one through `concept.characterStyleId`; `PUT /:id/reference`
// picks the gallery image this install uses as the style's character sheet.
const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listCharacterStyles());
}));

router.get('/:id', asyncHandler(async (req, res) => {
  // An unknown id fails the enum, so a 400 here is "no such style".
  const { id } = validateRequest(musicVideoCharacterStyleParamsSchema, req.params);
  res.json(await getCharacterStyleDetail(id));
}));

router.put('/:id/reference', asyncHandler(async (req, res) => {
  const { id } = validateRequest(musicVideoCharacterStyleParamsSchema, req.params);
  const { imageId } = validateRequest(musicVideoCharacterStyleReferenceSchema, req.body);
  if (imageId && !(await pathExists(join(PATHS.images, imageId)))) {
    throw new ServerError('Gallery image not found', { status: 404, code: 'NOT_FOUND' });
  }
  res.json(await setCharacterStyleReferenceImage(id, imageId));
}));

export default router;
