import { isDefaultA2vLoraStages } from '../../lib/videoLoraStageValidation.js';
/**
 * Submit a validated video-generation request to its federated, hosted, or local
 * dispatch lane. HTTP parsing and validation stay in the route; this service
 * owns every subsequent orchestration and rollback decision.
 */

import { unlink } from 'fs/promises';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { discardSourceAudioWindow } from '../federatedMedia/sourceAudio.js';
import { ServerError } from '../../lib/errorHandler.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import { asFableLoomRenderSettings } from '../../lib/fableLoomProduction.js';
import { isFullDecode } from '../../lib/videoDraftDecoders.js';
import { isDefaultVideoStreamingMode } from '../../lib/videoStreamingMode.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { isDefaultSpeedProfile } from '../../lib/videoSpeedProfiles.js';
import { isStockTextEncoder } from '../../lib/videoTextEncoders.js';
import { collectRemoteInputAssets } from '../federatedMedia/inputAssets.js';
import { prepareRemoteMediaJob, negotiateVideoConstraints } from '../federatedMedia/remoteSubmission.js';
import { getLoom } from '../fableLoom/records.js';
import {
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
} from '../fableLoom/visualConditioning.js';
import { VIDEO_GEN_MODE } from './modes.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { preparePerformanceShot } from '../musicVideo/performanceShot.js';
import { cleanupMultipartTemp, prepareVideoGenParams } from './prepareParams.js';
import { VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES } from './requestFields.js';

import { isTruthyMeta } from '../../lib/metadataFlags.js';

const musicVideoProjectAspect = async (projectId) => {
  const [{ getProject }, { musicVideoAspect }] = await Promise.all([
    import('../musicVideo/projects.js'), import('../../lib/musicVideoAspect.js'),
  ]);
  return musicVideoAspect(await getProject(projectId));
};

/**
 * The durable inputs one submission acquired before its queue job exists
 * (#12394): staged frames, supplied-audio windows, performance WAVs and a
 * repair reservation. Each is owned the moment it is created; any failure
 * before the queue write releases them all, newest first, and a queued job
 * takes them over for the worker's terminal cleanup.
 */
const createSubmissionInputs = () => {
  const releases = [];
  let releasing = null;
  return {
    own: (release) => { releases.push(release); },
    transfer: () => { releases.length = 0; },
    // A repeat call awaits the same unwind instead of reporting it settled early.
    release: () => {
      releasing ??= (async () => {
        while (releases.length) {
          await Promise.resolve().then(releases.pop())
            .catch((error) => console.error(`❌ Video submission input release failed: ${error.message}`));
        }
      })();
      return releasing;
    },
  };
};

/**
 * Acquire a submission's inputs: a federated peer's negotiated request, or
 * this machine's staged uploads, plus any supplied song window. `inputs` owns
 * each durable file the moment it exists. Final scene/song revalidation stays
 * at the queue-write boundary, never here.
 */
