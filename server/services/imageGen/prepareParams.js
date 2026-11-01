/**
 * Shared image-generation preparation and local model selection.
 *
 * `selectLocalImageModel`, `selectLocalImageModelFromSettings`, and
 * `resolveLocalImageModel` are the canonical owner of local image model
 * identity for every queueing surface. `prepareGenerateParams` also owns
 * pre-dispatch preparation for POST /image-gen/generate:
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

import { createHash, randomUUID } from 'crypto';
import { applyImageVisualProfile } from './visualProfile.js';
import { musicVideoStyleImages, musicVideoStylePrompt, musicVideoStyleReferenceCapacity } from '../../lib/musicVideoConditioning.js';
import { musicVideoFrameModelInput } from '../../lib/musicVideoShotPrompt.js';
import { join } from 'node:path';
import { ServerError } from '../../lib/errorHandler.js';
import { PATHS, ensureDir, resolveGalleryImage, copyFileGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { resolveImageInputPath } from '../../lib/pathSafety.js';
import { getSettings } from '../settings.js';
import { resolveImageCleaners } from '../../lib/imageCleanDefaults.js';
import { IMAGE_GEN_MODE, LOCAL_IMAGEGEN_DEFAULT_MODEL, editIncapableModeError, isEditCapableMode, modeLabel } from './modes.js';
import {
  cloudPromptRequired, maxInputImages, resolveCloudProviderConfig, resolveRenderTargetConfig,
} from './cloudProviderConfig.js';
import { RENDER_TARGET, recordRenderPin } from '../../lib/renderTargets.js';
import { CLOUD_IMAGE_GEN_MODES, QUEUEABLE_IMAGE_MODES } from '../../lib/generationModes.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getUniverseRenderPin } from '../universeBuilder/crud.js';
import { getImageModels, isFlux2, isEditOnly } from '../../lib/mediaModels.js';
import { hardwareUnavailableReason, isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { usesDiffusersRunner } from '../../lib/runners.js';
import { promptAddition } from '../../lib/modelInput.js';
import { IMAGE_REFERENCE_REQUEST_LIMIT } from '../../lib/imageGenCapabilities.js';
import { reviewedReferenceDigest } from './reviewedReference.js';

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
 * Select the model a local render will actually use. An omitted model prefers
 * the install-wide pin (`settings.imageGen.local.modelId`, set on Settings →
 * Media → Local), then the shipped Qwen-Image 2.1 default — each only when it can
 * actually run on this host; otherwise it falls through to the first
 * compatible catalog entry.
 *
 * `pinnedId` is a PREFERENCE, not a request: a stale or incompatible pin is
 * skipped rather than rejected, because the user who saved it is not the
 * caller of this render and has no way to see a 400 from it. A caller's own
 * `modelId` keeps its existing exact-match-or-throw handling upstream.
 *
 * @param {string|null|undefined} modelId
 * @param {object[]} [allModels]
 * @param {string|null} [pinnedId] - settings.imageGen.local.modelId
 * @returns {object|undefined}
 */
export function selectLocalImageModel(modelId, allModels = getImageModels(), pinnedId = null) {
  const requestedModel = allModels.find((model) => model.id === modelId);
  const pinnedIds = (Array.isArray(pinnedId) ? pinnedId : [pinnedId]).filter(Boolean);
  return requestedModel || [
    ...pinnedIds.map((id) => allModels.find((model) => model.id === id)),
    allModels.find((model) => model.id === LOCAL_IMAGEGEN_DEFAULT_MODEL),
    ...allModels,
  ].filter(Boolean).find((model) => isHardwareCompatible(model.hardwareCompatibility)) || allModels[0];
}

/**
 * Select the local image model honoring the install-wide pin
 * (`settings.imageGen.local.modelId`). Call this from any site that has
 * settings and only needs identity (FLUX.2 gate, FableLoom capability)
 * An optional `recordModelId` is another persisted preference, checked before
 * the install pin and filtered by the same hardware gate. Use this for local
 * record pins; do not pass those pins as explicit request model IDs.
 *
 * Call this rather than the full `resolveLocalImageModel` pre-dispatch validator —
 * that path also checks pythonPath / edit-only / unknown id, which is too
 * heavy before init images exist.
 */
export function selectLocalImageModelFromSettings(settings, modelId, allModels = getImageModels(), recordModelId = null) {
  return selectLocalImageModel(modelId, allModels, [recordModelId, settings?.imageGen?.local?.modelId].flat().filter(Boolean));
}

