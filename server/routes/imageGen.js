/**
 * Image Generation Routes — works against the external SD API, local mflux,
 * or the Codex CLI built-in image_gen tool, depending on settings.imageGen.mode
 * (or the per-request `mode` override).
 *
 * Generic endpoints (status, generate, avatar) go through the dispatcher.
 * Async-mode endpoints (events SSE, cancel) also go through the dispatcher
 * which routes the jobId to whichever provider owns it. Local-only endpoints
 * (gallery, loras, models, delete) target the local module directly.
 */

import { Router } from 'express';
import { z } from 'zod';
import { existsSync } from 'fs';
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validation.js';
import { optionalUpload } from '../lib/multipart.js';
import * as imageGen from '../services/imageGen/index.js';
import { local, IMAGE_GEN_MODES } from '../services/imageGen/index.js';
import { enqueueJob, attachSseClient as attachQueueSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';
import { getSettings } from '../services/settings.js';
import { getImageModels, isFlux2 } from '../lib/mediaModels.js';
import {
  REQUIRED_PACKAGES, detectPython, checkPackages, installPackages,
  isExternallyManaged, createVenv, isAllowedPython, pipNameFor,
  resolveFlux2Python, FLUX2_VENV_DEFAULT,
} from '../lib/pythonSetup.js';
import { PATHS, ensureDir } from '../lib/fileUtils.js';
import { join, basename, resolve as resolvePath, sep as PATH_SEP } from 'node:path';

const router = Router();

const generateSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  // Per-request backend override. If omitted, the dispatcher uses
  // `imageGen.mode` from settings.json.
  mode: z.enum(IMAGE_GEN_MODES).optional(),
  modelId: z.string().max(64).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  cfgScale: z.number().min(0).max(30).optional(),
  guidance: z.number().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  // mflux supports 3/4/5/6/8 bit quantization; 8 is the default.
  quantize: z.union([z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(8), z.literal('3'), z.literal('4'), z.literal('5'), z.literal('6'), z.literal('8')]).optional(),
  // Filenames only (basenames) — server resolves against PATHS.loras and
  // applies the prefix-check. Old payloads sent absolute server paths
  // (`loraPaths`); accept both for back-compat with stored gallery sidecars.
  loraFilenames: z.array(z.string().max(256).regex(/^[^/\\]+$/, 'lora filename must not contain path separators')).max(8).optional(),
  loraPaths: z.array(z.string().max(512)).max(8).optional(),
  loraScales: z.array(z.number().min(0).max(2)).max(8).optional(),
  // i2i: pick an existing gallery image (basename) as the init image. If
  // initImage was uploaded via multipart, this is ignored in favor of the
  // upload. Strength: 0.0 = ignore source, 1.0 = max influence.
  initImageFile: z.string().max(256).regex(/^[^/\\]+\.(png|jpg|jpeg|webp)$/i, 'init image must be a basename ending in png/jpg/jpeg/webp').optional(),
  initImageStrength: z.number().min(0).max(1).optional(),
});

// JSON callers (SDAPI bridge, avatar route, the Imagine page's old payload
// shape) skip the parser entirely; FormData callers get req.file + string
// req.body that coerceFormFields() converts before Zod validation.
// Only the formats mflux can decode — keep this in sync with the extension
// allowlist below so the route never silently relabels (e.g. HEIC) bytes
// as ".png".
const ACCEPTED_INIT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

const initImageUpload = optionalUpload('initImage', {
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_INIT_IMAGE_MIME.has((file.mimetype || '').toLowerCase())),
});

// Numerics arrive as strings from FormData — coerce before Zod validation.
function coerceFormFields(body) {
  const numericFields = ['width', 'height', 'steps', 'cfgScale', 'guidance', 'seed', 'initImageStrength'];
  for (const f of numericFields) {
    if (typeof body[f] === 'string' && body[f] !== '') body[f] = Number(body[f]);
  }
  if (typeof body.quantize === 'string' && /^\d+$/.test(body.quantize)) body.quantize = Number(body.quantize);
  return body;
}

