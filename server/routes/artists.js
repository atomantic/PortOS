/**
 * Music artist routes.
 *
 *   GET    /api/artists        → Artist[]   (live, sorted by name)
 *   POST   /api/artists        → Artist
 *   GET    /api/artists/:id     → Artist
 *   PATCH  /api/artists/:id     → Artist
 *   DELETE /api/artists/:id     → { id }     (soft delete)
 *
 * The Music studio's persona store — mirrors routes/authors.js. Bounds come from
 * services/artists/logic.js so the Zod schema here and the service-layer
 * sanitizer agree by construction.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest, isPaginationRequested, paginateArray } from '../lib/validation.js';
import * as artists from '../services/artists/index.js';

const router = Router();

const nameField = z.string().trim().min(1).max(artists.NAME_MAX);
const genreField = z.string().trim().max(artists.GENRE_MAX);
const bioField = z.string().trim().max(artists.BIO_MAX);
const musicalStyleField = z.string().trim().max(artists.MUSICAL_STYLE_MAX);
const physicalDescriptionField = z.string().trim().max(artists.PHYSICAL_DESCRIPTION_MAX);
const portraitStyleField = z.string().trim().max(artists.PORTRAIT_STYLE_MAX);
const portraitImageUrlField = z.string().trim().max(artists.PORTRAIT_IMAGE_URL_MAX);

const createSchema = z.object({
  name: nameField,
  genre: genreField.optional().default(''),
  bio: bioField.optional().default(''),
  musicalStyle: musicalStyleField.optional().default(''),
  physicalDescription: physicalDescriptionField.optional().default(''),
  portraitStyle: portraitStyleField.optional().default(''),
  portraitImageUrl: portraitImageUrlField.optional().default(''),
});

const patchSchema = z.object({
  name: nameField.optional(),
  genre: genreField.optional(),
  bio: bioField.optional(),
  musicalStyle: musicalStyleField.optional(),
  physicalDescription: physicalDescriptionField.optional(),
  portraitStyle: portraitStyleField.optional(),
  portraitImageUrl: portraitImageUrlField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

router.get('/', asyncHandler(async (req, res) => {
  const list = await artists.listArtists();
  if (!isPaginationRequested(req.query)) return res.json(list);
  res.json(paginateArray(list, req.query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await artists.createArtist(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const artist = await artists.getArtist(req.params.id);
  if (!artist) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
  res.json(artist);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  res.json(await artists.updateArtist(req.params.id, body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await artists.deleteArtist(req.params.id));
}));

export default router;
