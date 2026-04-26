/**
 * AUTOMATIC1111 / Forge — compatible API surface.
 *
 * Mounts at /sdapi/v1/* so other machines on the Tailscale network can point
 * their own AUTOMATIC1111 client at this PortOS instance. We dispatch through
 * the imageGen layer so the underlying provider is whatever PortOS is
 * configured for (external pass-through or local mflux).
 *
 * Gated by settings.imageGen.expose.a1111 (default false). When the toggle is
 * off, every endpoint returns 403 — better than half-implementing the surface
 * because clients fail fast and the user knows to flip the toggle.
 *
 * Implements just enough of the A1111 surface for txt2img + status/progress
 * polling. A1111 has dozens of additional endpoints (img2img, controlnet,
 * embedded LoRAs, etc.) that we punt on until someone needs them.
 */

import { Router } from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { z } from 'zod';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { PATHS } from '../lib/fileUtils.js';
import { getSettings } from '../services/settings.js';
import { generateImage, getMode, getActiveJob } from '../services/imageGen/index.js';
import { local as localImage } from '../services/imageGen/index.js';
import { imageGenEvents } from '../services/imageGenEvents.js';
import { listVideoModels, defaultVideoModelId } from '../services/videoGen/local.js';

const router = Router();

// Build a completion waiter for a future generationId. Listeners attach
// immediately so a fast Python child can't emit 'completed' before we're
// listening, but the id-match check uses a registered id (set by .register()
// once generateImage returns). 5-minute timeout matches the external client.
function createCompletionWaiter() {
  let registeredId = null;
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const onComplete = (ev) => { if (ev.generationId === registeredId) { cleanup(); resolve(ev); } };
  const onFailed = (ev) => { if (ev.generationId === registeredId) { cleanup(); reject(new ServerError(ev.error || 'Generation failed', { status: 500, code: 'GEN_FAILED' })); } };
  const timer = setTimeout(() => { cleanup(); reject(new ServerError('Generation timed out', { status: 504, code: 'GEN_TIMEOUT' })); }, 5 * 60 * 1000);
  const cleanup = () => {
    clearTimeout(timer);
    imageGenEvents.off('completed', onComplete);
    imageGenEvents.off('failed', onFailed);
  };
  imageGenEvents.on('completed', onComplete);
  imageGenEvents.on('failed', onFailed);
  return { register: (id) => { registeredId = id; }, promise };
}

const ensureExposed = async () => {
  const s = await getSettings();
  return s.imageGen?.expose?.a1111 === true;
};

router.use(asyncHandler(async (req, res, next) => {
  if (await ensureExposed()) return next();
  res.status(403).json({ error: 'PortOS A1111 API is disabled — toggle "Expose A1111 API" in Settings > Image Gen' });
}));

// Mirrors A1111's /sdapi/v1/options. Most clients only consult
// `sd_model_checkpoint` so we stuff our active mode/model into that field.
router.get('/options', asyncHandler(async (_req, res) => {
  const mode = await getMode();
  const models = localImage.listImageModels();
  const defaultModel = mode === 'local' ? `portos-local-${models[0]?.id || 'dev'}` : 'portos-external';
  res.json({
    sd_model_checkpoint: defaultModel,
    sampler_name: 'Euler',
    portos: { mode },
  });
}));

router.post('/options', (_req, res) => {
  // A1111 lets clients PUT the active checkpoint here; we don't support
  // switching the underlying model from a remote client (security + scope),
  // but we acknowledge so clients that always send options don't error out.
  res.json({ ok: true });
});

// Static catalog. Returns one entry per local image model so clients can show
// a model picker; the external mode shows a single "remote-passthrough" stub.
router.get('/sd-models', asyncHandler(async (_req, res) => {
  const mode = await getMode();
  if (mode === 'local') {
    return res.json(localImage.listImageModels().map((m) => ({
      title: `portos-local-${m.id} [flux]`,
      model_name: `portos-local-${m.id}`,
      hash: null,
      sha256: null,
      filename: m.id,
      config: null,
    })));
  }
  res.json([{ title: 'portos-external [passthrough]', model_name: 'portos-external', hash: null, sha256: null, filename: 'external', config: null }]);
}));

// Minimal stub — A1111 clients usually just check that this returns an array.
router.get('/samplers', (_req, res) => {
  res.json([
    { name: 'Euler', aliases: ['k_euler'], options: {} },
    { name: 'Euler a', aliases: ['k_euler_a'], options: {} },
  ]);
});

