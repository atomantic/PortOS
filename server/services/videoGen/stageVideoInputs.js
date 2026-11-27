/** Owns durable upload staging, rollback and resolution of the primary inputs for local and hosted video renders. */

import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { REFERENCE_AUDIO_FIELDS, VIDEO_REFERENCE_IMAGE_FIELDS } from './requestFields.js';
import { PATHS, ensureDir, resolveGalleryImage, copyFileGuarded, unlinkGuarded } from '../../lib/fileUtils.js';
import { assertFileNotMediaManifest } from '../../lib/uploads.js';
import { probeVideoDuration, safeUnder } from '../../lib/ffmpeg.js';
import { getProject as getMusicVideoProject } from '../musicVideo/projects.js';
import { getTrack } from '../tracks/index.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';
import { DEFAULT_NUM_FRAMES } from './renderArgs.js';
import { audioDurationToFrames } from './audioDuration.js';
import { validateVideoSourceContract } from './validateVideoContract.js';

/**
 * Best-effort unlink of every multipart temp file the parser wrote before the
 * handler ran. Exported because the route needs it on the Zod-parse failure
 * path, which happens before this service is ever called.
 *
 * @param {object} uploads - `req.files` keyed by fieldname (may be empty)
 */
const cleanedMultipartUploads = new WeakSet();

export const cleanupMultipartTemp = async (uploads) => {
  if (uploads && typeof uploads === 'object') {
    if (cleanedMultipartUploads.has(uploads)) return;
    cleanedMultipartUploads.add(uploads);
  }
  for (const f of Object.values(uploads || {})) {
    if (f?.path) await unlinkGuarded(f.path).catch(() => {});
  }
};

/**
 * Run `fn`, releasing everything staged so far if it throws or rejects, then
 * rethrow the original error unchanged (#3326).
 *
 * @param {() => Promise<void>} cleanupStaged - releases request-owned files
 * @param {() => Promise<any>|any} fn - work that may leave staged files behind
 */
export const withStagedRollback = async (cleanupStaged, fn) => {
  try {
    return await fn();
  } catch (err) {
    await cleanupStaged();
    throw err;
  }
};

export function createVideoInputStaging(uploads) {
  // Keep ownership here until preparation succeeds and the caller can enqueue.
  const stagedDurablePaths = [];
  const cleanupStaged = async () => {
    for (const p of stagedDurablePaths) await unlinkGuarded(p).catch(() => {});
    await cleanupMultipartTemp(uploads);
  };

  const stageDurableCopy = async (sourcePath, ext, kind, { message, code }) => {
    const durablePath = join(PATHS.uploads, `video-${kind}-${randomUUID()}${ext || '.bin'}`);
    // Register the destination first so rollback also owns a partial copy.
    stagedDurablePaths.push(durablePath);
    try {
      await copyFileGuarded(sourcePath, durablePath);
    } catch (err) {
      throw new ServerError(`${message}: ${err.message}`, { status: 500, code });
    }
    return durablePath;
  };

  const stageUploadDurable = async (file, kind) => {
    // ffmpeg reads the bytes, so reject manifests before the probe or render.
    await assertFileNotMediaManifest(file.path);
    const durablePath = await stageDurableCopy(file.path, extname(file.originalname || file.path), kind, {
      message: 'Failed to stage upload to durable location', code: 'VIDEO_GEN_UPLOAD_STAGE_FAILED',
    });
    await unlinkGuarded(file.path).catch(() => {});
    return durablePath;
  };
  return { stagedDurablePaths, cleanupStaged, stageDurableCopy, stageUploadDurable };
}

async function ensureUploadsDir(uploads) {
  if (!(uploads.sourceImage || uploads.lastImage || uploads.audioFile || REFERENCE_AUDIO_FIELDS.some((field) => uploads[field]) || VIDEO_REFERENCE_IMAGE_FIELDS.some((field) => uploads[field]) || uploads.icReference || uploads.runwayVideo || uploads.runwayCharacterVideo)) return;
  try {
    await ensureDir(PATHS.uploads);
  } catch (err) {
    throw new ServerError(
      `Failed to prepare uploads directory: ${err.message}`,
      { status: 500, code: 'VIDEO_GEN_UPLOADS_DIR_FAILED' },
    );
  }
}


