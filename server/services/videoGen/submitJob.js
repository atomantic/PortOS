/**
 * Submit a validated video-generation request to its federated, hosted, or local
 * dispatch lane. HTTP parsing and validation stay in the route; this service
 * owns every subsequent orchestration and rollback decision.
 */

import { unlink } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { buildFederatedMediaRequest } from '../../lib/federatedMediaRequest.js';
import { asFableLoomRenderSettings } from '../../lib/fableLoomProduction.js';
import { isFullDecode } from '../../lib/videoDraftDecoders.js';
import { isDefaultVideoStreamingMode } from '../../lib/videoStreamingMode.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { isDefaultSpeedProfile } from '../../lib/videoSpeedProfiles.js';
import { isStockTextEncoder } from '../../lib/videoTextEncoders.js';
import { collectRemoteInputAssets } from '../federatedMedia/inputAssets.js';
import { prepareRemoteMediaJob } from '../federatedMedia/remoteSubmission.js';
import { getLoom } from '../fableLoom/records.js';
import {
  compileFableLoomVisualRequest,
  fableLoomVideoCapabilities,
} from '../fableLoom/visualConditioning.js';
import { VIDEO_GEN_MODE } from './modes.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { preparePerformanceShot } from '../musicVideo/performanceShot.js';
import {
  cleanupMultipartTemp,
  prepareVideoGenParams,
  withStagedRollback,
} from './prepareParams.js';
import { VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES } from './requestFields.js';

