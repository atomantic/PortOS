// Zod request schemas for the tracks routes.

import { z } from 'zod';
import * as tracks from './trackLimits.js';
import { assertSafeMusicFilename } from './musicFilename.js';
import { YOUTUBE_VIDEO_URL_RE, YOUTUBE_URL_INVALID_MESSAGE } from './youtubeUrl.js';
import { SUNO_SONG_URL_RE, SUNO_URL_INVALID_MESSAGE } from './sunoSong.js';
import { PAINTED_CANVAS_LIMITS } from './paintedCanvas.js';

const titleField = z.string().trim().min(1).max(tracks.TITLE_MAX);

const albumIdField = z.string().trim().max(tracks.ALBUM_ID_MAX);

const artistIdField = z.string().trim().max(tracks.ARTIST_ID_MAX);

const artistNameField = z.string().trim().max(tracks.ARTIST_NAME_MAX);

const conceptField = z.string().max(tracks.CONCEPT_MAX);

const lyricsField = z.string().max(tracks.LYRICS_MAX);

const promptField = z.string().max(tracks.PROMPT_MAX);

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

export const createSchema = z.object({
  title: titleField,
  albumId: albumIdField.optional().default(''),
  artistId: artistIdField.optional().default(''),
  artist: artistNameField.optional().default(''),
  concept: conceptField.optional().default(''),
  lyrics: lyricsField.optional().default(''),
  prompt: promptField.optional().default(''),
  engine: engineField.optional().default(''),
  modelId: modelIdField.optional().default(''),
  durationSec: durationField.optional().default(null),
  audioFilename: audioFilenameField.optional().default(''),
});

export const patchSchema = z.object({
  title: titleField.optional(),
  albumId: albumIdField.optional(),
  artistId: artistIdField.optional(),
  artist: artistNameField.optional(),
  concept: conceptField.optional(),
  lyrics: lyricsField.optional(),
  prompt: promptField.optional(),
  engine: engineField.optional(),
  modelId: modelIdField.optional(),
  durationSec: durationField.optional(),
  audioFilename: audioFilenameField.optional(),
}).refine((p) => Object.keys(p).length > 0, { message: 'patch must include at least one field' });

export const attachSchema = z.object({
  filename: z.string().trim().min(1).max(tracks.AUDIO_FILENAME_MAX),
});

// Text fields riding a per-track audio upload. `source` is the take's
// provenance: a plain file, or a song exported from Suno. prompt/lyrics describe
// that take on its render card (for Suno: the style prompt and lyrics used there).
export const audioUploadSchema = z.object({
  source: z.enum([tracks.RENDER_SOURCES.UPLOAD, tracks.RENDER_SOURCES.SUNO]).optional().default(tracks.RENDER_SOURCES.UPLOAD),
  prompt: promptField.optional().default(''),
  lyrics: lyricsField.optional().default(''),
});

export const youtubeImportSchema = z.object({
  url: z.string().trim().regex(YOUTUBE_VIDEO_URL_RE, YOUTUBE_URL_INVALID_MESSAGE),
});

export const sunoImportSchema = z.object({
  url: z.string().trim().regex(SUNO_SONG_URL_RE, SUNO_URL_INVALID_MESSAGE),
});

export const chiptuneGenerateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(tracks.PROMPT_MAX),
  providerId: z.string().trim().max(120).optional(),
  model: z.string().trim().max(120).optional(),
  // true = ignore the track's existing score and compose from scratch
  // (default is to iterate on it when one exists).
  fresh: z.boolean().optional(),
});

export const chiptunePublishSchema = z.object({
  appId: z.string().trim().min(1).max(120),
  subdir: z.string().trim().max(200).optional(),
  slug: z.string().trim().max(64).optional(),
});

// --- Drawn waveform takes — the Music Designer's LLM-painted spectrogram
// canvas (server/lib/paintedCanvas.js, #8464). `draw` persists the painting on
// the track (`waveSketch`/`waveSketchPrompt`, #8376); `render` renders that
// STORED sketch with the same deterministic synth the browser previewed.
// Painting is one explicit user action per call (AI Provider Usage Policy).
const optionalPick = (max) => z.string().max(max).optional().transform((v) => v?.trim() || undefined);

export const waveformDrawSchema = z.object({
  description: z.string().trim().min(1, 'description is required').max(tracks.PROMPT_MAX),
  lyrics: z.string().trim().max(tracks.LYRICS_MAX).optional(),
  guidance: z.string().trim().max(4000).optional(),
  durationSec: z.number().min(PAINTED_CANVAS_LIMITS.DURATION_MIN_SEC).max(PAINTED_CANVAS_LIMITS.DURATION_MAX_SEC).optional(),
  // true = revise the track's stored painting instead of painting from scratch.
  revise: z.boolean().optional(),
  // true = show the model a spectrogram of each passage for one repaint pass.
  review: z.boolean().optional(),
  providerId: optionalPick(128),
  model: optionalPick(256),
  effort: optionalPick(64),
});

export const waveformRenderSchema = z.object({
  prompt: z.string().trim().max(tracks.PROMPT_MAX).optional(),
  title: z.string().trim().max(200).optional(),
});

// --- Code takes: the Music Designer's code engine runs LLM-written Strudel in
// a sandboxed browser frame and records it there. The server stores the
// recorded WAV and never runs the code.
export const codeRenderSchema = z.object({
  prompt: z.string().trim().max(tracks.PROMPT_MAX).optional(),
  title: z.string().trim().max(200).optional(),
});

// Save a finished SuperCollider preview as the active take (#9414). The preview
// id comes from the render job; the audio and provenance are read back from the
// host-written preview store, so the client cannot supply either.
export const superColliderTakeSchema = z.object({
  jobId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
  prompt: z.string().trim().max(tracks.PROMPT_MAX).optional(),
  title: z.string().trim().max(200).optional(),
});
