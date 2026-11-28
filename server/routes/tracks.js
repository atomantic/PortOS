/**
 * Music track routes.
 *
 *   GET    /api/tracks                 → Track[]   (live, creation order; `?limit`/`?offset`
 *                                                   switch it to the bounded
 *                                                   `{ items, total, limit, offset }` envelope)
 *   POST   /api/tracks                 → Track
 *   GET    /api/tracks/library         → { tracks } (shared music library list)
 *   POST   /api/tracks/import/youtube  → { jobId }  (download + extract audio from a YouTube URL)
 *   POST   /api/tracks/import/suno     → { jobId }  (a Suno song's audio, title, lyrics and style)
 *   GET    /api/tracks/import/:jobId/events → SSE progress for a YouTube or Suno import job
 *   POST   /api/tracks/import/:jobId/cancel → { ok }
 *   GET    /api/tracks/:id              → Track
 *   PATCH  /api/tracks/:id              → Track
 *   DELETE /api/tracks/:id              → { id }     (soft delete)
 *   POST   /api/tracks/:id/audio/upload → Track      (multipart 'track' file + optional
 *                                                   source/prompt/lyrics provenance fields)
 *   POST   /api/tracks/:id/audio/attach → Track      (attach a library filename)
 *   DELETE /api/tracks/:id/audio        → Track      (clear the audio pointer)
 *   POST   /api/tracks/:id/waveform/draw   → { sketch, llm, track } (LLM-drawn sketch, stored on the track)
 *   POST   /api/tracks/:id/waveform/render → { track, filename, durationSec } (drawn-waveform take)
 *   POST   /api/tracks/:id/supercollider/take → { track, filename, durationSec } (a finished SuperCollider preview saved as the take, with provenance)
 *   POST   /api/tracks/:id/code/render → { track, filename, durationSec } (multipart 'track' WAV recorded from code)
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
 *
 * Suno (#8967) arrives through the per-track upload: `source=suno` marks audio
 * the user exported from Suno, and the style prompt + lyrics ride along onto
 * that take. It is a manual import — no Suno API is called and no credential is
 * involved — so it works regardless of hosted API access and never claims to be
 * a hosted integration.
 */

import {
  createSchema,
  patchSchema,
  attachSchema,
  audioUploadSchema,
  youtubeImportSchema,
  sunoImportSchema,
  chiptuneGenerateSchema,
  chiptunePublishSchema,
  waveformDrawSchema,
  waveformRenderSchema,
  codeRenderSchema,
  superColliderTakeSchema,
} from '../lib/trackValidation.js';
import { Router } from 'express';
import { assertCancelResult } from '../lib/cancelResponse.js';
import { paginationQuerySchema, isPaginationRequested, paginateArray } from '../lib/queryValidation.js';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { uploadSingle } from '../lib/multipart.js';
import { PATHS } from '../lib/fileUtils.js';
import { probeVideoDuration } from '../lib/ffmpeg.js';
import * as tracks from '../services/tracks/index.js';
import { attachAudioAsRender } from '../services/trackAudioAttach.js';
import { createTrackWithAlbum, updateTrackWithAlbum, deleteTrackWithAlbum } from '../services/trackAlbumMembership.js';
import {
  listMusicLibrary, importUploadedTrack, statMusicTrack,
  isSupportedMusicUpload, assertSafeMusicFilename, MUSIC_UPLOAD_MAX_BYTES,
} from '../services/pipeline/musicLibrary.js';
import {
  startYoutubeImport, attachImportSseClient, cancelYoutubeImport,
} from '../services/trackYoutubeImport.js';
import { startSunoImport, attachSunoImportSseClient, cancelSunoImport } from '../services/trackSunoImport.js';
import { generateChiptuneScore, renderChiptuneTrack, publishChiptuneTrack } from '../services/chiptune.js';
import { drawWaveSketchForTrack, renderWaveSketchToTrack } from '../services/musicWaveform.js';
import { saveCodeTakeToTrack, saveSuperColliderTakeToTrack } from '../services/musicCode.js';

const router = Router();

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

// Run a multipart route's pre-import checks. A rejection deletes the temp
// upload first, so a refused request can't strand the file in os.tmpdir().
function checkBeforeImport(req, check) {
  return Promise.resolve().then(check).catch(async (err) => {
    if (req.file?.path) await unlink(req.file.path).catch(() => {});
    throw err;
  });
}

// Load a track or 404 — shared by the audio mutation routes.
async function requireTrack(id) {
  const track = await tracks.getTrack(id);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  return track;
}

// Backward-compatible by default: returns the full tracks array. When a client
// passes `limit`/`offset`, the response becomes the bounded
// `{ items, total, limit, offset }` envelope every paginated PortOS list shares.
router.get('/', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const list = await tracks.listTracks();
  if (!isPaginationRequested(page)) return res.json(list);
  res.json(paginateArray(list, page, { defaultLimit: 50, maxLimit: 500 }));
}));

