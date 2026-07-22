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
import { unlink, copyFile } from 'fs/promises';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import {
  validateRequest, imageEdgeSchema, refineImagePixelCap, PIXEL_CAP_MESSAGE,
} from '../lib/validation.js';
import { optionalUploadFields } from '../lib/multipart.js';
import * as imageGen from '../services/imageGen/index.js';
import { local, IMAGE_GEN_MODE, IMAGE_GEN_MODES } from '../services/imageGen/index.js';
import { resolveCloudProviderConfig } from '../services/imageGen/cloudProviderConfig.js';
import setupRouter from './imageGenSetup.js';
import { enqueueJob, attachSseClient as attachQueueSseClient, cancelJob, listJobs } from '../services/mediaJobQueue/index.js';
import { getImageModels, isFlux2, isEditOnly, repoForModel, requiredReposForModel } from '../lib/mediaModels.js';
import { usesDiffusersRunner } from '../lib/runners.js';
import { inspectModelCache, verifyModelCache, repairModelCache, aggregateVerifies } from '../lib/hfCache.js';
import { startHfDownloadStream } from '../lib/sseDownload.js';
import { PATHS, ensureDir, resolveGalleryImage } from '../lib/fileUtils.js';
import { prepareGenerateParams } from '../services/imageGen/prepareParams.js';
import { applyImageClean, applyWatermarkRemoval, applyLightRegenVariant } from '../services/imageGen/variants.js';
import { join, basename } from 'node:path';
import { STYLE_PRESETS } from '../lib/writersRoomStylePresets.js';
import {
  resolveRegenBackend, getRegenAvailability, readImageDimensions, buildRegenParams,
  REGEN_STRENGTH_MIN, REGEN_STRENGTH_MAX,
  resolveRegenStrengthDefault, REGEN_ANNOTATED_STRENGTH_DEFAULT,
} from '../services/imageGen/regen.js';
import { getSketchPngPath, isValidKey as isValidSketchKey } from '../services/mediaSketches.js';
import { itemKey } from '../lib/mediaItemKey.js';
import { purgeImageRefFromAllUniverses } from '../services/universeCanon.js';
import { findOrCreateUniverseCollection } from '../services/mediaCollections.js';
import * as characterService from '../services/character.js';
import { randomUUID } from 'crypto';
import { buildUniverseRunTag } from '../services/universeRunTag.js';

const router = Router();

// Shared validation limits. MAX_REFERENCE_IMAGES must stay in sync with the
// number of `referenceImageN` upload field names below.
const MAX_PROMPT_LENGTH = 8000;
const MAX_LORAS = 8;
const MAX_REFERENCE_IMAGES = 4;
const MAX_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;

router.get('/style-presets', (_req, res) => res.json(STYLE_PRESETS));

