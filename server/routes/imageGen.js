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
import { copyFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';
import { asyncHandler, ServerError } from '../lib/errorHandler.js';
import {
  validateRequest, imageEdgeSchema, refineImagePixelCap, PIXEL_CAP_MESSAGE,
} from '../lib/validation.js';
import { optionalUploadFields } from '../lib/multipart.js';
import * as imageGen from '../services/imageGen/index.js';
import { local, IMAGE_GEN_MODE, IMAGE_GEN_MODES, resolveImageCleaners } from '../services/imageGen/index.js';
import { enqueueJob, attachSseClient as attachQueueSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { getHfToken, getHfTokenInfo, HF_TOKEN_REGEX } from '../lib/hfToken.js';
import { getImageModels, isFlux2, isZImage, isErnie } from '../lib/mediaModels.js';
import {
  REQUIRED_PACKAGES, detectPython, checkPackages, installPackages,
  isExternallyManaged, createVenv, isAllowedPython, pipNameFor,
  resolveFlux2Python, FLUX2_VENV_DEFAULT, installFlux2Venv, isFlux2VenvHealthy,
} from '../lib/pythonSetup.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../lib/fileUtils.js';
import { join } from 'node:path';
import { readFile, writeFile } from 'fs/promises';
import { STYLE_PRESETS } from '../lib/writersRoomStylePresets.js';
import { cleanImageBuffer } from '../lib/imageClean.js';
import { purgeImageRefFromAllUniverses } from '../services/universeCanon.js';
import { listCollections, addItem, ERR_DUPLICATE } from '../services/mediaCollections.js';
import { itemKey } from '../lib/mediaItemKey.js';

const router = Router();

router.get('/style-presets', (_req, res) => res.json(STYLE_PRESETS));

const generateSchema = z.object({
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional(),
  // Per-request backend override. If omitted, the dispatcher uses
  // `imageGen.mode` from settings.json.
  mode: z.enum(IMAGE_GEN_MODES).optional(),
  modelId: z.string().max(64).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
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
  // Multi-reference image editing (FLUX.2). Up to 4 reference images are
  // uploaded as separate multipart fields `referenceImage1` … `referenceImage4`;
  // `referenceStrengths` is a parallel array of weights (0.0 = ignore the
  // reference, 1.0 = full influence). The schema only constrains the strengths
  // array — file presence is enforced at the upload layer, and the route
  // pairs filled slots with their strengths positionally.
  referenceStrengths: z.array(z.number().min(0).max(1)).max(4).optional(),
  // Per-render override of the cleaners. When omitted, the route inherits
  // from `settings.imageGen.{mode}.{cleanC2PA,denoise}`. Explicit booleans
  // here force the value for this one render. Legacy `autoClean` is still
  // accepted (mapped to both flags) so older clients keep working through
  // the deprecation window.
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  autoClean: z.boolean().optional(),
}).refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

// JSON callers (SDAPI bridge, avatar route, the Imagine page's old payload
// shape) skip the parser entirely; FormData callers get req.file + string
// req.body that coerceFormFields() converts before Zod validation.
// Only the formats mflux can decode — keep this in sync with the extension
// allowlist below so the route never silently relabels (e.g. HEIC) bytes
// as ".png".
const ACCEPTED_INIT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// Multi-reference editing accepts up to 4 references on dedicated field names.
// The legacy single `initImage` upload (mflux i2i) stays on its own slot so a
// FLUX.2 multi-ref upload and an mflux i2i upload don't collide.
const REFERENCE_IMAGE_FIELDS = ['referenceImage1', 'referenceImage2', 'referenceImage3', 'referenceImage4'];
const IMAGE_UPLOAD_FIELDS = ['initImage', ...REFERENCE_IMAGE_FIELDS];

const imageGenUploads = optionalUploadFields(IMAGE_UPLOAD_FIELDS, {
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_INIT_IMAGE_MIME.has((file.mimetype || '').toLowerCase())),
});

// Numerics arrive as strings from FormData — coerce before Zod validation.
// `referenceStrengths` is a repeated key (one per slot), which arrives as a
// string OR an array of strings; coerce element-wise so Zod sees numbers.
function coerceFormFields(body) {
  const numericFields = ['width', 'height', 'steps', 'cfgScale', 'guidance', 'seed', 'initImageStrength'];
  for (const f of numericFields) {
    if (typeof body[f] === 'string' && body[f] !== '') body[f] = Number(body[f]);
  }
  if (typeof body.quantize === 'string' && /^\d+$/.test(body.quantize)) body.quantize = Number(body.quantize);
  if (body.referenceStrengths != null) {
    const raw = Array.isArray(body.referenceStrengths) ? body.referenceStrengths : [body.referenceStrengths];
    body.referenceStrengths = raw.map((v) => (typeof v === 'string' && v !== '' ? Number(v) : v));
  }
  // Multipart sends checkbox values as 'true' / 'false' strings; coerce to
  // bool so Zod's `z.boolean()` accepts them.
  for (const f of ['cleanC2PA', 'denoise', 'autoClean']) {
    if (typeof body[f] === 'string') body[f] = body[f] === 'true';
  }
  // Legacy single-flag clients: an explicit `autoClean` on the wire maps to
  // BOTH new flags (preserves the pre-split behavior) only when the caller
  // didn't also send the new fields. Modern clients that pass cleanC2PA /
  // denoise explicitly win.
  if (typeof body.autoClean === 'boolean') {
    if (typeof body.cleanC2PA !== 'boolean') body.cleanC2PA = body.autoClean;
    if (typeof body.denoise !== 'boolean') body.denoise = body.autoClean;
  }
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

// Shape returned for any image-gen job that goes through the mediaJobQueue
// (local + codex). Kept in one place so the two enqueue branches below stay
// in sync — the client's polling/SSE hooks key off these fields.
const queuedImageResponse = ({ jobId, position, status, mode, model }) => ({
  jobId,
  generationId: jobId,
  filename: `${jobId}.png`,
  path: `/data/images/${jobId}.png`,
  mode,
  model,
  status,
  position,
});

router.post('/generate', imageGenUploads, asyncHandler(async (req, res) => {
  const data = validateRequest(generateSchema, coerceFormFields(req.body));
  // Resolve init image source: uploaded file > gallery filename. The local
  // service double-checks that the path stays under PATHS.images.
  let initImagePath = null;
  const uploadedTempPaths = [];
  const initUpload = req.files?.initImage;
  const referenceImagePaths = [];
  const referenceImageStrengths = [];
  // Pair strengths by PACK position (post-filter), not slot position — the
  // client renumbers populated slots into `referenceImage1..N` and sends a
  // parallel `referenceStrengths` array sized N. A curl user could leave a
  // gap (`referenceImage2` + `referenceImage4` only); the strength at index 0
  // still pairs with the first surviving upload in slot order.
  const referenceUploads = REFERENCE_IMAGE_FIELDS
    .map((field) => req.files?.[field])
    .filter(Boolean)
    .map((upload, packedIndex) => ({ upload, strength: data.referenceStrengths?.[packedIndex] }));

  // Best-effort cleanup of every multer-staged file currently on `req.files`.
  // The multipart parser writes uploads to `os.tmpdir()` as they stream in,
  // so a 400 thrown from validation BEFORE we've registered the `res.on('close')`
  // sweep would otherwise leak those temp files. Call this from any pre-stage
  // throw site (FLUX.2-only gate, non-local-backend gate).
  const cleanupReqFilesTemp = () => {
    if (!req.files) return;
    for (const f of Object.values(req.files)) {
      if (f?.path) unlink(f.path).catch(() => {});
    }
  };

  // Resolve the effective backend BEFORE staging reference uploads — only the
  // local FLUX.2 runner consumes `referenceImagePaths`; an `external` or `codex`
  // request that uploaded refs would otherwise stage files under
  // `PATHS.imageRefs` and write sidecar metadata claiming references were used,
  // while the actual generation silently ignored them. (Reading settings here
  // is cheap — it's already read again below for the per-mode dispatch.)
  const settings = await getSettings();
  const mode = data.mode || settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
  // Resolve cleaners ONCE at the route layer so all three dispatch paths
  // (synchronous external, codex queue, local queue) see the same values.
  // Stamp onto `data` so they flow through the spread-into-params calls
  // below verbatim.
  const cleaners = resolveImageCleaners(data, settings, mode);
  data.cleanC2PA = cleaners.cleanC2PA;
  data.denoise = cleaners.denoise;
  delete data.autoClean; // legacy field — already mapped into both flags above

  // Multi-reference is a FLUX.2-only, local-backend-only feature — local.js's
  // buildArgs only emits --reference-images/--reference-strengths inside the
  // isFlux2 branch, and codex/external backends don't read these fields at all.
  // Reject up-front rather than copying the uploads to PATHS.imageRefs and
  // silently dropping them downstream (which would orphan files on disk and
  // produce metadata sidecars that lie about how the render was conditioned).
  if (referenceUploads.length) {
    if (mode !== IMAGE_GEN_MODE.LOCAL) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for local FLUX.2 renders',
        { status: 400, code: 'REFERENCE_IMAGES_LOCAL_ONLY' },
      );
    }
    const candidate = getImageModels().find((m) => m.id === data.modelId)
      ?? getImageModels().find((m) => m.id === 'dev')
      ?? getImageModels()[0];
    if (!isFlux2(candidate)) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for FLUX.2 models',
        { status: 400, code: 'REFERENCE_IMAGES_FLUX2_ONLY' },
      );
    }
  }

  if (initUpload) await ensureDir(PATHS.images);
  if (referenceUploads.length) await ensureDir(PATHS.imageRefs);
  if (initUpload) {
    // Trust the validated mimetype from the fileFilter — picking the ext
    // off the original filename can mismatch the bytes (e.g. HEIC saved
    // as .jpg). MIME_TO_EXT only contains formats the fileFilter accepts.
    const ext = MIME_TO_EXT[(initUpload.mimetype || '').toLowerCase()] || '.png';
    const initFilename = `init-${randomUUID()}${ext}`;
    initImagePath = join(PATHS.images, initFilename);
    await copyFile(initUpload.path, initImagePath);
    uploadedTempPaths.push(initUpload.path);
  } else if (data.initImageFile) {
    const resolved = resolveGalleryImage(data.initImageFile);
    if (!resolved) {
      throw new ServerError('Init image not found in gallery', { status: 400, code: 'INIT_IMAGE_NOT_FOUND' });
    }
    initImagePath = resolved;
  }
  // Multi-reference editing (FLUX.2). Walk packed slot entries in submit
  // order — each contributes a path + its parallel strength. Empty slots
  // are filtered out above so the runner sees `referenceImagePaths: [p1, ...]`
  // and aligns strengths by index.
  for (const { upload, strength } of referenceUploads) {
    const ext = MIME_TO_EXT[(upload.mimetype || '').toLowerCase()] || '.png';
    const refFilename = `ref-${randomUUID()}${ext}`;
    const refPath = join(PATHS.imageRefs, refFilename);
    await copyFile(upload.path, refPath);
    uploadedTempPaths.push(upload.path);
    referenceImagePaths.push(refPath);
    // Default to 1.0 when the client didn't send a parallel strength entry,
    // matching the "full influence" intent of an uploaded reference.
    referenceImageStrengths.push(typeof strength === 'number' ? strength : 1.0);
  }
  // Strip the route-only fields — providers expect normalized `…Path(s)`.
  delete data.initImageFile;
  delete data.referenceStrengths;
  if (initImagePath) data.initImagePath = initImagePath;
  if (referenceImagePaths.length) {
    data.referenceImagePaths = referenceImagePaths;
    data.referenceImageStrengths = referenceImageStrengths;
  }
  if (data.guidance == null && data.cfgScale != null) {
    data.guidance = data.cfgScale;
  }

  // Multer's tmp upload is no longer needed once we've copied it into
  // PATHS.images. Use res.on('close') so the temp files are cleaned up whether
  // generateImage resolves, throws (handled by errorHandler middleware), or
  // the client drops the connection mid-flight.
  if (uploadedTempPaths.length) {
    res.on('close', () => {
      for (const p of uploadedTempPaths) unlink(p).catch(() => {});
    });
  }
  // Local + codex both go through mediaJobQueue (separate lanes — codex
  // doesn't share MLX). External SD-API stays synchronous: it's a remote
  // call with no local single-flight constraint to absorb. `settings` and
  // `mode` were already resolved above (so the FLUX.2 + local-backend gate
  // could fire before staging any uploads).
  if (mode === IMAGE_GEN_MODE.CODEX) {
    // Reject up-front rather than enqueueing a doomed job — codex is gated
    // behind an explicit toggle since not every Codex account has access to
    // the image_gen tool.
    const c = settings.imageGen?.codex || {};
    if (!c.enabled) {
      throw new ServerError(
        'Codex Imagegen is disabled — enable it in Settings → Image Gen first',
        { status: 400, code: 'CODEX_IMAGEGEN_DISABLED' },
      );
    }
    const queued = enqueueJob({
      kind: 'image',
      // `mode: IMAGE_GEN_MODE.CODEX` is the queue's discriminator —
      // laneForJob() routes codex jobs to the codex lane, and runJob's image
      // branch dispatches to imageGen/codex.js when it sees this flag.
      params: {
        mode: IMAGE_GEN_MODE.CODEX,
        codexPath: c.codexPath,
        model: c.model,
        ...data,
      },
    });
    return res.json(queuedImageResponse({ ...queued, mode: IMAGE_GEN_MODE.CODEX, model: c.model || null }));
  }
  if (mode === IMAGE_GEN_MODE.LOCAL) {
    const py = settings.imageGen?.local?.pythonPath || null;
    // Pre-validate config: mflux models need pythonPath, FLUX.2 doesn't
    // (it uses its own bundled venv). Without this guard, the queue would
    // accept the job and only surface the failure async over SSE.
    const allModels = getImageModels();
    // Reject a typo'd modelId synchronously rather than enqueueing a doomed
    // job. When omitted, fall through to the default ('dev'-ish) — the
    // worker does the same lookup so behavior stays consistent.
    if (data.modelId && !allModels.some((m) => m.id === data.modelId)) {
      throw new ServerError(
        `Unknown modelId: ${data.modelId}`,
        { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' },
      );
    }
    const selectedModel = allModels.find((m) => m.id === data.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    if (selectedModel && !isFlux2(selectedModel) && !isZImage(selectedModel) && !isErnie(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
    const queued = enqueueJob({
      kind: 'image',
      params: { pythonPath: py, ...data },
    });
    // Resolve the effective model the same way the validation block above
    // does so the response reflects the actual fallback chain (caller
    // modelId → 'dev' → allModels[0]) rather than just the requested id.
    return res.json(queuedImageResponse({
      ...queued,
      mode: IMAGE_GEN_MODE.LOCAL,
      model: selectedModel?.id || data.modelId || 'dev',
    }));
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
  res.json(await local.listLoraFilenames());
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
  //   1. body.all === true — cancel every queued/running image job. Used by
  //      the writers-room storyboard "Cancel renders" CTA, which can have
  //      20+ scene renders in flight at once.
  //   2. Explicit body.jobId — cancel that queued/running local image job.
  //      Required for users with multiple in-flight renders.
  //   3. No jobId — cancel the newest queued/running local image job (most
  //      recent activity wins, matching the user's last "submit" gesture).
  //   4. No queue match — fall through to the codex-mode cancel.
  const requestedJobId = typeof req.body?.jobId === 'string' && req.body.jobId.trim()
    ? req.body.jobId.trim()
    : undefined;
  const cancellable = listJobs({ kind: 'image' })
    .filter((j) => j.status === 'queued' || j.status === 'running');
  if (req.body?.all === true) {
    // Cancel queued first so the running job's slot doesn't get refilled the
    // moment we cancel it. Settle individually so one stale job doesn't
    // block the rest. cancellable is already a fresh filter() result.
    const ordered = cancellable.sort((a, b) => {
      if (a.status === b.status) return 0;
      return a.status === 'queued' ? -1 : 1;
    });
    const results = await Promise.all(ordered.map((j) => cancelJob(j.id).catch((err) => ({ ok: false, error: err.message }))));
    // Belt-and-braces: also poke the legacy single-process cancel so any
    // in-flight gen outside the queue (codex sync mode) gets stopped.
    imageGen.cancel();
    return res.json({ ok: true, canceled: results.filter((r) => r?.ok).length, attempted: results.length });
  }
  if (requestedJobId) {
    const target = cancellable.find((j) => j.id === requestedJobId);
    if (target) return res.json(await cancelJob(target.id));
    // jobId not in our queue — fall through (could be a codex job).
  } else if (cancellable.length) {
    // "Most recent submit" — explicitly sort by queuedAt DESC instead of
    // relying on listJobs() ordering (which puts gpuRunning before
    // codexRunning, then queue, then archive). queuedAt is the user's
    // actual submit timestamp; startedAt would mis-order an older queued
    // job that just dequeued ahead of a more-recently-submitted job
    // still waiting in queue.
    const latestSubmitFirst = [...cancellable].sort((a, b) => {
      const ta = new Date(a.queuedAt || 0).getTime();
      const tb = new Date(b.queuedAt || 0).getTime();
      return tb - ta;
    });
    return res.json(await cancelJob(latestSubmitFirst[0].id));
  }
  const cancelled = imageGen.cancel();
  res.json({ ok: cancelled });
}));

router.delete('/:filename', asyncHandler(async (req, res) => {
  const result = await local.deleteImage(req.params.filename);
  // Sync universe canon — characters/settings/objects[].imageRefs on every
  // universe is scanned and any reference to this filename is dropped.
  // Best-effort: a purge failure must not block the gallery delete itself.
  const universePurge = await purgeImageRefFromAllUniverses(req.params.filename).catch((err) => {
    console.warn(`⚠️ Universe canon purge failed for ${req.params.filename}: ${err?.message || err}`);
    return { removed: 0 };
  });
  if (universePurge.removed > 0) {
    console.log(`🧹 Purged ${universePurge.removed} canon ref(s) for ${req.params.filename}`);
  }
  res.json({ ...result, canonRefsRemoved: universePurge.removed });
}));

router.post('/:filename/visibility', asyncHandler(async (req, res) => {
  res.json(await local.setImageHidden(req.params.filename, !!req.body?.hidden));
}));

router.post('/:filename/clean', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename);

  const sourcePath = join(PATHS.images, filename);
  const [buffer, { metadata: sourceMeta }] = await Promise.all([
    readFile(sourcePath).catch((err) => {
      if (err.code === 'ENOENT') throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
      throw err;
    }),
    local.readImageSidecar(filename),
  ]);

  const result = await cleanImageBuffer(buffer);
  if (result.format !== 'png') {
    throw new ServerError('Gallery images must be PNG', { status: 400, code: 'UNSUPPORTED_FORMAT' });
  }

  // The `_clean-aggressive` filename suffix and `cleanLevel: 'aggressive'`
  // sidecar field survive the light/aggressive collapse so already-cleaned
  // images on disk keep round-tripping through the gallery unchanged. A future
  // rename to `_cleaned.png` would need a backfill migration.
  const base = filename.slice(0, -'.png'.length);
  const outFilename = `${base}_clean-aggressive.png`;
  const outPath = join(PATHS.images, outFilename);
  const sidecarPath = join(PATHS.images, `${base}_clean-aggressive.metadata.json`);

  const createdAt = new Date().toISOString();
  // Strip `hidden` so a clean of a hidden source still surfaces in the gallery
  // — cleaning is a deliberate user action that implies wanting to see the result.
  // Strip `filename`/`id` so listGallery's `...metadata` spread doesn't overwrite
  // the disk-derived filename for the cleaned copy with the source's filename.
  const { hidden: _hidden, filename: _srcFilename, id: _srcId, ...sourceMetaForCleaned } = sourceMeta;
  const cleanedMeta = {
    ...sourceMetaForCleaned,
    createdAt,
    cleanedFrom: filename,
    cleanLevel: 'aggressive',
    c2paStripped: result.c2paStripped,
  };

  await Promise.all([
    writeFile(outPath, result.data),
    writeFile(sidecarPath, JSON.stringify(cleanedMeta, null, 2)),
  ]);

  // Auto-file the cleaned copy into every collection that contained the
  // source. Without this, users who built a collection around an original
  // would have to manually re-add the cleaned variant — the prior behavior
  // surprised users (cleaned image vanished from "their" view). Best-effort:
  // a collection-add failure must not fail the clean itself. ERR_DUPLICATE
  // is silently swallowed so re-cleans of an already-filed pair are no-ops.
  const filedCollections = await autoFileCleanedToSourceCollections(filename, outFilename).catch((err) => {
    console.warn(`⚠️ Auto-file cleaned ${outFilename} → source collections failed: ${err?.message || err}`);
    return [];
  });

  console.log(`🧼 Cleaned ${filename} → ${outFilename} (${result.sizeBefore}B → ${result.sizeAfter}B, c2pa=${result.c2paStripped}${filedCollections.length ? `, filed to ${filedCollections.length} collection(s)` : ''})`);

  // sourceMeta first so explicit fields below win on key collisions (the
  // cleaned copy's createdAt must reflect the cleaning, not the original).
  res.json({
    ...sourceMetaForCleaned,
    filename: outFilename,
    path: `/data/images/${outFilename}`,
    createdAt,
    sizeBefore: result.sizeBefore,
    sizeAfter: result.sizeAfter,
    sizeBytes: result.sizeAfter,
    width: result.width,
    height: result.height,
    cleanedFrom: filename,
    cleanLevel: 'aggressive',
    c2paStripped: result.c2paStripped,
  });
}));

