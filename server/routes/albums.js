/**
 * Music album routes.
 *
 *   GET    /api/albums        → Album[]   (live, sorted by title; `?limit`/`?offset`
 *                                          switches to the bounded envelope)
 *   POST   /api/albums        → Album
 *   GET    /api/albums/:id     → Album
 *   PATCH  /api/albums/:id     → Album
 *   DELETE /api/albums/:id     → { id }     (soft delete)
 *
 * Bounds come from services/albums/logic.js so the Zod schema here and the
 * service-layer sanitizer agree by construction. Mirrors routes/artists.js.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import * as albums from '../services/albums/index.js';
import { createAlbumWithTracks, updateAlbumWithTracks, deleteAlbumWithTracks } from '../services/trackAlbumMembership.js';
import { createSchema, patchSchema } from '../lib/albumValidation.js';

const router = Router();

// Backward-compatible by default: returns the full albums array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const list = await albums.listAlbums();
  const query = validateRequest(paginationQuerySchema, req.query);
  if (!isPaginationRequested(query)) return res.json(list);
  res.json(paginateArray(list, query, { defaultLimit: 50, maxLimit: 500 }));
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  const album = await createAlbumWithTracks(body);
  res.status(201).json(album);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const album = await albums.getAlbum(req.params.id);
  if (!album) throw new ServerError('Album not found', { status: 404, code: 'NOT_FOUND' });
  res.json(album);
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const album = await updateAlbumWithTracks(req.params.id, body);
  res.json(album);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await deleteAlbumWithTracks(req.params.id);
  res.json(result);
}));

export default router;
