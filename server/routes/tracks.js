/**
 * Music track routes.
 *
 *   GET    /api/tracks                 → Track[]   (live, creation order)
 *   POST   /api/tracks                 → Track
 *   GET    /api/tracks/library         → { tracks } (shared music library list)
 *   POST   /api/tracks/import/youtube  → { jobId }  (download + extract audio from a YouTube URL)
 *   GET    /api/tracks/import/:jobId/events → SSE progress for a YouTube import job
 *   POST   /api/tracks/import/:jobId/cancel → { ok }
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
 *
 * The YouTube import (#1945) is a library-level action (not per-track) — it
 * lands a new Track in the library, same as an upload, so any project's track
 * picker can attach it afterward without re-downloading.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { uploadSingle } from '../lib/multipart.js';
import * as tracks from '../services/tracks/index.js';
import * as albums from '../services/albums/index.js';
import {
  listMusicLibrary, importUploadedTrack, statMusicTrack,
  isSupportedMusicUpload, assertSafeMusicFilename, MUSIC_UPLOAD_MAX_BYTES,
} from '../services/pipeline/musicLibrary.js';
import {
  startYoutubeImport, attachImportSseClient, cancelYoutubeImport, YOUTUBE_URL_RE,
} from '../services/trackYoutubeImport.js';
import { generateChiptuneScore, renderChiptuneTrack, publishChiptuneTrack } from '../services/chiptune.js';

const router = Router();

const titleField = z.string().trim().min(1).max(tracks.TITLE_MAX);
const albumIdField = z.string().trim().max(tracks.ALBUM_ID_MAX);
const artistIdField = z.string().trim().max(tracks.ARTIST_ID_MAX);
const artistNameField = z.string().trim().max(tracks.ARTIST_NAME_MAX);
const lyricsField = z.string().trim().max(tracks.LYRICS_MAX);
const promptField = z.string().trim().max(tracks.PROMPT_MAX);
const engineField = z.string().trim().max(tracks.ENGINE_MAX);
const modelIdField = z.string().trim().max(tracks.MODEL_ID_MAX);
// On the generic save path, `audioFilename` must be a bare, safe music-library
// basename — same guard `/audio/attach` enforces — so a direct POST/PATCH can't
// persist a path-ish (`../x.mp3`) or wrong-extension pointer that the player
// would later render. '' is allowed (clears the pointer). Existence is NOT
// checked here (a create may set the name before the file lands); the dedicated
// attach route verifies the file is in the library.
const audioFilenameField = z.string().trim().max(tracks.AUDIO_FILENAME_MAX).refine(
  (v) => {
    if (v === '') return true;
    try { assertSafeMusicFilename(v); return true; } catch { return false; }
  },
  { message: 'audioFilename must be a bare music-library filename (mp3/wav/m4a/ogg/flac), no path separators' },
);
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

const youtubeImportSchema = z.object({
  url: z.string().trim().regex(YOUTUBE_URL_RE, 'Not a recognized YouTube URL (expected youtube.com/watch, youtu.be, or m.youtube.com)'),
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

// Make `filename` the active audio AND record it in the render history so an
// uploaded/attached take shows up as a card alongside generated ones. An
// uploaded render has no engine/model/duration, so the active gen-metadata is
// cleared (keeps the read-only badges honest). Re-attaching a file already in
// the history just re-selects it (no duplicate card).
//
// Re-reads the track by id (the caller validated existence earlier) so the
// append builds on the FRESHEST persisted history: a render added to this track
// between the route's initial load and now — a long generation finishing, or a
// parallel upload, both of which can span the file-import window — isn't dropped
// by writing back a stale renders array. (The sub-millisecond getTrack→
// updateTrack window is a single-user request race we don't lock against per the
// trust model.)
async function attachAudioAsRender(trackId, filename) {
  const track = await tracks.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  const existing = (track.renders || []).find((r) => r.audioFilename === filename);
  if (existing) {
    const patch = tracks.selectRenderPatch(track, existing.id) || { audioFilename: filename };
    return tracks.updateTrack(trackId, patch);
  }
  const { renders } = tracks.buildRenderAppend(track, { audioFilename: filename });
  return tracks.updateTrack(trackId, {
    audioFilename: filename,
    engine: '',
    modelId: '',
    durationSec: null,
    renders,
  });
}

// Membership reconcile, track→album direction (the inverse of the album route's
// reconcileAlbumMembership). When a track's `albumId` changes, append it to the
// new album's ordered `trackIds` (if absent) and drop it from the previous
// album's list — so `track.albumId` (the membership truth) and `album.trackIds`
// (the order) never disagree. Calls the album SERVICE directly (not the album
// ROUTE) so this can't re-enter the album route's track-side reconcile and loop.
// Best-effort: a missing/deleted album id is skipped.
async function reconcileTrackAlbum(trackId, prevAlbumId, nextAlbumId) {
  if (prevAlbumId === nextAlbumId) return;
  if (prevAlbumId) {
    const prev = await albums.getAlbum(prevAlbumId).catch(() => null);
    if (prev && (prev.trackIds || []).includes(trackId)) {
      await albums.updateAlbum(prevAlbumId, { trackIds: prev.trackIds.filter((id) => id !== trackId) }).catch(() => {});
    }
  }
  if (nextAlbumId) {
    const next = await albums.getAlbum(nextAlbumId).catch(() => null);
    if (next && !(next.trackIds || []).includes(trackId)) {
      await albums.updateAlbum(nextAlbumId, { trackIds: [...(next.trackIds || []), trackId] }).catch(() => {});
    }
  }
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

// YouTube audio import (#1945): download + extract a track's audio via yt-dlp,
// land it in the shared library, and create a Track pointing at it. Two-segment
// paths ('import/...') can't collide with the single-segment GET/:id below.
router.post('/import/youtube', asyncHandler(async (req, res) => {
  const { url } = validateRequest(youtubeImportSchema, req.body ?? {});
  res.status(202).json(await startYoutubeImport(url));
}));

router.get('/import/:jobId/events', (req, res) => {
  if (!attachImportSseClient(req.params.jobId, res)) {
    throw new ServerError('Import job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/import/:jobId/cancel', (req, res) => {
  res.json({ ok: cancelYoutubeImport(req.params.jobId) });
});

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  const track = await tracks.createTrack(body);
  if (track.albumId) await reconcileTrackAlbum(track.id, '', track.albumId);
  res.status(201).json(track);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await requireTrack(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const prev = await requireTrack(req.params.id);
  const track = await tracks.updateTrack(req.params.id, body);
  if ('albumId' in body) await reconcileTrackAlbum(track.id, prev.albumId, track.albumId);
  res.json(track);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const prev = await tracks.getTrack(req.params.id).catch(() => null);
  const result = await tracks.deleteTrack(req.params.id);
  // Drop the deleted track from its album's ordered list so the album doesn't
  // render a dangling (missing) entry.
  if (prev?.albumId) await reconcileTrackAlbum(req.params.id, prev.albumId, '');
  res.json(result);
}));

// Upload an audio file into the shared library and attach it to this track.
router.post('/:id/audio/upload', musicUpload, asyncHandler(async (req, res) => {
  const track = await requireTrack(req.params.id);
  if (!req.file) throw new ServerError('No audio file uploaded', { status: 400, code: 'TRACK_AUDIO_MISSING_FILE' });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const updated = await attachAudioAsRender(track.id, filename);
  res.json({ track: updated, filename, sizeBytes });
}));

// Attach an existing library track (by stored filename) to this track.
router.post('/:id/audio/attach', asyncHandler(async (req, res) => {
  const track = await requireTrack(req.params.id);
  const { filename } = validateRequest(attachSchema, req.body ?? {});
  assertSafeMusicFilename(filename);
  const found = await statMusicTrack(filename);
  if (!found) throw new ServerError('Track not found in the music library', { status: 404, code: 'TRACK_AUDIO_NOT_IN_LIBRARY' });
  res.json({ track: await attachAudioAsRender(track.id, filename) });
}));

// Clear the audio pointer (leaves the library file in place — it may be shared).
// Does NOT touch the render history — to drop a specific take, use the
// per-render delete below.
router.delete('/:id/audio', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  res.json({ track: await tracks.updateTrack(req.params.id, { audioFilename: '' }) });
}));

// --- Chiptune scores (#2911) — prompt-based looping 8-bit background music.
// Generation is synchronous (a single LLM call, seconds) and strictly
// user-triggered from the Track editor, per the AI-provider usage policy.

const chiptuneGenerateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(tracks.PROMPT_MAX),
  providerId: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  // true = ignore the track's existing score and compose from scratch
  // (default is to iterate on it when one exists).
  fresh: z.boolean().optional(),
});

const chiptunePublishSchema = z.object({
  appId: z.string().trim().min(1).max(120),
  subdir: z.string().trim().max(200).optional(),
  slug: z.string().trim().max(64).optional(),
});

// Generate (or iterate on) the track's chiptune score with an AI provider.
router.post('/:id/chiptune/generate', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  const body = validateRequest(chiptuneGenerateSchema, req.body ?? {});
  res.json(await generateChiptuneScore({ trackId: req.params.id, ...body }));
}));

// Render the current score into the shared music library as a looping take.
router.post('/:id/chiptune/render', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  res.json(await renderChiptuneTrack({ trackId: req.params.id }));
}));

// Publish the current score into a managed app's repo (OGG + score JSON).
router.post('/:id/chiptune/publish', asyncHandler(async (req, res) => {
  await requireTrack(req.params.id);
  const body = validateRequest(chiptunePublishSchema, req.body ?? {});
  res.json(await publishChiptuneTrack({ trackId: req.params.id, ...body }));
}));

// Make a past render the active one (re-point the player + gen-metadata badges
// at it). The user-authored prompt/lyrics are left untouched — they drive the
// NEXT generation, independent of which take is selected for playback.
router.post('/:id/renders/:renderId/select', asyncHandler(async (req, res) => {
  const track = await requireTrack(req.params.id);
  const patch = tracks.selectRenderPatch(track, req.params.renderId);
  if (!patch) throw new ServerError('Render not found', { status: 404, code: 'TRACK_RENDER_NOT_FOUND' });
  res.json({ track: await tracks.updateTrack(req.params.id, patch) });
}));

// Remove a render from the history. When it was the active take, the active
// pointer re-points at the newest remaining render (or clears). The audio bytes
// stay in the shared library (they may be shared with another track).
router.delete('/:id/renders/:renderId', asyncHandler(async (req, res) => {
  const track = await requireTrack(req.params.id);
  const patch = tracks.deleteRenderPatch(track, req.params.renderId);
  if (!patch) throw new ServerError('Render not found', { status: 404, code: 'TRACK_RENDER_NOT_FOUND' });
  res.json({ track: await tracks.updateTrack(req.params.id, patch) });
}));

export default router;
