/**
 * Music generation routes (the Music studio's on-device generator surface).
 *
 *   GET  /api/music/engines              → { engines, defaultEngine }
 *   POST /api/music/describe             → { description, llm }
 *   POST /api/music/lyrics               → { lyrics, llm }
 *   POST /api/music/waveform             → { sketch, llm }
 *   POST /api/music/code                 → { language, code, llm }
 *   POST /api/music/generate             → { jobId, position, status }
 *
 * `describe`/`lyrics` are the Generate tab's stepped designer (#4305): an LLM
 * expands a short reference/vibe into a rich conditioning prompt, then writes
 * lyrics from it. Both are one-shot, user-triggered calls — the studio never
 * fires them on its own (AI Provider Usage Policy). `waveform` is the same
 * designer's "Drawn waveform" engine: the LLM paints strokes on a stereo
 * spectrogram canvas (server/lib/paintedCanvas.js) that the browser plays directly.
 * `code` is its "Code" engine: the LLM writes the piece for a sandboxed browser
 * player or contained server renderer. Authoring itself can launch a
 * coding CLI/TUI agent (including via fallback), so all four designer routes
 * require operator authority through the central host-control gate.
 *
 * Generation (`queueMusicGeneration`, services/musicGeneration.js — shared with the
 * autonomous Music Video run) runs the engine-agnostic `generateMusic` (server/services/pipeline/
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
  ENGINES, isEngineHealthy, isEnginePlatformSupported,
  enginePlatformLabel, resolveEngineVramReadiness, MUSIC_VRAM_READINESS,
  formatEngineVramReadinessMessage,
} from '../services/pipeline/musicGen.js';
import { listEngineModels, addAudioModel, removeAudioModel, isValidRepoId } from '../services/audioModels.js';
import { listMusicEngineCapabilities } from '../services/musicEngineCapabilities.js';
import { describeMusic, writeLyrics } from '../services/musicDesigner.js';
import { drawWaveSketch } from '../services/musicWaveform.js';
import { MUSIC_CODE_LANGUAGES, MUSIC_CODE_MAX, writeMusicCode } from '../services/musicCode.js';
import { PAINTED_CANVAS_LIMITS } from '../lib/paintedCanvas.js';
import { startHfDownloadStream } from '../services/hfDownloadStream.js';
import { onClientDisconnect, openSseStream } from '../lib/sseDownload.js';
import { createInstallLogger } from '../lib/installLogger.js';
import { inspectModelCache } from '../lib/hfCache.js';
import { getCudaCapability } from '../lib/cudaCapability.js';
import { federatedMediaAudioProfileSchema } from '../lib/federatedMediaWire.js';
import { queueMusicGeneration } from '../services/musicGeneration.js';

const router = Router();

// GET /api/music/engines — every selectable backend with its models (shipped +
// user-installed, merged), duration window, lyric capability, auto-duration
// support, and a `ready` flag (the opt-in venv is provisioned). The UI gates its
// Generate affordance + shows the install hint from this.
router.get('/engines', asyncHandler(async (_req, res) => {
  res.json(await listMusicEngineCapabilities());
}));

// --- Install music runtime venvs -------------------------------------------
// Mirrors the image/video in-app setup flow: the client opens a POST fetch stream
// and we shell out to the canonical setup script with the selected engine's
// INSTALL_* env var set. Keeping the bash path as the single installer source
// avoids a second Node implementation drifting from scripts/setup-image-video.sh.

const requireMusicEngine = (runtime) => {
  const engine = ENGINES[runtime];
  if (!engine) {
    throw new ServerError(
      `Unknown music runtime: ${runtime}. Expected one of: ${Object.keys(ENGINES).join(', ')}`,
      { status: 400, code: 'UNKNOWN_MUSIC_RUNTIME' },
    );
  }
  return engine;
};

const sendRuntimeStatus = async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  const engine = requireMusicEngine(runtime);
  res.json({
    runtime: engine.id,
    label: engine.name,
    installed: await isEngineHealthy(engine.id),
    venvPath: engine.resolvePython() || null,
    expectedVenvPath: engine.venvDefault,
    installEnvVar: engine.installEnv,
  });
};

router.get('/setup/runtime-status', asyncHandler(sendRuntimeStatus));

// Backward-compatible read surface for stale clients and status pollers. GET
// reports readiness only; installing is restricted to the POST route below.
router.get('/setup/runtime-install', asyncHandler(sendRuntimeStatus));

const runtimeInstallInFlight = new Map();

router.post('/setup/runtime-install', asyncHandler(async (req, res) => {
  const runtime = String(req.query?.runtime || '');
  // Validate before flushing SSE headers so callers receive the standard
  // { error, code, timestamp } response for a bad runtime.
  const engine = requireMusicEngine(runtime);
  const { send, safeEnd } = openSseStream(res);

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
    const vram = resolveEngineVramReadiness(engine.id, cuda);
    if (vram.state !== MUSIC_VRAM_READINESS.SUFFICIENT) {
      send({ type: 'error', message: formatEngineVramReadinessMessage(engine.id, vram, 'installed') });
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

  onClientDisconnect(req, res, () => {
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

const waveformSchema = z.object({
  description: z.string().trim().min(1, 'description is required').max(8000),
  lyrics: z.string().trim().max(20000).optional(),
  durationSec: z.number().min(PAINTED_CANVAS_LIMITS.DURATION_MIN_SEC).max(PAINTED_CANVAS_LIMITS.DURATION_MAX_SEC).optional(),
  // The painting to revise — normalized (and size-bounded) by the service.
  current: z.record(z.string(), z.unknown()).optional(),
  review: z.boolean().optional(),
  // The drawing contract is fixed (no meta-prompt override like describe/lyrics).
  ...designerPickerShape,
}).omit({ template: true });

// POST /api/music/waveform — stateless: have the LLM PAINT the music on a
// spectrogram canvas (lib/paintedCanvas.js) without storing it. The
// designer draws via POST /api/tracks/:id/waveform/draw, which persists it.
// One explicit user action per call.
router.post('/waveform', asyncHandler(async (req, res) => {
  const body = validateRequest(waveformSchema, req.body ?? {});
  res.json(await drawWaveSketch(body));
}));

const codeSchema = z.object({
  description: z.string().trim().min(1, 'description is required').max(8000),
  lyrics: z.string().trim().max(20000).optional(),
  // The code in the editor, to revise. It is prompt input for an authorized
  // authoring provider; playback uses the language's separate render boundary.
  current: z.string().max(MUSIC_CODE_MAX).optional().transform(blankToUndefined),
  language: z.enum(MUSIC_CODE_LANGUAGES).optional().default('strudel'),
  ...designerPickerShape,
}).omit({ template: true });

// POST /api/music/code — have the LLM write the piece in the selected language.
// The selected provider or fallback can execute a coding agent on the host;
// the central host-control gate requires operator authority.
router.post('/code', asyncHandler(async (req, res) => {
  const body = validateRequest(codeSchema, req.body ?? {});
  res.json(await writeMusicCode(body));
}));

const generateSchema = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(8000),
  // No default: distinguish ABSENT (don't touch the track's lyrics) from a
  // present '' (the user cleared them and generated without — persist the clear).
  lyrics: z.string().trim().max(20000).optional(),
  // A render-level override: ignore even supplied lyrics without clearing the
  // track's saved lyric field when the completed audio is attached.
  instrumentalOnly: z.boolean().optional().default(false),
  engine: z.string().trim().min(1).max(80).optional(),
  modelId: z.string().trim().min(1).max(256).optional(),
  // The peer record id is machine-local routing intent. It never crosses the
  // provider boundary. Free-form text stays local too: remote execution uses a
  // fixed-vocabulary instrumental profile rendered by the worker.
  // Why audio alone is restricted that way:
  // docs/decisions/2026-08-20-federated-visual-prompts.md
  mediaProviderPeerId: z.string().uuid().optional(),
  remoteMusicProfile: federatedMediaAudioProfileSchema.optional(),
  durationSec: z.number().positive().max(600).optional(),
  durationMode: z.enum(['auto', 'manual']).optional(),
  // Attach the result to an existing track (else a new one is created). The
  // title seeds a freshly-created track; ignored when trackId is given.
  trackId: z.string().trim().max(80).optional(),
  title: z.string().trim().max(200).optional(),
  artistId: z.string().trim().max(80).optional().default(''),
  artist: z.string().trim().max(120).optional().default(''),
  albumId: z.string().trim().max(80).optional().default(''),
}).superRefine((value, ctx) => {
  if (!value.mediaProviderPeerId) {
    if (value.remoteMusicProfile) {
      ctx.addIssue({
        code: 'custom',
        path: ['remoteMusicProfile'],
        message: 'remoteMusicProfile requires a remote media provider',
      });
    }
    return;
  }
  if (!value.engine) {
    ctx.addIssue({ code: 'custom', path: ['engine'], message: 'engine is required for a remote media provider' });
  }
  if (!value.modelId) {
    ctx.addIssue({ code: 'custom', path: ['modelId'], message: 'modelId is required for a remote media provider' });
  }
  if (!value.remoteMusicProfile) {
    ctx.addIssue({ code: 'custom', path: ['remoteMusicProfile'], message: 'remoteMusicProfile is required for a remote media provider' });
  }
  // Lyrics used to be refused outright here. They now cross to an allowlisted
  // peer (ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2),
  // but only when the resolved capability says the model sings AND the peer's
  // build accepts them on the wire — neither of which this schema can see.
  // The check moved into the handler, below the capability resolve.
});

router.post('/generate', asyncHandler(async (req, res) => {
  const body = validateRequest(generateSchema, req.body ?? {});
  res.status(202).json(await queueMusicGeneration(body));
}));

export default router;
