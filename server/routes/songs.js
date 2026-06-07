/**
 * Songs API
 *
 *   GET    /api/songs        → { songs }
 *   GET    /api/songs/:id    → { song }
 *   POST   /api/songs        → { song }   (body: songInputSchema)
 *   PUT    /api/songs/:id    → { song }   (body: songInputSchema.partial())
 *   DELETE /api/songs/:id    → { id }
 *
 * The a cappella song workbench: write/arrange songs and track which voice
 * layers you're learning. Bounds come from services/songs.js so the Zod schema
 * here and the service-layer sanitizer agree by construction (the dashboard-
 * layouts pattern).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import * as svc from '../services/songs.js';

const router = Router();

// Trim then cap, allowing empty (the client clears a field by sending '').
const str = (max) => z.string().trim().max(max);

const sectionSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  lyrics: str(svc.FIELD_MAX_LENGTH).optional().default(''),
});

const layerSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  part: str(svc.PART_MAX_LENGTH).optional().default(''),
  notes: str(svc.FIELD_MAX_LENGTH).optional().default(''),
});

const songInputSchema = z.object({
  title: str(svc.TITLE_MAX_LENGTH).optional().default(''),
  artist: str(svc.ARTIST_MAX_LENGTH).optional().default(''),
  key: str(svc.KEY_MAX_LENGTH).optional().default(''),
  // null clears the tempo; a number is clamped server-side into the band.
  tempo: z.number().int().min(svc.TEMPO_MIN).max(svc.TEMPO_MAX).nullable().optional(),
  rhythmShapeId: str(svc.ID_MAX_LENGTH).optional().default(''),
  notation: str(svc.FIELD_MAX_LENGTH).optional().default(''),
  notes: str(svc.FIELD_MAX_LENGTH).optional().default(''),
  learned: z.boolean().optional(),
  sections: z.array(sectionSchema).max(svc.SECTIONS_MAX).optional(),
  layers: z.array(layerSchema).max(svc.LAYERS_MAX).optional(),
});

// Map a service error (carries a `code`) to the right HTTP status. Without
// this, asyncHandler defaults everything to 500.
const mapSongError = (err) => {
  if (err?.code === svc.ERR_NOT_FOUND) return new ServerError(err.message, { status: 404, code: err.code });
  return err;
};
const rethrowSongError = (err) => { throw mapSongError(err); };

router.get('/', asyncHandler(async (req, res) => {
  const songs = await svc.listSongs();
  res.json({ songs });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const song = await svc.getSong(req.params.id);
  if (!song) throw new ServerError('Song not found', { status: 404, code: svc.ERR_NOT_FOUND });
  res.json({ song });
}));

router.post('/', asyncHandler(async (req, res) => {
  const input = validateRequest(songInputSchema, req.body || {});
  const song = await svc.createSong(input).catch(rethrowSongError);
  res.json({ song });
}));

router.put('/:id', asyncHandler(async (req, res) => {
  const patch = validateRequest(songInputSchema.partial(), req.body || {});
  const song = await svc.updateSong(req.params.id, patch).catch(rethrowSongError);
  res.json({ song });
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await svc.deleteSong(req.params.id).catch(rethrowSongError);
  res.json(result);
}));

export default router;
