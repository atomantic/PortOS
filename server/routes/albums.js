/**
 * Music album routes.
 *
 *   GET    /api/albums        → Album[]   (live, sorted by title)
 *   POST   /api/albums        → Album
 *   GET    /api/albums/:id     → Album
 *   PATCH  /api/albums/:id     → Album
 *   DELETE /api/albums/:id     → { id }     (soft delete)
 *
 * Bounds come from services/albums/logic.js so the Zod schema here and the
 * service-layer sanitizer agree by construction. Mirrors routes/artists.js.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as albums from '../services/albums/index.js';

const router = Router();

const titleField = z.string().trim().min(1).max(albums.TITLE_MAX);
const artistIdField = z.string().trim().max(albums.ARTIST_ID_MAX);
const artistNameField = z.string().trim().max(albums.ARTIST_NAME_MAX);
const descriptionField = z.string().trim().max(albums.DESCRIPTION_MAX);
const genreField = z.string().trim().max(albums.GENRE_MAX);
const coverImageUrlField = z.string().trim().max(albums.COVER_IMAGE_URL_MAX);
// null clears the year; a number is clamped server-side into the band.
const releaseYearField = z.number().int().min(albums.RELEASE_YEAR_MIN).max(albums.RELEASE_YEAR_MAX).nullable();
const trackIdsField = z.array(z.string().trim().max(albums.TRACK_ID_MAX)).max(albums.TRACK_IDS_MAX);

const createSchema = z.object({
  title: titleField,
  artistId: artistIdField.optional().default(''),
  artist: artistNameField.optional().default(''),
  description: descriptionField.optional().default(''),
  genre: genreField.optional().default(''),
  releaseYear: releaseYearField.optional().default(null),
  coverImageUrl: coverImageUrlField.optional().default(''),
  trackIds: trackIdsField.optional().default([]),
});

const patchSchema = z.object({
  title: titleField.optional(),
  artistId: artistIdField.optional(),
  artist: artistNameField.optional(),
  description: descriptionField.optional(),
  genre: genreField.optional(),
  releaseYear: releaseYearField.optional(),
  coverImageUrl: coverImageUrlField.optional(),
  trackIds: trackIdsField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await albums.listAlbums());
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await albums.createAlbum(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const album = await albums.getAlbum(req.params.id);
  if (!album) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
  res.json(album);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  res.json(await albums.updateAlbum(req.params.id, body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await albums.deleteAlbum(req.params.id));
}));

export default router;