// Add the cleaned-image filename to every collection that already contains
// the source filename. Returns the ids of the collections that received the
// new entry (excluding ones that already contained the cleaned filename).
// Cross-collection writes run in parallel — addItem serializes per file write
// internally, so concurrent calls on different collections are safe.
async function autoFileCleanedToSourceCollections(sourceFilename, cleanedFilename) {
  const sourceKey = itemKey({ kind: 'image', ref: sourceFilename });
  const all = await listCollections();
  const matching = all.filter((c) => c.items.some((it) => itemKey(it) === sourceKey));
  if (matching.length === 0) return [];
  const results = await Promise.all(matching.map(async (c) => {
    try {
      await addItem(c.id, { kind: 'image', ref: cleanedFilename });
      return c.id;
    } catch (err) {
      if (err?.code === ERR_DUPLICATE) return null;
      console.warn(`⚠️ Auto-file ${cleanedFilename} → collection ${c.id} failed: ${err?.message || err}`);
      return null;
    }
  }));
  return results.filter(Boolean);
}

// --- Local-mode setup automation ---

router.get('/setup/python', asyncHandler(async (_req, res) => {
  const path = await detectPython();
  res.json({ path });
}));

// SSE-driven FLUX.2 venv bootstrap. Replaces the "drop to a shell and run
// INSTALL_FLUX2=1 bash scripts/setup-image-video.sh" friction with an in-app
// install: the client opens an EventSource, gets staged progress events
// (detect → venv → upgrade-pip → install → verify), and either finishes or
// surfaces a clear error. Runs the install logic in-process via
// installFlux2Venv() so we get structured `stage` events the UI can animate
// against, instead of having to parse bash output.
//
// In-flight singleton: a rapid double-click would otherwise race two pip
// processes against the same venv directory. resolveFlux2Python() can't
// gate the second click — the first install hasn't created the python yet.
let flux2InstallInFlight = null;