// Local audio is queue-owned whether supplied as an upload or copied from a
// project song. Keep source selection and durable ownership in one step.
async function prepareLocalAudio({ body, uploads, numFrames, stageUploadDurable, stageDurableCopy }) {
  // Music-video a2v jobs reuse an existing library track rather than uploading
  // the same song for every cut. Copy it into the queue-owned uploads area so
  // the worker may safely delete its input on completion without ever touching
  // the source track under data/music.
  let audioFilePath = null;
  let audioProject = null;
  if (uploads.audioFile) {
    // a2v: audio file rides through the same durable-staging path as the
    // image uploads. Cleanup tracking via extraUploadedTempPaths so the
    // worker drops it on terminal events the same way it drops lastImage.
    audioFilePath = await stageUploadDurable(uploads.audioFile, 'audio');
  } else if (body.mode === 'a2v' && body.musicVideo) {
    const project = await getMusicVideoProject(body.musicVideo.projectId);
    const sceneExists = project?.scenes?.some((scene) => scene.sceneId === body.musicVideo.sceneId);
    if (!project || !sceneExists) {
      throw new ServerError('Music-video project or scene not found', { status: 404, code: 'NOT_FOUND' });
    }
    const track = project.trackId ? await getTrack(project.trackId) : null;
    const filename = track?.audioFilename || project.uploadedAudioFilename;
    const sourceAudioPath = filename ? safeUnder(PATHS.music, filename) : null;
    if (!sourceAudioPath || !existsSync(sourceAudioPath)) {
      throw new ServerError('Music-video project audio is unavailable', { status: 400, code: 'VIDEO_GEN_PROJECT_AUDIO_MISSING' });
    }
    const startSample = Math.round((Number(body.audioStartSec) || 0) * 48000);
    const sampleCount = Math.round(((numFrames - 1) / Number(body.fps ?? 24)) * 48000);
    const endSample = startSample + sampleCount;
    const exactWindow = Number.isSafeInteger(startSample) && startSample >= 0
      && Number.isSafeInteger(sampleCount) && sampleCount > 0 && sampleCount <= 48000 * 60
      && endSample <= 48000 * 36000;
    // Exact PCM provenance has a bounded window; longer local inputs retain
    // the worker's full-song/offset contract without claiming a clip digest.
    if (!body._suppliedAudio && exactWindow) audioProject = project;
    else {
      audioFilePath = await stageDurableCopy(sourceAudioPath, extname(sourceAudioPath), 'audio', {
        message: 'Failed to stage project audio', code: 'VIDEO_GEN_AUDIO_STAGE_FAILED',
      });
    }
  }
  return { audioFilePath, audioProject };
}

