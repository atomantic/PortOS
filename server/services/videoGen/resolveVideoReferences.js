/** Resolves video keyframes, cast references and prior renders into the reference inputs consumed by the worker. */

import { existsSync } from 'fs';
import { basename } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { REFERENCE_AUDIO_FIELDS } from './requestFields.js';
import { PATHS, resolveGalleryImage } from '../../lib/fileUtils.js';
import { safeUnder } from '../../lib/ffmpeg.js';
import { loadHistory } from './history.js';
import { DEFAULT_NUM_FRAMES } from './renderArgs.js';
import { extraReferenceImageLimit, validateReferenceLimits, validateResolvedReferences } from './validateVideoContract.js';

// Multi-keyframe interpolation: resolve each gallery filename to an
// absolute path under PATHS.images via the same path-traversal guard as
// sourceImageFile. Reject up-front when any reference can't be resolved
// so the queue doesn't accept a doomed job. Only valid for fflf mode +
// single-chunk renders (the chain orchestrator pins keyframes only on
// chunk 0; chaining ≥2 chunks with N keyframes has no defined semantic).
// Returns null when the request carries no multi-keyframe list.
function resolveKeyframeAnchors({ body, sourceImagePath, lastImagePath }) {
  if (!body.keyframes || body.keyframes.length < 2) return null;
  const reject = (message, code) => {
    throw new ServerError(message, { status: 400, code });
  };
  if (body.mode && body.mode !== 'fflf') {
    reject(`keyframes is only valid with mode='fflf' (got mode='${body.mode}').`, 'KEYFRAMES_MODE_MISMATCH');
  }
  // Reject mixing keyframes with the legacy 2-keyframe inputs — the
  // worker would silently ignore sourceImage/lastImage when keyframes is
  // present, but staging/resizing them anyway is wasted work and the
  // ambiguity (which one wins?) bites callers later. Force the user to
  // pick one shape per request. Covers both upload paths and the
  // gallery-resolved file fields.
  if (sourceImagePath || lastImagePath || body.sourceImageFile || body.lastImageFile) {
    reject(
      'keyframes cannot be combined with sourceImage / lastImage inputs — pass each anchor frame as a keyframes[] entry instead.',
      'KEYFRAMES_LEGACY_INPUTS_CONFLICT',
    );
  }
  // Default mode to 'fflf' when keyframes is set without an explicit mode —
  // otherwise local.js#buildLtx2Args resolves helperMode to 'text' and the
  // keyframes silently disappear.
  if (!body.mode) body.mode = 'fflf';
  // Validate keyframe indices against the *effective* numFrames so a
  // request with no explicit `numFrames` (which falls back to the
  // generateVideo default of 121) still rejects out-of-range indices
  // up-front instead of failing late inside the worker / Python helper.
  // Keep this in sync with the default in services/videoGen/local.js.
  const effectiveNumFrames = body.numFrames != null ? Number(body.numFrames) : DEFAULT_NUM_FRAMES;
  const resolved = [];
  let prevIndex = -1;
  for (let i = 0; i < body.keyframes.length; i++) {
    const kf = body.keyframes[i];
    const path = resolveGalleryImage(kf.file);
    if (!path) reject(`keyframes[${i}].file not found in gallery: ${kf.file}`, 'KEYFRAME_GALLERY_MISS');
    if (kf.index <= prevIndex) {
      reject(`keyframes indices must be strictly ascending; got ${prevIndex} then ${kf.index}`, 'KEYFRAME_INDICES_NOT_ASCENDING');
    }
    if (kf.index > effectiveNumFrames - 1) {
      const numFramesLabel = body.numFrames != null
        ? `numFrames ${body.numFrames}`
        : `default numFrames ${DEFAULT_NUM_FRAMES}`;
      reject(`keyframes[${i}].index ${kf.index} >= ${numFramesLabel}`, 'KEYFRAME_INDEX_OUT_OF_RANGE');
    }
    resolved.push({ path, index: kf.index });
    prevIndex = kf.index;
  }
  return resolved;
}

