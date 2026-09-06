/**
 * prepareGenerateParams — pre-dispatch preparation for POST /image-gen/generate.
 *
 * Handles everything between Zod validation and the final dispatch branch:
 *   - resolve effective backend mode + per-render cleaners
 *   - gate input-image uploads to backends that can consume them, are enabled,
 *     and can take that many — all BEFORE anything is staged to disk
 *   - stage multer temp uploads into PATHS.images / PATHS.imageRefs
 *   - resolve initImagePath and referenceImagePaths from uploads or gallery filenames
 *   - enforce each cloud CLI's prompt requirement
 *
 * Returns:
 *   {
 *     data            - mutated validated body (gallery filenames/referenceStrengths
 *                       stripped; initImagePath/referenceImagePaths/Strengths added)
 *     mode            - resolved IMAGE_GEN_MODE string
 *     settings        - raw settings object (caller reuses for dispatch)
 *     uploadedTempPaths - multer temp paths to unlink after the response closes
 *   }
 *
 * On validation failure throws ServerError so the route's asyncHandler
 * middleware translates it to a 4xx response.
 */

import { randomUUID } from 'crypto';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, resolveGalleryImage, copyFileGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { getSettings } from '../settings.js';
import { IMAGE_GEN_MODE, resolveImageCleaners } from './index.js';
import { editIncapableModeError, isEditCapableMode, modeLabel } from './modes.js';
import {
  cloudPromptRequired, maxInputImages, resolveCloudProviderConfig, resolveRenderTargetConfig,
} from './cloudProviderConfig.js';
import { RENDER_TARGET, recordRenderPin } from '../../lib/renderTargets.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getUniverseRenderPin } from '../universeBuilder/crud.js';
import { getImageModels, isFlux2, isEditOnly } from '../../lib/mediaModels.js';
import { isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { usesDiffusersRunner } from '../../lib/runners.js';

// The job tags that name the record owning a render, each mapped to the record
// loader and the render target whose `renderDefaults` pin backs it. A generate
// request carrying one of these and NO explicit mode resolves its backend
// through that record's pin — see the ladder below. Ordered by priority; the
// first tag present on the request wins.
//
// `load` runs on every mode-less tagged render and only two scalars are read
// off it, so prefer a projected pin-only read over a full record load for any
// record big enough to care — a universe carries its whole canon plus a
// sanitize pass, hence `getUniverseRenderPin`. A music-video project is small,
// so it still uses the ordinary getter.
const RECORD_PIN_SOURCES = Object.freeze([
  {
    tag: 'musicVideo',
    idKey: 'projectId',
    target: RENDER_TARGET.MUSIC_VIDEO,
    load: getMusicVideoProject,
  },
  {
    tag: 'universeRun',
    idKey: 'universeId',
    target: RENDER_TARGET.UNIVERSE_BIBLE,
    load: getUniverseRenderPin,
  },
]);

// Only the formats mflux can decode — mirrors the route's MIME_TO_EXT map
// so the route never silently relabels (e.g. HEIC) bytes as ".png".
const MIME_TO_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

/**
 * Select the model a local render will actually use. An omitted model keeps
 * the historical `dev` preference only when that model can run on this host;
 * otherwise it falls through to the first compatible catalog entry.
 *
 * @param {string|null|undefined} modelId
 * @param {object[]} [allModels]
 * @returns {object|undefined}
 */
export function selectLocalImageModel(modelId, allModels = getImageModels()) {
  const requestedModel = allModels.find((model) => model.id === modelId);
  return requestedModel || [
    allModels.find((model) => model.id === 'dev'),
    ...allModels,
  ].filter(Boolean).find((model) => isHardwareCompatible(model.hardwareCompatibility)) || allModels[0];
}

/**
 * @param {object} opts
 * @param {object} opts.data    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.files   - req.files from multer (may be undefined)
 * @param {string[]} opts.referenceImageFields - field names for multi-ref slots
 * @returns {Promise<{ data, mode, settings, uploadedTempPaths }>}
 */
export async function prepareGenerateParams({ data, files, referenceImageFields }) {
  let initImagePath = null;
  const uploadedTempPaths = [];
  const initUpload = files?.initImage;
  const referenceImagePaths = [];
  const referenceImageStrengths = [];
  const namedReferenceFiles = Array.isArray(data.referenceImageFiles) ? data.referenceImageFiles : [];

  // Pair strengths by PACK position (post-filter), not slot position — the
  // client renumbers populated slots into `referenceImage1..N` and sends a
  // parallel `referenceStrengths` array sized N. A curl user could leave a
  // gap (`referenceImage2` + `referenceImage4` only); the strength at index 0
  // still pairs with the first surviving upload in slot order.
  const referenceUploads = referenceImageFields
    .map((field) => files?.[field])
    .filter(Boolean)
    .map((upload, packedIndex) => ({
      upload,
      strength: data.referenceStrengths?.[namedReferenceFiles.length + packedIndex],
    }));

  // Best-effort cleanup of every multer-staged file currently on `files`.
  // The multipart parser writes uploads to `os.tmpdir()` as they stream in,
  // so a 400 thrown from validation BEFORE we've registered the `res.on('close')`
  // sweep would otherwise leak those temp files. Call this from any pre-stage
  // throw site (the local-FLUX.2 gate, the edit-incapable-backend gate).
  const cleanupReqFilesTemp = () => {
    if (!files) return;
    for (const f of Object.values(files)) {
      if (f?.path) unlinkGuarded(f.path).catch(() => {});
    }
  };

  // Every file THIS request copied into PATHS.imageRefs. A throw AFTER staging
  // has to unlink these or they are orphaned forever: nothing downstream knows
  // they exist, and the route's `res.on('close')` sweep only covers multer
  // temps — it is wired from `uploadedTempPaths`, which a throw prevents
  // prepareGenerateParams from ever returning. Only staged COPIES go in here,
  // never a gallery path resolved by `resolveGalleryImage` (that's a real
  // gallery image the user still owns).
  const stagedRefPaths = [];
  const cleanupStagedAndTemp = () => {
    cleanupReqFilesTemp();
    for (const p of stagedRefPaths) unlinkGuarded(p).catch(() => {});
  };

  // Resolve the effective backend BEFORE staging reference uploads — an
  // `external` request that uploaded refs would otherwise stage files under
  // `PATHS.imageRefs` and write sidecar metadata claiming references were used,
  // while the actual generation silently ignored them. (Reading settings here
  // is cheap — it's already read again below for the per-mode dispatch.)
  const settings = await getSettings();
  let mode = data.mode || settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
  // #3231 Phase 4 — a render tagged with the record that owns it resolves
  // through the render-target ladder: that record's pin
  // (`imageMode`/`imageModelId`) → `renderDefaults[target]` → the install
  // default above. An explicit per-request mode wins outright (and blocks the
  // pinned model from leaking), so the record fetch is skipped entirely in that
  // case. The layered model is stamped onto `data.cloudModel` so the
  // route/dispatch resolution downstream picks it up; an explicit per-request
  // cloudModel wins untouched.
  //
  // First matching tag wins — a payload carrying two tags would otherwise let
  // whichever branch ran last silently overwrite the other's mode while
  // inheriting its model. Adding a surface is one row here, matching the
  // "one entry + one resolve call" contract in lib/renderTargets.js.
  const source = data.mode ? null : RECORD_PIN_SOURCES.find((s) => data[s.tag]?.[s.idKey]);
  if (source) {
    const record = await source.load(data[source.tag][source.idKey]).catch(() => null);
    const pin = recordRenderPin(record || {});
    const resolved = resolveRenderTargetConfig(settings, source.target, {
      model: data.cloudModel || null,
      recordMode: pin.mode,
      recordModel: pin.modelId,
      fallbackMode: IMAGE_GEN_MODE.EXTERNAL,
    });
    mode = resolved.mode;
    if (!data.cloudModel && resolved.cloud?.modelId) data.cloudModel = resolved.cloud.modelId;
  }
  // The render's input images, counted once: the init image (uploaded this
  // request or named by an earlier one) plus every reference slot. Every gate
  // below keys off these two, rather than respelling "carries input images"
  // per gate and having to keep the spellings in sync.
  const referenceImageCount = namedReferenceFiles.length + referenceUploads.length;
  const inputImageCount = (initUpload || data.initImageFile ? 1 : 0) + referenceImageCount;

  if (referenceImageCount > referenceImageFields.length) {
    cleanupReqFilesTemp();
    throw new ServerError(
      `Image generation accepts at most ${referenceImageFields.length} reference images; received ${referenceImageCount}`,
      { status: 400, code: 'TOO_MANY_REFERENCE_IMAGES' },
    );
  }

  if (!isEditCapableMode(mode) && inputImageCount) {
    cleanupReqFilesTemp();
    throw editIncapableModeError(mode);
  }

  // A disabled cloud CLI is rejected BEFORE anything is staged. The route
  // throws the same `disabledError` a few steps later, but by then the uploads
  // have been copied into PATHS.imageRefs and the route's `res.on('close')`
  // sweep only covers multer temps — so the staged copies would survive the
  // 400 forever. Same "reject up-front rather than copy-then-fail" rule the
  // reference gates below follow.
  const cloudConfig = resolveCloudProviderConfig(settings, mode);
  if (cloudConfig && !cloudConfig.enabled && inputImageCount) {
    cleanupReqFilesTemp();
    throw cloudConfig.disabledError;
  }

  // Resolve cleaners ONCE at the route layer so all three dispatch paths
  // (synchronous external, codex queue, local queue) see the same values.
  // Stamp onto `data` so they flow through the spread-into-params calls
  // below verbatim.
  const cleaners = resolveImageCleaners(data, settings, mode);
  data.cleanC2PA = cleaners.cleanC2PA;
  data.denoise = cleaners.denoise;
  delete data.autoClean; // legacy field — already mapped into both flags above

  // Reference images reach every backend that can consume them: local via
  // local.js's buildArgs (--reference-images/--reference-strengths, emitted
  // only inside the isFlux2 branch) and each cloud CLI via its own tool's
  // reference array (codex `referenced_image_paths`, grok `image_edit.image`,
  // agy `ImagePaths`). The two that CAN'T are rejected up-front rather than
  // copying the uploads to PATHS.imageRefs and silently dropping them
  // downstream — that would orphan files on disk and produce metadata sidecars
  // that lie about how the render was conditioned.
  if (referenceImageCount && mode === IMAGE_GEN_MODE.LOCAL) {
    const candidate = selectLocalImageModel(data.modelId);
    if (!isFlux2(candidate)) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for FLUX.2 models on the local backend',
        { status: 400, code: 'REFERENCE_IMAGES_FLUX2_ONLY' },
      );
    }
  }

  // Reject an over-cap request instead of staging every upload and letting
  // `resolveInputImages` silently keep the first N. Same reasoning as the
  // gates above: the extra copies would be orphaned in PATHS.imageRefs, and
  // the render would 200 while quietly ignoring images the caller submitted.
  // The Image Gen form already caps its slots per backend (referenceSlotsFor),
  // so this only fires for direct API callers — but a silent drop is exactly
  // the failure the sidecar-honesty rule exists to prevent. `resolveInputImages`
  // keeps its own cap as the backstop for in-process callers that skip the route.
  const inputImageCap = maxInputImages(mode);
  if (inputImageCap != null && inputImageCount > inputImageCap) {
    cleanupReqFilesTemp();
    throw new ServerError(
      `${modeLabel(mode)} accepts at most ${inputImageCap} input images (init image + references); received ${inputImageCount}`,
      { status: 400, code: 'TOO_MANY_INPUT_IMAGES' },
    );
  }

  if (initUpload || referenceUploads.length) await ensureDir(PATHS.imageRefs);
  if (initUpload) {
    // Trust the validated mimetype from the fileFilter — picking the ext
    // off the original filename can mismatch the bytes (e.g. HEIC saved
    // as .jpg). MIME_TO_EXT only contains formats the fileFilter accepts.
    const ext = MIME_TO_EXT[(initUpload.mimetype || '').toLowerCase()] || '.png';
    const initFilename = `init-${randomUUID()}${ext}`;
    // Stage into PATHS.imageRefs (sibling of the gallery), NOT PATHS.images —
    // listGallery() enumerates every .png in PATHS.images, so an init upload
    // landing there surfaces as a duplicate "(no prompt)" card in the gallery
    // on every i2i/edit render. The runner re-anchors init paths through
    // resolveImageInputPath, which accepts the refs dir.
    initImagePath = join(PATHS.imageRefs, initFilename);
    await copyFileGuarded(initUpload.path, initImagePath);
    stagedRefPaths.push(initImagePath);
    uploadedTempPaths.push(initUpload.path);
  } else if (data.initImageFile) {
    const resolved = resolveGalleryImage(data.initImageFile);
    if (!resolved) {
      cleanupStagedAndTemp();
      throw new ServerError('Init image not found in gallery', { status: 400, code: 'INIT_IMAGE_NOT_FOUND' });
    }
    initImagePath = resolved;
  }

  // JSON callers can condition a new render on existing gallery images
  // without mislabeling them as an init/edit source. Keep these first so their
  // strengths align with `referenceStrengths`, followed by multipart uploads.
  for (const [index, filename] of namedReferenceFiles.entries()) {
    const resolved = resolveGalleryImage(filename);
    if (!resolved) {
      cleanupStagedAndTemp();
      throw new ServerError(
        'Reference image not found in gallery',
        { status: 400, code: 'REFERENCE_IMAGE_NOT_FOUND' },
      );
    }
    referenceImagePaths.push(resolved);
    const strength = data.referenceStrengths?.[index];
    referenceImageStrengths.push(typeof strength === 'number' ? strength : 1.0);
  }

  // Multi-reference editing (FLUX.2). Walk packed slot entries in submit
  // order — each contributes a path + its parallel strength. Empty slots
  // are filtered out above so the runner sees `referenceImagePaths: [p1, ...]`
  // and aligns strengths by index.
  for (const { upload, strength } of referenceUploads) {
    const ext = MIME_TO_EXT[(upload.mimetype || '').toLowerCase()] || '.png';
    const refFilename = `ref-${randomUUID()}${ext}`;
    const refPath = join(PATHS.imageRefs, refFilename);
    await copyFileGuarded(upload.path, refPath);
    stagedRefPaths.push(refPath);
    uploadedTempPaths.push(upload.path);
    referenceImagePaths.push(refPath);
    // Default to 1.0 when the client didn't send a parallel strength entry,
    // matching the "full influence" intent of an uploaded reference.
    referenceImageStrengths.push(typeof strength === 'number' ? strength : 1.0);
  }

  // Strip the route-only fields — providers expect normalized `…Path(s)`.
  delete data.initImageFile;
  delete data.referenceImageFiles;
  delete data.referenceStrengths;
  if (initImagePath) data.initImagePath = initImagePath;
  if (referenceImagePaths.length) {
    data.referenceImagePaths = referenceImagePaths;
    data.referenceImageStrengths = referenceImageStrengths;
  }

  // Empty prompt is allowed for i2i / local / external, but a cloud-CLI render
  // still needs one whenever its tool can't run image-only — text-to-image
  // everywhere, plus agy even with input images (`Prompt` is required by its
  // tool schema). Reject synchronously here so direct API callers get a 400
  // instead of a 200-then-async-job-failure. Mirrors the guards in
  // codex.js/grok.js/agy.js and the client's needs-prompt gate.
  // This is the one throw that can fire with an input image already staged:
  // agy requires a prompt even then, so a prompt-less agy render with a
  // reference upload reaches here having already copied it into
  // PATHS.imageRefs. Unlink before throwing or it is orphaned on disk.
  const hasInputImage = Boolean(initImagePath) || referenceImagePaths.length > 0;
  if (cloudPromptRequired(mode, hasInputImage) && !data.prompt?.trim()) {
    cleanupStagedAndTemp();
    // Naming "text-to-image" would be wrong for the agy-with-input-images case,
    // which is precisely the one that isn't.
    const what = hasInputImage ? 'an image render' : 'text-to-image';
    throw new ServerError(`Prompt is required for ${modeLabel(mode)} ${what}`, { status: 400, code: 'VALIDATION_ERROR' });
  }

  if (data.guidance == null && data.cfgScale != null) {
    data.guidance = data.cfgScale;
  }

  return { data, mode, settings, uploadedTempPaths };
}