// LTX models surfaced as a PortOS extension — clients that know about us can
// list video options without hitting a separate endpoint.
router.get('/portos/video-models', (_req, res) => {
  res.json({ models: listVideoModels(), defaultModel: defaultVideoModelId() });
});

// Live progress — A1111 clients poll this every ~500ms while a generation is
// running. The dispatcher's getActiveJob() surfaces the current generation
// snapshot for both modes (local mflux emits stepwise frames as currentImage
// base64; external SD polls the upstream /progress endpoint). When nothing
// is in flight we return a "no active job" payload that A1111 clients
// understand as idle.
router.get('/progress', asyncHandler(async (_req, res) => {
  const job = await getActiveJob();
  if (!job) {
    return res.json({
      progress: 0,
      eta_relative: 0,
      state: { sampling_step: 0, sampling_steps: 0 },
      current_image: null,
      textinfo: 'PortOS — no active generation',
    });
  }
  res.json({
    progress: typeof job.progress === 'number' ? job.progress : 0,
    eta_relative: 0,
    state: {
      sampling_step: typeof job.step === 'number' ? job.step : 0,
      sampling_steps: typeof job.totalSteps === 'number' ? job.totalSteps : 0,
    },
    current_image: job.currentImage || null,
    textinfo: `PortOS — ${job.mode || 'unknown'} mode${job.modelId ? ` (${job.modelId})` : ''}`,
  });
}));

// Mirror imageGen.js's generateSchema bounds — A1111 clients can be sloppy
// (e.g. defaulting steps=999 from a preset) and we want a clear 400 instead
// of letting bad values through to the dispatcher.
const txt2imgSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negative_prompt: z.string().max(2000).optional().nullable(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfg_scale: z.number().min(0).max(30).optional(),
  seed: z.number().int().optional(),
  sd_model_checkpoint: z.string().max(128).optional(),
}).passthrough(); // tolerate extra A1111 fields the client sends

router.post('/txt2img', asyncHandler(async (req, res) => {
  const parsed = txt2imgSchema.safeParse(req.body || {});
  if (!parsed.success) {
    throw new ServerError(`Validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const {
    prompt,
    negative_prompt,
    width,
    height,
    steps,
    cfg_scale,
    seed,
    sd_model_checkpoint,
  } = parsed.data;

  // Map an A1111-style "portos-local-<id>" checkpoint name back to our
  // internal model id so remote clients can pick a local model. Anything
  // else falls through to whatever PortOS has set as the active mode.
  let modelId;
  if (typeof sd_model_checkpoint === 'string' && sd_model_checkpoint.startsWith('portos-local-')) {
    modelId = sd_model_checkpoint.replace(/^portos-local-/, '').split(' ')[0];
  }

  // In local mode generateImage returns the moment the Python child is
  // spawned — the file isn't on disk yet. Subscribe to the completion event
  // BEFORE calling generateImage so a fast job (cached weights, low steps)
  // can't fire before we attach. External mode awaits internally and the
  // file is on disk by the time generateImage resolves, so the wait is a
  // no-op there.
  const mode = await getMode();
  const localWait = mode === 'local'
    ? createCompletionWaiter()
    : { register: () => {}, promise: Promise.resolve() };

  const result = await generateImage({
    prompt,
    negativePrompt: negative_prompt,
    modelId,
    width,
    height,
    steps,
    cfgScale: cfg_scale,
    seed: seed != null && seed >= 0 ? Number(seed) : undefined,
  });

  localWait.register(result.generationId);
  await localWait.promise;

  // A1111 clients expect base64-encoded images in `images: []`. Read the
  // file we just wrote (the dispatcher saved it under data/images/) and
  // hand it back — slightly wasteful, but it keeps client compatibility.
  const filePath = join(PATHS.images, result.filename);
  const buf = await readFile(filePath).catch(() => null);
  res.json({
    images: buf ? [buf.toString('base64')] : [],
    parameters: { prompt, negative_prompt, width, height, steps, cfg_scale, seed },
    info: JSON.stringify({
      prompt,
      negative_prompt,
      seed: result.seed ?? seed,
      model: result.model || sd_model_checkpoint,
      width,
      height,
      steps,
      cfg_scale,
      portos: { mode: result.mode, filename: result.filename, path: result.path },
    }),
  });
}));

export default router;