async function resolveAudioFrameCount({ body, audioFilePath, effectiveModel, effectiveNumFrames }) {
  // A direct-upload LTX-2.5 A2V request follows the whole audio file. The MLX
  // pipeline still requires an explicit 8n+1 frame canvas, so derive that canvas
  // from the durable upload rather than trusting browser metadata (or forcing an
  // API caller to probe the file itself). MiniMax Ref2VA is deliberately excluded:
  // its wrapper windows arbitrary-length audio and owns its duration internally.
  // Music-video jobs also keep their explicit scene canvas because they select a
  // slice of a longer song with audioStartSec.
  if (body.mode === 'a2v' && audioFilePath
    && effectiveModel?.audioDurationDriven === true
    && effectiveModel?.arbitraryLengthAudio !== true
    && !body.musicVideo) {
    const durationSeconds = await probeVideoDuration(audioFilePath);
    if (durationSeconds == null) {
      throw new ServerError(
        'Could not read the uploaded audio duration. Upload a valid WAV, MP3, M4A, AAC, FLAC, or OGG file.',
        { status: 400, code: 'VIDEO_GEN_AUDIO_DURATION_UNREADABLE' },
      );
    }
    const frameStride = Number(effectiveModel.frameStride);
    const fps = Number(body.fps ?? 24);
    const maxNumFrames = Number(effectiveModel.maxNumFrames);
    if (!Number.isInteger(frameStride) || frameStride <= 0
      || !Number.isInteger(maxNumFrames) || maxNumFrames <= 0) {
      throw new ServerError(
        `${effectiveModel.name} is missing its duration-driven frameStride/maxNumFrames contract.`,
        { status: 500, code: 'VIDEO_MODEL_MISCONFIGURED' },
      );
    }
    effectiveNumFrames = audioDurationToFrames(durationSeconds, fps, frameStride);
    if (effectiveNumFrames > maxNumFrames) {
      throw new ServerError(
        `${effectiveModel.name} supports up to ${(maxNumFrames / fps).toFixed(1)}s in one audio-to-video render; this file is ${durationSeconds.toFixed(1)}s. Use MiniMax H3 Ref2VA for longer audio, or trim the file.`,
        { status: 400, code: 'VIDEO_GEN_AUDIO_TOO_LONG' },
      );
    }
  }
  return effectiveNumFrames;
}

async function stageOpeningFrame({
  body, uploads, declaredMode, contractParams, effectiveModel, stageUploadDurable, stagedDurablePaths,
}) {
  // A fresh upload wins over the gallery pick on either side. Preserve the
  // legacy queue ownership field for the start frame, with other owned
  // media tracked in uploadedTempPaths.
  let sourceImagePath = null;
  let uploadedTempPath = null;
  await ensureUploadsDir(uploads);
  if (uploads.sourceImage) {
    sourceImagePath = await stageUploadDurable(uploads.sourceImage, 'source');
    uploadedTempPath = sourceImagePath;
  } else if (body.sourceImageFile) {
    sourceImagePath = resolveGalleryImage(body.sourceImageFile);
  }
  if (declaredMode === 'ic-ingredients-25' && body.sourceImageFile && !sourceImagePath) {
    throw new ServerError('The selected opening frame is missing or could not be resolved. Choose it again.',
      { status: 400, code: 'IC_LORA_SOURCE_MISSING' });
  }
  validateVideoSourceContract(effectiveModel, { ...contractParams, sourceImagePath }, declaredMode, true);
  // Music Video director-board renders are always i2v FROM the scene's reference
  // frame (#1760 Phase 1). resolveGalleryImage returns null for a missing/invalid
  // gallery file (mustExist defaults true), and an unresolved source would
  // otherwise fall through to a text-to-video render — silently attaching a clip
  // that ignores the frame the director chose. Reject instead, so a stale/deleted
  // reference frame surfaces as a clear error rather than a wrong-looking clip.
  if (body.musicVideo && !sourceImagePath && !body.guidanceImageFile) {
    throw new ServerError(
      'Music Video scene render needs a resolvable reference frame (sourceImageFile) — the scene\'s frame is missing or could not be resolved.',
      { status: 400, code: 'MUSIC_VIDEO_SOURCE_REQUIRED' },
    );
  }
  const discardSourceImage = async () => {
    if (uploadedTempPath) {
      await unlinkGuarded(uploadedTempPath).catch(() => {});
      const index = stagedDurablePaths.indexOf(uploadedTempPath);
      if (index >= 0) stagedDurablePaths.splice(index, 1);
    }
    if (uploads.sourceImage?.path) await unlinkGuarded(uploads.sourceImage.path).catch(() => {});
  };
  return { sourceImagePath, uploadedTempPath, discardSourceImage };
}

