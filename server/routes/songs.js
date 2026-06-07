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
import { generateSong, evaluateSong } from '../services/songsAI.js';

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

// A saved vocal take. `filename` is the /api/uploads file the audio is served
// from (the client uploads the WAV first, then PUTs the song with the returned
// filename). Numbers are accepted for the mixer; the service clamps them.
const recordingSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  layerId: str(svc.ID_MAX_LENGTH).optional().default(''),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  filename: str(svc.URL_MAX_LENGTH),
  durationMs: z.number().nonnegative().optional(),
  peak: z.number().min(0).max(1).optional(),
  muted: z.boolean().optional(),
  createdAt: z.string().optional(),
});

// A reference link/video (e.g. a TikTok performance). `url` is required; the
// client renders TikTok urls as embeds and everything else as a link.
const referenceSchema = z.object({
  id: str(svc.ID_MAX_LENGTH).optional(),
  url: str(svc.URL_MAX_LENGTH),
  label: str(svc.LABEL_MAX_LENGTH).optional().default(''),
  note: str(svc.FIELD_MAX_LENGTH).optional().default(''),
});

// No `.default('')` on these fields: `.partial()` (used for PUT) materializes a
// default for an *omitted* key, which would turn a single-field PUT into a
// wipe of every other field via updateSong's `'key' in patch` merge. Leaving
// them plain-optional keeps omitted keys absent (preserve) vs present-empty
// (clear); the service's `trimField` coerces a present `undefined`/'' anyway.
const songInputSchema = z.object({
  title: str(svc.TITLE_MAX_LENGTH).optional(),
  artist: str(svc.ARTIST_MAX_LENGTH).optional(),
  key: str(svc.KEY_MAX_LENGTH).optional(),
  // null clears the tempo; a number is clamped server-side into the band.
  tempo: z.number().int().min(svc.TEMPO_MIN).max(svc.TEMPO_MAX).nullable().optional(),
  rhythmShapeId: str(svc.ID_MAX_LENGTH).optional(),
  notation: str(svc.FIELD_MAX_LENGTH).optional(),
  // Sheet-music notation (PortOS lead-sheet DSL) — bounded free text; the client
  // parses/renders it. Longer cap than `notation` since a full score is verbose.
  score: str(svc.SCORE_MAX_LENGTH).optional(),
  notes: str(svc.FIELD_MAX_LENGTH).optional(),
  learned: z.boolean().optional(),
  sections: z.array(sectionSchema).max(svc.SECTIONS_MAX).optional(),
  layers: z.array(layerSchema).max(svc.LAYERS_MAX).optional(),
  recordings: z.array(recordingSchema).max(svc.RECORDINGS_MAX).optional(),
  references: z.array(referenceSchema).max(svc.REFERENCES_MAX).optional(),
});

// AI generate/evaluate inputs. providerId/model are optional overrides; the
// service falls back to the active provider. Empty-string providerId (a UI
// "use default" sentinel) is coerced to undefined so it doesn't pin a bogus id.
const optProvider = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());
const generateSchema = z.object({
  title: str(svc.TITLE_MAX_LENGTH).optional(),
  artist: str(svc.ARTIST_MAX_LENGTH).optional(),
  brief: str(svc.FIELD_MAX_LENGTH).optional(),
  mood: str(svc.FIELD_MAX_LENGTH).optional(),
  // When true, the target song (route :id) is folded into the prompt so
  // "generate" expands the existing draft instead of starting blank.
  expandExisting: z.boolean().optional(),
  providerId: optProvider,
  model: optProvider,
});
const evaluateSchema = z.object({
  providerId: optProvider,
  model: optProvider,
});

// Map a service error (carries a `code`) to the right HTTP status. Without
// this, asyncHandler defaults everything to 500.
const mapSongError = (err) => {
  if (err?.code === svc.ERR_NOT_FOUND) return new ServerError(err.message, { status: 404, code: err.code });
  if (err?.code === svc.ERR_NOT_BUILTIN) return new ServerError(err.message, { status: 400, code: err.code });
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

// POST /api/songs/:id/refresh-template → reset a built-in default song's shipped
// content (metadata/lyrics/layers/notation) to the current bundled template,
// preserving the user's own recordings + learned progress. 400 if not built-in.
router.post('/:id/refresh-template', asyncHandler(async (req, res) => {
  const song = await svc.refreshSongFromTemplate(req.params.id).catch(rethrowSongError);
  res.json({ song });
}));

// --- AI generate / evaluate -------------------------------------------------
// POST /api/songs/generate → draft a brand-new arrangement from a brief. Does
// NOT persist — returns { song: <fields>, llm } the client merges/creates from.
// (Routed before /:id/* so a literal `/generate` can't be read as an id.)
router.post('/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body || {});
  const result = await generateSong(body);
  res.json(result);
}));

// POST /api/songs/:id/generate → expand the stored song (when expandExisting)
// or draft fresh using its title/artist as the brief. Returns { song, llm };
// the client merges into the editor draft (does not auto-save).
router.post('/:id/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body || {});
  const existing = await svc.getSong(req.params.id);
  if (!existing) throw new ServerError('Song not found', { status: 404, code: svc.ERR_NOT_FOUND });
  const result = await generateSong({
    title: body.title ?? existing.title,
    artist: body.artist ?? existing.artist,
    brief: body.brief,
    mood: body.mood,
    existingSong: body.expandExisting ? existing : undefined,
    providerId: body.providerId,
    model: body.model,
  });
  res.json(result);
}));

// POST /api/songs/:id/evaluate → critique the stored arrangement. Read-only:
// returns { evaluation, llm } without mutating the song.
router.post('/:id/evaluate', asyncHandler(async (req, res) => {
  const body = validateRequest(evaluateSchema, req.body || {});
  const song = await svc.getSong(req.params.id);
  if (!song) throw new ServerError('Song not found', { status: 404, code: svc.ERR_NOT_FOUND });
  const result = await evaluateSong({ song, providerId: body.providerId, model: body.model });
  res.json(result);
}));

export default router;