router.get('/setup/flux2-install', asyncHandler(async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  // Skip only when the venv binary AND the import work — a half-broken venv
  // (binary present, packages missing from a killed mid-install) needs to
  // re-run the install, not be reported as ready.
  if (await isFlux2VenvHealthy()) {
    send({ type: 'stage', stage: 'verify', message: 'FLUX.2 venv already installed.' });
    send({ type: 'complete', message: 'Already installed — nothing to do.' });
    return safeEnd();
  }
  if (flux2InstallInFlight) {
    send({ type: 'error', message: 'Another FLUX.2 install is already running. Wait for it to finish or restart PortOS.' });
    return safeEnd();
  }

  const { promise, kill } = installFlux2Venv(send);
  flux2InstallInFlight = promise;
  promise
    .catch((err) => send({ type: 'error', message: err?.message || 'Unknown installer failure' }))
    .finally(() => {
      flux2InstallInFlight = null;
      safeEnd();
    });

  // Cancel the install if the client navigates away mid-bootstrap. A torch
  // install is a multi-GB download and would otherwise keep running invisibly.
  req.on('close', () => { kill(); safeEnd(); });
}));

// Used by the FLUX.2 model picker: surface a banner when the gated repo's
// license hasn't been accepted (HF_TOKEN missing) and the runner is set up.
// `venvInstalled` reflects functional health (binary AND packages import) —
// a half-broken venv would otherwise hide the install banner forever.
router.get('/setup/flux2-status', asyncHandler(async (_req, res) => {
  const [token, healthy] = await Promise.all([getHfToken(), isFlux2VenvHealthy()]);
  const venvPython = resolveFlux2Python();
  res.json({
    hfTokenPresent: !!token,
    venvInstalled: healthy,
    venvPath: venvPython,
    expectedVenvPath: FLUX2_VENV_DEFAULT,
    licenseUrl: 'https://huggingface.co/black-forest-labs/FLUX.2-klein-4B',
  });
}));

