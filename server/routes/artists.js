/**
 * Music artist routes.
 *
 *   GET    /api/artists        → Artist[]   (live, sorted by name; `?limit`/`?offset`
 *                                            switches to the bounded envelope)
 *   POST   /api/artists        → Artist
 *   GET    /api/artists/:id     → Artist
 *   PATCH  /api/artists/:id     → Artist
 *   DELETE /api/artists/:id     → { id }     (soft delete)
 *   GET    /api/artists/:id/submission-profile → { profile, missing, markdown }
 *                                            (the press & submission profile agents
 *                                            read when filling festival/EPK forms)
 *
 * The Music studio's persona store — mirrors routes/authors.js. Bounds come from
 * services/artists/logic.js so the Zod schema here and the service-layer
 * sanitizer agree by construction.
 */

import { Router } from 'express';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import * as artists from '../services/artists/index.js';
import { createSchema, patchSchema } from '../lib/artistValidation.js';

const router = Router();

// Backward-compatible by default: returns the full artists array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const list = await artists.listArtists();
  const query = validateRequest(paginationQuerySchema, req.query);
  if (!isPaginationRequested(query)) return res.json(list);
  res.json(paginateArray(list, query, { defaultLimit: 50, maxLimit: 500 }));
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

router.get('/:id/submission-profile', asyncHandler(async (req, res) => {
  const artist = await artists.getArtist(req.params.id);
  if (!artist) throw new ServerError('Artist not found', { status: 404, code: 'NOT_FOUND' });
  res.json(artists.buildSubmissionProfile(artist));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  res.json(await artists.updateArtist(req.params.id, body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await artists.deleteArtist(req.params.id));
}));

export default router;
