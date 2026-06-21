/**
 * Music generation routes (the Music studio's on-device generator surface).
 *
 *   GET  /api/music/engines              → { engines, defaultEngine }
 *   POST /api/music/generate             → { track, filename, durationSec, engine, modelId }
 *
 * Generation runs the engine-agnostic `generateMusic` (server/services/pipeline/
 * musicGen.js) — MusicGen / AudioLDM2 / ACE-Step behind one contract — lands the
 * WAV in the shared music library (data/music/), then creates a new Track (or
 * updates an existing one via `trackId`) with the audio pointer + the prompt /
 * lyrics / engine / model / duration metadata. The pipeline audio stage has its
 * own generator routes; this is the studio's standalone path.
 *
 * Generation is synchronous here (one render at a time, like the pipeline audio
 * stage's generate route) — a long ACE-Step render holds the request open. An
 * async mediaJobQueue lane can be added later behind the same response shape.
 */

import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { ENGINES, DEFAULT_ENGINE_ID, getEngine, isEngineReady, generateMusic } from '../services/pipeline/musicGen.js';
import { listEngineModels, addAudioModel, removeAudioModel, isValidRepoId } from '../services/audioModels.js';
import { startHfDownloadStream } from '../lib/sseDownload.js';
import * as tracks from '../services/tracks/index.js';
import * as albums from '../services/albums/index.js';

const router = Router();

// GET /api/music/engines — every selectable backend with its models (shipped +
// user-installed, merged), duration window, lyric capability, and a `ready` flag
// (the opt-in venv is provisioned). The UI gates its Generate affordance + shows
// the install hint from this.
router.get('/engines', asyncHandler(async (_req, res) => {
  const engines = await Promise.all(Object.values(ENGINES).map(async (engine) => ({
    id: engine.id,
    name: engine.name,
    models: await listEngineModels(engine.id),
    defaultModelId: engine.defaultModelId,
    minDurationSec: engine.minDurationSec,
    maxDurationSec: engine.maxDurationSec,
    defaultDurationSec: engine.defaultDurationSec,
    lyrics: engine.lyrics === true,
    // Whether this engine can render an arbitrary HuggingFace checkpoint (gates
    // the "install/select model" UI). ACE-Step resolves a single foundation
    // checkpoint via checkpoint_dir, so custom repos don't apply to it.
    customModels: engine.customModels === true,
    ready: isEngineReady(engine.id),
    installEnv: engine.installEnv,
    venvDefault: engine.venvDefault,
  })));
  res.json({ engines, defaultEngine: DEFAULT_ENGINE_ID });
}));

// --- Install additional audio models from HuggingFace -----------------------
// The shipped per-engine model lists (musicGen.js) cover the common checkpoints;
// these endpoints let a user add more HF repos (e.g. a larger MusicGen, an
// AudioLDM2 variant) using the SAME HF-download path as the image/video model
// installer. A registered model's id is its repo id, which the sidecar passes
// to --model, so it's selectable for generation immediately.

const installSchema = z.object({
  engine: z.string().trim().min(1).max(60),
  repo: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
});

// GET /api/music/models/:engine → the merged shipped+user model list for one
// engine (also exposed via /engines, but handy for a focused refresh).
router.get('/models/:engine', asyncHandler(async (req, res) => {
  if (!ENGINES[req.params.engine]) throw new ServerError('Unknown audio engine', { status: 404, code: 'AUDIO_MODEL_UNKNOWN_ENGINE' });
  res.json({ models: await listEngineModels(req.params.engine) });
}));

// POST /api/music/models — register an HF repo for an engine, then STREAM its
// download as SSE (text/event-stream). Registering first (before the bytes land)
// is intentional: the generation sidecars auto-download a missing checkpoint on
// first use, so even a cancelled pre-download leaves a usable (lazily-fetched)
// model — same posture as the shipped models.
router.post('/models', asyncHandler(async (req, res) => {
  const body = validateRequest(installSchema, req.body ?? {});
  if (!ENGINES[body.engine]) throw new ServerError('Unknown audio engine', { status: 400, code: 'AUDIO_MODEL_UNKNOWN_ENGINE' });
  // Reject install for engines that can't render a custom HF checkpoint (e.g.
  // ACE-Step, which uses a fixed checkpoint_dir) — otherwise a downloaded repo
  // would register as selectable but the sidecar would ignore it.
  if (!ENGINES[body.engine].customModels) {
    throw new ServerError(`${ENGINES[body.engine].name} does not support custom HuggingFace models`, { status: 400, code: 'AUDIO_MODEL_ENGINE_FIXED' });
  }
  if (!isValidRepoId(body.repo)) throw new ServerError('Invalid HuggingFace repo id', { status: 400, code: 'AUDIO_MODEL_INVALID_REPO' });
  await addAudioModel({ engine: body.engine, repo: body.repo, name: body.name });
  // Hand the response to the shared SSE driver — it owns writeHead/end + the
  // in-flight dedupe + client-disconnect kill. The cache pre-warm is best-effort.
  await startHfDownloadStream({ req, res, repo: body.repo });
}));

