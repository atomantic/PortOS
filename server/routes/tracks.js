/**
 * Music track routes.
 *
 *   GET    /api/tracks                 → Track[]   (live, creation order)
 *   POST   /api/tracks                 → Track
 *   GET    /api/tracks/library         → { tracks } (shared music library list)
 *   GET    /api/tracks/:id              → Track
 *   PATCH  /api/tracks/:id              → Track
 *   DELETE /api/tracks/:id              → { id }     (soft delete)
 *   POST   /api/tracks/:id/audio/upload → Track      (multipart 'track' file)
 *   POST   /api/tracks/:id/audio/attach → Track      (attach a library filename)
 *   DELETE /api/tracks/:id/audio        → Track      (clear the audio pointer)
 *
 * Tracks store only a pointer (`audioFilename`) into the shared music library
 * (services/pipeline/musicLibrary.js, `data/music/`); the bytes are uploaded /
 * generated there. Bounds come from services/tracks/logic.js. Mirrors the
 * artists/albums routes plus the audio-attach surface from the pipeline audio
 * stage. Deleting a track does NOT delete its library audio (it may be shared).
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { uploadSingle } from '../lib/multipart.js';
import * as tracks from '../services/tracks/index.js';
import {
  listMusicLibrary, importUploadedTrack, statMusicTrack,
  isSupportedMusicUpload, assertSafeMusicFilename, MUSIC_UPLOAD_MAX_BYTES,
} from '../services/pipeline/musicLibrary.js';

const router = Router();

const titleField = z.string().trim().min(1).max(tracks.TITLE_MAX);
const albumIdField = z.string().trim().max(tracks.ALBUM_ID_MAX);
const artistIdField = z.string().trim().max(tracks.ARTIST_ID_MAX);
const artistNameField = z.string().trim().max(tracks.ARTIST_NAME_MAX);
const lyricsField = z.string().trim().max(tracks.LYRICS_MAX);
const promptField = z.string().trim().max(tracks.PROMPT_MAX);
const engineField = z.string().trim().max(tracks.ENGINE_MAX);
const modelIdField = z.string().trim().max(tracks.MODEL_ID_MAX);
const audioFilenameField = z.string().trim().max(tracks.AUDIO_FILENAME_MAX);
const durationField = z.number().int().min(tracks.DURATION_MIN_SEC).max(tracks.DURATION_MAX_SEC).nullable();

const createSchema = z.object({
  title: titleField,
  albumId: albumIdField.optional().default(''),
  artistId: artistIdField.optional().default(''),
  artist: artistNameField.optional().default(''),
  lyrics: lyricsField.optional().default(''),
  prompt: promptField.optional().default(''),
  engine: engineField.optional().default(''),
  modelId: modelIdField.optional().default(''),
  durationSec: durationField.optional().default(null),
  audioFilename: audioFilenameField.optional().default(''),
});

const patchSchema = z.object({
  title: titleField.optional(),
  albumId: albumIdField.optional(),
  artistId: artistIdField.optional(),
  artist: artistNameField.optional(),
  lyrics: lyricsField.optional(),
  prompt: promptField.optional(),
  engine: engineField.optional(),
  modelId: modelIdField.optional(),
  durationSec: durationField.optional(),
  audioFilename: audioFilenameField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

const attachSchema = z.object({
  filename: z.string().trim().min(1).max(tracks.AUDIO_FILENAME_MAX),
});

// Reuse the pipeline audio stage's multipart upload contract (50MB, audio MIME).
const musicUpload = uploadSingle('track', {
  limits: { fileSize: MUSIC_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (isSupportedMusicUpload(file)) {
      cb(null, true);
    } else {
      cb(new ServerError(
        'Unsupported audio format — accepted: MP3, WAV, M4A, OGG, FLAC',
        { status: 400, code: 'TRACK_AUDIO_UNSUPPORTED_FORMAT' },
      ));
    }
  },
});

// Load a track or 404 — shared by the audio mutation routes.
async function requireTrack(id) {
  const track = await tracks.getTrack(id);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  return track;
}

router.get('/', asyncHandler(async (_req, res) => {
  res.json(await tracks.listTracks());
}));

// Shared music library — every uploaded/generated track sits here. The studio
// uses it to attach an existing track to a record without re-uploading. Routed
// before /:id so the literal `library` segment can't be read as a track id.
router.get('/library', asyncHandler(async (_req, res) => {
  res.json({ tracks: await listMusicLibrary() });
}));

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  res.status(201).json(await tracks.createTrack(body));
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await requireTrack(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  res.json(await tracks.updateTrack(req.params.id, body));
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  res.json(await tracks.deleteTrack(req.params.id));
}));

// Upload an audio file into the shared library and attach it to this track.
router.post('/:id/audio/upload', musicUpload, asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  if (!req.file) throw new ServerError('No audio file uploaded', { status: 400, code: 'TRACK_AUDIO_MISSING_FILE' });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const updated = await tracks.updateTrack(req.params.id, { audioFilename: filename });
  res.json({ track: updated, filename, sizeBytes });
}));

// Attach an existing library track (by stored filename) to this track.
router.post('/:id/audio/attach', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  const { filename } = validateRequest(attachSchema, req.body ?? {});
  assertSafeMusicFilename(filename);
  const found = await statMusicTrack(filename);
  if (!found) throw new ServerError('Track not found in the music library', { status: 404, code: 'TRACK_AUDIO_NOT_IN_LIBRARY' });
  res.json({ track: await tracks.updateTrack(req.params.id, { audioFilename: filename }) });
}));

// Clear the audio pointer (leaves the library file in place — it may be shared).
router.delete('/:id/audio', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  res.json({ track: await tracks.updateTrack(req.params.id, { audioFilename: '' }) });
}));

export default router;