async function prepareVideoReferences({
  body, uploads, effectiveModel, sourceImagePath, getHistory,
  stageUploadDurable, extraUploadedTempPaths,
}) {
  // The backend and capability-dependent model are already resolved here, and
  // hosted/peer submissions have taken their own lanes. Add cast sheets only
  // when they cannot displace caller-provided references or break a chain.
  const audioUploads = REFERENCE_AUDIO_FIELDS.map((field) => uploads[field]).filter(Boolean);
  const images = body.referenceImageFiles?.length;
  const videos = body.referenceVideoIds?.length;
  validateReferenceLimits(effectiveModel, { images, videos, audios: audioUploads.length });
  const hasRequestedReferences = images || videos || audioUploads.length;
  let referenceImagePaths = null;
  if (body.musicVideo?.sceneId && !body.musicVideo.clipReferencesDisabled && sourceImagePath && !hasRequestedReferences && !(Number(body.chunks) > 1)) {
    const totalLimit = Number(effectiveModel?.maxReferenceTotal) || Infinity;
    const limit = Math.min(extraReferenceImageLimit(effectiveModel), totalLimit - 1);
    if (limit > 0) {
      const { musicVideoLocalReferencePaths } = await import('../musicVideo/clipCastReferences.js');
      const paths = await musicVideoLocalReferencePaths(body.musicVideo, limit, { excludePath: sourceImagePath });
      if (paths.length) referenceImagePaths = paths;
    }
  }
  // Extra reference stills for a reference-to-video model. Rejected up-front on
  // a model that declares no `maxReferenceImages` (a silently dropped reference
  // would render a clip that ignores what the user supplied) and past the
  // model's ceiling, which counts the source still as the first image.
  if (body.referenceImageFiles?.length) {
    referenceImagePaths = [];
    for (let i = 0; i < body.referenceImageFiles.length; i++) {
      const file = body.referenceImageFiles[i];
      const path = resolveGalleryImage(file);
      if (!path) {
        throw new ServerError(
          `referenceImageFiles[${i}] not found in gallery: ${file}`,
          { status: 400, code: 'VIDEO_REFERENCE_IMAGE_GALLERY_MISS' },
        );
      }
      referenceImagePaths.push(path);
    }
  }

  // Ordered clip and voice references, after the same per-model ceilings as the
  // image rows. A history clip already lives under data/videos/ and must survive
  // the render; an uploaded voice clip is staged durably and dropped with the job.
  let referenceVideoPaths = null;
  if (body.referenceVideoIds?.length) {
    const history = await getHistory();
    referenceVideoPaths = [];
    for (const id of body.referenceVideoIds) {
      referenceVideoPaths.push(resolveHistoryVideoPath(id, {
        history,
        label: 'referenceVideoIds entry',
        notFoundCode: 'VIDEO_REFERENCE_CLIP_NOT_FOUND',
        missingFileCode: 'VIDEO_REFERENCE_CLIP_FILE_MISSING',
      }));
    }
  }
  let referenceAudioPaths = null;
  if (audioUploads.length) {
    referenceAudioPaths = [];
    for (const upload of audioUploads) {
      const path = await stageUploadDurable(upload, 'ref-audio');
      extraUploadedTempPaths.push(path);
      referenceAudioPaths.push(path);
    }
  }

  validateResolvedReferences(effectiveModel, {
    sourceImagePath, referenceImagePaths, referenceVideoPaths, referenceAudioPaths, chunks: body.chunks,
  });

  return { referenceImagePaths, referenceVideoPaths, referenceAudioPaths };
}

/**
 * IC-LoRA reference channel: gallery stills for an image-kind weight, else the
 * staged upload or the picked prior render(s). `assertIcLoraRequest` already
 * rejected the cross-kind and both-present cases and asserted the count, so
 * exactly one branch contributes and each entry resolves 1:1 or throws.
 */