// A compose-time preview (#11317) names uploads it never stages: each stands in
// as this label, so the preview shows where the image goes without copying it.
export const previewUploadLabel = (index) => `(uploaded image ${index + 1})`;

const QWEN_IMAGE_21_PIPELINE = 'QwenImage21Pipeline';

// An uploaded or named reference without a parallel strength entry gets full influence.
const referenceStrengthOrFull = (strength) => (typeof strength === 'number' ? strength : 1.0);

// A quick edit wraps the authored change in an edit instruction; each added
// clause is listed as its own prompt addition beside the authored text.
function withQuickEditInstruction(data) {
  const authoredPrompt = data.prompt;
  // Named references after the first are pictures to draw from (a place, a
  // prop, a face), never images to edit.
  const extraReferences = Math.max(0, (data.referenceImageFiles?.length || 0) - 1);
  const prefix = extraReferences ? 'Edit the first reference image: ' : 'Edit the reference image: ';
  const referencesLine = extraReferences ? '. Use the other reference images only as visual references for this change' : '';
  const preservation = '. Keep everything else exactly as it is: composition, framing, subject, lighting, color and film look.';
  return { ...data, authoredPrompt, prompt: `${prefix}${authoredPrompt}${referencesLine}${preservation}`,
    promptAdditions: [...(data.promptAdditions || []),
      { id: 'quick-edit-prefix', label: 'Reference edit instruction', text: prefix },
      ...(referencesLine ? [{ id: 'quick-edit-references', label: 'Other references', text: referencesLine }] : []),
      { id: 'quick-edit-preservation', label: 'Preserve the rest', text: preservation }],
  };
}

// The live greybox capture leads the named references. A render that edits a
// picked frame keeps that frame first and puts the capture right after it; an
// older capture of the shot (`cachedCapture`) is dropped unless it is that frame.
function placeGreyboxReference(namedReferenceFiles, imageId, { cachedCapture, fromFrame }) {
  if (cachedCapture && cachedCapture !== imageId) {
    for (let i = namedReferenceFiles.length - 1; i >= 0; i--) {
      if (namedReferenceFiles[i] === cachedCapture && !(fromFrame && i === 0)) namedReferenceFiles.splice(i, 1);
    }
  }
  const existing = namedReferenceFiles.indexOf(imageId);
  if (fromFrame && existing === 0) return;
  if (existing >= 0) namedReferenceFiles.splice(existing, 1);
  namedReferenceFiles.splice(fromFrame ? Math.min(1, namedReferenceFiles.length) : 0, 0, imageId);
}

// A music-video scene render adds its greybox capture, its composed shot prompt
// and its mood-board style images. Mutates `data` and `namedReferenceFiles`.
async function applyMusicVideoSceneInputs(data, { project, mode, localModel, namedReferenceFiles, referenceUploads, initInputCount }) {
  const tag = data.musicVideo;
  const scene = project?.scenes?.find((entry) => entry.sceneId === tag.sceneId);
  const [{ loadMusicVideoGreybox }, { loadLinkedStoryboardPanel }] = await Promise.all([
    import('../musicVideo/greyboxReferences.js'), import('../musicVideo/linkedPanel.js'),
  ]);
  const [greybox, panel] = await Promise.all([
    loadMusicVideoGreybox(project, scene), tag.compose ? loadLinkedStoryboardPanel(project, scene) : null,
  ]);
  if (greybox) {
    placeGreyboxReference(namedReferenceFiles, greybox.reference.imageId, { cachedCapture: tag.greyboxImageId, fromFrame: tag.fromFrame || tag.refine });
  }
  if (tag.compose) {
    // The director's text plus each labeled block PortOS adds (#11317), from the
    // composer the server's production run uses for the same still.
    const composed = musicVideoFrameModelInput(project, scene, {
      slot: tag.slot === 'end' ? 'end' : 'start', authored: data.prompt || '', greybox,
      fromFrame: tag.fromFrame === true, refine: tag.refine === true,
      // The picked frame comes first; any reference after it is the shot's character or set reference.
      otherReferences: Math.max(0, namedReferenceFiles.length + referenceUploads.length - 1),
      panel, panelReference: scene?.panelArt ? namedReferenceFiles.indexOf(scene.panelArt) + 1 : 0,
      // Which named file is whom; a picked frame or other file outside the project's references stays unnamed.
      references: namedReferenceFiles.map((file) => (project?.visualSpec?.references || []).find((ref) => ref?.imageId === file) || null),
    });
    data.prompt = composed.prompt;
    if (composed.promptAdditions.length) data.promptAdditions = [...(data.promptAdditions || []), ...composed.promptAdditions];
  } else if (greybox) {
    data.prompt = [data.prompt, ...greybox.promptAdditions.map((a) => a.text)].filter(Boolean).join('\n');
    data.promptAdditions = [...(data.promptAdditions || []), ...greybox.promptAdditions];
  }
  const reservedSlots = referenceUploads.length + initInputCount;
  const capacity = Math.max(0, musicVideoStyleReferenceCapacity(mode, localModel) - reservedSlots);
  const styles = musicVideoStyleImages(project, namedReferenceFiles, capacity);
  // Named inputs precede uploads. Keep the latter's packed strength positions intact.
  if (!referenceUploads.length) namedReferenceFiles.push(...styles);
  const look = musicVideoStylePrompt(project, referenceUploads.length ? 0 : styles.length);
  if (look) {
    data.prompt = [data.prompt, look].filter(Boolean).join('. ');
    data.promptAdditions = [...(data.promptAdditions || []), promptAddition('mood-board-style', 'Mood board style', look)];
  }
}