import { isTruthyMeta } from '../../lib/metadataFlags.js';
const submitValidatedVideoGenJob = async (body, uploads) => {
  let fableLoomRenderSettings = null;
  if (body.fableLoom) {
    const taggedLoom = await getLoom(body.fableLoom.loomId);
    if (taggedLoom) {
      fableLoomRenderSettings = asFableLoomRenderSettings(taggedLoom.renderSettings);
      body.width = fableLoomRenderSettings.width;
      body.height = fableLoomRenderSettings.height;
    }
  }

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
      ['LoRA weights', body.loraFilenames?.length],
      ['chained chunks', body.chunks > 1],
      ['warm render batches', body.batchSize > 1],
      ['the Grok backend', body.backend === 'grok'],
      ['a FableLoom scene tag', body.fableLoom],
      // Inspire is a per-runtime capability the caller cannot prove for a peer.
      // Refuse it instead of returning an anchored clip under an Inspire label.
      ['a loose reference mode', !isDefaultI2vReferenceMode(body.i2vReferenceMode)],
      ['a music-video scene tag', body.musicVideo],
    ].filter(([, present]) => present).map(([label]) => label);
    if (unsupported.length) {
      throw new ServerError(
        `A federated media provider cannot render this clip — it uses ${unsupported.join(' and ')}. Render locally instead.`,
        { status: 400, code: 'MEDIA_PROVIDER_INPUT_UNSUPPORTED' },
      );
    }

    const inputAssets = collectRemoteInputAssets('video', body);
    const impliedMode = body.lastImageFile ? 'fflf' : body.sourceImageFile ? 'image' : 'text';
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

    const request = buildFederatedMediaRequest({ kind: 'video', params: body });
    const { peer, remoteMedia } = await prepareRemoteMediaJob({
      peerId: body.mediaProviderPeerId,
      kind: 'video',
      request,
      inputAssets,
    });
    const { jobId, position, status } = await enqueueJob({
      kind: 'video',
      params: { remoteMedia },
    });
    return {
      jobId,
      generationId: jobId,
      filename: `${jobId}.mp4`,
      model: request.modelId,
      mode: null,
      mediaProviderPeerId: peer.id,
      status,
      position,
    };
  }

  const prepared = await prepareVideoGenParams({
    body,
    uploads,
    localOnlyParamKeys: VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES,
  });
  const { backend, cleanupStaged } = prepared;

  if (body.fableLoom) {
    const conditioningModel = backend === VIDEO_GEN_MODE.GROK
      ? { id: 'grok-video', supportedModes: ['image'] }
      : backend === VIDEO_GEN_MODE.FAL
        ? { id: 'fal-video', supportedModes: ['text', 'image'] }
        : backend === VIDEO_GEN_MODE.REACTOR
          ? { id: 'reactor-video', supportedModes: ['text', 'image'] }
          : prepared.effectiveModel;
    const compiled = await compileFableLoomVisualRequest({
      tag: body.fableLoom,
      kind: 'video',
      capability: fableLoomVideoCapabilities({ backend, model: conditioningModel }),
      authoredPrompt: body.prompt,
      authoredNegativePrompt: body.negativePrompt,
      sourceImagePath: prepared.sourceImagePath,
    }).catch(async (error) => {
      await cleanupStaged();
      throw error;
    });
    if (compiled) {
      body.prompt = compiled.prompt;
      body.negativePrompt = compiled.negativePrompt;
      if (prepared.sourceImagePath && !compiled.sourceImagePath) {
        await prepared.discardSourceImage();
        prepared.uploadedTempPath = null;
        prepared.mode = 'text';
      }
      prepared.sourceImagePath = compiled.sourceImagePath;
      const renderSettings = fableLoomRenderSettings || asFableLoomRenderSettings();
      body.visualConditioning = compiled.visualConditioning ? {
        ...compiled.visualConditioning,
        render: {
          provider: backend,
          modelId: conditioningModel?.id || null,
          modelRevision: conditioningModel?.revision || null,
          parameters: {
            width: body.width,
            height: body.height,
            aspectRatio: renderSettings.aspectRatio,
          },
        },
      } : null;
    }
  }

  // Music Video performance shots (#8977): a lip-synced scene renders only on a
  // verified source-audio provider, from the exact slice of the master song.
  // A cutaway scene (or any non-music-video render) gets null and is untouched;
  // a performance scene on an incapable backend is refused here rather than
  // rendered as an unrelated voice or a silent cutaway.
  const performance = body.musicVideo
    ? await preparePerformanceShot({
      musicVideo: body.musicVideo,
      backend,
      sourceImagePath: prepared.sourceImagePath,
      mode: body.mode,
      resolution: body.falResolution,
    }).catch(async (error) => {
      await cleanupStaged();
      throw error;
    })
    : null;
  const performanceParams = performance ? {
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
  } : null;

  const enqueue = (params) => withStagedRollback(
    async () => {
      if (performance) await unlink(performance.audioFilePath).catch(() => {});
      await cleanupStaged();
    },
    async () => {
      // Selective section revision (#9011): checked as the LAST step before the
      // actual queue write (staging, FableLoom compilation and the performance-
      // shot audio slice above can all take real time), so a revision closed
      // mid-submission is caught as close to the cancel/kickoff race as this
      // request can get. A no-op when the tag carries no revisionId; deferred
      // import since only this rare path needs the revision service's closure.
      if (body.musicVideo?.revisionId) {
        const { assertRevisionOpen } = await import('../musicVideo/revisionService.js');
        await assertRevisionOpen(body.musicVideo.projectId, body.musicVideo.revisionId, { sceneId: body.musicVideo.sceneId, kind: 'video' });
      }
      if (body.musicVideo?.productionRunId) {
        const { assertProductionSubmission } = await import('../musicVideo/productionService.js');
        await assertProductionSubmission(body.musicVideo.projectId, body.musicVideo.productionRunId,
          body.musicVideo.productionStepKey, { sceneId: body.musicVideo.sceneId, kind: 'video' });
      }
      if (body.musicVideo) {
        const [{ getProject }, { assertShotActionContract, withShotActionPrompt }] = await Promise.all([
          import('../musicVideo/projects.js'), import('../../lib/musicVideoActionContract.js'),
        ]);
        const project = await getProject(body.musicVideo.projectId);
        const scene = project?.scenes?.find((entry) => entry.sceneId === body.musicVideo.sceneId);
        assertShotActionContract(scene);
        params.prompt = withShotActionPrompt(params.prompt, project, scene, { offsetSec: performance?.shotInstruction?.edit?.inSec || 0 });
        if (scene?.direction?.actionContract != null) {
          const interval = performance?.shotInstruction?.songInterval;
          if (interval && (interval.startSec !== scene.startSec || interval.endSec !== scene.endSec)) {
            throw new ServerError('The shot timing changed while its performance audio was prepared — submit again', { status: 409, code: 'MUSIC_VIDEO_SHOT_TIMING_CHANGED' });
          }
          const requestedSec = performance?.shotInstruction?.audioWindow?.durationSec ?? params.duration
            ?? (Number.isFinite(params.numFrames) ? (params.numFrames - 1) / (params.fps || 24) : null);
          const offsetSec = performance?.shotInstruction?.edit?.inSec || 0;
          const lastEventSec = Math.max(0, ...['actions', 'reactions'].flatMap((key) => (scene.direction.actionContract[key] || []).map((event) => event.endSec))) + offsetSec;
          if (Number.isFinite(requestedSec) && lastEventSec > requestedSec) {
            throw new ServerError('Shot actions do not fit inside the requested provider clip — increase its duration', { status: 422, code: 'MUSIC_VIDEO_ACTION_CONTRACT_INVALID' });
          }
          params.shotInstruction = {
            ...(params.shotInstruction || { version: 1, shotMode: scene.shotMode || 'cutaway', songInterval: { startSec: scene.startSec, endSec: scene.endSec } }),
            actionContract: structuredClone(scene.direction.actionContract),
          };
        }
        const { captureTakeDependencies } = await import('../../lib/musicVideoDependencies.js');
        const { basename } = await import('path');
        if (scene) params.musicVideoDependencies = captureTakeDependencies(scene, prepared.sourceImagePath ? basename(prepared.sourceImagePath) : null);
      }
      return enqueueJob({ kind: 'video', params });
    },
  );

  const hosted = HOSTED_VIDEO_SUBMISSIONS[backend];
  if (hosted) {
    const { sourceImagePath, uploadedTempPath } = prepared;
    const { jobId, position, status } = await enqueue({
      // Hosted jobs use mode for queue dispatch and videoMode for text/image.
      mode: backend,
      videoMode: sourceImagePath ? 'image' : 'text',
      prompt: body.prompt,
      negativePrompt: body.negativePrompt || '',
      sourceImagePath,
      uploadedTempPath,
      ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
      ...(body.fableLoom ? { fableLoom: body.fableLoom } : {}),
      ...(body.visualConditioning ? { visualConditioning: body.visualConditioning } : {}),
      ...hosted.buildParams(body, prepared),
      ...performanceParams,
    });
    return {
      jobId,
      generationId: jobId,
      filename: `${jobId}.mp4`,
      model: backend,
      mode: backend,
      status,
      position,
    };
  }

  const {
    pythonPath, effectiveModelId, effectiveNumFrames, mode,
    sourceImagePath, lastImagePath, audioFilePath, icReferencePaths,
    resolvedKeyframes, extendFromVideoPath,
    uploadedTempPath, uploadedTempPaths, loras, effectiveChunks,
    effectiveChunkPrompts, effectiveContextFrames,
  } = prepared;
  const { jobId, position, status } = await enqueue({
    pythonPath,
    prompt: body.prompt,
    negativePrompt: body.negativePrompt || '',
    modelId: body.modelId,
    width: body.width,
    height: body.height,
    ...(body.visualConditioning?.render?.parameters?.aspectRatio
      ? { aspectRatio: body.visualConditioning.render.parameters.aspectRatio }
      : {}),
    numFrames: effectiveNumFrames,
    fps: body.fps,
    steps: body.steps,
    guidanceScale: body.guidanceScale,
    seed: body.seed,
    ...(body.batchSize > 1 ? { batchSize: body.batchSize } : {}),
    tiling: body.tiling || 'auto',
    // Default-valued delivery controls stay absent from persisted params so a
    // resumed form cannot restore a knob that never changed the render.
    ...(isStockTextEncoder(body.textEncoderId) ? {} : { textEncoderId: body.textEncoderId }),
    ...(isDefaultSpeedProfile(body.speedProfileId) ? {} : { speedProfileId: body.speedProfileId }),
    ...(isFullDecode(body.draftDecode) ? {} : { draftDecode: body.draftDecode }),
    ...(isDefaultVideoStreamingMode(body.streamingMode) ? {} : { streamingMode: body.streamingMode }),
    disableAudio: isTruthyMeta(body.disableAudio),
    // Absent means "use the settings.videoGen.displaySleep default" — only
    // forward it when the form actually sent an explicit choice.
    ...(body.displaySleep !== undefined
      ? { displaySleep: isTruthyMeta(body.displaySleep) }
      : {}),
    sourceImagePath,
    audioFilePath,
    audioStartSec: body.audioStartSec,
    uploadedTempPath,
    uploadedTempPaths,
    lastImagePath,
    keyframes: resolvedKeyframes,
    extendFromVideoPath,
    mode,
    imageStrength: body.imageStrength,
    ...(isDefaultI2vReferenceMode(body.i2vReferenceMode) ? {} : { i2vReferenceMode: body.i2vReferenceMode }),
    chunks: effectiveChunks,
    ...(effectiveChunkPrompts ? { chunkPrompts: effectiveChunkPrompts } : {}),
    // Zero is a real last-frame-chaining value; only nullish means absent.
    ...(effectiveContextFrames != null ? { contextFrames: effectiveContextFrames } : {}),
    loras,
    icReferencePaths,
    icStrength: body.icStrength,
    icAttentionStrength: body.icAttentionStrength,
    icSkipStage2: isTruthyMeta(body.icSkipStage2),
    ...(body.musicVideo ? { musicVideo: body.musicVideo } : {}),
    ...(body.fableLoom ? { fableLoom: body.fableLoom } : {}),
    ...(body.visualConditioning ? { visualConditioning: body.visualConditioning } : {}),
  });
  return {
    jobId,
    generationId: jobId,
    filename: `${jobId}.mp4`,
    model: effectiveModelId,
    mode: 'local',
    status,
    position,
  };
};

/**
 * @param {object} body - validated/coerced request body, mutated with compiled
 *   FableLoom dimensions, prompts, and visual conditioning when present
 * @param {object} uploads - multipart uploads keyed by field name
 */
export async function submitVideoGenJob(body, uploads) {
  try {
    return await submitValidatedVideoGenJob(body, uploads);
  } catch (err) {
    // Preparation may already have released these request-scoped files. The
    // cleanup helper is idempotent, so this remains the one submission-level
    // unwind path without issuing duplicate unlinks.
    await cleanupMultipartTemp(uploads).catch(() => {});
    throw err;
  }
}
