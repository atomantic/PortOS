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
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { PATHS } from '../lib/fileUtils.js';
import { safeChildProcessEnv } from '../lib/processEnv.js';
import { ENGINES, DEFAULT_ENGINE_ID, getEngine, isEngineReady, generateMusic } from '../services/pipeline/musicGen.js';
import { listEngineModels, addAudioModel, removeAudioModel, isValidRepoId } from '../services/audioModels.js';
import { startHfDownloadStream, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { inspectModelCache } from '../lib/hfCache.js';
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

// --- Install music runtime venvs -------------------------------------------
// Mirrors the image/video in-app setup flow: the client opens an EventSource
// and we shell out to the canonical setup script with the selected engine's
// INSTALL_* env var set. Keeping the bash path as the single installer source
// avoids a second Node implementation drifting from scripts/setup-image-video.sh.

router.get('/setup/runtime-status', asyncHandler(async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  const engine = ENGINES[runtime];
  if (!engine) {
    throw new ServerError(
      `Unknown music runtime: ${runtime}. Expected one of: ${Object.keys(ENGINES).join(', ')}`,
      { status: 400, code: 'UNKNOWN_MUSIC_RUNTIME' },
    );
  }
  res.json({
    runtime: engine.id,
    label: engine.name,
    installed: isEngineReady(engine.id),
    venvPath: engine.resolvePython() || null,
    expectedVenvPath: engine.venvDefault,
    installEnvVar: engine.installEnv,
  });
}));

const runtimeInstallInFlight = new Map();