// DELETE /api/music/models/:engine/*id — de-register a user-added model. The id
// is an HF repo id (contains a slash), so it's captured as a named trailing
// wildcard (`*id`, path-to-regexp v8) rather than a single `:id` segment.
// path-to-regexp returns the splat as an array of path segments; rejoin with
// `/` to reconstruct the repo id. Cached weights are left to the HF cache;
// shipped defaults can't be removed here (no-op → 200 {removed:false}).
router.delete('/models/:engine/*id', asyncHandler(async (req, res) => {
  const splat = req.params.id;
  const id = Array.isArray(splat) ? splat.join('/') : String(splat || '');
  const removed = await removeAudioModel({ engine: req.params.engine, id });
  res.json({ removed });
}));

const generateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(8000),
  // No default: distinguish ABSENT (don't touch the track's lyrics) from a
  // present '' (the user cleared them and generated without — persist the clear).
  lyrics: z.string().trim().max(20000).optional(),
  engine: z.string().trim().max(60).optional(),
  modelId: z.string().trim().max(120).optional(),
  durationSec: z.number().positive().max(600).optional(),
  // Attach the result to an existing track (else a new one is created). The
  // title seeds a freshly-created track; ignored when trackId is given.
  trackId: z.string().trim().max(80).optional(),
  title: z.string().trim().max(200).optional(),
  artistId: z.string().trim().max(80).optional().default(''),
  artist: z.string().trim().max(120).optional().default(''),
  albumId: z.string().trim().max(80).optional().default(''),
});

router.post('/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body ?? {});
  const engine = getEngine(body.engine);

  // Validate the target track BEFORE the (minutes-long) render so a stale/
  // deleted trackId fails fast instead of wasting a render + orphaning a WAV.
  let existing = null;
  if (body.trackId) {
    existing = await tracks.getTrack(body.trackId);
    if (!existing) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Resolve a USER-INSTALLED model id to its HF repo so the sidecar renders with
  // the installed checkpoint instead of falling back to the engine default. A
  // shipped model id leaves `repo` undefined (generateMusic uses the registry).
  let repo;
  if (body.modelId) {
    const merged = await listEngineModels(engine.id);
    const picked = merged.find((m) => m.id === body.modelId);
    if (picked?.userAdded) repo = picked.repo || picked.id;
  }

  // generateMusic throws a typed ServerError (503 venv-missing / 500 sidecar
  // failure) that asyncHandler maps verbatim — no need to re-wrap here. A
  // lyric-aware engine renders with the provided lyrics ('' = no lyrics); a
  // non-lyric engine ignores the flag entirely.
  const result = await generateMusic({
    prompt: body.prompt,
    lyrics: engine.lyrics ? (body.lyrics ?? '') : '',
    engine: engine.id,
    modelId: body.modelId,
    repo,
    durationSec: body.durationSec,
  });

  // Persist the audio + gen metadata. Lyrics follow the audio that was actually
  // rendered: for a lyric-aware engine we persist what the caller SENT —
  // including an intentional '' clear (the audio was generated without lyrics) —
  // but an ABSENT lyrics field leaves the track's lyrics untouched. A non-lyric
  // engine never writes lyrics (it can't erase a song's words by adding a bed).
  const meta = {
    audioFilename: result.filename,
    engine: result.engine,
    modelId: result.modelId,
    durationSec: Math.round(result.durationSec),
    prompt: body.prompt,
  };
  if (engine.lyrics && body.lyrics !== undefined) meta.lyrics = body.lyrics;

  let track;
  if (existing) {
    track = await tracks.updateTrack(body.trackId, meta);
  } else {
    track = await tracks.createTrack({
      title: body.title?.trim() || body.prompt.slice(0, 60),
      artistId: body.artistId,
      artist: body.artist,
      albumId: body.albumId,
      ...(engine.lyrics && body.lyrics !== undefined ? { lyrics: body.lyrics } : {}),
      ...meta,
    });
    // Mirror the /api/tracks create path: a new track with an albumId must be
    // appended to that album's ordered trackIds so album views show it.
    if (track.albumId) {
      const album = await albums.getAlbum(track.albumId).catch(() => null);
      if (album && !(album.trackIds || []).includes(track.id)) {
        await albums.updateAlbum(track.albumId, { trackIds: [...(album.trackIds || []), track.id] }).catch(() => {});
      }
    }
  }

  res.status(body.trackId ? 200 : 201).json({
    track,
    filename: result.filename,
    durationSec: result.durationSec,
    engine: result.engine,
    modelId: result.modelId,
  });
}));

export default router;
