import { Router } from 'express';
import { join } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { PATHS, pathExists } from '../lib/fileUtils.js';
import {
  musicVideoCharacterStyleParamsSchema,
  musicVideoCharacterStyleReferenceSchema,
} from '../lib/musicVideo/routeValidation/misc.js';
import {
  listCharacterStyles, setCharacterStyleReferenceImage,
} from '../services/musicVideo/characterStyles.js';

// Built-in Music Video character styles (server/lib/musicVideo/musicVideoCharacterStyles.js).
// A project loads one through `concept.characterStyleId`; `PUT /:id/reference`
// picks the gallery image this install uses as the style's character sheet.
const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(await listCharacterStyles());
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