router.get('/setup/runtime-install', asyncHandler(async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  const engine = ENGINES[runtime];
  const { send, safeEnd } = openSseStream(res);

  if (!engine) {
    send({ type: 'error', message: `Unknown music runtime: ${runtime}` });
    return safeEnd();
  }
  if (runtimeInstallInFlight.has(engine.id)) {
    send({ type: 'error', message: `Another ${engine.name} install is already running. Wait for it to finish or restart PortOS.` });
    return safeEnd();
  }
  runtimeInstallInFlight.set(engine.id, null);

  if (isEngineReady(engine.id)) {
    runtimeInstallInFlight.delete(engine.id);
    send({ type: 'log', message: `${engine.name} already installed at ${engine.resolvePython() || engine.venvDefault}` });
    send({ type: 'complete', message: 'Already installed - nothing to do.' });
    return safeEnd();
  }

  const scriptPath = join(PATHS.root, 'scripts', 'setup-image-video.sh');
  if (!existsSync(scriptPath)) {
    runtimeInstallInFlight.delete(engine.id);
    send({ type: 'error', message: `Installer script not found at ${scriptPath}` });
    return safeEnd();
  }

  send({ type: 'log', message: `Starting ${engine.name} install.` });
  // Server-console visibility for the multi-GB install (start / heartbeat /
  // outcome) — the SSE stream otherwise surfaces progress only in the browser.
  const installLog = createInstallLogger({ installer: engine.name, target: engine.venvDefault });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };
  installLog.start();
  const child = spawn('bash', [scriptPath], {
    env: safeChildProcessEnv({ [engine.installEnv]: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  runtimeInstallInFlight.set(engine.id, child);
  let finished = false;

  const onChunk = (chunk) => {
    for (const line of chunk.toString().split(/[\r\n]+/)) {
      const t = line.trimEnd();
      if (t) emit({ type: 'log', message: t });
    }
  };
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  child.on('error', (err) => {
    finished = true;
    runtimeInstallInFlight.delete(engine.id);
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    safeEnd();
  });
  child.on('close', (code) => {
    finished = true;
    runtimeInstallInFlight.delete(engine.id);
    if (code === 0 && isEngineReady(engine.id)) {
      emit({ type: 'complete', message: `${engine.name} ready: ${engine.resolvePython() || engine.venvDefault}` });
    } else if (code === 0) {
      emit({ type: 'error', message: `Installer exited 0 but ${engine.name} is still not available. Check the log above for setup errors.` });
    } else {
      emit({ type: 'error', message: `Installer exited with code ${code}.` });
    }
    safeEnd();
  });

  req.on('close', () => {
    if (finished) return;
    installLog.cancel();
    if (!child.killed && child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch { child.kill('SIGTERM'); }
    }
    safeEnd();
  });
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

// POST /api/music/models — register the repo, STREAM its HF download as SSE
// (text/event-stream), then ROLL BACK the registration if the download didn't
// actually land. Registering up front (before the stream's `complete` frame)
// means the model is durably persisted by the time the client's post-stream
// `/engines` refresh runs — no race. The rollback (de-register when the cache
// is still empty after a failed/cancelled download) means a typo / private /
// gated / auth-failed repo doesn't linger as a bogus "installed" model. Net:
// a completed install is always registered, a failed one never is.
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
  // Register first so it's durable before the stream signals completion.
  await addAudioModel({ engine: body.engine, repo: body.repo, name: body.name });
  // Hand the response to the shared SSE driver — it owns writeHead/end + the
  // in-flight dedupe + client-disconnect kill. Resolves after the stream ends.
  await startHfDownloadStream({ req, res, repo: body.repo });
  // Roll back if the weights aren't actually present now (failed/cancelled
  // download) so a bogus repo doesn't persist. Best-effort: a rollback failure
  // is logged by the service, not surfaced (the response already closed).
  const cached = await inspectModelCache(body.repo).catch(() => ({ cached: false }));
  if (!cached.cached) {
    await removeAudioModel({ engine: body.engine, id: body.repo }).catch(() => {});
  }
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
  // Reject an unknown engine explicitly rather than letting getEngine() fall
  // back to the default — a typo/stale client (`acestep-v2`) would otherwise
  // burn a render producing the WRONG backend's output + metadata. An ABSENT
  // engine is allowed (uses the default).
  if (body.engine !== undefined && !ENGINES[body.engine]) {
    throw new ServerError(`Unknown audio engine: ${body.engine}`, { status: 400, code: 'PIPELINE_MUSIC_UNKNOWN_ENGINE' });
  }
  const engine = getEngine(body.engine);

  // Validate the target track BEFORE the (minutes-long) render so a stale/
  // deleted trackId fails fast instead of wasting a render + orphaning a WAV.
  let existing = null;
  if (body.trackId) {
    existing = await tracks.getTrack(body.trackId);
    if (!existing) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Resolve the requested model against the engine's merged list. An unknown
  // modelId (stale UI selection, removed model) must FAIL FAST — otherwise
  // `repo` stays undefined and generateMusic silently renders the engine default,
  // spending minutes producing audio from the wrong checkpoint. A user-installed
  // id resolves to its HF repo (passed to the sidecar); a shipped id leaves
  // `repo` undefined (generateMusic uses its own registry for shipped models).
  let repo;
  if (body.modelId) {
    const merged = await listEngineModels(engine.id);
    const picked = merged.find((m) => m.id === body.modelId);
    if (!picked) {
      throw new ServerError(`Unknown model for ${engine.name}: ${body.modelId}`, { status: 400, code: 'PIPELINE_MUSIC_UNKNOWN_MODEL' });
    }
    if (picked.userAdded) repo = picked.repo || picked.id;
  }

  // The lyrics that actually CONDITION this render: what the caller sent for a
  // lyric-aware engine ('' = render without lyrics), nothing for a non-lyric
  // engine. The same value drives the generation call AND the render snapshot,
  // so a render card can never claim conditioning text the audio wasn't built
  // from (an absent-lyrics lyric render is genuinely un-conditioned, not "the
  // track's old words").
  const usedLyrics = engine.lyrics ? (body.lyrics ?? '') : '';

  // generateMusic throws a typed ServerError (503 venv-missing / 500 sidecar
  // failure) that asyncHandler maps verbatim — no need to re-wrap here.
  const result = await generateMusic({
    prompt: body.prompt,
    lyrics: usedLyrics,
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
  const durationSec = Math.round(result.durationSec);
  // Re-read the track AFTER the (minutes-long) render so the append lands on the
  // FRESHEST persisted history — a render uploaded/generated to this same track
  // while this generation was running isn't dropped by writing back a stale
  // pre-render array. (The sub-millisecond getTrack→updateTrack window is a
  // single-user request race we intentionally don't lock against — trust model.)
  const current = existing ? ((await tracks.getTrack(body.trackId)) ?? existing) : null;
  const { renders } = tracks.buildRenderAppend(current, {
    audioFilename: result.filename,
    prompt: body.prompt,
    lyrics: usedLyrics,
    engine: result.engine,
    modelId: result.modelId,
    durationSec,
  });

  const meta = {
    audioFilename: result.filename,
    engine: result.engine,
    modelId: result.modelId,
    durationSec,
    prompt: body.prompt,
    renders,
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