export async function stagePrimaryMedia({
  body, uploads, settings, backend, effectiveModel, declaredMode, contractParams,
  effectiveNumFrames, guidance, falSourceAudio, stageUploadDurable, stageDurableCopy,
  stagedDurablePaths, cleanupStaged,
}) {
  const { sourceImagePath, uploadedTempPath, discardSourceImage } = await stageOpeningFrame({
    body, uploads, declaredMode, contractParams, effectiveModel, stageUploadDurable, stagedDurablePaths,
  });
  // Hosted workers consume staged frames and supported source audio, but none
  // of the local runtime/IC machinery below. Keep availability checking here
  // so failures retain source validation precedence and staged-file ownership.
  const hosted = HOSTED_VIDEO_SUBMISSIONS[backend];
  if (hosted) {
    const { usable, extras } = hosted.prepare(settings);
    if (!usable) {
      throw new ServerError(hosted.errorMessage, { status: 400, code: hosted.errorCode });
    }
    const staged = await hosted.stageInputs({
      body, uploads, sourceImagePath, falSourceAudio, stageUploadDurable, settings,
    });
    return {
      hostedParams: {
        backend,
        ...extras,
        effectiveModel: { id: backend, supportedModes: ['text', 'image'] },
        sourceImagePath,
        uploadedTempPath,
        ...staged,
        ...guidance,
        discardSourceImage,
        cleanupStaged,
      },
    };
  }

  const extraUploadedTempPaths = [];
  let lastImagePath = null;
  if (uploads.lastImage) {
    lastImagePath = await stageUploadDurable(uploads.lastImage, 'last');
    extraUploadedTempPaths.push(lastImagePath);
  } else if (body.lastImageFile) {
    // Same path-traversal guard as the start frame.
    lastImagePath = resolveGalleryImage(body.lastImageFile);
  }
  const audioInput = await prepareLocalAudio({
    body, uploads, numFrames: effectiveNumFrames ?? effectiveModel.defaultFrames ?? DEFAULT_NUM_FRAMES,
    stageUploadDurable, stageDurableCopy,
  });
  let { audioFilePath } = audioInput;
  effectiveNumFrames = await resolveAudioFrameCount({
    body, audioFilePath, effectiveModel, effectiveNumFrames,
  });
  let audioConditioning = null;
  if (audioInput.audioProject) {
    // Pin the renderer's default with the sliced input so an omitted count
    // neither reaches the slicer unset nor changes after its PCM is prepared.
    effectiveNumFrames ??= effectiveModel.defaultFrames ?? DEFAULT_NUM_FRAMES;
    const fps = Number(body.fps ?? 24);
    const startSec = Number(body.audioStartSec) || 0;
    const { prepareSourceAudioWindow } = await import('../federatedMedia/sourceAudio.js');
    const window = await prepareSourceAudioWindow({
      project: audioInput.audioProject,
      scene: { startSec, endSec: startSec + (effectiveNumFrames - 1) / fps },
      numFrames: effectiveNumFrames,
      fps,
    });
    audioFilePath = window.audioFilePath;
    audioConditioning = window.audioConditioning;
    stagedDurablePaths.push(audioFilePath);
    // The worker now receives the exact clip whose digest is recorded. Its
    // original song offset remains in provenance, not a second input trim.
    body.audioStartSec = 0;
  }
  if (audioFilePath) extraUploadedTempPaths.push(audioFilePath);
  let icReferenceUploadPath = null;
  if (uploads.icReference) {
    // IC-LoRA reference clip — same durable staging + cleanup tracking as the
    // audio upload above. A history-picked reference needs neither (it already
    // lives under data/videos/ and must survive the render).
    icReferenceUploadPath = await stageUploadDurable(uploads.icReference, 'ic-ref');
    extraUploadedTempPaths.push(icReferenceUploadPath);
  }

  return {
    effectiveNumFrames,
    sourceImagePath,
    lastImagePath,
    audioFilePath,
    ...(audioConditioning ? { audioConditioning } : {}),
    icReferenceUploadPath,
    uploadedTempPath,
    uploadedTempPaths: extraUploadedTempPaths,
    discardSourceImage,
    cleanupStaged,
  };
}