// Reference images one request may carry. A peer-routed render is bounded by the
// request limit alone; a FableLoom cloud render takes its provider's own limit
// within that bound; everything else not named here takes 4.
function referenceImageCap({ peerRouted, mode, isQwen21, fableLoom, cloudModel }) {
  if (peerRouted) return IMAGE_REFERENCE_REQUEST_LIMIT;
  if (mode === IMAGE_GEN_MODE.RUNWAY) return maxInputImages(mode, cloudModel);
  if (isQwen21) return 10;
  if (fableLoom && CLOUD_IMAGE_GEN_MODES.includes(mode)) {
    return Math.min(maxInputImages(mode, cloudModel) ?? IMAGE_REFERENCE_REQUEST_LIMIT, IMAGE_REFERENCE_REQUEST_LIMIT);
  }
  return 4;
}

/**
 * @param {object} opts
 * @param {object} opts.data    - validated + coerced body from Zod (mutated in place)
 * @param {object} opts.files   - req.files from multer (may be undefined)
 * @param {string[]} opts.referenceImageFields - field names for multi-ref slots
 * @returns {Promise<{ data, mode, settings, uploadedTempPaths }>}
 */
export async function prepareGenerateParams({ data, files, referenceImageFields, preview = false }) {
  if (data.quickEdit) data = withQuickEditInstruction(data);
  let profile = data.visualProfileOverride;
  if (profile === undefined && !data.musicVideo && data.universeRun?.universeId) {
    const { getUniverseVisualProfile } = await import('../universeBuilder/crud.js');
    profile = await getUniverseVisualProfile(data.universeRun.universeId);
  }
  // FableLoom's canon compiler owns the photography block. Keep authored
  // intent untouched until that compiler has resolved explicit overrides.
  if (!data.fableLoom) data = applyImageVisualProfile(data, profile);
  let initImagePath = null;
  const uploadedTempPaths = [];
  const initUpload = files?.initImage;
  const referenceImagePaths = [];
  const referenceImageStrengths = [];
  const namedReferenceFiles = Array.isArray(data.referenceImageFiles) ? [...data.referenceImageFiles] : [];
  let musicVideoProject = null;
  let musicVideoProjectLoaded = false;

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
  if (data.fableLoom && (data.referenceStrengths?.length || 0) > namedReferenceFiles.length + referenceUploads.length) {
    cleanupReqFilesTemp();
    throw new ServerError('Each requested reference strength needs a matching reference image.', { status: 400, code: 'FABLELOOM_REFERENCE_STRENGTH_MISMATCH' });
  }
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
  let localModelCandidates = [];
  const source = data.mode ? null : RECORD_PIN_SOURCES.find((s) => data[s.tag]?.[s.idKey]);
  if (source) {
    const record = await source.load(data[source.tag][source.idKey]).catch(() => null);
    if (source.tag === 'musicVideo') { musicVideoProject = record; musicVideoProjectLoaded = true; }
    const pin = recordRenderPin(record || {});
    const resolved = resolveRenderTargetConfig(settings, source.target, {
      model: data.cloudModel || null,
      recordMode: pin.mode,
      recordModel: pin.modelId,
      fallbackMode: IMAGE_GEN_MODE.EXTERNAL,
      usableInstallFallback: true,
    });
    mode = resolved.mode;
    localModelCandidates = resolved.modelCandidates;
    // Stamping the id ERASES where it came from, and the dispatch below
    // re-resolves from `data.cloudModel` alone — so a shipped default
    // materialized here would arrive there looking like a deliberate choice and
    // the retired-default re-point would never run for a record-tagged render
    // (#7366). The provenance rides along as its own dispatcher-level field.
    if (!data.cloudModel && resolved.cloud?.modelId) {
      data.cloudModel = resolved.cloud.modelId;
      data.cloudModelIsShippedDefault = resolved.cloud.modelIsShippedDefault === true;
    }
  }
  // The render's input images, counted once: the init image (uploaded this
  // request or named by an earlier one) plus every reference slot. Every gate
  // below keys off these two, rather than respelling "carries input images"
  // per gate and having to keep the spellings in sync.
  const localModel = !data.mediaProviderPeerId && mode === IMAGE_GEN_MODE.LOCAL ? selectLocalImageModelFromSettings(settings, data.modelId, getImageModels(), localModelCandidates) : null;
  const initInputCount = initUpload || data.initImageFile ? 1 : 0;
  if (data.musicVideo?.sceneId) {
    const project = musicVideoProjectLoaded ? musicVideoProject : await getMusicVideoProject(data.musicVideo.projectId).catch(() => null);
    await applyMusicVideoSceneInputs(data, { project, mode, localModel, namedReferenceFiles, referenceUploads, initInputCount });
  }
  const referenceImageCount = namedReferenceFiles.length + referenceUploads.length;
  const inputImageCount = initInputCount + referenceImageCount;
  // Freeze the selected preference before capability checks. Explicit ids stay
  // untouched so the existing unknown/hardware rejection still applies.
  if (!data.modelId && localModel?.id) data.modelId = localModel.id;
  const selectedCloudModel = [IMAGE_GEN_MODE.RUNWAY, IMAGE_GEN_MODE.FAL].includes(mode)
    ? data.cloudModel || resolveCloudProviderConfig(settings, mode)?.modelId : null;
  const isQwen21 = localModel?.pipelineClass === QWEN_IMAGE_21_PIPELINE;
  const referenceCap = referenceImageCap({ peerRouted: Boolean(data.mediaProviderPeerId), mode, isQwen21, fableLoom: data.fableLoom, cloudModel: selectedCloudModel });
  if (referenceImageCount > referenceCap) {
    cleanupReqFilesTemp();
    throw new ServerError(
      `Image generation accepts at most ${referenceCap} reference images; received ${referenceImageCount}`,
      { status: 400, code: 'TOO_MANY_REFERENCE_IMAGES' },
    );
  }

  if (!data.mediaProviderPeerId && !isEditCapableMode(mode) && inputImageCount) {
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
  if (!data.mediaProviderPeerId && cloudConfig && !cloudConfig.enabled && inputImageCount) {
    cleanupReqFilesTemp();
    throw cloudConfig.disabledError;
  }

  // A full media queue (#8326) is refused before anything is staged too — the
  // route's enqueue would refuse the same render, after these copies landed.
  // Lazy: only a queue-bound render needs the queue loaded.
  if (!preview && (data.mediaProviderPeerId || QUEUEABLE_IMAGE_MODES.includes(mode))) {
    await import('../mediaJobQueue/index.js')
      .then(({ assertMediaQueueRoom }) => assertMediaQueueRoom(1))
      .catch((err) => {
        cleanupReqFilesTemp();
        throw err;
      });
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
  // for FLUX.2, and --reference-images for Qwen 2.1) and each cloud CLI via its tool's
  // reference array (codex `referenced_image_paths`, grok `image_edit.image`,
  // agy `ImagePaths`). The two that CAN'T are rejected up-front rather than
  // copying the uploads to PATHS.imageRefs and silently dropping them
  // downstream — that would orphan files on disk and produce metadata sidecars
  // that lie about how the render was conditioned.
  if (!data.mediaProviderPeerId && referenceImageCount && mode === IMAGE_GEN_MODE.LOCAL) {
    if (!isFlux2(localModel) && !isQwen21) {
      cleanupReqFilesTemp();
      throw new ServerError(
        'Reference images are only supported for FLUX.2 and Qwen Image 2.1 models on the local backend',
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
  const inputImageCap = data.mediaProviderPeerId ? null : isQwen21 ? 10 : maxInputImages(mode, selectedCloudModel);
  if (inputImageCap != null && inputImageCount > inputImageCap) {
    cleanupReqFilesTemp();
    throw new ServerError(
      `${modeLabel(mode)} accepts at most ${inputImageCap} input images (init image + references); received ${inputImageCount}`,
      { status: 400, code: 'TOO_MANY_INPUT_IMAGES' },
    );
  }

  // Stage into PATHS.imageRefs (sibling of the gallery), NOT PATHS.images —
  // listGallery() enumerates every .png in PATHS.images, so an init upload
  // landing there surfaces as a duplicate "(no prompt)" card in the gallery
  // on every i2i/edit render. The runner re-anchors init paths through
  // resolveImageInputPath, which accepts the refs dir.
  const stageUpload = async (upload, prefix) => {
    // Trust the validated mimetype from the fileFilter — picking the ext
    // off the original filename can mismatch the bytes (e.g. HEIC saved
    // as .jpg). MIME_TO_EXT only contains formats the fileFilter accepts.
    const ext = MIME_TO_EXT[(upload.mimetype || '').toLowerCase()] || '.png';
    const stagedPath = join(PATHS.imageRefs, `${prefix}-${randomUUID()}${ext}`);
    await copyFileGuarded(upload.path, stagedPath);
    stagedRefPaths.push(stagedPath);
    uploadedTempPaths.push(upload.path);
    return stagedPath;
  };

  let uploadIndex = 0;
  if (!preview && (initUpload || referenceUploads.length)) await ensureDir(PATHS.imageRefs);
  if (initUpload) {
    initImagePath = preview ? previewUploadLabel(uploadIndex++) : await stageUpload(initUpload, 'init');
  } else if (data.initImageFile) {
    const resolved = resolveGalleryImage(data.initImageFile) || resolveImageInputPath(data.initImageFile);
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
    // The gallery first; a Casting guide (#12763) may sit in any image-input root the catalog accepts.
    const resolved = resolveGalleryImage(filename) || resolveImageInputPath(filename);
    if (!resolved) {
      cleanupStagedAndTemp();
      throw new ServerError(
        'Reference image not found in gallery',
        { status: 400, code: 'REFERENCE_IMAGE_NOT_FOUND' },
      );
    }
    referenceImagePaths.push(resolved);
    referenceImageStrengths.push(referenceStrengthOrFull(data.referenceStrengths?.[index]));
  }

  // Multi-reference editing (FLUX.2). Walk packed slot entries in submit
  // order — each contributes a path + its parallel strength. Empty slots
  // are filtered out above so the runner sees `referenceImagePaths: [p1, ...]`
  // and aligns strengths by index.
  for (const { upload, strength } of referenceUploads) {
    referenceImagePaths.push(preview ? previewUploadLabel(uploadIndex++) : await stageUpload(upload, 'ref'));
    referenceImageStrengths.push(referenceStrengthOrFull(strength));
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
  if (!data.mediaProviderPeerId && cloudPromptRequired(mode, hasInputImage) && !data.prompt?.trim()) {
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
 * uses (`params.modelId` → the install pin → compatible Qwen-Image 2.1 → the
 * first compatible model)
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
  // job. When omitted, fall through to Qwen-Image 2.1 or the first compatible
  // catalog model — the worker uses the same selection path.
  if (params.modelId && !allModels.some((m) => m.id === params.modelId)) {
    throw new ServerError(
      `Unknown modelId: ${params.modelId}`,
      { status: 400, code: 'IMAGE_GEN_UNKNOWN_MODEL' },
    );
  }
  // An explicit pin must fail clearly when the host cannot run it. For an
  // omitted pin, prefer the shipped default only when compatible, then choose
  // the first known-compatible model.
  const selectedModel = selectLocalImageModelFromSettings(settings, params.modelId, allModels);
  if (selectedModel && !isHardwareCompatible(selectedModel.hardwareCompatibility)) {
    throw new ServerError(
      hardwareUnavailableReason(`Image model "${selectedModel.id}"`, selectedModel.hardwareCompatibility),
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

/**
 * Bind the reviewed composition and provider defaults. The edited image's bytes
 * are pinned separately (the reviewed snapshot); the bytes of any further
 * references are bound here, so a reference replaced after review is refused.
 */
export async function quickEditCompositionDigest({ params, mode, settings }) {
  const keys = ['prompt', 'negativePrompt', 'promptAdditions', 'width', 'height', 'modelId', 'cloudModel', 'effort', 'initImagePath', 'referenceImagePaths', 'referenceImageStrengths', 'mediaProviderPeerId', 'visualProfileRevision'];
  const extraReferenceDigests = await Promise.all((params.referenceImagePaths || []).slice(1).map(reviewedReferenceDigest));
  return createHash('sha256').update(JSON.stringify({
    mode, imageGen: settings.imageGen,
    input: Object.fromEntries(keys.map(key => [key, params[key]])),
    ...(extraReferenceDigests.length ? { extraReferenceDigests } : {}),
  })).digest('hex');
}