const generateSchema = z.object({
  // Empty prompt allowed — i2i / edit / unconditional generation don't require
  // one. The multipart FormData builder drops empty-string fields, so an empty
  // prompt arrives as `undefined`; default it to '' rather than rejecting.
  prompt: z.string().max(MAX_PROMPT_LENGTH).optional().default(''),
  negativePrompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
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
  loraFilenames: z.array(z.string().max(256).regex(/^[^/\\]+$/, 'lora filename must not contain path separators')).max(MAX_LORAS).optional(),
  loraPaths: z.array(z.string().max(512)).max(MAX_LORAS).optional(),
  loraScales: z.array(z.number().min(0).max(2)).max(MAX_LORAS).optional(),
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
  referenceStrengths: z.array(z.number().min(0).max(1)).max(MAX_REFERENCE_IMAGES).optional(),
  // Per-render override of the cleaners. When omitted, the route inherits
  // from `settings.imageGen.{mode}.{cleanC2PA,denoise}`. Explicit booleans
  // here force the value for this one render. Legacy `autoClean` is still
  // accepted (mapped to both flags) so older clients keep working through
  // the deprecation window.
  cleanC2PA: z.boolean().optional(),
  denoise: z.boolean().optional(),
  autoClean: z.boolean().optional(),
  // Optional universe-collection target. When present, the route resolves the
  // universe's media collection server-side and tags the queued job so
  // `universeBuilderCollectionHook` files the finished render into that
  // collection — the same auto-filing path batch renders and character
  // reference sheets use. The client passes only the universe identity (never
  // a collectionId — that's server-resolved), so the front-end does no
  // collection bookkeeping. The base-style probe (StyleProbeImage) and the
  // Universe canon section-local renders (#1395) are the callers; JSON-only
  // (the multipart ImageGen page never sends it).
  universeRun: z.object({
    universeId: z.string().min(1).max(200),
    universeName: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
    category: z.string().max(64).optional(),
    // Section-local canon renders (#1395) tag the target entry so the
    // completion hook durably appends the render to its `imageRefs[]` even
    // after the originating page unmounts — converging these renders onto the
    // same durable path batch renders use. Shape mirrors the batch path's
    // entryRef (server/services/universeBuilder.js `ENTRY_REF_KIND`).
    entryRef: z.object({
      kind: z.enum(['canon', 'variation', 'sheet']),
      kindKey: z.string().min(1).max(64).optional(),
      categoryKey: z.string().min(1).max(64).optional(),
      id: z.string().min(1).max(200),
    }).refine(
      // Each kind needs its locating key, else appendEntryImageRef silently
      // no-ops: canon→kindKey, variation→categoryKey (sheet needs neither).
      (r) => (r.kind === 'canon' ? !!r.kindKey : r.kind === 'variation' ? !!r.categoryKey : true),
      { message: 'entryRef requires its locating key (canon→kindKey, variation→categoryKey)' },
    ).optional(),
  }).optional(),
  // Writers-Room storyboard scene render (#1363). When present, the mediaJobQueue
  // completion hook (`writersRoomSceneImageHook`) files the finished render onto
  // the analysis snapshot's `sceneImages[sceneId]` AND mirrors it into the work's
  // auto-collection — durably, even if the editor unmounted mid-render (the
  // "navigated away → image never attached" failure mode the synchronous attach
  // suffered). Only the async local/Codex lanes ride the queue this hook listens
  // to; the synchronous external SD-API lane still attaches via the scene-image
  // route. The scene prompt is read from the job's own `prompt` param, so the tag
  // carries only the destination identity. JSON-only (the multipart ImageGen page
  // never sends it).
  writersRoom: z.object({
    workId: z.string().min(1).max(200),
    analysisId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
  }).optional(),
  // Music Video scene reference-frame render (#1760 Phase 1b). When present, the
  // mediaJobQueue completion hook (`musicVideoSceneImageHook`) files the finished
  // render onto the project scene's `referenceImageId` — durably, even if the
  // director board unmounted mid-render. Only the async local/Codex lanes ride
  // the queue this hook listens to; the synchronous external SD-API lane returns
  // the filename inline and the client PATCHes `referenceImageId` directly. Rides
  // into job.params untouched via `...params` (like `writersRoom`). JSON-only.
  musicVideo: z.object({
    projectId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
  }).optional(),
  // Durable catalog attach (#1359). When present, the mediaJobQueue completion
  // hook (catalogImageAttachHook) files the finished render onto this catalog
  // ingredient even if the page that started the render has since unmounted —
  // so a long queued local/Codex render is no longer lost to navigation.
  // `catalogMediaKind` forces portrait/reference; omitted = auto (first image →
  // portrait, later → reference, mirroring the client's optimistic path). Only
  // the async (local/codex) lanes need this — the synchronous external SD-API
  // path returns the filename to the client, which attaches it directly.
  catalogIngredientId: z.string().min(1).max(200).optional(),
  catalogMediaKind: z.enum(['portrait', 'reference']).optional(),
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
const REFERENCE_IMAGE_FIELDS = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => `referenceImage${i + 1}`);
const IMAGE_UPLOAD_FIELDS = ['initImage', ...REFERENCE_IMAGE_FIELDS];

const imageGenUploads = optionalUploadFields(IMAGE_UPLOAD_FIELDS, {
  limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES },
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
  // LoRA fields are repeated multipart keys (one per selected LoRA). A SINGLE
  // selected LoRA arrives as a bare string, not a one-element array — wrap it
  // so Zod's `z.array(...)` accepts it. `loraScales` numbers also arrive as
  // strings, so coerce element-wise like referenceStrengths above.
  for (const f of ['loraFilenames', 'loraPaths']) {
    if (body[f] != null && !Array.isArray(body[f])) body[f] = [body[f]];
  }
  if (body.loraScales != null) {
    const raw = Array.isArray(body.loraScales) ? body.loraScales : [body.loraScales];
    body.loraScales = raw.map((v) => (typeof v === 'string' && v !== '' ? Number(v) : v));
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
  // When set, the route persists the rendered path onto the singleton
  // character record itself (the character store has no id), so the client
  // skips the follow-up PUT /api/character round-trip.
  persistToCharacter: z.boolean().optional(),
});

// Upload a user-supplied image straight into the gallery (`data/images/`) so it
// rides the existing `image` peer-sync asset path. `data` is base64 (no data:
// URI prefix); the real format is sniffed server-side, so the schema only caps
// the encoded string length (~16MB decoded ≈ 21.8M base64 chars).
const uploadImageSchema = z.object({
  data: z.string().min(1).max(24 * 1024 * 1024),
});

// SynthID-defeat regen (issue #912). Body is optional — every field defaults
// server-side (strength → DEFAULT_REGEN_STRENGTH, steps → the model default,
// prompt → empty for minimal mutation). An empty/whitespace `prompt` is treated
// as "no prompt" by buildRegenParams, so the UI can send '' for the default.
const regenerateSchema = z.object({
  strength: z.number().min(REGEN_STRENGTH_MIN).max(REGEN_STRENGTH_MAX).optional(),
  steps: z.number().int().min(1).max(50).optional(),
  prompt: z.string().max(MAX_PROMPT_LENGTH).optional(),
  // 'flux' (default) = GPU img2img round-trip; 'light' = CPU-only spatial pass
  // for installs without a FLUX runner (strength/steps/prompt ignored).
  method: z.enum(['flux', 'light']).optional(),
  // Annotation re-render (issue #2036 phase 2): seed the img2img init image from
  // the saved flattened sketch (source + drawn strokes) instead of the raw
  // gallery file, so the marks reshape the render. GPU-only (light ignores the
  // init image); defaults to a higher denoise so the strokes take effect.
  annotated: z.boolean().optional(),
});

// Visible-watermark removal — erases the Gemini / Nano-Banana bottom-right ✦.
// Body is optional: with no fields the corner box is auto-sized to the
// sparkle's typical footprint. `size` overrides the square side; `region`
// pins an explicit box (each field clamped server-side into the image) for
// off-spec placements. All ints in pixels.
const removeWatermarkSchema = z.object({
  size: z.number().int().min(1).max(4096).optional(),
  region: z.object({
    x: z.number().int().min(0).max(100000).optional(),
    y: z.number().int().min(0).max(100000).optional(),
    w: z.number().int().min(1).max(4096).optional(),
    h: z.number().int().min(1).max(4096).optional(),
  }).optional(),
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

// SynthID-defeat regen availability (issue #912). Drives whether the lightbox
// shows the "Regenerate" action — it's hardware-gated on a local FLUX runner.
// Optional `?filename=` (issue #2036): when the caller names a source image, its
// model is resolved from the sidecar and threaded into the backend pick so the
// reported `modelId` matches the exact model a regen of THAT image would run —
// the annotate re-render dialog must disclose the real model before the render.
router.get('/regen/availability', asyncHandler(async (req, res) => {
  const rawFilename = req.query.filename;
  const galleryPath = typeof rawFilename === 'string' && rawFilename ? resolveGalleryImage(rawFilename) : null;
  let sourceModelId;
  if (galleryPath) {
    // Read the sidecar by the RESOLVED gallery path's basename, never the raw
    // query value: resolveGalleryImage only validated the basename, so a
    // `../foo.png` input could otherwise traverse out of PATHS.images in the
    // sidecar read. basename(galleryPath) is the sanitized filename.
    const { metadata } = await local.readImageSidecar(basename(galleryPath));
    sourceModelId = metadata?.modelId;
  }
  res.json(await getRegenAvailability({ sourceModelId }));
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
  const { data: params, mode, settings, uploadedTempPaths } = await prepareGenerateParams({
    data,
    files: req.files,
    referenceImageFields: REFERENCE_IMAGE_FIELDS,
  });

  // Resolve an optional universe-collection target into a job tag the
  // completion hook understands. Done server-side so a base-style probe lands
  // in the same "Universe: <name>" bucket as batch renders without the
  // front-end doing any collection bookkeeping. Best-effort: a provisioning
  // failure drops the tag and the render still proceeds (it just won't
  // auto-file) rather than failing the user's generation over a side-effect.
  if (params.universeRun?.universeId) {
    const { universeId, universeName, label, category, entryRef } = params.universeRun;
    // The helper provisions the universe collection (best-effort) and assembles
    // the tag. It preserves `entryRef` even when provisioning fails — the
    // durable `imageRefs[]` append (#1395) must not depend on the gallery
    // collection existing — and returns `undefined` (dropping the tag) only
    // when there's nothing left to do (no collection AND no entryRef).
    params.universeRun = await buildUniverseRunTag({
      universeId,
      universeName,
      label,
      category,
      entryRef,
      errorContext: 'image-gen → universe collection provision failed',
    });
  }

  // Collapse the catalog-attach params into a single job tag the completion
  // hook understands (#1359). Folded into `params` so it rides into both the
  // local and codex `enqueueJob` branches below via `...params`; the raw fields
  // are dropped so persisted job.params carries only the canonical tag.
  if (params.catalogIngredientId) {
    params.catalogAttach = {
      ingredientId: params.catalogIngredientId,
      ...(params.catalogMediaKind ? { kind: params.catalogMediaKind } : {}),
    };
  }
  delete params.catalogIngredientId;
  delete params.catalogMediaKind;

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
  const cloud = resolveCloudProviderConfig(settings, mode);
  if (cloud) {
    // Reject up-front rather than enqueueing a doomed job — the cloud CLIs are
    // gated behind an explicit toggle each (not every Codex account has access
    // to the image_gen tool, and grok spends the user's Grok quota).
    if (!cloud.enabled) throw cloud.disabledError;
    // `mode` inside jobParams is the queue's discriminator — laneForJob()
    // routes cloud jobs to the parallel cloud lane, and runJob's image branch
    // dispatches to the matching imageGen provider module when it sees it.
    // `cloud.modelId` is the *effective* model so the response metadata reports
    // what actually renders (gpt-5.6-luna by default) instead of "codex"/null.
    const queued = enqueueJob({ kind: 'image', params: { ...cloud.jobParams, ...params } });
    return res.json(queuedImageResponse({ ...queued, mode, model: cloud.modelId }));
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
    if (params.modelId && !allModels.some((m) => m.id === params.modelId)) {
      throw new ServerError(
        `Unknown modelId: ${params.modelId}`,
        { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' },
      );
    }
    const selectedModel = allModels.find((m) => m.id === params.modelId)
      ?? allModels.find((m) => m.id === 'dev')
      ?? allModels[0];
    // Edit-only models (Qwen-Image-Edit) load a pipeline that REQUIRES a
    // source image. Reject a text-only submission up-front rather than
    // enqueueing a job that crashes deep inside diffusers. `params.initImagePath`
    // is already populated above from either an uploaded `initImage` or a
    // gallery `initImageFile`.
    if (isEditOnly(selectedModel) && !params.initImagePath) {
      throw new ServerError(
        `${selectedModel.name || selectedModel.id} is an image-edit model — it requires a source image. Upload an init image to use it.`,
        { status: 400, code: 'IMAGE_GEN_EDIT_IMAGE_REQUIRED' },
      );
    }
    if (selectedModel && !isFlux2(selectedModel) && !usesDiffusersRunner(selectedModel) && !py) {
      throw new ServerError(
        'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
        { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
      );
    }
    const queued = enqueueJob({
      kind: 'image',
      params: { pythonPath: py, ...params },
    });
    // Resolve the effective model the same way the validation block above
    // does so the response reflects the actual fallback chain (caller
    // modelId → 'dev' → allModels[0]) rather than just the requested id.
    return res.json(queuedImageResponse({
      ...queued,
      mode: IMAGE_GEN_MODE.LOCAL,
      model: selectedModel?.id || params.modelId || 'dev',
    }));
  }
  res.json(await imageGen.generateImage(params));
}));

router.post('/avatar', asyncHandler(async (req, res) => {
  const data = validateRequest(avatarSchema, req.body);
  const result = await imageGen.generateAvatar(data);
  // `result.path` is server-generated as `/data/images/<file>` (the same value
  // the client previously round-tripped through PUT /api/character), so it's
  // safe to persist directly without re-validating against the path regex.
  if (data.persistToCharacter && result?.path) {
    await characterService.setAvatar(result.path);
  }
  res.json(result);
}));

// Save an uploaded image into the gallery dir so callers (e.g. author
// headshots) get a `/data/images/<f>` URL that the peer-sync `image` asset
// path can transfer — unlike `/api/uploads/<f>`, which is not a pullable
// asset kind and 404s on a peer.
router.post('/upload', asyncHandler(async (req, res) => {
  const { data } = validateRequest(uploadImageSchema, req.body);
  res.json(await local.saveUploadedGalleryImage(data));
}));

// Local-only: list image models and LoRAs the local backend can use.
router.get('/models', (_req, res) => {
  res.json(local.listImageModels());
});

// Per-model download status. Returns `[{ id, repo, cached, sizeBytes }]` so
// the form can show an inline "Available" or "Download" badge next to the
// model picker — without waiting until a render to discover a multi-GB HF
// download. Models without a known HF repo (typically third-party custom
// entries with `runner: 'mflux'` and a non-default name) report
// `cached: null` so the UI can render "unknown" rather than a misleading
// "not downloaded" state. Lazy generation still works regardless of badge.
router.get('/models/status', asyncHandler(async (_req, res) => {
  const statuses = await Promise.all(getImageModels().map(async (m) => {
    const required = requiredReposForModel(m);
    if (!required) return { id: m.id, repo: null, cached: null, sizeBytes: 0 };
    // Inspect every required repo (main + any aux text encoders). The badge
    // is `cached: true` only when ALL are cached; sizeBytes is the sum. The
    // `pendingRepos` field lets the UI explain WHICH repos still need a pull
    // so the user isn't surprised when clicking "Download" triggers >1 fetch.
    const inspections = await Promise.all(required.map((r) => inspectModelCache(r)));
    const cached = inspections.every((i) => i.cached);
    const sizeBytes = inspections.reduce((sum, i) => sum + (i.sizeBytes || 0), 0);
    const pendingRepos = required.filter((_, i) => !inspections[i].cached);
    // Integrity is only meaningful for repos that finished downloading — run
    // the cheap structural check across every cached required repo and report
    // the worst result, so a corrupt aux encoder still surfaces a Repair state.
    const integrity = cached ? aggregateVerifies(await Promise.all(required.map((r) => verifyModelCache(r)))) : null;
    return { id: m.id, repo: required[0], cached, sizeBytes, requiredRepos: required, pendingRepos, integrity };
  }));
  res.json(statuses);
}));

// POST /models/verify — on-demand integrity re-scan. `deep:true` adds the
// per-file sha256 comparison on top of the structural check. With no `modelId`
// it scans every model.
const verifyImageBodySchema = z.object({
  modelId: z.string().min(1).optional(),
  deep: z.boolean().optional(),
});
router.post('/models/verify', asyncHandler(async (req, res) => {
  const parsed = verifyImageBodySchema.safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const { modelId, deep = false } = parsed.data;
  const models = getImageModels().filter((m) => (modelId ? m.id === modelId : true));
  if (modelId && models.length === 0) {
    throw new ServerError(`Unknown model id: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  }
  const results = await Promise.all(models.map(async (m) => {
    const required = requiredReposForModel(m) || [];
    const verifies = await Promise.all(required.map((r) => verifyModelCache(r, { deep })));
    return { id: m.id, ...(aggregateVerifies(verifies) || { status: 'missing', checkedDeep: deep, badFiles: [] }) };
  }));
  res.json({ deep, models: results });
}));

// POST /models/:modelId/repair — delete the flagged weight files across the
// model's required repos so the existing resumable HF fetch path re-downloads
// them. Returns the deleted-file list; the client then re-triggers the normal
// download SSE to pull clean copies with progress.
router.post('/models/:modelId/repair', asyncHandler(async (req, res) => {
  const model = getImageModels().find((m) => m.id === req.params.modelId);
  if (!model) throw new ServerError(`Unknown model id: ${req.params.modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  const parsed = z.object({ deep: z.boolean().optional() }).safeParse(req.body || {});
  if (!parsed.success) failValidation(parsed);
  const deep = parsed.data.deep || false;
  const required = requiredReposForModel(model);
  if (!required) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  }
  const repaired = await Promise.all(required.map((repo) => repairModelCache(repo, { deep })));
  const deleted = repaired.flatMap((r) => r.deleted.map((name) => ({ repo: r.repoId, name })));
  res.json({ deep, deleted, repos: required });
}));

// SSE-driven model download. Cancels the python child if the client
// disconnects mid-download; cross-route in-flight dedupe lives in
// startHfDownloadStream so a FLUX repo shared with video gen can't spawn
// two concurrent children.
router.get('/models/:modelId/download', asyncHandler(async (req, res) => {
  const model = getImageModels().find((m) => m.id === req.params.modelId);
  if (!model) {
    throw new ServerError(`Unknown model id: ${req.params.modelId}`, { status: 404 });
  }
  const repos = requiredReposForModel(model);
  if (!repos) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file — cannot pre-download.`, {
      status: 400,
      code: 'NO_REPO_FOR_MODEL',
    });
  }
  // Sequentially fetch every required repo (main + aux text encoders for
  // HiDream). The SSE stream tags each event with `repo` so the client can
  // show per-repo progress / log lines. `?force=1` (repair-initiated) re-fetches
  // even when the repo still looks cached, so a deleted shard isn't skipped.
  await startHfDownloadStream({ req, res, repos, force: req.query.force === '1' });
}));

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
  throw new ServerError('Job not found or expired', { status: 404 });
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
  const { metadata: sourceMeta } = await local.readImageSidecar(filename);
  res.json(await applyImageClean({ filename, sourceMeta }));
}));

// Visible-watermark removal — erases the Gemini / Nano-Banana bottom-right ✦.
// Unlike SynthID regen (which round-trips the WHOLE image to overwrite an
// invisible per-pixel signal), this localizes the corner logo and reconstructs
// only that box via a dependency-free harmonic inpaint — so it's a CPU-only
// sharp pass that runs on every install, GPU or not, and leaves the rest of the
// image byte-faithful. Synchronous like Clean: writes a `_nowatermark.png`
// variant + sidecar, files it into the source's collections, and returns it.
router.post('/:filename/remove-watermark', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename);
  const body = validateRequest(removeWatermarkSchema, req.body || {});
  const { metadata: sourceMeta } = await local.readImageSidecar(filename);
  res.json(await applyWatermarkRemoval({ filename, sourceMeta, size: body.size, region: body.region }));
}));

// SynthID-defeat regeneration (issue #912). Round-trips an existing gallery
// image through local FLUX img2img at low–moderate denoise so the per-pixel
// watermark is overwritten by fresh sampling — the only honest defeat path
// (the lossless clean above can't touch SynthID). Post-hoc + history-only:
// enqueues a normal local image job (GPU lane) using the source's own prompt;
// the new render lands in the gallery as a variant of the source. Hardware-
// gated — 400s with an actionable message when no local FLUX runner exists.
router.post('/:filename/regenerate', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename);
  const body = validateRequest(regenerateSchema, req.body || {});

  const sourceAbsPath = resolveGalleryImage(filename);
  if (!sourceAbsPath) {
    throw new ServerError('Image not found', { status: 404, code: 'NOT_FOUND' });
  }

  // Annotation re-render (issue #2036 phase 2): use the saved flattened sketch
  // (source + strokes) as the img2img init image. It's a whole-image denoise, so
  // the light spatial pass can't honor the marks — GPU only. Validate cheaply
  // here (no disk writes) so a bad request 400s without leaving anything behind;
  // the actual staging copy happens below, only once every gate has passed.
  let annotatedSketchPath = null;
  if (body.annotated) {
    if (body.method === 'light') {
      throw new ServerError('Annotation re-render needs the GPU img2img pass, not the light method.', { status: 400, code: 'VALIDATION_ERROR' });
    }
    const key = itemKey({ kind: 'image', ref: filename });
    if (!isValidSketchKey(key)) {
      throw new ServerError('Image cannot be annotated', { status: 400, code: 'VALIDATION_ERROR' });
    }
    annotatedSketchPath = await getSketchPngPath(key);
    if (!annotatedSketchPath) {
      throw new ServerError('No saved annotation to re-render — draw over the image and save first.', { status: 400, code: 'NO_ANNOTATION' });
    }
  }

  // Sidecar (for prompt/model) and the on-disk dimension probe have no data
  // dependency — overlap the two reads.
  const [{ metadata: sourceMeta }, sourceDims] = await Promise.all([
    local.readImageSidecar(filename),
    readImageDimensions(sourceAbsPath),
  ]);

  // CPU-only light path (no FLUX runner required). A best-effort spatial pass
  // for installs that can't run the GPU round-trip — synchronous like Clean:
  // it writes a `_regen-light.png` variant inline and returns it (no queue).
  if (body.method === 'light') {
    return res.json(await applyLightRegenVariant({ filename, sourceAbsPath, sourceMeta }));
  }

  const backend = await resolveRegenBackend({ sourceModelId: sourceMeta.modelId });
  if (!backend.available) {
    throw new ServerError(backend.reason, { status: 400, code: 'REGEN_BACKEND_UNAVAILABLE' });
  }

  // Stage the flattened annotation ONLY now that every gate has passed and the
  // job is about to enqueue — so a rejected request (unavailable backend, failed
  // read) never leaves an orphaned snapshot behind. The local runner re-validates
  // initImagePath against its approved image roots (gallery / image-refs /
  // visual-templates) and silently drops anything outside them — `data/media-
  // sketches/` is NOT one, so the sidecar is copied into the image-refs root the
  // runner accepts. The copy also freezes the markup at enqueue time (a later
  // re-save can't change what this queued job renders from), and the `init-<uuid>`
  // name (it IS this job's init image) lets imageRefsGc.js sweep it once
  // unreferenced.
  let initImageAbsPath = null;
  if (annotatedSketchPath) {
    await ensureDir(PATHS.imageRefs);
    initImageAbsPath = join(PATHS.imageRefs, `init-${randomUUID()}.png`);
    await copyFile(annotatedSketchPath, initImageAbsPath);
  }

  // Provider-aware default (issue #912): SynthID-bearing sources keep the
  // known-good 0.25; local FLUX sources use a lighter pass. An annotation
  // re-render instead defaults higher so the drawn marks reshape the render
  // (issue #2036). The explicit `strength` override always wins.
  const strength = body.strength
    ?? (body.annotated ? REGEN_ANNOTATED_STRENGTH_DEFAULT : resolveRegenStrengthDefault(sourceMeta));
  const params = buildRegenParams({
    filename,
    sourceAbsPath,
    sourceMeta,
    sourceDims,
    model: backend.model,
    pythonPath: backend.pythonPath,
    strength,
    steps: body.steps,
    promptOverride: body.prompt,
    initImageAbsPath,
    annotated: !!body.annotated,
  });
  const queued = enqueueJob({ kind: 'image', params });
  const via = body.annotated ? 'annotation re-render' : 'Regenerating';
  console.log(`♻️ ${via} ${filename} via ${backend.model.id} (strength=${strength}) → job ${queued.jobId.slice(0, 8)}`);
  return res.json(queuedImageResponse({ ...queued, mode: IMAGE_GEN_MODE.LOCAL, model: backend.model.id }));
}));

// Local-mode setup automation (python probe/venv, FLUX.2 install/status,
// HF token store, pip installer) lives in its own router.
router.use("/setup", setupRouter);

export default router;
