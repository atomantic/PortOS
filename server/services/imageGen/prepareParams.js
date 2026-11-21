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
 *     uploadedTempPaths - multer temp paths for the caller to unlink
 *     stagedRefPaths    - request-owned copies to unlink if dispatch is refused
 *   }
 *
 * On validation failure throws ServerError so the route's asyncHandler
 * middleware translates it to a 4xx response.
 */

import { createHash, randomUUID } from 'crypto';
import { applyImageVisualProfile } from './visualProfile.js';
import { MUSIC_VIDEO_MAX_REFERENCE_CHOICES, musicVideoCastGuideReferences, musicVideoConditioningReferences, musicVideoFrameReferenceFiles, musicVideoLimitReferenceFiles, musicVideoLinkedCastReferences, musicVideoMissingFrameLinkedPicks, musicVideoPanelArtReferences, musicVideoResearchReferences, musicVideoReferenceChoices, musicVideoStyleImages, musicVideoReferenceCapacity, musicVideoStylePrompt, musicVideoStyleReferenceCapacity } from '../../lib/musicVideo/musicVideoConditioning.js';
import { castInputsFromReferences } from '../../lib/musicVideo/musicVideoCastLook.js';
import { musicVideoCameoReferences } from '../../lib/musicVideo/musicVideoCameos.js';
import { FRAME_REFERENCE_UNAVAILABLE } from '../musicVideo/sceneFrameReferences.js';
import { musicVideoFrameModelInput } from '../../lib/musicVideo/musicVideoShotPrompt.js';
import { captureImageFrameDependencies } from '../../lib/musicVideo/musicVideoDependencies.js';
import { musicVideoGreyboxReferences } from '../../lib/musicVideo/musicVideoGreybox.js';
import { musicVideoFrameGenSize } from '../../lib/musicVideo/musicVideoAspect.js';
import { join } from 'node:path';
import { assertFlux2InputsCompatible } from '../../lib/flux2Inputs.js';
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
import { getUniverseRenderPin, getUniverseVisualProfile } from '../universeBuilder/crud.js';
import { getImageModels, isEditOnly } from '../../lib/mediaModels.js';
import { hardwareUnavailableReason, isHardwareCompatible } from '../../lib/systemCapabilities.js';
import { usesFlux3, usesMossSwift, usesMinimaxH3Image } from '../../lib/imageRuntimeRemedies.js';
import { isFlux2, usesDiffusersRunner } from '../../lib/runners.js';
import { promptAddition } from '../../lib/modelInput.js';
import { QUICK_EDIT_PREFIX, QUICK_EDIT_PREFIX_WITH_REFERENCES } from '../../lib/quickEditPrompt.js';
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

const isQwenImage21 = (model) => model?.pipelineClass === 'QwenImage21Pipeline';

export const localModelSupportsReferences = (model) =>
  isFlux2(model) || isQwenImage21(model) || model?.runner === 'flux3' || model?.maxReferenceImages > 0;

export function inputImageCap({ peerRouted, mode, localModel, cloudModel }) {
  if (peerRouted) return null;
  return isQwenImage21(localModel) ? 10 : maxInputImages(mode, cloudModel);
}

// An uploaded or named reference without a parallel strength entry gets full influence.
const referenceStrengthOrFull = (strength) => (typeof strength === 'number' ? strength : 1.0);

// A quick edit wraps the authored change in an edit instruction; each added
// clause is listed as its own prompt addition beside the authored text.
function withQuickEditInstruction(data) {
  const authoredPrompt = data.prompt;
  // Named references after the first are pictures to draw from (a place, a
  // prop, a face), never images to edit.
  const extraReferences = Math.max(0, (data.referenceImageFiles?.length || 0) - 1);
  const prefix = extraReferences ? QUICK_EDIT_PREFIX_WITH_REFERENCES : QUICK_EDIT_PREFIX;
  const referencesLine = extraReferences ? '. Use the other reference images only as visual references for this change' : '';
  const preservation = '. Keep everything else exactly as it is: composition, framing, subject, lighting, color and film look.';
  return { ...data, authoredPrompt, prompt: `${prefix}${authoredPrompt}${referencesLine}${preservation}`,
    promptAdditions: [...(data.promptAdditions || []),
      { id: 'quick-edit-prefix', label: 'Reference edit instruction', text: prefix },
      ...(referencesLine ? [{ id: 'quick-edit-references', label: 'Other references', text: referencesLine }] : []),
      { id: 'quick-edit-preservation', label: 'Preserve the rest', text: preservation }],
  };
}

