import { getRunwayModelCatalog } from '../services/runwayModelCatalog.js';
import { getFalImageModelCatalog } from '../services/falImageModelCatalog.js';
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

import { createImageGalleryHandlers } from './imageGalleryRead.js';
import { Router } from 'express';
import { z } from 'zod';
import { fableLoomMultipartUnsupported } from '../services/imageGen/fableLoomParams.js';
import { asyncHandler, ServerError, failValidation } from '../lib/errorHandler.js';
import { validateRequest } from '../lib/validateRequest.js';
import { optionalUploadFields, optionalUpload } from '../lib/multipart.js';
import * as imageGen from '../services/imageGen/index.js';
import { local, IMAGE_GEN_MODE, IMAGE_GEN_MODES } from '../services/imageGen/index.js';
import setupRouter, { streamMossAction } from './imageGenSetup.js';
import { usesMossSwift } from '../lib/imageRuntimeRemedies.js';
import { downloadMossWeights, mossModelCacheStatus, verifyMossWeights, repairMossWeights } from '../services/imageGen/mossWeights.js';
import { attachSseClient as attachQueueSseClient, cancelJob, listJobs, laneConcurrencyFor } from '../services/mediaJobQueue/index.js';
import { mediaJobExecutionLane } from '../lib/generationModes.js';
import { getImageModels, requiredRepoSpecsForModel, imageModelDownloadTargets } from '../lib/mediaModels.js';
import {
  inspectModelCache, verifyModelCache, repairModelCache, aggregateVerifies, verifyCachedRepoFiles, repairCachedRepoFiles,
} from '../lib/hfCache.js';
import { startHfDownloadStream } from '../services/hfDownloadStream.js';
import { PATHS, ensureDir, resolveGalleryImage, unlinkGuarded, copyFileGuarded } from '../lib/fileUtils.js';
import { applyImageClean, applyWatermarkRemoval, applyLightRegenVariant } from '../services/imageGen/variants.js';
import { applyFilmLookBake, readFilmLookSource } from '../services/imageGen/filmLookBake.js';
import { previewImagePrompt } from '../services/imageGen/promptPreview.js';
import { join, basename } from 'node:path';
import { STYLE_PRESETS } from '../lib/writersRoomStylePresets.js';
import {
  resolveRegenBackend, getRegenAvailability, readImageDimensions, buildRegenParams,
  resolveRegenStrengthDefault, REGEN_ANNOTATED_STRENGTH_DEFAULT,
} from '../services/imageGen/regen.js';
import { getSketchPngPath, isValidKey as isValidSketchKey } from '../services/mediaSketches.js';
import { itemKey } from '../lib/mediaItemKey.js';
import { deleteMediaAnywhere, cancelPendingDelete } from '../services/mediaRemoteDelete.js';
import { assertMediaDeletable } from '../services/mediaUsage.js';
import * as characterService from '../services/character.js';
import { randomUUID } from 'crypto';
import { getSettings } from '../services/settings.js';
import { deleteImageHostedCopy } from '../services/hostedRenderRemoteDelete.js';
import {
  hostedProviderParamSchema, mediaDeleteQuerySchema, modelDownloadQuerySchema, modelDownloadParamsSchema,
  imageCancelBodySchema, imageVisibilityBodySchema
} from '../lib/mediaGenerationValidation.js';
import {
  REFERENCE_IMAGE_FIELDS,
  avatarSchema,
  coerceFormFields,
  filmLookBakeSchema,
  generateSchema,
  promptPreviewSchema,
  regenAvailabilityQuerySchema,
  regenerateSchema,
  removeWatermarkSchema,
  statusQuerySchema,
  updatePromptSchema,
  uploadImageSchema,
} from '../lib/imageGenValidation.js';
import { enqueueLoggedImage, executeImageGenerate, queuedImageResponse } from '../services/imageGen/submitJob.js';
const router = Router();

router.get('/runway-models', asyncHandler(async (_req, res) => {
  res.json(await getRunwayModelCatalog());
}));
router.post('/runway-models/refresh', asyncHandler(async (_req, res) => {
  res.json(await getRunwayModelCatalog({ refresh: true }));
}));
router.get('/fal-models', asyncHandler(async (_req, res) => {
  res.json(await getFalImageModelCatalog());
}));
router.post('/fal-models/refresh', asyncHandler(async (_req, res) => {
  res.json(await getFalImageModelCatalog({ refresh: true }));
}));