const avatarSchema = z.object({
  name: z.string().max(100).optional(),
  characterClass: z.string().max(100).optional(),
  prompt: z.string().max(2000).optional(),
});

router.get('/status', asyncHandler(async (req, res) => {
  // Optional ?mode= override lets the Image Gen page probe a specific
  // backend (e.g. when the user flips the per-render chip to Codex but
  // hasn't saved Codex as the default yet). Express's default query
  // parser turns duplicated keys (?mode=local&mode=codex) into arrays,
  // so guard on string type before forwarding so `mode` always reaches
  // the dispatcher as `string | undefined`.
  const rawMode = req.query.mode;
  const mode = typeof rawMode === 'string' && IMAGE_GEN_MODES.includes(rawMode) ? rawMode : undefined;
  res.json(await imageGen.checkConnection({ mode }));
}));

router.get('/active', asyncHandler(async (_req, res) => {
  res.json({ activeJob: await imageGen.getActiveJob() });
}));

router.post('/generate', initImageUpload, asyncHandler(async (req, res) => {
  const data = validateRequest(generateSchema, coerceFormFields(req.body));
  // Resolve init image source: uploaded file > gallery filename. The local
  // service double-checks that the path stays under PATHS.images.
  let initImagePath = null;
  let uploadedInitTempPath = null;
  if (req.file) {
    await ensureDir(PATHS.images);
    // Trust the validated mimetype from the fileFilter — picking the ext
    // off the original filename can mismatch the bytes (e.g. HEIC saved
    // as .jpg). MIME_TO_EXT only contains formats the fileFilter accepts.
    const ext = MIME_TO_EXT[(req.file.mimetype || '').toLowerCase()] || '.png';
    const initFilename = `init-${randomUUID()}${ext}`;
    initImagePath = join(PATHS.images, initFilename);
    await copyFile(req.file.path, initImagePath);
    uploadedInitTempPath = req.file.path;
  } else if (data.initImageFile) {
    const candidate = join(PATHS.images, basename(data.initImageFile));
    const imagesRoot = resolvePath(PATHS.images) + PATH_SEP;
    const resolved = resolvePath(candidate);
    if (!resolved.startsWith(imagesRoot) || !existsSync(resolved)) {
      throw new ServerError('Init image not found in gallery', { status: 400, code: 'INIT_IMAGE_NOT_FOUND' });
    }
    initImagePath = resolved;
  }
  // Strip the route-only `initImageFile` field — providers expect `initImagePath`.
  delete data.initImageFile;
  if (initImagePath) data.initImagePath = initImagePath;

  // Multer's tmp upload is no longer needed once we've copied it into
  // PATHS.images. Use res.on('close') so the temp file is cleaned up whether
  // generateImage resolves, throws (handled by errorHandler middleware), or
  // the client drops the connection mid-flight.
  if (uploadedInitTempPath) {
    res.on('close', () => { unlink(uploadedInitTempPath).catch(() => {}); });
  }
  // Mode resolution: explicit per-request override > settings default. Only
  // local-mode goes through the mediaJobQueue (it's the GPU-bound backend that
  // used to throw BUSY). External and Codex backends remain synchronous —
  // they don't share Metal/MLX resources so no queue is needed.
  const settings = await getSettings();
  const mode = data.mode || settings.imageGen?.mode || 'external';
  if (mode === 'local') {
    const py = settings.imageGen?.local?.pythonPath || null;
    // Pre-validate config: mflux models need pythonPath, FLUX.2 doesn't
    // (it uses its own bundled venv). Without this guard, the queue would
    // accept the job and only surface the failure async over SSE.
    const allModels = getImageModels();
    const selectedModel = allModels.find((m) => m.id === data.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    if (selectedModel && !isFlux2(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
    const { jobId, position, status } = enqueueJob({
      kind: 'image',
      params: { pythonPath: py, ...data },
    });
    return res.json({
      jobId,
      generationId: jobId,
      filename: `${jobId}.png`,
      path: `/data/images/${jobId}.png`,
      mode: 'local',
      model: data.modelId,
      status,
      position,
    });
  }
  res.json(await imageGen.generateImage(data));
}));

router.post('/avatar', asyncHandler(async (req, res) => {
  const data = validateRequest(avatarSchema, req.body);
  res.json(await imageGen.generateAvatar(data));
}));

// Local-only: list image models and LoRAs the local backend can use.
router.get('/models', (_req, res) => {
  res.json(local.listImageModels());
});

router.get('/loras', asyncHandler(async (_req, res) => {
  res.json(await local.listLoras());
}));

router.get('/gallery', asyncHandler(async (_req, res) => {
  res.json(await local.listGallery());
}));

// SSE progress stream. Local renders run via the mediaJobQueue and emit
// `queued` → `started` → `progress` → `complete` events; the queue owns the
// SSE attachment for those. Codex still produces job-keyed SSE through its
// own provider — fall through to the dispatcher when the queue doesn't know
// the job. External backend has no SSE (it's blocking).
router.get('/:jobId/events', (req, res) => {
  if (attachQueueSseClient(req.params.jobId, res)) return;
  if (imageGen.attachSseClient(req.params.jobId, res)) return;
  res.status(404).json({ error: 'Job not found or expired' });
});

router.post('/cancel', asyncHandler(async (req, res) => {
  // Cancel selection rules, in priority order:
  //   1. Explicit body.jobId — cancel that queued/running local image job.
  //      Required for users with multiple in-flight renders.
  //   2. No jobId — cancel the newest queued/running local image job (most
  //      recent activity wins, matching the user's last "submit" gesture).
  //   3. No queue match — fall through to the codex-mode cancel.
  const requestedJobId = typeof req.body?.jobId === 'string' && req.body.jobId.trim()
    ? req.body.jobId.trim()
    : undefined;
  const cancellable = listJobs({ kind: 'image' })
    .filter((j) => j.status === 'queued' || j.status === 'running');
  if (requestedJobId) {
    const target = cancellable.find((j) => j.id === requestedJobId);
    if (target) return res.json(await cancelJob(target.id));
    // jobId not in our queue — fall through (could be a codex job).
  } else if (cancellable.length) {
    return res.json(await cancelJob(cancellable[cancellable.length - 1].id));
  }
  const cancelled = imageGen.cancel();
  res.json({ ok: cancelled });
}));

router.delete('/:filename', asyncHandler(async (req, res) => {
  res.json(await local.deleteImage(req.params.filename));
}));

router.post('/:filename/visibility', asyncHandler(async (req, res) => {
  res.json(await local.setImageHidden(req.params.filename, !!req.body?.hidden));
}));

// --- Local-mode setup automation ---

router.get('/setup/python', asyncHandler(async (_req, res) => {
  const path = await detectPython();
  res.json({ path });
}));

// Used by the FLUX.2 model picker: surface a banner when the gated repo's
// license hasn't been accepted (HF_TOKEN missing) and the runner is set up.
router.get('/setup/flux2-status', (_req, res) => {
  // huggingface_hub reads HF_TOKEN (preferred) and the legacy
  // HUGGINGFACEHUB_API_TOKEN / HUGGINGFACE_HUB_TOKEN names. Earlier rev of
  // this code used HUGGING_FACE_HUB_TOKEN (extra underscore) which doesn't
  // match what the library actually checks.
  const hasToken = !!(
    process.env.HF_TOKEN ||
    process.env.HUGGINGFACE_HUB_TOKEN ||
    process.env.HUGGINGFACEHUB_API_TOKEN
  );
  const venvPython = resolveFlux2Python();
  res.json({
    hfTokenPresent: hasToken,
    venvInstalled: !!venvPython,
    venvPath: venvPython,
    expectedVenvPath: FLUX2_VENV_DEFAULT,
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B',
  });
});

const checkSchema = z.object({ pythonPath: z.string().min(1) });

router.get('/setup/check', asyncHandler(async (req, res) => {
  const { pythonPath } = validateRequest(checkSchema, req.query);
  if (!isAllowedPython(pythonPath)) {
    return res.status(400).json({ error: 'pythonPath must be a python interpreter (basename python/python3/python3.NN)' });
  }
  const [pkgs, externallyManaged] = await Promise.all([
    checkPackages(pythonPath),
    isExternallyManaged(pythonPath),
  ]);
  res.json({
    pythonPath,
    externallyManaged,
    required: REQUIRED_PACKAGES,
    ...pkgs,
  });
}));

const venvSchema = z.object({
  basePython: z.string().min(1).optional(),
});

router.post('/setup/create-venv', asyncHandler(async (req, res) => {
  const { basePython } = validateRequest(venvSchema, req.body || {});
  if (basePython && !isAllowedPython(basePython)) {
    return res.status(400).json({ error: 'basePython must be a python interpreter (basename python/python3/python3.NN)' });
  }
  const base = basePython || (await detectPython());
  if (!base) {
    return res.status(400).json({ error: 'No base Python 3 found to bootstrap a venv. Install Python 3.10+ first.' });
  }
  const target = join(PATHS.data, 'python', 'venv');
  const venvPython = await createVenv(base, target);
  res.json({ pythonPath: venvPython, target });
}));

// Allowlist: only PortOS's own required pip names (or their pinned variants
// like `transformers<5`) are installable. Without this, the endpoint would
// happily pip-install arbitrary PyPI packages — the install runs as the
// PortOS user and pip itself executes setup.py from the package, so an
// arbitrary package install is effectively arbitrary code execution.
// Build the pip-spec allowlist from REQUIRED_PACKAGES via pipNameFor — that
// translates import names (`cv2`) to their actual pip specs
// (`opencv-python`). Without this mapping, the allowlist would contain
// import-only names that can't actually be installed but ALSO don't appear
// here as their pip specs, so the legitimate install request would 400.
// Worse: an import name like `cv2` isn't a real PyPI package but if a
// typosquat existed under that name it'd be installable.
const REQUIRED_PIP_NAMES = new Set([
  ...REQUIRED_PACKAGES.map(pipNameFor),
  // Windows torch path also installs torch + diffusers, which are in
  // REQUIRED_PACKAGES on Windows but not on macOS — keep them allowlisted
  // unconditionally so a Windows install requested from a macOS server
  // (unlikely but possible) doesn't 400 unhelpfully.
  'torch',
  'diffusers',
  // Both the bare `transformers` and the macOS-pinned `transformers<5`
  // variant should be installable; pipNameFor only emits the pinned
  // variant on macOS, so list both unconditionally for safety.
  'transformers',
  'transformers<5',
]);

const installSchema = z.object({
  pythonPath: z.string().min(1),
  packages: z.array(z.string().min(1)).min(1).max(40),
});

// EventSource consumers re-run /setup/check on `complete` to refresh status.
router.get('/setup/install', (req, res) => {
  const pythonPath = req.query.pythonPath;
  const packages = String(req.query.packages || '').split(',').filter(Boolean);
  const parsed = installSchema.safeParse({ pythonPath, packages });
  if (!parsed.success) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: parsed.error.message }));
  }
  if (!isAllowedPython(parsed.data.pythonPath)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'pythonPath must be a python interpreter' }));
  }
  const disallowed = parsed.data.packages.filter((p) => !REQUIRED_PIP_NAMES.has(p));
  if (disallowed.length) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: `Packages not in allowlist: ${disallowed.join(', ')}` }));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // `send` and `safeEnd` no-op once the response has ended so a late
  // pip-output line (or the promise.then below) doesn't trigger
  // ERR_STREAM_WRITE_AFTER_END or double-end the response.
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const { promise, kill } = installPackages(parsed.data.pythonPath, parsed.data.packages, send);
  promise.then(safeEnd);

  // Client navigation away should kill pip — a torch upgrade can run for
  // 10+ minutes and would otherwise keep going invisibly.
  req.on('close', () => { kill(); safeEnd(); });
});

export default router;
