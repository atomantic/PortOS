/**
 * Compose-time preview of what a Video Gen render sends to its model (#11317):
 * the same backend resolution and the same per-backend prompt builders the
 * render runs, without staging uploads or queueing anything. An upload the form
 * holds is named in place of its staged path, and the grok scratch folder names
 * the job folder it will get.
 */
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServerError } from '../../lib/errorHandler.js';
import { resolveGalleryImage } from '../../lib/fileUtils.js';
import { carriedPromptAdditions, sentPromptRecord } from '../../lib/modelInput.js';
import { getSettings } from '../settings.js';
import { VIDEO_GEN_MODE } from './modes.js';
import { HOSTED_VIDEO_SUBMISSIONS } from './hostedSubmission.js';
import { resolveRequestedVideoBackend } from './prepareParams.js';
import { VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES, REFERENCE_AUDIO_FIELDS } from './requestFields.js';
import { grokVideoSentPrompt } from './grok.js';
import { resolveStoryboardGuidanceInputs, storyboardGuidanceRequestError } from './storyboardGuidance.js';
import { falVideoSentPrompt } from './fal.js';

export const PREVIEW_UPLOAD_FIELDS = ['sourceImage', 'lastImage', 'audioFile', ...REFERENCE_AUDIO_FIELDS, 'icReference', 'runwayVideo', 'runwayCharacterVideo'];
const UPLOADED_SOURCE_IMAGE = '(uploaded image)';

const asWritten = (body, extra = {}) => ({
  ...extra,
  ...sentPromptRecord({
    sentPrompt: body.prompt || '', sentNegativePrompt: body.negativePrompt || null,
    carried: carriedPromptAdditions(body),
  }),
});

export async function previewVideoPrompt({ previewUploads = [], ...body }) {
  // A shot card and a FableLoom scene rebuild the prompt from their project on
  // submit; their own previews belong to those surfaces, not this form's.
  if (body.musicVideo || body.fableLoom) {
    throw new ServerError('Preview a music video shot or FableLoom scene from its own card', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const uploads = Object.fromEntries(previewUploads.map((field) => [field, {}]));
  const settings = await getSettings();
  const backend = resolveRequestedVideoBackend({ body, uploads, settings, localOnlyParamKeys: VIDEO_GEN_LOCAL_ONLY_FIELD_NAMES });
  // A federated provider receives the prompt as written; its own backend may add lines there.
  if (body.mediaProviderPeerId) return asWritten(body, { backend: 'remote', remote: true });

  const hosted = HOSTED_VIDEO_SUBMISSIONS[backend];
  // The same refusal POST /video-gen gives a backend that is off or has no key.
  if (hosted && !hosted.prepare(settings).usable) {
    throw new ServerError(hosted.errorMessage, { status: 400, code: hosted.errorCode });
  }
  const hasSourceImage = !!uploads.sourceImage || !!body.sourceImageFile;
  const sourceImagePath = uploads.sourceImage ? UPLOADED_SOURCE_IMAGE
    : body.sourceImageFile ? resolveGalleryImage(body.sourceImageFile) : null;
  const promptAdditions = carriedPromptAdditions(body);
  const guidanceError = storyboardGuidanceRequestError({ body, uploads, backend });
  if (guidanceError) throw guidanceError;
  // A storyboard panel and its references, named by gallery path as the render names them.
  const guidance = resolveStoryboardGuidanceInputs(body, { lenient: true });

  if (backend === VIDEO_GEN_MODE.GROK) {
    return { backend, ...grokVideoSentPrompt({
      prompt: body.prompt, negativePrompt: body.negativePrompt,
      aspectRatio: settings.imageGen?.grok?.aspectRatio, width: body.width, height: body.height,
      duration: body.grokDuration, sourceImagePath, scratchDir: join(tmpdir(), 'portos-grok-video-<job>'), promptAdditions, ...guidance,
    }).record };
  }
  if (backend === VIDEO_GEN_MODE.FAL) {
    return { backend, ...falVideoSentPrompt({
      modelId: body.falModelId, prompt: body.prompt, negativePrompt: body.negativePrompt,
      seconds: body.falDuration, width: body.width, height: body.height, resolution: body.falResolution,
      generateAudio: body.falGenerateAudio === true, promptAdditions,
      hasImage: hasSourceImage, hasEndImage: !!uploads.lastImage || !!body.lastImageFile, hasAudio: !!uploads.audioFile,
      guidanceReferences: body.guidanceImageFile ? (body.referenceImageFiles || []).length : null,
    }).record };
  }
  if (backend === VIDEO_GEN_MODE.RUNWAY) {
    const { runwayVideoSentPrompt } = await import('./runway.js');
    return { backend, ...runwayVideoSentPrompt({
      modelId: body.runwayModelId, prompt: body.prompt, negativePrompt: body.negativePrompt,
      videoMode: body.mode, hasVideo: !!uploads.runwayVideo, hasCharacterVideo: !!uploads.runwayCharacterVideo,
      targetAspectRatio: body.runwayTargetAspect, ratio: body.runwayRatio,
      bodyControl: body.runwayBodyControl, expressionIntensity: body.runwayExpressionIntensity, seed: body.runwaySeed,
      seconds: body.runwayDuration, width: body.width, height: body.height, resolution: body.runwayResolution, promptAdditions,
      hasImage: hasSourceImage, hasEndImage: !!uploads.lastImage || !!body.lastImageFile,
    }).record };
  }
  if (backend === VIDEO_GEN_MODE.LOCAL) {
    // The local runner's modules load only for a local preview.
    const [{ defaultVideoModelId, listVideoModels }, { resolveVideoLoras }, { captureSystemCapabilities }] = await Promise.all([
      import('./local.js'), import('./renderArgs.js'), import('../../lib/systemCapabilities.js'),
    ]);
    const loraFilenames = body.loraFilenames || [];
    // The render's own LoRA refusals (missing file, not a video LoRA), minus
    // its one-time effect probe, which spawns Python and is cached for the render.
    if (loraFilenames.length) {
      const modelId = body.modelId || defaultVideoModelId(captureSystemCapabilities(), settings?.videoGen?.defaultModelId);
      const runtime = listVideoModels().find((model) => model.id === modelId)?.runtime ?? null;
      await resolveVideoLoras(loraFilenames.map((filename) => ({ filename })), { runtime });
    }
    const { localVideoSentPrompt } = await import('./generateVideo.js');
    return { backend, ...(await localVideoSentPrompt({
      prompt: body.prompt, negativePrompt: body.negativePrompt, loraFilenames, promptAdditions,
    })).record };
  }
  // reactor.inc receives the trimmed prompt with nothing added.
  return asWritten(body, { backend });
}