/**
 * resolveLocalImageModel — pre-dispatch validation for the LOCAL backend,
 * called from the route right before it enqueues a local job.
 *
 * Resolves the effective model via the same fallback chain the local worker
 * uses (`params.modelId` → compatible `'dev'` → the first compatible model)
 * and validates it can actually run: an edit-only model (e.g. Qwen-Image-Edit)
 * requires a source image, and any model that isn't FLUX.2 or diffusers-run
 * needs a configured pythonPath. Throws the identical `ServerError`s (same
 * status/code/message, same order) the route used to throw inline — these
 * surface directly in the UI.
 *
 * @param {object} settings - raw settings object (as returned by getSettings())
 * @param {object} params   - in-flight generate params (post prepareGenerateParams)
 * @returns {{ pythonPath: string|null, selectedModel: object|undefined }}
 */
export function resolveLocalImageModel(settings, params) {
  const pythonPath = settings.imageGen?.local?.pythonPath || null;
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
  // An explicit pin must fail clearly when the host cannot run it. For an
  // omitted pin, prefer the historical `dev` default only when it is actually
  // compatible, then choose the first known-compatible model. This keeps a
  // Windows/Linux install from silently queueing the Apple-only default.
  const selectedModel = selectLocalImageModel(params.modelId, allModels);
  if (selectedModel && !isHardwareCompatible(selectedModel.hardwareCompatibility)) {
    throw new ServerError(
      `Image model "${selectedModel.id}" is unavailable on this machine: ${selectedModel.hardwareCompatibility.reasons.join(' · ')}`,
      { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' },
    );
  }
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
  if (selectedModel && !isFlux2(selectedModel) && !usesDiffusersRunner(selectedModel) && !pythonPath) {
    throw new ServerError(
      'Local image generation is not configured (settings.imageGen.local.pythonPath is missing).',
      { status: 400, code: 'IMAGE_GEN_NOT_CONFIGURED' },
    );
  }
  return { pythonPath, selectedModel };
}