const routeSource = (req) => ({ route: `${req.baseUrl}${req.route?.path ?? ''}`, method: req.method });

router.get('/style-presets', (_req, res) => res.json(STYLE_PRESETS));

// JSON callers (SDAPI bridge, avatar route, the Imagine page's old payload
// shape) skip the parser entirely; FormData callers get req.file + string
// req.body that coerceFormFields() converts before Zod validation.
// Only the formats mflux can decode — keep this in sync with the extension
// allowlist below so the route never silently relabels (e.g. HEIC) bytes
// as ".png".
const ACCEPTED_INIT_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);
const _MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

// Multi-reference editing accepts up to 4 references on dedicated field names.
// The legacy single `initImage` upload (mflux i2i) stays on its own slot so a
// FLUX.2 multi-ref upload and an mflux i2i upload don't collide.
const IMAGE_UPLOAD_FIELDS = ['initImage', ...REFERENCE_IMAGE_FIELDS];

const imageGenUploads = optionalUploadFields(IMAGE_UPLOAD_FIELDS, {
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_INIT_IMAGE_MIME.has((file.mimetype || '').toLowerCase())),
});

// Film look (lib/filmLook.js) baked into a new copy of a gallery still — the
// same SVG filter the music-video preview and final render apply, rendered in
// the composition browser at the image's own size. Synchronous like Clean:
// writes a `_look-<preset>-<id>.png` variant + sidecar beside the untouched
// source, files it into the source's collections, and returns it.
router.post('/:filename/film-look', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename, { pngOnly: true });
  const { look } = validateRequest(filmLookBakeSchema, req.body ?? {});
  const { metadata: sourceMeta } = await local.readImageSidecar(filename);
  res.json(await applyFilmLookBake({ filename, sourceMeta, look }));
}));

router.get('/:filename/film-look-source', asyncHandler(async (req, res) => {
  const { filename, path } = await readFilmLookSource(req.params.filename);
  res.json({ filename, path });
}));

router.get('/status', asyncHandler(async (req, res) => {
  const query = validateRequest(statusQuerySchema, req.query);
  // Optional ?mode= override lets the Image Gen page probe a specific
  // backend (e.g. when the user flips the per-render chip to Codex but
  // hasn't saved Codex as the default yet). Express's default query
  // parser turns duplicated keys (?mode=local&mode=codex) into arrays,
  // so guard on string type before forwarding so `mode` always reaches
  // the dispatcher as `string | undefined`.
  const rawMode = query.mode;
  const mode = typeof rawMode === 'string' && IMAGE_GEN_MODES.includes(rawMode) ? rawMode : undefined;
  const rawModelId = query.modelId;
  const modelId = rawModelId || undefined;
  res.json(await imageGen.checkConnection({ mode, ...(modelId ? { modelId } : {}) }));
}));

router.get('/active', asyncHandler(async (_req, res) => {
  const activeJob = await imageGen.getActiveJob();
  const queueRunning = listJobs({ kind: 'image', status: 'running' }).map((job) => ({
    jobId: job.id,
    generationId: job.id,
    status: job.status,
    position: job.position,
    startedAt: job.startedAt || null,
    params: job.params,
  }));
  const serviceJobs = (await imageGen.getActiveJobs?.()) || [];
  const seen = new Set();
  const activeJobs = [];
  for (const j of [...queueRunning, ...serviceJobs]) {
    const id = j.jobId || j.generationId || j.id;
    if (id && !seen.has(id)) {
      seen.add(id);
      activeJobs.push(j);
    } else if (!id) {
      activeJobs.push(j);
    }
  }
  const sampleJob = queueRunning[0] || (activeJob ? { kind: 'image', params: activeJob } : null);
  const lane = sampleJob ? mediaJobExecutionLane({ kind: 'image', mode: sampleJob.params?.mode }) : 'gpu';
  const isLocal = lane === 'gpu';
  const limit = (typeof laneConcurrencyFor === 'function' && sampleJob) ? laneConcurrencyFor(sampleJob) : 1;

  res.json({
    activeJob,
    activeJobs: activeJobs.length > 0 ? activeJobs : (activeJob ? [activeJob] : []),
    limit,
    ...(isLocal ? { memoryGoverned: true, limitReason: 'memory-governed' } : {}),
  });
}));