async function resolveIcReferencePaths({
  icSpec, body, icReferenceUploadPath, getHistory,
}) {
  if (icSpec.referenceKind === 'image') {
    if (icSpec.mode === 'ic-ingredients-25' && body.musicVideo?.sceneId) {
      const { musicVideoClipReferences } = await import('../musicVideo/clipCastReferences.js');
      const refs = await musicVideoClipReferences(body.musicVideo, icSpec.maxReferences, {
        excludePath: body.sourceImageFile ? resolveGalleryImage(body.sourceImageFile) : null,
      });
      const actual = refs.map((ref) => basename(ref.path));
      if (JSON.stringify(actual) !== JSON.stringify(body.icReferenceImageFiles)) {
        throw new ServerError('The shot references changed. Review them and render again.',
          { status: 409, code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
      }
      return refs.map((ref) => ref.path);
    }
    // Gallery-only, exactly like `keyframes` — same path-traversal guard, same
    // "reject up-front so the queue never accepts a doomed job" contract. The
    // service materializes each still into a VAE-compatible clip at render
    // resolution (the IC reference channel is a video encoder end-to-end).
    const paths = [];
    for (let i = 0; i < body.icReferenceImageFiles.length; i++) {
      const file = body.icReferenceImageFiles[i];
      const path = resolveGalleryImage(file);
      if (!path) {
        throw new ServerError(
          `icReferenceImageFiles[${i}] not found in gallery: ${file}`,
          { status: 400, code: 'IC_LORA_REFERENCE_GALLERY_MISS' },
        );
      }
      paths.push(path);
    }
    return paths;
  }
  if (icReferenceUploadPath) return [icReferenceUploadPath];
  const history = await getHistory();
  const paths = [];
  for (const id of body.icReferenceVideoIds || []) {
    paths.push(resolveHistoryVideoPath(id, {
      history,
      label: 'icReferenceVideoIds entry',
      notFoundCode: 'IC_LORA_REFERENCE_NOT_FOUND',
      missingFileCode: 'IC_LORA_REFERENCE_FILE_MISSING',
    }));
  }
  return paths;
}

function resolveHistoryVideoPath(id, { history, label, notFoundCode, missingFileCode }) {
  const videoEntry = history.find((entry) => entry.id === id);
  if (!videoEntry) {
    throw new ServerError(`${label} not found in history: ${id}`, { status: 404, code: notFoundCode });
  }
  const candidate = safeUnder(PATHS.videos, videoEntry.filename);
  if (!candidate || !existsSync(candidate)) {
    throw new ServerError(
      `${label} resolved to a missing file: ${videoEntry.filename}`,
      { status: 404, code: missingFileCode },
    );
  }
  return candidate;
}

export async function resolveReferenceInputs({
  body, uploads, effectiveModel, icSpec, icReferenceUploadPath, stageUploadDurable,
  sourceImagePath, lastImagePath, extraUploadedTempPaths,
}) {
  const resolvedKeyframes = resolveKeyframeAnchors({ body, sourceImagePath, lastImagePath });

  // Render history is read by both the extend and IC reference paths. Load it
  // lazily and at most once — the file grows with every render, so a request
  // carrying both would otherwise re-read and re-parse megabytes.
  let historyCache = null;
  const getHistory = async () => (historyCache ??= await loadHistory());

  // Native extend (ltx2 runtime): forward the resolved path as
  // extendFromVideoPath.
  let extendFromVideoPath = null;
  if (body.extendFromVideoId) {
    extendFromVideoPath = resolveHistoryVideoPath(body.extendFromVideoId, {
      history: await getHistory(),
      label: 'extendFromVideoId',
      notFoundCode: 'EXTEND_SOURCE_NOT_FOUND',
      missingFileCode: 'EXTEND_SOURCE_FILE_MISSING',
    });
  }

  const icReferencePaths = icSpec
    ? await resolveIcReferencePaths({
      icSpec, body, icReferenceUploadPath, getHistory,
    })
    : null;

  const { referenceImagePaths, referenceVideoPaths, referenceAudioPaths } = await prepareVideoReferences({
    body, uploads, effectiveModel, sourceImagePath, getHistory,
    stageUploadDurable, extraUploadedTempPaths,
  });

  return { resolvedKeyframes, extendFromVideoPath, icReferencePaths, referenceImagePaths, referenceVideoPaths, referenceAudioPaths };
}
