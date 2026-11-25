// Read-only projection of prepared retry inputs. Never run submission
// preparation here: it can stage files and reconstruct the original prompt.
import { basename } from 'node:path';
import { ServerError } from '../lib/errorHandler.js';
import { VIDEO_GEN_MODE } from '../lib/generationModes.js';
import { carriedPromptAdditions, sentPromptRecord } from '../lib/modelInput.js';
import { getSettings } from './settings.js';
import { isRemoteMediaJob } from './mediaJobQueue/remoteMediaJob.js';

function referenceInputs(groups) {
  return groups.flatMap(([source, paths]) => (paths ?? []).flatMap((path) => (
    typeof path === 'string' && path ? [{ filename: basename(path), status: 'included', source }] : []
  )));
}

export async function previewRetryModelInput(kind, params) {
  // Federated queue rows only offer plain Retry. Their immutable wire request
  // ignores local edits, so a preview of merged local overrides would be false.
  if ((kind !== 'image' && kind !== 'video') || isRemoteMediaJob({ kind, params })) {
    throw new ServerError('This job does not support an editable retry preview', { status: 400, code: 'JOB_RETRY_PREVIEW_UNSUPPORTED' });
  }
  if (kind === 'image') {
    const { previewRetryImagePrompt } = await import('./imageGen/promptPreview.js');
    return previewRetryImagePrompt(params, await getSettings());
  }
  const referenceImages = referenceInputs([
    ['Start frame', [params.sourceImagePath]], ['End frame', [params.lastImagePath]],
    ['Storyboard', [params.guidanceImagePath]], ['Reference image', params.referenceImagePaths],
    ['Cast reference', params.castReferences?.map((ref) => ref.path)],
    ['Keyframe', params.keyframes?.map((frame) => frame.path)], ['Reference video', [params.sourceVideoPath, params.runwayVideoPath, params.runwayCharacterVideoPath]],
    ['Source audio', [params.audioFilePath]], ['Reference video', params.referenceVideoPaths],
    ['Reference audio', params.referenceAudioPaths], ['Conditioning image', params.icReferencePaths],
  ]);
  return { ...await previewVideo(params), ...(referenceImages.length ? { referenceImages } : {}) };
}

async function previewVideo(params) {
  const { mode, duration, frameAspect, sourceImagePath, lastImagePath, audioFilePath, referenceImagePaths = [],
    clipReferenceLabels, guidanceImagePath, sourceVideoPath, runwayVideoPath, runwayCharacterVideoPath } = params;
  const inputs = {
    ...params, seconds: duration, hasImage: !!sourceImagePath, hasEndImage: !!lastImagePath,
    hasAudio: !!audioFilePath, referenceCount: referenceImagePaths.length,
  };
  switch (mode) {
    case VIDEO_GEN_MODE.GROK: {
      const { grokVideoSentPrompt } = await import('./videoGen/grok.js');
      return grokVideoSentPrompt(params).record;
    }
    case VIDEO_GEN_MODE.FAL: {
      const { falVideoSentPrompt } = await import('./videoGen/fal.js');
      return falVideoSentPrompt({
        ...inputs, hasVideo: !!sourceVideoPath,
        guidanceReferences: guidanceImagePath ? referenceImagePaths.length : null,
        referenceCount: guidanceImagePath ? 0 : referenceImagePaths.length,
        clipReferenceLabels: guidanceImagePath ? null : clipReferenceLabels,
        ...(params.musicVideo ? { promptExpansion: 'disabled' } : {}),
      }).record;
    }
    case VIDEO_GEN_MODE.RUNWAY: {
      const { runwayVideoSentPrompt } = await import('./videoGen/runway.js');
      const { RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL } = await import('../lib/runwayVideoModels.js');
      return runwayVideoSentPrompt({
        ...inputs, modelId: params.modelId || RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL, aspectRatio: frameAspect || params.aspectRatio,
        hasVideo: !!runwayVideoPath, hasCharacterVideo: !!runwayCharacterVideoPath,
      }).record;
    }
    case VIDEO_GEN_MODE.HIGGSFIELD: {
      const { higgsfieldVideoSentPrompt } = await import('./videoGen/higgsfield.js');
      return higgsfieldVideoSentPrompt({ ...inputs, aspectRatio: params.aspectRatio || frameAspect }).record;
    }
    case VIDEO_GEN_MODE.GOOGLE: {
      const { googleVideoSentPrompt } = await import('./videoGen/google.js');
      return googleVideoSentPrompt({ ...inputs, aspectRatio: params.aspectRatio || frameAspect }).record;
    }
    case VIDEO_GEN_MODE.REACTOR: {
      const { validateReactorRequest } = await import('./videoGen/reactor.js');
      return sentPromptRecord({ sentPrompt: validateReactorRequest(params).prompt, carried: carriedPromptAdditions(params) });
    }
    case VIDEO_GEN_MODE.GEMINI:
      return sentPromptRecord({ sentPrompt: params.prompt, carried: carriedPromptAdditions(params) });
    default: {
      const { localVideoSentPrompt } = await import('./videoGen/generateVideo.js');
      const context = { ...params, loraFilenames: params.loras?.map((lora) => lora.filename) };
      const { record } = await localVideoSentPrompt(context);
      const chunks = Math.min(8, Math.trunc(Number(params.chunks) || 1));
      if (chunks <= 1 || !params.chunkPrompts?.some((beat) => beat?.trim())) return record;
      const segmentPrompts = await Promise.all(Array.from({ length: chunks }, async (_, index) => {
        const beat = params.chunkPrompts[index];
        return beat?.trim() ? (await localVideoSentPrompt({ ...context, prompt: beat })).record.sentPrompt : record.sentPrompt;
      }));
      return { ...record, segmentPrompts };
    }
  }
}