router.get('/agy/models', asyncHandler(async (_req, res) => {
  const settings = await getSettings();
  res.json(await imageGen.agy.listModels({
    agyPath: settings.imageGen?.agy?.agyPath,
  }));
}));

// SynthID-defeat regen availability (issue #912). Drives whether the lightbox
// shows the "Regenerate" action — it's hardware-gated on a local FLUX runner.
// Optional `?filename=` (issue #2036): when the caller names a source image, its
// model is resolved from the sidecar and threaded into the backend pick so the
// reported `modelId` matches the exact model a regen of THAT image would run —
// the annotate re-render dialog must disclose the real model before the render.
router.get('/regen/availability', asyncHandler(async (req, res) => {
  const rawFilename = validateRequest(regenAvailabilityQuerySchema, req.query).filename;
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

router.post('/prompt-preview', asyncHandler(async (req, res) => {
  res.json(await previewImagePrompt(validateRequest(promptPreviewSchema, req.body ?? {})));
}));

router.post('/generate', imageGenUploads, asyncHandler(async (req, res) => {
  const uploadedTempPaths = Object.values(req.files || {}).map(file => file.path).filter(Boolean);
  try {
    if (typeof req.body?.fableLoom === 'string' && uploadedTempPaths.length) throw fableLoomMultipartUnsupported();
    const data = validateRequest(generateSchema, coerceFormFields(req.body));
    const rendered = await executeImageGenerate(data, req.files, { source: routeSource(req) });
    res.json(rendered.body);
  } finally {
    // Keep uploads alive until preparation/dispatch settles, even if the client
    // disconnects; validation and generation failures must clean them up too.
    await Promise.allSettled(uploadedTempPaths.map(path => unlinkGuarded(path)));
  }
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
router.post('/upload', optionalUpload('file'), asyncHandler(async (req, res) => {
  if (req.file) {
    try {
      return res.json(await local.saveUploadedGalleryImage(null, req.file.path));
    } finally {
      await unlinkGuarded(req.file.path).catch(() => {});
    }
  }
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
// A model pinned to exact files in aggregate repos is checked file by file at
// its pinned revision; a whole-repo inspection would call a partial snapshot of
// the repo's other layouts "cached".
const verifyPinnedTargets = (targets, deep = false) =>
  Promise.all(targets.map((t) => verifyCachedRepoFiles(t.repo, t.only, { deep, revision: t.revision })));

const imageModelCacheStatus = async (m) => {
  if (usesMossSwift(m)) return mossModelCacheStatus(m.id);
  const targets = imageModelDownloadTargets(m);
  if (targets) {
    const verifies = await verifyPinnedTargets(targets);
    const requiredRepos = targets.map((t) => t.repo);
    const cached = verifies.every((v) => v.status === 'ok');
    return {
      id: m.id, repo: requiredRepos[0], cached, requiredRepos,
      sizeBytes: verifies.reduce((sum, v) => sum + (v.sizeBytes || 0), 0),
      pendingRepos: requiredRepos.filter((_, i) => verifies[i].status !== 'ok'),
      integrity: cached ? aggregateVerifies(verifies) : null,
    };
  }
  const required = requiredRepoSpecsForModel(m);
  if (!required) return { id: m.id, repo: null, cached: null, sizeBytes: 0 };
  const inspections = await Promise.all(required.map(({ repo, revision }) => inspectModelCache(repo, { revision })));
  const cached = inspections.every((i) => i.cached);
  const sizeBytes = inspections.reduce((sum, i) => sum + (i.sizeBytes || 0), 0);
  const requiredRepos = required.map(({ repo }) => repo);
  const pendingRepos = requiredRepos.filter((_, i) => !inspections[i].cached);
  // Integrity is only meaningful for repos that finished downloading — run
  // the cheap structural check across every cached required repo and report
  // the worst result, so a corrupt aux encoder still surfaces a Repair state.
  const integrity = cached ? aggregateVerifies(await Promise.all(required.map(({ repo, revision }) => verifyModelCache(repo, { revision })))) : null;
  return { id: m.id, repo: requiredRepos[0], cached, sizeBytes, requiredRepos, pendingRepos, integrity };
};

router.get('/models/status', asyncHandler(async (_req, res) => {
  res.json(await Promise.all(getImageModels().map(imageModelCacheStatus)));
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
    if (usesMossSwift(m)) return { id: m.id, ...aggregateVerifies([await verifyMossWeights({ deep })]) };
    const targets = imageModelDownloadTargets(m);
    if (targets) return { id: m.id, ...(aggregateVerifies(await verifyPinnedTargets(targets, deep)) || { status: 'missing', checkedDeep: deep, badFiles: [] }) };
    const required = requiredRepoSpecsForModel(m) || [];
    const verifies = await Promise.all(required.map(({ repo, revision }) => verifyModelCache(repo, { deep, revision })));
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
  if (usesMossSwift(model)) return res.json(await repairMossWeights({ deep }));
  const targets = imageModelDownloadTargets(model);
  if (targets) {
    const repaired = await Promise.all(targets.map((t) => repairCachedRepoFiles(t.repo, t.only, { deep, revision: t.revision })));
    const deleted = repaired.flatMap((r, i) => (r.deleted || []).map((name) => ({ repo: targets[i].repo, name })));
    return res.json({ deep, deleted, repos: targets.map((t) => t.repo) });
  }
  const required = requiredRepoSpecsForModel(model);
  if (!required) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file.`, { status: 400, code: 'NO_REPO_FOR_MODEL' });
  }
  const repaired = await Promise.all(required.map(({ repo, revision }) => repairModelCache(repo, { deep, revision })));
  const deleted = repaired.flatMap((r) => r.deleted.map((name) => ({ repo: r.repoId, name })));
  res.json({ deep, deleted, repos: required.map(({ repo }) => repo) });
}));

// SSE-driven model download. Cancels the python child if the client
// disconnects mid-download; cross-route in-flight dedupe lives in
// startHfDownloadStream so a FLUX repo shared with video gen can't spawn
// two concurrent children.
const downloadableImageModel = (req) => {
  const { modelId } = validateRequest(modelDownloadParamsSchema, req.params);
  const model = getImageModels().find((m) => m.id === modelId);
  if (!model) throw new ServerError(`Unknown model id: ${modelId}`, { status: 404, code: 'UNKNOWN_MODEL' });
  return model;
};

router.get('/models/:modelId/download', asyncHandler(async (req, res) => {
  validateRequest(modelDownloadQuerySchema, req.query);
  res.json(await imageModelCacheStatus(downloadableImageModel(req)));
}));

router.post('/models/:modelId/download', asyncHandler(async (req, res) => {
  const { force } = validateRequest(modelDownloadQuerySchema, req.query);
  const model = downloadableImageModel(req);
  if (usesMossSwift(model)) return streamMossAction(req, res, downloadMossWeights);
  const repos = imageModelDownloadTargets(model) || requiredRepoSpecsForModel(model);
  if (!repos) {
    throw new ServerError(`Model "${model.id}" has no HuggingFace repo on file — cannot pre-download.`, {
      status: 400,
      code: 'NO_REPO_FOR_MODEL',
    });
  }
  // Sequentially fetch the required snapshots. SSE events carry `repo` so the
  // client can show per-repo progress. `?force=1` (repair-initiated) re-fetches
  // even when the repo still looks cached, so a deleted shard isn't skipped.
  await startHfDownloadStream({ req, res, repos, force });
}));

const galleryReads = createImageGalleryHandlers(local.listGallery);
router.get('/gallery/collections', galleryReads.collections);
router.get('/gallery/facets', galleryReads.facets);
router.post('/gallery/lookup', galleryReads.lookup);
router.get('/gallery', galleryReads.list);

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
  //   2. Explicit body.jobId — cancel exactly that job and NOTHING else. An id
  //      that is unknown (404) or already terminal (409) never falls through
  //      to another job or a bulk cancel (#9932). A malformed id is a 400.
  //   3. No jobId — cancel the newest queued/running local image job (most
  //      recent activity wins, matching the user's last "submit" gesture).
  //   4. No queue match — fall through to the codex-mode cancel.
  const { jobId: requestedJobId, all } = validateRequest(imageCancelBodySchema, req.body ?? {});
  const imageJobs = listJobs({ kind: 'image' });
  const cancellable = imageJobs.filter((j) => j.status === 'queued' || j.status === 'running');
  if (all === true) {
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
    const known = imageJobs.find((j) => j.id === requestedJobId);
    if (known) {
      if (!cancellable.includes(known)) {
        throw new ServerError(`Job already ${known.status}`, { status: 409, code: 'ALREADY_TERMINAL' });
      }
      const result = await cancelJob(known.id);
      if (!result?.ok && result?.code) {
        throw new ServerError(result.error || 'Cancel failed', { status: result.code === 'ALREADY_TERMINAL' ? 409 : 404, code: result.code });
      }
      return res.json(result);
    }
    // Not in the queue — it may be a legacy provider job (sync codex/grok/agy/
    // fal, local) the dispatcher owns. Exact-ID only; never the bulk path.
    if (imageGen.cancelJob(requestedJobId)) return res.json({ ok: true });
    throw new ServerError('Job not found or expired', { status: 404 });
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

// Deletes on the machine that owns the image (services/mediaRemoteDelete.js):
// `{ ok, status: 'deleted' | 'deleted-remote' | 'pending' | 'owner-unknown' | 'cancelled' }`.
// A local delete also purges the filename from universe canon (entry `imageRefs`
// and style references) inside the same backup admission as the file removal.
router.delete('/:filename', asyncHandler(async (req, res) => {
  local.assertGalleryFilename(req.params.filename);
  const { force } = validateRequest(mediaDeleteQuerySchema, req.query ?? {});
  await assertMediaDeletable(`image:${req.params.filename}`, { force: force === '1' });
  res.json({ ok: true, ...(await deleteMediaAnywhere('image', req.params.filename)) });
}));

// Runs the provider's delete for a finished render (Runway: the rendered asset; fal.ai: stored payloads and output files);
// the local image and sidecar stay, stamped with when the hosted copy was deleted.
router.delete('/:filename/hosted/:provider', asyncHandler(async (req, res) => {
  local.assertGalleryFilename(req.params.filename);
  const provider = validateRequest(hostedProviderParamSchema, req.params.provider);
  res.json(await deleteImageHostedCopy(provider, req.params.filename));
}));

router.post('/:filename/cancel-delete', asyncHandler(async (req, res) => {
  local.assertGalleryFilename(req.params.filename);
  res.json(await cancelPendingDelete('image', req.params.filename));
}));

// Variant set for ONE image, for the lightbox original-vs-cleaned toggle —
// see listImageVariants for why no host list can answer it.
router.get('/:filename/variants', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename);
  const { listImageVariants } = await import('../services/mediaAssetIndex/gallery.js');
  res.json({ items: await listImageVariants(filename, local.listGallery) });
}));

router.post('/:filename/visibility', asyncHandler(async (req, res) => {
  res.json(await local.setImageHidden(req.params.filename, validateRequest(imageVisibilityBodySchema, req.body ?? {}).hidden));
}));

router.patch('/:filename/prompt', asyncHandler(async (req, res) => {
  const body = validateRequest(updatePromptSchema, req.body ?? {});
  res.json(await local.updateImagePrompt(req.params.filename, body.prompt));
}));

router.post('/:filename/clean', asyncHandler(async (req, res) => {
  const filename = req.params.filename;
  local.assertGalleryFilename(filename, { pngOnly: true });
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
  local.assertGalleryFilename(filename, { pngOnly: true });
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
  local.assertGalleryFilename(filename, { pngOnly: true });
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
    await copyFileGuarded(annotatedSketchPath, initImageAbsPath);
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
  const queued = await enqueueLoggedImage({ kind: 'image', params }, { source: routeSource(req) });
  const via = body.annotated ? 'annotation re-render' : 'Regenerating';
  console.log(`♻️ ${via} ${filename} via ${backend.model.id} (strength=${strength}) → job ${queued.jobId.slice(0, 8)}`);
  return res.json(queuedImageResponse({ ...queued, mode: IMAGE_GEN_MODE.LOCAL, model: backend.model.id }));
}));

// Local-mode setup automation (python probe/venv, FLUX.2 install/status,
// HF token store, pip installer) lives in its own router.
router.use("/setup", setupRouter);

export default router;