// Generic HF-token presence check for legacy mflux runners that don't need
// the FLUX.2 venv. Any model entry with `requiresHfToken: true` in
// data/media-models.json drives the banner through this endpoint.
router.get('/setup/hf-token-status', asyncHandler(async (_req, res) => {
  const { token, source } = await getHfTokenInfo();
  res.json({ hfTokenPresent: !!token, source });
}));

// Save the HF token from the inline form on the Image Gen page. settings.json
// is the canonical location (single-user app behind Tailscale — see CLAUDE.md).
// Same endpoint serves FLUX.2 and legacy mflux gated models — the token is
// global (HF_TOKEN env in spawn).
const hfTokenSchema = z.object({
  token: z.string().regex(HF_TOKEN_REGEX, 'Token must look like `hf_…`').max(200),
});
router.post('/setup/hf-token', asyncHandler(async (req, res) => {
  const { token } = validateRequest(hfTokenSchema, req.body || {});
  const settings = await getSettings();
  await saveSettings({
    ...settings,
    imageGen: { ...(settings.imageGen || {}), hfToken: token.trim() },
  });
  res.json({ ok: true, hfTokenPresent: true, source: 'stored' });
}));

// Clear the stored HF token. Falls back to env / CLI tokens if present —
// callers should re-fetch /setup/hf-token-status to see the post-clear state.
router.delete('/setup/hf-token', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  const { hfToken: _drop, ...restImageGen } = settings.imageGen || {};
  await saveSettings({ ...settings, imageGen: restImageGen });
  const { token, source } = await getHfTokenInfo();
  res.json({ ok: true, hfTokenPresent: !!token, source });
}));

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