// The live greybox images (the camera's plate or capture, then its optional
// figure blocking layout) lead the named references. A render that edits a
// picked frame keeps that frame first and puts them right after it; an older
// copy the client sent (`cached`) is dropped unless it is that frame.
function placeGreyboxReferences(namedReferenceFiles, imageIds, { cached = [], fromFrame }) {
  const live = new Set(imageIds);
  const drop = new Set([...cached.filter((id) => id && !live.has(id)), ...imageIds]);
  const keepFrame = fromFrame && namedReferenceFiles.length > 0;
  const frame = keepFrame ? namedReferenceFiles[0] : null;
  const rest = namedReferenceFiles.filter((file, i) => !(keepFrame && i === 0) && !drop.has(file));
  // The edited frame may itself be one of the greybox images; it stays first, once.
  const greybox = imageIds.filter((id) => id !== frame);
  namedReferenceFiles.splice(0, namedReferenceFiles.length, ...(keepFrame ? [frame] : []), ...greybox, ...rest);
}

// The shot card's reference set, shared with POST /music-video/:id/scenes/:sceneId/frame.
// An omitted file list is filled. An explicit pick that is missing, or a sent
// list that drops one, is refused before a take is spent.
function reconcileCardFrameReferences(data, namedReferenceFiles, { project, scene, castMedia, greybox, referenceFilesOmitted }) {
  const tag = data.musicVideo;
  if (!tag?.compose || !scene) return;
  if (tag.refine && tag.includeReferences === false) {
    const lead = tag.leadImageId || namedReferenceFiles[0];
    if (!lead) throw new ServerError('Choose an image to refine', { status: 422, code: 'MUSIC_VIDEO_REFINE_IMAGE_REQUIRED' });
    namedReferenceFiles.splice(0, namedReferenceFiles.length, lead);
    data.referenceImageFiles = [lead];
    data.musicVideo = { ...tag, castInputs: castInputsFromReferences(scene, []) };
    return;
  }
  if (musicVideoMissingFrameLinkedPicks(project, scene, castMedia).length) {
    throw new ServerError(FRAME_REFERENCE_UNAVAILABLE, { status: 409, code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING' });
  }
  const explicit = Array.isArray(scene.frameReferenceIds);
  if (!referenceFilesOmitted && !explicit) return;
  const lead = ((tag.fromFrame || tag.refine) && namedReferenceFiles[0]) || tag.leadImageId
    || ((tag.fromFrame || tag.refine || tag.slot === 'end') ? scene.referenceImageId : null) || null;
  const conditioning = musicVideoConditioningReferences(project, scene, castMedia, greybox);
  const expected = musicVideoFrameReferenceFiles(lead, conditioning, MUSIC_VIDEO_MAX_REFERENCE_CHOICES, { reservePanel: !explicit });
  if (referenceFilesOmitted) {
    if (!expected.length) return;
    namedReferenceFiles.splice(0, namedReferenceFiles.length, ...expected);
    data.referenceImageFiles = expected.slice();
    if (!tag.castInputs) {
      data.musicVideo = { ...data.musicVideo, castInputs: castInputsFromReferences(scene, conditioning.filter((ref) => expected.includes(ref.imageId))) };
    }
    return;
  }
  const required = conditioning.filter((ref) => !ref.greybox).map((ref) => ref.imageId);
  const sent = new Set(namedReferenceFiles);
  if (required.some((id) => !sent.has(id))) {
    throw new ServerError(FRAME_REFERENCE_UNAVAILABLE, { status: 409, code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING' });
  }
}

function limitMusicVideoReferences(data, { scene, mode, localModel, cloudModel, namedReferenceFiles, referenceUploads, initInputCount, greyboxFiles }) {
  const tag = data.musicVideo;
  // The board sends its priority-ordered references; this renderer takes as many as it can (a peer decides its own).
  const rendererCapacity = musicVideoReferenceCapacity(mode, { modelId: cloudModel, localModel });
  if (!data.mediaProviderPeerId && rendererCapacity > 0) {
    const room = Math.max(0, rendererCapacity - initInputCount - referenceUploads.length);
    const panelImageId = !Array.isArray(scene?.frameReferenceIds) ? scene?.panelArt : null;
    const frameCount = (tag.fromFrame || tag.refine) && namedReferenceFiles.length ? 1 : 0;
    const greyboxIndex = Math.max(-1, ...greyboxFiles.map((file) => namedReferenceFiles.indexOf(file)));
    const protectedCount = Math.max(frameCount, greyboxIndex + 1);
    const limited = musicVideoLimitReferenceFiles(namedReferenceFiles, room, { panelImageId, protectedCount });
    namedReferenceFiles.splice(0, namedReferenceFiles.length, ...limited);
    // Trimming or retaining a panel can change positions; strengths follow the files.
    if (data.referenceStrengths) {
      const originalFiles = data.referenceImageFiles || [];
      const usedIndices = new Set();
      data.referenceStrengths = [...namedReferenceFiles.map((file) => {
        const index = originalFiles.findIndex((original, i) => original === file && !usedIndices.has(i));
        if (index >= 0) usedIndices.add(index);
        return referenceStrengthOrFull(data.referenceStrengths[index]);
      }),
        ...referenceUploads.map(({ strength }) => referenceStrengthOrFull(strength))];
    }
    if (tag.castInputs) {
      const sent = new Set(namedReferenceFiles);
      data.musicVideo = { ...tag, castInputs: { ...tag.castInputs,
        guides: tag.castInputs.guides.filter((file) => sent.has(file)),
        sheets: tag.castInputs.sheets.filter((sheet) => sent.has(sheet.imageId)),
        ...(Array.isArray(tag.castInputs.characters) ? { characters: tag.castInputs.characters.filter((entry) => sent.has(entry.imageId)) } : {}),
      } };
    }
  }
}

function applyMusicVideoShotPrompt(data, { project, scene, tag, greybox, panel, castMedia, sizes, namedReferenceFiles, referenceUploads, initInputCount }) {
  if (tag.compose) {
    // A peer chooses its runner; local incompatible inputs are rejected below.
    const positionsUnknown = Boolean(data.mediaProviderPeerId && initInputCount);
    const sentFiles = positionsUnknown ? [] : namedReferenceFiles;
    const known = [...musicVideoGreyboxReferences(greybox), ...musicVideoResearchReferences(scene), ...musicVideoPanelArtReferences(scene), ...musicVideoCameoReferences(project, scene), ...musicVideoCastGuideReferences(project, scene, castMedia), ...(project?.visualSpec?.references || []), ...musicVideoReferenceChoices(project), ...musicVideoLinkedCastReferences(project, castMedia)];
    const panelIndex = scene?.panelArt ? sentFiles.indexOf(scene.panelArt) : -1;
    // The director's text plus each labeled block PortOS adds (#11317), from the
    // composer the server's production run uses for the same still.
    const composed = musicVideoFrameModelInput(project, scene, {
      slot: tag.slot === 'end' ? 'end' : 'start', authored: data.prompt || '', greybox,
      fromFrame: tag.fromFrame === true, refine: tag.refine === true,
      // The picked frame comes first; any reference after it is the shot's character or set reference.
      otherReferences: Math.max(0, initInputCount + sentFiles.length + referenceUploads.length - 1),
      panel, panelReference: panelIndex >= 0 ? initInputCount + panelIndex + 1 : 0, sizes,
      // An init image or picked frame occupies a slot without being a character sheet.
      references: [...Array(initInputCount).fill(null), ...sentFiles.map((file, index) =>
        !initInputCount && index === 0 && (tag.fromFrame || tag.refine) ? null : known.find((ref) => ref?.imageId === file) || null)],
      // The bible describes only the subjects these references show, even when a peer decides their positions.
      subjectReferences: namedReferenceFiles.map((file) => known.find((ref) => ref?.imageId === file) || null),
    });
    data.prompt = composed.prompt;
    if (composed.promptAdditions.length) data.promptAdditions = [...(data.promptAdditions || []), ...composed.promptAdditions];
  } else if (greybox) {
    data.prompt = [data.prompt, ...greybox.promptAdditions.map((a) => a.text)].filter(Boolean).join('\n');
    data.promptAdditions = [...(data.promptAdditions || []), ...greybox.promptAdditions];
  }
}

// A music-video scene render adds its greybox capture, its composed shot prompt
// and its mood-board style images. Mutates `data` and `namedReferenceFiles`.
async function applyMusicVideoSceneInputs(data, { project, mode, localModel, cloudModel, namedReferenceFiles, referenceUploads, initInputCount, referenceFilesOmitted = false }) {
  let tag = data.musicVideo;
  const referencesOff = tag.refine === true && tag.includeReferences === false;
  const scene = project?.scenes?.find((entry) => entry.sceneId === tag.sceneId);
  const [{ loadMusicVideoGreybox }, { loadLinkedStoryboardPanel }, castGuideMedia, subjectScale] = await Promise.all([
    import('../musicVideo/greyboxReferences.js'), import('../musicVideo/linkedPanel.js'),
    tag.compose ? import('../musicVideo/castGuideMedia.js') : null,
    tag.compose ? import('../musicVideo/subjectScale.js') : null,
  ]);
  const [greybox, panel, castMedia, sizes] = await Promise.all([
    referencesOff ? null : loadMusicVideoGreybox(project, scene), tag.compose && !referencesOff ? loadLinkedStoryboardPanel(project, scene) : null,
    referencesOff ? null : castGuideMedia?.loadSceneCastMedia(scene, { project }),
    referencesOff ? null : subjectScale?.loadMusicVideoSubjectSizes(project),
  ]);
  reconcileCardFrameReferences(data, namedReferenceFiles, { project, scene, castMedia, greybox, referenceFilesOmitted });
  tag = data.musicVideo;
  const greyboxFiles = musicVideoGreyboxReferences(greybox).map((ref) => ref.imageId);
  if (greybox) {
    placeGreyboxReferences(namedReferenceFiles, greyboxFiles, { cached: [tag.greyboxImageId, tag.greyboxBlockingImageId], fromFrame: tag.fromFrame || tag.refine });
  }
  limitMusicVideoReferences(data, { scene, mode, localModel, cloudModel, namedReferenceFiles, referenceUploads, initInputCount, greyboxFiles });
  applyMusicVideoShotPrompt(data, { project, scene, tag, greybox, panel, castMedia, sizes, namedReferenceFiles, referenceUploads, initInputCount });
  const reservedSlots = referenceUploads.length + initInputCount;
  const capacity = Math.max(0, musicVideoStyleReferenceCapacity(mode, localModel, cloudModel) - reservedSlots);
  const styles = referencesOff ? [] : musicVideoStyleImages(project, namedReferenceFiles, capacity);
  // Named inputs precede uploads. Keep the latter's packed strength positions intact.
  if (!referenceUploads.length) namedReferenceFiles.push(...styles);
  const look = referencesOff ? '' : musicVideoStylePrompt(project, referenceUploads.length ? 0 : styles.length);
  if (look) {
    data.prompt = [data.prompt, look].filter(Boolean).join('. ');
    data.promptAdditions = [...(data.promptAdditions || []), promptAddition('mood-board-style', 'Mood board style', look)];
  }
  // Stamp at submit, including a job that does not compose, so completion
  // files the shot the director sent rather than the shot it finds later.
  if (scene) {
    const currentTag = data.musicVideo || tag;
    data.musicVideo = { ...currentTag, frameDependencies: captureImageFrameDependencies(project, scene, { slot: currentTag.slot === 'end' ? 'end' : 'start' }) };
  }
}

// Reference images one request may carry. A peer-routed render is bounded by the
// request limit alone; a FableLoom cloud render takes its provider's own limit
// within that bound; everything else not named here takes 4.
export function referenceImageCap({ peerRouted, mode, localModel, fableLoom, cloudModel }) {
  if (peerRouted) return IMAGE_REFERENCE_REQUEST_LIMIT;
  if (mode === IMAGE_GEN_MODE.LOCAL && Number.isInteger(localModel?.maxReferenceImages)) {
    return Math.min(localModel.maxReferenceImages, IMAGE_REFERENCE_REQUEST_LIMIT);
  }
  if (mode === IMAGE_GEN_MODE.RUNWAY) return maxInputImages(mode, cloudModel);
  if (isQwenImage21(localModel) || localModel?.runner === 'flux3') return 10;
  // A cloud image CLI takes its own provider's (or model's) limit, not a fixed 4.
  if (CLOUD_IMAGE_GEN_MODES.includes(mode)) {
    if (fableLoom) return Math.min(maxInputImages(mode, cloudModel) ?? IMAGE_REFERENCE_REQUEST_LIMIT, IMAGE_REFERENCE_REQUEST_LIMIT);
    // A provider that takes fewer is refused below with its own input-image count.
    return Math.min(Math.max(4, maxInputImages(mode, cloudModel) ?? IMAGE_REFERENCE_REQUEST_LIMIT), IMAGE_REFERENCE_REQUEST_LIMIT);
  }
  return 4;
}

async function resolveRecordRenderPin(data, settings) {
  let mode = data.mode || settings.imageGen?.mode || IMAGE_GEN_MODE.EXTERNAL;
  let musicVideoProject;
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
    const record = await source.load(data[source.tag][source.idKey]).catch(error => {
      if (source.tag === 'musicVideo') throw error;
      return null;
    });
    if (source.tag === 'musicVideo') musicVideoProject = record ?? null;
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
  return { mode, localModelCandidates, musicVideoProject };
}

async function prepareMusicVideoScene(data, { mode, localModel, cloudModel, musicVideoProject, namedReferenceFiles, referenceUploads, initInputCount }) {
  if (!data.musicVideo?.sceneId) return;
  const { requireCatalogRenderReady, assertCatalogReferenceFiles, assertCatalogInputBasis } = await import('../musicVideo/clipCastReferences.js');
  const project = await requireCatalogRenderReady(musicVideoProject === undefined ? await getMusicVideoProject(data.musicVideo.projectId) : musicVideoProject);
  assertCatalogInputBasis(project, data.musicVideo.catalogBasis, { required: namedReferenceFiles.length > 0 || !!data.initImageFile });
  assertCatalogReferenceFiles(project, [...namedReferenceFiles, data.initImageFile]);
  if (project?.castAndSets?.source === 'catalog') data.musicVideoCatalogBasis = project.castAndSets.catalogCheckin.basis;
  const standardSize = musicVideoFrameGenSize(project);
  if (localModel?.runner === 'flux3' && Number(data.width) === standardSize.width && Number(data.height) === standardSize.height) {
    Object.assign(data, musicVideoFrameGenSize(project, localModel));
  }
  await applyMusicVideoSceneInputs(data, {
    project, mode, localModel, cloudModel, namedReferenceFiles, referenceUploads, initInputCount,
    referenceFilesOmitted: !Array.isArray(data.referenceImageFiles),
  });
  // A list the server filled still has to name the catalog basis the files came from.
  assertCatalogInputBasis(project, data.musicVideo.catalogBasis, { required: namedReferenceFiles.length > 0 || !!data.initImageFile });
  assertCatalogReferenceFiles(project, namedReferenceFiles);
}

async function assertLocalModelInputs(localModel, data, { initInputCount, referenceImageCount }) {
  if (!localModel) return;
  const inputs = {
    negativePrompt: data.negativePrompt,
    hasInitImage: Boolean(initInputCount),
    referenceCount: referenceImageCount,
    referenceImageStrengths: data.referenceStrengths || [],
    loraCount: (data.loraFilenames?.length || 0) + (data.loraPaths?.length || 0),
  };
  if (localModel.runner === 'flux3') {
    const { assertFlux3Inputs } = await import('./flux3Runtime.js');
    assertFlux3Inputs({ ...inputs, width: Number(data.width ?? 1024), height: Number(data.height ?? 1024) });
  }
  if (usesMinimaxH3Image(localModel)) {
    const { assertMinimaxH3ImageInputs } = await import('./minimaxH3ImageRuntime.js');
    assertMinimaxH3ImageInputs({ ...inputs, width: Number(data.width ?? 2048), height: Number(data.height ?? 2048), steps: data.steps || null });
  }
  assertFlux2InputsCompatible(localModel, inputs);
}

async function assertPreStageGates(data, { settings, mode, cloudModel, localModel, referenceImageCount, initInputCount, preview }) {
  const peerRouted = Boolean(data.mediaProviderPeerId);
  const inputImageCount = initInputCount + referenceImageCount;
  const referenceCap = referenceImageCap({ peerRouted, mode, localModel, fableLoom: data.fableLoom, cloudModel });
  if (referenceImageCount > referenceCap) {
    throw new ServerError(
      `Image generation accepts at most ${referenceCap} reference images; received ${referenceImageCount}`,
      { status: 400, code: 'TOO_MANY_REFERENCE_IMAGES' },
    );
  }
  if (!peerRouted && !isEditCapableMode(mode) && inputImageCount) throw editIncapableModeError(mode);

  const cloudConfig = resolveCloudProviderConfig(settings, mode);
  if (!peerRouted && cloudConfig && !cloudConfig.enabled && inputImageCount) throw cloudConfig.disabledError;

  if (!preview && (peerRouted || QUEUEABLE_IMAGE_MODES.includes(mode))) {
    const { assertMediaQueueRoom } = await import('../mediaJobQueue/index.js');
    await assertMediaQueueRoom(1);
  }

  // Reject inputs the backend would silently discard, before copying uploads.
  if (!peerRouted && mode === IMAGE_GEN_MODE.LOCAL && referenceImageCount && !localModelSupportsReferences(localModel)) {
    throw new ServerError(
      'Reference images require a FLUX.2, FLUX.3, MiniMax H3-Image or Qwen Image 2.1 model on the local backend',
      { status: 400, code: 'REFERENCE_IMAGES_FLUX2_ONLY' },
    );
  }
  const totalCap = inputImageCap({ peerRouted, mode, localModel, cloudModel });
  if (totalCap != null && inputImageCount > totalCap) {
    throw new ServerError(
      `${modeLabel(mode)} accepts at most ${totalCap} input images (init image + references); received ${inputImageCount}`,
      { status: 400, code: 'TOO_MANY_INPUT_IMAGES' },
    );
  }
}

async function stageAndResolveInputImages(data, { initUpload, namedReferenceFiles, referenceUploads, preview, stagedRefPaths }) {
  let initImagePath = null;
  const referenceImagePaths = [];
  const referenceImageStrengths = [];
  const uploadedTempPaths = [];
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
    stagedRefPaths.push(stagedPath);
    await copyFileGuarded(upload.path, stagedPath);
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

  return { uploadedTempPaths, hasInputImage: Boolean(initImagePath) || referenceImagePaths.length > 0 };
}

function assertCloudPrompt(data, mode, hasInputImage) {
  if (!data.mediaProviderPeerId && cloudPromptRequired(mode, hasInputImage) && !data.prompt?.trim()) {
    const what = hasInputImage ? 'an image render' : 'text-to-image';
    throw new ServerError(`Prompt is required for ${modeLabel(mode)} ${what}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
}

async function applyRequestProfile(data) {
  if (data.quickEdit) data = withQuickEditInstruction(data);
  let profile = data.visualProfileOverride;
  if (profile === undefined && !data.musicVideo && data.universeRun?.universeId) {
    profile = await getUniverseVisualProfile(data.universeRun.universeId);
  }
  // FableLoom's canon compiler owns the photography block and explicit overrides.
  return data.fableLoom ? data : applyImageVisualProfile(data, profile);
}

function collectReferenceUploads(data, files, referenceImageFields, namedReferenceCount) {
  // Pair strengths by PACK position (post-filter), not slot position — the
  // client renumbers populated slots into `referenceImage1..N` and sends a
  // parallel `referenceStrengths` array sized N. A curl user could leave a
  // gap (`referenceImage2` + `referenceImage4` only); the strength at index 0
  // still pairs with the first surviving upload in slot order.
  return referenceImageFields
    .map((field) => files?.[field])
    .filter(Boolean)
    .map((upload, packedIndex) => ({
      upload,
      strength: data.referenceStrengths?.[namedReferenceCount + packedIndex],
    }));
}

/** Prepare validated generation inputs and transfer ownership of staged copies to the caller. */
export async function prepareGenerateParams({ data, files, referenceImageFields, preview = false }) {
  // Track only copies owned by this request. Resolved gallery images belong to the user.
  const stagedRefPaths = [];
  try {
    data = await applyRequestProfile(data);
    const initUpload = files?.initImage;
    const namedReferenceFiles = Array.isArray(data.referenceImageFiles) ? [...data.referenceImageFiles] : [];
    const referenceUploads = collectReferenceUploads(data, files, referenceImageFields, namedReferenceFiles.length);
    const settings = await getSettings();
    if (data.fableLoom && (data.referenceStrengths?.length || 0) > namedReferenceFiles.length + referenceUploads.length) {
      throw new ServerError('Each requested reference strength needs a matching reference image.', { status: 400, code: 'FABLELOOM_REFERENCE_STRENGTH_MISMATCH' });
    }

    const { mode, localModelCandidates, musicVideoProject } = await resolveRecordRenderPin(data, settings);
    const localModel = !data.mediaProviderPeerId && mode === IMAGE_GEN_MODE.LOCAL
      ? selectLocalImageModelFromSettings(settings, data.modelId, getImageModels(), localModelCandidates) : null;
    const initInputCount = initUpload || data.initImageFile ? 1 : 0;
    const cloudModel = [IMAGE_GEN_MODE.RUNWAY, IMAGE_GEN_MODE.FAL, IMAGE_GEN_MODE.HIGGSFIELD, IMAGE_GEN_MODE.GOOGLE].includes(mode)
      ? data.cloudModel || resolveCloudProviderConfig(settings, mode)?.modelId : data.cloudModel || null;
    await prepareMusicVideoScene(data, { mode, localModel, cloudModel, musicVideoProject, namedReferenceFiles, referenceUploads, initInputCount });
    const referenceImageCount = namedReferenceFiles.length + referenceUploads.length;
    await assertLocalModelInputs(localModel, data, { initInputCount, referenceImageCount });
    // Freeze the selected preference, leaving explicit ids for dispatch validation.
    if (!data.modelId && localModel?.id) data.modelId = localModel.id;
    await assertPreStageGates(data, { settings, mode, cloudModel, localModel, referenceImageCount, initInputCount, preview });

    Object.assign(data, resolveImageCleaners(data, settings, mode));
    delete data.autoClean;
    const { uploadedTempPaths, hasInputImage } = await stageAndResolveInputImages(data, {
      initUpload, namedReferenceFiles, referenceUploads, preview, stagedRefPaths,
    });
    assertCloudPrompt(data, mode, hasInputImage);
    if (data.guidance == null && data.cfgScale != null) data.guidance = data.cfgScale;
    return { data, mode, settings, uploadedTempPaths, stagedRefPaths };
  } catch (error) {
    const tempPaths = Object.values(files || {}).map(file => file?.path).filter(Boolean);
    await Promise.allSettled([...stagedRefPaths, ...tempPaths].map(path => unlinkGuarded(path)));
    throw error;
  }
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
  assertFlux2InputsCompatible(selectedModel, {
    hasInitImage: Boolean(params.initImagePath), referenceCount: params.referenceImagePaths?.length || 0,
    loraCount: (params.loraFilenames?.length || 0) + (params.loraPaths?.length || 0),
  });
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
  if (selectedModel && !usesFlux3(selectedModel) && !usesMinimaxH3Image(selectedModel) && !usesMossSwift(selectedModel) && !isFlux2(selectedModel) && !usesDiffusersRunner(selectedModel) && !pythonPath) {
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
