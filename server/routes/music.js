/**
 * Music generation routes (the Music studio's on-device generator surface).
 *
 *   GET  /api/music/engines              → { engines, defaultEngine }
 *   POST /api/music/describe             → { description, llm }
 *   POST /api/music/lyrics               → { lyrics, llm }
 *   POST /api/music/generate             → { jobId, position, status }
 *
 * `describe`/`lyrics` are the Generate tab's stepped designer (#4305): an LLM
 * expands a short reference/vibe into a rich conditioning prompt, then writes
 * lyrics from it. Both are one-shot, user-triggered calls — the studio never
 * fires them on its own (AI Provider Usage Policy).
 *
 * Generation runs the engine-agnostic `generateMusic` (server/services/pipeline/
 * musicGen.js) through the unified audio media-job lane. The completion hook
 * lands the WAV in the shared music library and creates or updates the Track,
 * independently of whether the requesting browser remains mounted. The pipeline
 * audio stage has its own generator routes; this is the studio's standalone path.
 *
 * Generation is acknowledged immediately and drained by the audio media-job
 * lane, so a long render never holds the HTTP request open.
 */

import { Router } from 'express';
import { existsSync } from 'fs';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { createLineReader } from '../lib/streamLines.js';
import { SETUP_IMAGE_VIDEO_SCRIPT, spawnSetupScript, stopSetupScript } from '../lib/setupScriptRunner.js';
import {
  ENGINES, getEngine, isEngineHealthy, isEnginePlatformSupported,
  enginePlatformLabel,
} from '../services/pipeline/musicGen.js';
import { listEngineModels, addAudioModel, removeAudioModel, isValidRepoId } from '../services/audioModels.js';
import { listMusicEngineCapabilities } from '../services/musicEngineCapabilities.js';
import { describeMusic, writeLyrics } from '../services/musicDesigner.js';
import { startHfDownloadStream, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { inspectModelCache } from '../lib/hfCache.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import { enqueueJob, listJobs } from '../services/mediaJobQueue/index.js';
import * as tracks from '../services/tracks/index.js';

const router = Router();

// GET /api/music/engines — every selectable backend with its models (shipped +
// user-installed, merged), duration window, lyric capability, auto-duration
// support, and a `ready` flag (the opt-in venv is provisioned). The UI gates its
// Generate affordance + shows the install hint from this.
router.get('/engines', asyncHandler(async (_req, res) => {
  res.json(await listMusicEngineCapabilities());
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
    installed: await isEngineHealthy(engine.id),
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
  if (!isEnginePlatformSupported(engine.id)) {
    send({ type: 'error', message: `${engine.name} requires ${enginePlatformLabel(engine.id)} and cannot be installed on this host.` });
    return safeEnd();
  }
  if (engine.cudaRequired) {
    const cuda = await getCudaCapability();
    if (cuda.status !== 'available') {
      send({ type: 'error', message: cuda.status === 'unknown'
        ? `${engine.name} cannot be installed because CUDA availability could not be determined.`
        : `${engine.name} requires an NVIDIA CUDA GPU and cannot be installed on this host.` });
      return safeEnd();
    }
  }
  runtimeInstallInFlight.set(engine.id, null);

  // Force a fresh probe: a cached `true` from before the venv broke would
  // short-circuit the very install meant to repair it.
  if (await isEngineHealthy(engine.id, { refresh: true })) {
    runtimeInstallInFlight.delete(engine.id);
    send({ type: 'log', message: `${engine.name} already installed at ${engine.resolvePython() || engine.venvDefault}` });
    send({ type: 'complete', message: 'Already installed - nothing to do.' });
    return safeEnd();
  }

  if (!existsSync(SETUP_IMAGE_VIDEO_SCRIPT)) {
    runtimeInstallInFlight.delete(engine.id);
    send({ type: 'error', message: `Installer script not found at ${SETUP_IMAGE_VIDEO_SCRIPT}` });
    return safeEnd();
  }

  send({ type: 'log', message: `Starting ${engine.name} install.` });
  // Server-console visibility for the multi-GB install (start / heartbeat /
  // outcome) — the SSE stream otherwise surfaces progress only in the browser.
  const installLog = createInstallLogger({ installer: engine.name, target: engine.venvDefault });
  const emit = (ev) => { installLog.onEvent(ev); send(ev); };
  installLog.start();
  const child = spawnSetupScript({ [engine.installEnv]: '1' });
  runtimeInstallInFlight.set(engine.id, child);
  let finished = false;

  // `splitRe: /[\r\n]+/` so a bash/pip/tqdm progress bar that redraws with a
  // bare `\r` surfaces each redraw as its own log line; the carry buffer
  // stitches a line split across chunk boundaries (flushed on close).
  const onLine = (line) => {
    const t = line.trimEnd();
    if (t) emit({ type: 'log', message: t });
  };
  const stdoutReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  const stderrReader = createLineReader(onLine, { splitRe: /[\r\n]+/ });
  child.stdout.on('data', stdoutReader.push);
  child.stderr.on('data', stderrReader.push);
  child.on('error', (err) => {
    finished = true;
    runtimeInstallInFlight.delete(engine.id);
    emit({ type: 'error', message: `Installer failed to spawn: ${err.message}` });
    safeEnd();
  });
  // Async because the completion verdict re-probes the venv. try/catch because
  // this runs outside the request lifecycle — an uncaught throw here would take
  // the process down instead of reaching the error middleware.
  child.on('close', async (code) => {
    try {
      stdoutReader.flush();
      stderrReader.flush();
      finished = true;
      runtimeInstallInFlight.delete(engine.id);
      // The venv just changed on disk, so the cached verdict is stale by
      // definition — re-probe rather than trusting it.
      const healthy = code === 0 && await isEngineHealthy(engine.id, { refresh: true });
      if (healthy) {
        emit({ type: 'complete', message: `${engine.name} ready: ${engine.resolvePython() || engine.venvDefault}` });
      } else if (code === 0) {
        emit({ type: 'error', message: `Installer exited 0 but ${engine.name} is still not available. Check the log above for setup errors.` });
      } else {
        emit({ type: 'error', message: `Installer exited with code ${code}.` });
      }
      safeEnd();
    } catch (err) {
      console.error(`❌ ${engine.name} install completion check failed: ${err.message}`);
      emit({ type: 'error', message: `Install completion check failed: ${err.message}` });
      safeEnd();
    }
  });

  req.on('close', () => {
    if (finished) return;
    installLog.cancel();
    stopSetupScript(child);
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
  const engine = ENGINES[body.engine];
  const fixedModel = engine.fixedModelInstall ? engine.models.find((model) => model.repo === body.repo) || null : null;
  if (!engine.customModels && !fixedModel) {
    throw new ServerError(`${ENGINES[body.engine].name} does not support custom HuggingFace models`, { status: 400, code: 'AUDIO_MODEL_ENGINE_FIXED' });
  }
  if (!isValidRepoId(body.repo)) throw new ServerError('Invalid HuggingFace repo id', { status: 400, code: 'AUDIO_MODEL_INVALID_REPO' });
  // Register first so it's durable before the stream signals completion.
  if (!fixedModel) await addAudioModel({ engine: body.engine, repo: body.repo, name: body.name });
  // Hand the response to the shared SSE driver — it owns writeHead/end + the
  // in-flight dedupe + client-disconnect kill. Resolves after the stream ends.
  // A shipped fixed model may declare `downloadIgnore` to skip repo paths its
  // runtime never loads (see MINIMAX_MUSIC3_MODELS) — a user-added repo has no
  // such contract, so it always gets the full snapshot.
  const downloadTarget = { repo: body.repo, ignore: fixedModel?.downloadIgnore ?? [] };
  if (fixedModel?.revision) downloadTarget.revision = fixedModel.revision;
  await startHfDownloadStream({
    req,
    res,
    repos: [downloadTarget],
  });
  // Roll back if the weights aren't actually present now (failed/cancelled
  // download) so a bogus repo doesn't persist. Best-effort: a rollback failure
  // is logged by the service, not surfaced (the response already closed).
  const cacheOptions = fixedModel?.revision ? { revision: fixedModel.revision } : {};
  const cached = await inspectModelCache(body.repo, cacheOptions).catch(() => ({ cached: false }));
  if (!cached.cached) {
    if (!fixedModel) await removeAudioModel({ engine: body.engine, id: body.repo }).catch(() => {});
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

// --- Stepped designer (#4305) ----------------------------------------------
// Empty/whitespace picker values normalize to undefined so a blank <select>
// means "use the install's active provider / the provider's default model"
// instead of reaching the runner as a whitespace string (same preprocessing as
// `refinePromptSchema` in routes/mediaJobs.js).
const blankToUndefined = (s) => {
  const v = (s ?? '').trim();
  return v.length > 0 ? v : undefined;
};
// Shared picker + meta-prompt-override fields for both designer routes. The
// template cap matches the description cap — an override is an instruction
// block, not a document.
const designerPickerShape = {
  guidance: z.string().trim().max(4000).optional(),
  template: z.string().trim().max(8000).optional(),
  providerId: z.string().max(128).optional().transform(blankToUndefined),
  model: z.string().max(256).optional().transform(blankToUndefined),
  effort: z.string().max(64).optional().transform(blankToUndefined),
};

// Caps mirror the Generate form's own limits: a concept/description feeds the
// prompt field (≤8000), lyrics feed the lyrics field (≤20000).
const describeSchema = z.object({
  concept: z.string().trim().min(1, 'concept is required').max(8000),
  ...designerPickerShape,
});

const lyricsSchema = z.object({
  description: z.string().trim().min(1, 'description is required').max(8000),
  ...designerPickerShape,
});

// POST /api/music/describe — expand a short reference/vibe into a rich musical
// description the audio engine can condition on. One explicit user action per
// call; nothing here runs unprompted.
router.post('/describe', asyncHandler(async (req, res) => {
  const body = validateRequest(describeSchema, req.body ?? {});
  const { description, llm } = await describeMusic({
    concept: body.concept,
    guidance: body.guidance,
    template: body.template,
    providerId: body.providerId,
    model: body.model,
    effort: body.effort,
  });
  res.json({ description, llm });
}));

// POST /api/music/lyrics — write original lyrics from that description plus the
// user's extra guidance, in the `[verse]`/`[chorus]` syntax the lyric-aware
// engines expect.
router.post('/lyrics', asyncHandler(async (req, res) => {
  const body = validateRequest(lyricsSchema, req.body ?? {});
  const { lyrics, llm } = await writeLyrics({
    description: body.description,
    guidance: body.guidance,
    template: body.template,
    providerId: body.providerId,
    model: body.model,
    effort: body.effort,
  });
  res.json({ lyrics, llm });
}));

const generateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(8000),
  // No default: distinguish ABSENT (don't touch the track's lyrics) from a
  // present '' (the user cleared them and generated without — persist the clear).
  lyrics: z.string().trim().max(20000).optional(),
  // A render-level override: ignore even supplied lyrics without clearing the
  // track's saved lyric field when the completed audio is attached.
  instrumentalOnly: z.boolean().optional().default(false),
  engine: z.string().trim().max(60).optional(),
  modelId: z.string().trim().max(120).optional(),
  durationSec: z.number().positive().max(600).optional(),
  durationMode: z.enum(['auto', 'manual']).optional(),
  // Attach the result to an existing track (else a new one is created). The
  // title seeds a freshly-created track; ignored when trackId is given.
  trackId: z.string().trim().max(80).optional(),
  title: z.string().trim().max(200).optional(),
  artistId: z.string().trim().max(80).optional().default(''),
  artist: z.string().trim().max(120).optional().default(''),
  albumId: z.string().trim().max(80).optional().default(''),
});

const INSTRUMENTAL_ONLY_GUIDANCE = 'Instrumental only. Do not include sung, spoken, chanted, choir, or background vocals. Carry the lead melody with the described instruments or textures.';

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

  // Make the render-level override explicit in BOTH conditioning inputs. Merely
  // dropping lyrics is not enough when the authored caption itself mentions a
  // vocalist. Keep it idempotent so remixing an instrumental take does not append
  // the same directive repeatedly.
  const usedPrompt = body.instrumentalOnly && !body.prompt.includes(INSTRUMENTAL_ONLY_GUIDANCE)
    ? `${body.prompt}\n\n${INSTRUMENTAL_ONLY_GUIDANCE}`
    : body.prompt;

  // The lyrics that actually CONDITION this render: what the caller sent for a
  // lyric-aware engine ('' = render without lyrics), nothing for a non-lyric
  // engine. The same value drives the generation call AND the render snapshot,
  // so a render card can never claim conditioning text the audio wasn't built
  // from (an absent-lyrics lyric render is genuinely un-conditioned, not "the
  // track's old words").
  const usedLyrics = engine.lyrics && !body.instrumentalOnly ? (body.lyrics ?? '') : '';

  const liveJobs = listJobs({ kind: 'audio' }).filter((job) => job.status === 'queued' || job.status === 'running');
  const duplicate = liveJobs.find((job) => {
    const tag = job.params?.musicStudio;
    return body.trackId ? tag?.trackId === body.trackId : tag && !tag.trackId;
  });
  if (duplicate) {
    throw new ServerError('Music generation is already in progress', {
      status: 409,
      code: 'PIPELINE_MUSIC_BUSY',
      context: { jobId: duplicate.id },
    });
  }

  const result = enqueueJob({
    kind: 'audio',
    params: {
      prompt: usedPrompt,
      lyrics: usedLyrics,
      engine: engine.id,
      modelId: body.modelId,
      repo,
      durationSec: body.durationSec,
      durationMode: body.durationMode,
      musicStudio: {
        trackId: body.trackId || null,
        title: body.title || body.prompt.slice(0, 60),
        artistId: body.artistId,
        artist: body.artist,
        albumId: body.albumId,
        // Keep editable source text distinct from the augmented prompt and
        // empty lyric payload that actually condition an instrumental render.
        authoredPrompt: body.prompt,
        authoredLyrics: engine.lyrics === true ? body.lyrics : undefined,
        lyricsEnabled: engine.lyrics === true,
        lyricsProvided: engine.lyrics === true && body.lyrics !== undefined,
        instrumentalOnly: body.instrumentalOnly,
      },
    },
  });
  res.status(202).json(result);
}));

export default router;