// Shared music library — every uploaded/generated track sits here. The studio
// uses it to attach an existing track to a record without re-uploading. Routed
// before /:id so the literal `library` segment can't be read as a track id.
router.get('/library', asyncHandler(async (req, res) => {
  const page = validateRequest(paginationQuerySchema, req.query);
  const libraryTracks = await listMusicLibrary();
  if (!isPaginationRequested(page)) return res.json({ tracks: libraryTracks });
  res.json(paginateArray(libraryTracks, page, { maxLimit: 500 }));
}));

// YouTube audio import (#1945): download + extract a track's audio via yt-dlp,
// land it in the shared library, and create a Track pointing at it. Two-segment
// paths ('import/...') can't collide with the single-segment GET/:id below.
router.post('/import/youtube', asyncHandler(async (req, res) => {
  const { url } = validateRequest(youtubeImportSchema, req.body ?? {});
  res.status(202).json(await startYoutubeImport(url));
}));

// Suno song import: the song's audio plus the title, lyrics and style its page
// carries, as a Track. Its jobs share the events/cancel routes below.
router.post('/import/suno', asyncHandler(async (req, res) => {
  const { url } = validateRequest(sunoImportSchema, req.body ?? {});
  res.status(202).json(await startSunoImport(url));
}));

router.get('/import/:jobId/events', (req, res) => {
  if (!attachImportSseClient(req.params.jobId, res) && !attachSunoImportSseClient(req.params.jobId, res)) {
    throw new ServerError('Import job not found or expired', { status: 404, code: 'NOT_FOUND' });
  }
});

router.post('/import/:jobId/cancel', (req, res) => {
  res.json(assertCancelResult(cancelYoutubeImport(req.params.jobId) || cancelSunoImport(req.params.jobId), { notFoundMessage: 'Track import not found' }));
});

router.post('/', asyncHandler(async (req, res) => {
  const body = validateRequest(createSchema, req.body ?? {});
  const { track } = await createTrackWithAlbum(body);
  res.status(201).json(track);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  res.json(await requireTrack(req.params.id));
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const body = validateRequest(patchSchema, req.body ?? {});
  const track = await updateTrackWithAlbum({ id: req.params.id }, body);
  res.json(track);
}));

router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await deleteTrackWithAlbum(req.params.id);
  res.json(result);
}));

// Upload an audio file into the shared library and attach it to this track.
// `source=suno` records the take as a Suno export (see the header note).
router.post('/:id/audio/upload', musicUpload, asyncHandler(async (req, res) => {
  const { track, take } = await checkBeforeImport(req, async () => ({
    take: validateRequest(audioUploadSchema, req.body ?? {}),
    track: await requireTrack(req.params.id),
  }));
  if (!req.file) throw new ServerError('No audio file uploaded', { status: 400, code: 'TRACK_AUDIO_MISSING_FILE' });
  const { filename, sizeBytes } = await importUploadedTrack(req.file.path, req.file.originalname);
  const durationSec = await probeVideoDuration(join(PATHS.music, filename)).catch(() => null);
  const updated = await attachAudioAsRender(track.id, filename, { ...take, durationSec });
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

// --- Chiptune scores (#2911) — prompt-based looping 8-bit background music.
// Generation is synchronous (a single LLM call, seconds) and strictly
// user-triggered from the Track editor, per the AI-provider usage policy.

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

router.post('/:id/waveform/draw', asyncHandler(async (req, res) => {
  const body = validateRequest(waveformDrawSchema, req.body ?? {});
  res.json(await drawWaveSketchForTrack({ trackId: req.params.id, ...body }));
}));

router.post('/:id/waveform/render', asyncHandler(async (req, res) => {
  const body = validateRequest(waveformRenderSchema, req.body ?? {});
  res.json(await renderWaveSketchToTrack({ trackId: req.params.id, ...body }));
}));

router.post('/:id/code/render', musicUpload, asyncHandler(async (req, res) => {
  if (!req.file) throw new ServerError('No recorded take uploaded', { status: 400, code: 'TRACK_AUDIO_MISSING_FILE' });
  // Read the temp upload before validating so a rejected body can't strand it.
  const wav = await readFile(req.file.path).finally(() => unlink(req.file.path).catch(() => {}));
  const body = validateRequest(codeRenderSchema, req.body ?? {});
  res.json(await saveCodeTakeToTrack({ trackId: req.params.id, wav, ...body }));
}));

router.post('/:id/supercollider/take', asyncHandler(async (req, res) => {
  const body = validateRequest(superColliderTakeSchema, req.body ?? {});
  res.json(await saveSuperColliderTakeToTrack({ trackId: req.params.id, ...body }));
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