async function prepareVideoSubmissionInputs(body, uploads, inputs) {
  let prepared;
  // Federated render (#4348): submit to the selected peer instead of running
  // locally. Handled before local preparation, which resolves this machine's
  // backend and stages uploads a remote render can never use.
  if (body.mediaProviderPeerId) {
    // Start/end gallery frames may cross to an allowlisted peer, but multipart
    // files, model weights, and multi-step chain state stay local under the
    // federated-input contract in ADR 2026-08-22. Each entry here is a deliberate
    // refusal, not a missing transport implementation.
    const unsupported = [
      ['uploaded files', Object.keys(uploads).length],
      ['keyframes', body.keyframes?.length],
      ['a source video to extend', body.extendFromVideoId],
      ['IC-LoRA references', body.icReferenceVideoIds?.length || body.icReferenceImageFiles?.length],
      ['reference images', body.referenceImageFiles?.length],
      ['reference clips', body.referenceVideoIds?.length],
      ['LoRA weights', body.loraFilenames?.length],
      ['per-stage user LoRA strengths', !isDefaultA2vLoraStages(body.a2vLoraStageStrengths)],
      ['chained chunks', body.chunks > 1],
      ['an explicit continuation strategy', body.continuityStrategy != null],
      ['warm render batches', body.batchSize > 1],
      ['the Grok backend', body.backend === 'grok'],
      ['a FableLoom scene tag', body.fableLoom],
      // Inspire is a per-runtime capability the caller cannot prove for a peer.
      // Refuse it instead of returning an anchored clip under an Inspire label.
      ['a loose reference mode', !isDefaultI2vReferenceMode(body.i2vReferenceMode)],
    ].filter(([, present]) => present).map(([label]) => label);
    if (unsupported.length) {
      throw new ServerError(
        `A federated media provider cannot render this clip — it uses ${unsupported.join(' and ')}. Render locally instead.`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }

    const inputAssets = collectRemoteInputAssets('video', body);
    const impliedMode = body._suppliedAudio ? 'a2v' : body.lastImageFile ? 'fflf' : body.sourceImageFile ? 'image' : 'text';
    if (body.mode !== undefined && body.mode !== impliedMode) {
      throw new ServerError(
        `A federated render mode must match its conditioning — this request asks for '${body.mode}' but supplies ${impliedMode === 'text' ? 'no frames' : `a ${impliedMode} frame set`}. Render locally instead.`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }
    if (!body.modelId) {
      throw new ServerError(
        'A federated render must name the provider model explicitly (modelId)',
        { status: 400, code: 'MEDIA_PROVIDER_MODEL_REQUIRED' },
      );
    }

    const { resolveGalleryImage } = await import('../../lib/pathSafety.js');
    const request = buildFederatedMediaRequest({ kind: 'video', params: body });
    // Negotiate dimensions/frames before slicing audio. Audio is never padded,
    // truncated, or silently dropped to fit a different peer after submission.
    if (body._suppliedAudio) inputAssets.push({ role: 'sourceAudio', path: 'pending.wav' });
    const selected = await prepareRemoteMediaJob({ peerId: body.mediaProviderPeerId, kind: 'video', request, inputAssets });
    const sourceImagePath = body.sourceImageFile ? resolveGalleryImage(body.sourceImageFile) : null;
    let audio = null;
    if (body._suppliedAudio) {
      const [{ getProject }, { prepareSourceAudioWindow, sourceAudioVideoRequest }] = await Promise.all([
        import('../musicVideo/projects.js'), import('../federatedMedia/sourceAudio.js'),
      ]);
      const project = await getProject(body.musicVideo.projectId);
      const scene = project?.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
      selected.request = negotiateVideoConstraints(sourceAudioVideoRequest(scene, selected.capability, selected.request), selected.capability);
      selected.remoteMedia.request = selected.request;
      audio = await prepareSourceAudioWindow({ project, scene, ...selected.request });
      inputs.own(() => discardSourceAudioWindow(audio.audioFilePath));
      selected.remoteMedia.request.audioConditioning = audio.audioConditioning;
      selected.remoteMedia.inputAssets = collectRemoteInputAssets('video', { ...body, ...audio });
    }
    prepared = { backend: 'remote', sourceImagePath, remoteMedia: selected.remoteMedia, audio };
  } else {
    if (body._suppliedAudio) {
      const [{ getProject }, { resolveVideoModelSelection }, { sourceAudioVideoRequest, supportsSourceAudioWindow }, { isPerformanceScene }] = await Promise.all([
        import('../musicVideo/projects.js'), import('./modelSelection.js'), import('../federatedMedia/sourceAudio.js'),
        import('../../lib/musicVideoShotTiming.js'),
      ]);
      const project = await getProject(body.musicVideo.projectId);
      const scene = project?.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
      // A performance shot cuts its own song window (performanceShot.js), so
      // it enters as an image render and becomes a2v once that window exists.
      if (isPerformanceScene(scene)) body = { ...body, mode: 'image', _suppliedAudio: false };
      else {
        const { model, modelId } = await resolveVideoModelSelection(body.modelId);
        if (!supportsSourceAudioWindow(model)) {
          throw new ServerError('Supplied song windows currently require an LTX MLX model with audio conditioning', { status: 400, code: 'MUSIC_VIDEO_AUDIO_UNSUPPORTED' });
        }
        body = sourceAudioVideoRequest(scene, model, { ...body, modelId });
      }
    }
    prepared = await prepareVideoGenParams({ body, uploads, localOnlyParamKeys: VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES });
    inputs.own(prepared.cleanupStaged);
  }
  if (body._suppliedAudio && prepared.backend === 'local') {
    const [{ getProject }, { prepareSourceAudioWindow, supportsSourceAudioWindow }] = await Promise.all([
      import('../musicVideo/projects.js'), import('../federatedMedia/sourceAudio.js'),
    ]);
    if (!supportsSourceAudioWindow(prepared.effectiveModel)) {
      throw new ServerError('Supplied song windows currently require an LTX MLX model with audio conditioning', { status: 400, code: 'MUSIC_VIDEO_AUDIO_UNSUPPORTED' });
    }
    const project = await getProject(body.musicVideo.projectId);
    const scene = project?.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
    const audio = await prepareSourceAudioWindow({ project, scene, numFrames: prepared.effectiveNumFrames, fps: body.fps || 24 });
    inputs.own(() => discardSourceAudioWindow(audio.audioFilePath));
    prepared.audio = audio;
    prepared.audioFilePath = audio.audioFilePath;
    prepared.uploadedTempPaths = [...(prepared.uploadedTempPaths || []), audio.audioFilePath];
    body.audioStartSec = 0;
  }
  return { body, prepared };
}

// What each hosted backend's visual-conditioning compile is told about the
// render. A local backend has no entry and uses the resolved model itself.
const CONDITIONING_MODEL_BY_BACKEND = {
  [VIDEO_GEN_MODE.GROK]: { id: 'grok-video', supportedModes: ['image'] },
  [VIDEO_GEN_MODE.FAL]: { id: 'fal-video', supportedModes: ['text', 'image'] },
  [VIDEO_GEN_MODE.REACTOR]: { id: 'reactor-video', supportedModes: ['text', 'image'] },
  [VIDEO_GEN_MODE.RUNWAY]: { id: 'runway-video', supportedModes: ['text', 'image'] },
};

/** The tagged loom's render dimensions, applied to `body`; null when untagged or the loom is gone. */
async function loadFableLoomRenderSettings(body) {
  if (!body.fableLoom) return null;
  const taggedLoom = await getLoom(body.fableLoom.loomId);
  if (!taggedLoom) return null;
  const settings = asFableLoomRenderSettings(taggedLoom.renderSettings);
  body.width = settings.width;
  body.height = settings.height;
  return settings;
}

/** Compiles the FableLoom tag into the prompt, source frame and visual-conditioning record. */
async function applyFableLoomConditioning({ body, prepared, backend, renderSettings }) {
  const conditioningModel = CONDITIONING_MODEL_BY_BACKEND[backend] ?? prepared.effectiveModel;
  const compiled = await compileFableLoomVisualRequest({
    tag: body.fableLoom,
    kind: 'video',
    capability: fableLoomVideoCapabilities({ backend, model: conditioningModel }),
    authoredPrompt: body.prompt,
    authoredNegativePrompt: body.negativePrompt,
    sourceImagePath: prepared.sourceImagePath,
  });
  if (!compiled) return;
  body.prompt = compiled.prompt;
  body.negativePrompt = compiled.negativePrompt;
  if (compiled.promptAdditions?.length) body.promptAdditions = [...(body.promptAdditions || []), ...compiled.promptAdditions];
  if (prepared.sourceImagePath && !compiled.sourceImagePath) {
    await prepared.discardSourceImage();
    prepared.uploadedTempPath = null;
    prepared.mode = 'text';
  }
  prepared.sourceImagePath = compiled.sourceImagePath;
  const { aspectRatio } = renderSettings || asFableLoomRenderSettings();
  body.visualConditioning = compiled.visualConditioning ? {
    ...compiled.visualConditioning,
    render: {
      provider: backend,
      modelId: conditioningModel?.id || null,
      modelRevision: conditioningModel?.revision || null,
      parameters: { width: body.width, height: body.height, aspectRatio },
    },
  } : null;
}

/**
 * Local lip-sync (LTX, or MiniMax H3 Ref2VA): the performance window is the a2v
 * audio, on a frame canvas that covers it (the helper pads the tail; the edit
 * points trim it).
 */
async function localPerformanceRequest({ body, prepared, performance }) {
  const [{ sourceAudioVideoRequest }, { localModelRendersPerformance }] = await Promise.all([
    import('../federatedMedia/sourceAudio.js'), import('../../lib/musicVideoLocalModels.js'),
  ]);
  const fail = (message, code) => { throw new ServerError(message, { status: 400, code }); };
  if (!localModelRendersPerformance(prepared.effectiveModel)) {
    fail(`${prepared.effectiveModel?.name || 'This local model'} cannot lip-sync; choose LTX-2.5, LTX-2.3 dgrauet or MiniMax H3 Ref2VA for performance shots`, 'MUSIC_VIDEO_PERFORMANCE_UNSUPPORTED');
  }
  const { audioWindow } = performance.shotInstruction;
  const { numFrames } = await Promise.resolve()
    .then(() => sourceAudioVideoRequest(audioWindow, prepared.effectiveModel, { fps: body.fps || 24 }))
    .catch((error) => fail(error.message, error.code || 'MUSIC_VIDEO_AUDIO_WINDOW_INVALID'));
  return {
    mode: 'a2v',
    numFrames,
    audioFilePath: performance.audioFilePath,
    audioStartSec: 0,
    disableAudio: false,
    uploadedTempPaths: [...(prepared.uploadedTempPaths || []), performance.audioFilePath],
    shotInstruction: performance.shotInstruction,
  };
}

const hostedPerformanceParams = (performance) => ({
  modelId: performance.modelId,
  // The output length follows the submitted audio window; a clip-length pin
  // would contradict it, so none is sent.
  duration: undefined,
  audioFilePath: performance.audioFilePath,
  // The lip-sync route's own output resolution (a cutaway resolution pin
  // names another model's alphabet, so the performance plan resolves it).
  resolution: performance.resolution,
  generateAudio: undefined,
  lipSync: { enableTranscription: performance.enableTranscription },
  shotInstruction: performance.shotInstruction,
});

/**
 * Music Video performance shots (#8977): a lip-synced scene renders only on a
 * verified source-audio provider, from the exact slice of the master song.
 * A cutaway scene (or any non-music-video render) gets all nulls and is
 * untouched; a performance scene on an incapable backend is refused here
 * rather than rendered as an unrelated voice or a silent cutaway.
 */
async function preparePerformanceSubmission({ body, prepared, backend, inputs }) {
  const none = { performance: null, localPerformanceParams: null, performanceParams: null };
  if (!body.musicVideo) return none;
  const performance = await preparePerformanceShot({
    musicVideo: body.musicVideo,
    backend,
    sourceImagePath: prepared.sourceImagePath,
    mode: body.mode,
    resolution: body.falResolution,
    musicModelId: backend === VIDEO_GEN_MODE.FAL ? body.falModelId || null : null,
  });
  if (!performance) return none;
  inputs.own(() => unlink(performance.audioFilePath).catch(() => {}));
  return backend === 'local'
    ? { ...none, performance, localPerformanceParams: await localPerformanceRequest({ body, prepared, performance }) }
    : { ...none, performance, performanceParams: hostedPerformanceParams(performance) };
}

/**
 * The last steps before the queue write, shared by every lane: music-video
 * guards, selective-revision check, the remote wire request, prompt additions,
 * then the queue write that takes over the acquired inputs.
 */
const createEnqueue = ({ body, prepared, performance, backend, inputs }) => async (params) => {
  let composedAdditions = [];
  if (body.musicVideo) {
    const { applyMusicVideoSubmissionGuards } = await import('../musicVideo/submissionGuards.js');
    composedAdditions = await applyMusicVideoSubmissionGuards({ body, params, prepared, performance, backend });
  }
  // Selective section revision (#9011): checked as the LAST step before the
  // actual queue write (staging, FableLoom compilation and the performance-
  // shot audio slice above can all take real time), so a revision closed
  // mid-submission is caught as close to the cancel/kickoff race as this
  // request can get. A no-op when the tag carries no revisionId; deferred
  // import since only this rare path needs the revision service's closure.
  if (body.musicVideo?.revisionId) {
    const { assertRevisionOpen } = await import('../musicVideo/revisionService.js');
    await assertRevisionOpen(body.musicVideo.projectId, body.musicVideo.revisionId, { sceneId: body.musicVideo.sceneId, kind: 'video' });
    if (performance?.shotInstruction?.repair) {
      inputs.own(async () => {
        const { releasePerformanceRepairSubmission } = await import('../musicVideo/revisionService.js');
        await releasePerformanceRepairSubmission(body.musicVideo.projectId, body.musicVideo.revisionId);
      });
    }
  }
  if (params.remoteMedia && params.musicVideo) {
    // Prompt augmentation still passes the strict wire boundary before any upload.
    params.remoteMedia.request = buildFederatedMediaRequest({ kind: 'video', params: { ...params.remoteMedia.request, prompt: params.prompt } });
  }
  if (params.remoteMedia && !params.musicVideo) delete params.prompt;
  // The labeled additions the composers put around the user's text ride with the job to its record.
  const additions = [...(body.promptAdditions || []), ...composedAdditions];
  if (additions.length) params.promptAdditions = additions;
  const job = await enqueueJob({ kind: 'video', params });
  inputs.transfer();
  return job;
};

// The request tags every hosted and local job carries to its record.
const submissionTagParams = (body) => ({
  ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
  ...(body.fableLoom ? { fableLoom: body.fableLoom } : {}),
  ...(body.musicVideoProjectId ? { musicVideoProjectId: body.musicVideoProjectId } : {}),
  ...(body.visualConditioning ? { visualConditioning: body.visualConditioning } : {}),
});

const submitRemoteLane = async ({ body, prepared, enqueue }) => {
  const { remoteMedia, audio } = prepared;
  const { jobId, position, status } = await enqueue({
    prompt: body.prompt, remoteMedia, ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
    ...(body.musicVideoProjectId ? { musicVideoProjectId: body.musicVideoProjectId } : {}),
    ...(body.musicVideo && prepared.sourceImagePath ? { sourceImagePath: prepared.sourceImagePath } : {}),
    ...(body.musicVideo ? { ...remoteMedia.request } : {}),
    ...(audio ? { audioConditioning: audio.audioConditioning, uploadedTempPaths: [audio.audioFilePath],
      shotInstruction: { version: 1, shotMode: 'cutaway', songInterval: audio.songInterval, audioConditioning: audio.audioConditioning } } : {}),
  });
  return { jobId, generationId: jobId, filename: `${jobId}.mp4`, model: remoteMedia.request.modelId,
    mode: null, mediaProviderPeerId: remoteMedia.peerId, status, position };
};

const submitHostedLane = async ({ body, prepared, backend, hosted, performanceParams, enqueue }) => {
  const { sourceImagePath, uploadedTempPath } = prepared;
  // A Music Video fal clip renders at its project's aspect: requested where
  // the model takes an aspect ratio, and its frames cropped to it where the
  // output follows the start frame (falFrameAspect.js). An explicit
  // visual-conditioning aspect (FableLoom) still wins.
  const projectAspect = (backend === VIDEO_GEN_MODE.FAL || backend === VIDEO_GEN_MODE.RUNWAY) && body.musicVideo && !body.visualConditioning?.render?.parameters?.aspectRatio
    ? await musicVideoProjectAspect(body.musicVideo.projectId)
    : null;
  // A Music Video shot animated on Grok carries its cast sheets beside the still,
  // so people stay recognizable once the clip moves past the opening frame.
  const castReferences = backend === VIDEO_GEN_MODE.GROK && body.musicVideo && sourceImagePath && !prepared.guidanceImagePath
    ? await (await import('../musicVideo/clipCastReferences.js')).musicVideoClipCastReferences(body.musicVideo)
    : [];
  const { jobId, position, status } = await enqueue({
    // Hosted jobs use mode for queue dispatch and videoMode for text/image.
    mode: backend,
    videoMode: body.mode || (sourceImagePath ? 'image' : 'text'),
    prompt: body.prompt,
    negativePrompt: body.negativePrompt || '',
    sourceImagePath,
    uploadedTempPath,
    ...submissionTagParams(body),
    ...hosted.buildParams(body, prepared),
    ...(castReferences.length ? { castReferences } : {}),
    ...(projectAspect ? { aspectRatio: projectAspect, frameAspect: projectAspect } : {}),
    // standalone fal lip sync: the uploaded voice clip (a Music Video performance shot overrides below)
    ...(prepared.audioFilePath ? { audioFilePath: prepared.audioFilePath, uploadedTempPaths: prepared.uploadedTempPaths, lipSync: { enableTranscription: false } } : {}),
    ...performanceParams,
  });
  return { jobId, generationId: jobId, filename: `${jobId}.mp4`, model: backend, mode: backend, status, position };
};

// Delivery controls a local render takes from the form. Default-valued ones
// stay absent from persisted params so a resumed form cannot restore a knob
// that never changed the render.
const localDeliveryParams = (body) => ({
  tiling: body.tiling || 'auto',
  ...(body.a2vLoraStageStrengths !== undefined ? { a2vLoraStageStrengths: body.a2vLoraStageStrengths } : {}),
  ...(isStockTextEncoder(body.textEncoderId) ? {} : { textEncoderId: body.textEncoderId }),
  ...(isDefaultSpeedProfile(body.speedProfileId) ? {} : { speedProfileId: body.speedProfileId }),
  ...(isFullDecode(body.draftDecode) ? {} : { draftDecode: body.draftDecode }),
  ...(isDefaultVideoStreamingMode(body.streamingMode) ? {} : { streamingMode: body.streamingMode }),
  // Absent means "use the settings.videoGen.displaySleep default" — only
  // forward it when the form actually sent an explicit choice.
  ...(body.displaySleep !== undefined ? { displaySleep: isTruthyMeta(body.displaySleep) } : {}),
  ...(isDefaultI2vReferenceMode(body.i2vReferenceMode) ? {} : { i2vReferenceMode: body.i2vReferenceMode }),
});

const submitLocalLane = async ({ body, prepared, localPerformanceParams, enqueue }) => {
  const { jobId, position, status } = await enqueue({
    pythonPath: prepared.pythonPath,
    prompt: body.prompt,
    negativePrompt: body.negativePrompt || '',
    modelId: body.modelId,
    width: body.width,
    height: body.height,
    ...(body.visualConditioning?.render?.parameters?.aspectRatio
      ? { aspectRatio: body.visualConditioning.render.parameters.aspectRatio }
      : {}),
    numFrames: prepared.effectiveNumFrames,
    fps: body.fps,
    steps: body.steps,
    guidanceScale: body.guidanceScale,
    seed: body.seed,
    ...(body.batchSize > 1 ? { batchSize: body.batchSize } : {}),
    ...localDeliveryParams(body),
    // A Music Video cutaway plays under the song, so its own soundtrack is never
    // heard: local clips render silent unless the song conditions them (a2v),
    // whatever the caller sent. Lip-sync shots set this back below.
    disableAudio: isTruthyMeta(body.disableAudio) || (Boolean(body.musicVideo) && prepared.mode !== 'a2v'),
    sourceImagePath: prepared.sourceImagePath,
    audioFilePath: prepared.audioFilePath,
    audioStartSec: body.audioStartSec,
    ...(prepared.audio ? { audioConditioning: prepared.audio.audioConditioning,
      shotInstruction: { version: 1, shotMode: 'cutaway', songInterval: prepared.audio.songInterval, audioConditioning: prepared.audio.audioConditioning } } : {}),
    uploadedTempPath: prepared.uploadedTempPath,
    uploadedTempPaths: prepared.uploadedTempPaths,
    lastImagePath: prepared.lastImagePath,
    keyframes: prepared.resolvedKeyframes,
    extendFromVideoPath: prepared.extendFromVideoPath,
    mode: prepared.mode,
    imageStrength: body.imageStrength,
    chunks: prepared.effectiveChunks,
    ...(prepared.effectiveChunkPrompts ? { chunkPrompts: prepared.effectiveChunkPrompts } : {}),
    // Zero is a real last-frame-chaining value; only nullish means absent.
    ...(prepared.effectiveContextFrames != null ? { contextFrames: prepared.effectiveContextFrames } : {}),
    ...(body.continuityStrategy != null ? { continuityStrategy: body.continuityStrategy } : {}),
    ...(prepared.continuation ? { continuation: prepared.continuation } : {}),
    loras: prepared.loras,
    icReferencePaths: prepared.icReferencePaths,
    ...(prepared.referenceImagePaths?.length ? { referenceImagePaths: prepared.referenceImagePaths } : {}),
    ...(prepared.referenceVideoPaths?.length ? { referenceVideoPaths: prepared.referenceVideoPaths } : {}),
    ...(prepared.referenceAudioPaths?.length ? { referenceAudioPaths: prepared.referenceAudioPaths } : {}),
    icStrength: body.icStrength,
    icAttentionStrength: body.icAttentionStrength,
    icSkipStage2: isTruthyMeta(body.icSkipStage2),
    ...submissionTagParams(body),
    ...localPerformanceParams,
  });
  return { jobId, generationId: jobId, filename: `${jobId}.mp4`, model: prepared.effectiveModelId, mode: 'local', status, position };
};

const submitValidatedVideoGenJob = async (body, uploads, inputs) => {
  const fableLoomRenderSettings = await loadFableLoomRenderSettings(body);
  if (body.musicVideo) {
    const { applyProjectRenderPool } = await import('../musicVideo/renderPool.js');
    body = await applyProjectRenderPool(body);
  }
  let prepared;
  ({ body, prepared } = await prepareVideoSubmissionInputs(body, uploads, inputs));
  const { backend } = prepared;
  if (body.fableLoom) await applyFableLoomConditioning({ body, prepared, backend, renderSettings: fableLoomRenderSettings });

  const { performance, localPerformanceParams, performanceParams } = await preparePerformanceSubmission({ body, prepared, backend, inputs });
  const enqueue = createEnqueue({ body, prepared, performance, backend, inputs });
  if (backend === 'remote') return submitRemoteLane({ body, prepared, enqueue });
  const hosted = HOSTED_VIDEO_SUBMISSIONS[backend];
  if (hosted) return submitHostedLane({ body, prepared, backend, hosted, performanceParams, enqueue });
  return submitLocalLane({ body, prepared, localPerformanceParams, enqueue });
};

/**
 * @param {object} body - validated/coerced request body, mutated with compiled
 *   FableLoom dimensions, prompts, and visual conditioning when present
 * @param {object} uploads - multipart uploads keyed by field name
 */
export async function submitVideoGenJob(body, uploads) {
  const submit = async () => {
    const inputs = createSubmissionInputs();
    try {
      return await submitValidatedVideoGenJob(body, uploads, inputs);
    } catch (err) {
      // The one submission-level unwind path. Preparation may already have
      // released the multipart files; that helper is idempotent.
      await inputs.release();
      await cleanupMultipartTemp(uploads).catch(() => {});
      throw err;
    }
  };
  return body.musicVideo
    ? maintenance.run('media-input', 'Music Video submission', submit, { continuation: true })
    : submit();
}
