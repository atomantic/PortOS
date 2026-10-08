/**
 * Hosted preparation policy and provider-specific queue fields. Configuration
 * is read from this submission's live settings; fal/Reactor credentials never
 * enter prepared output or persisted params (their workers resolve them).
 */
import { VIDEO_GEN_MODE, isVideoModeUsable } from './modes.js';

export const HOSTED_VIDEO_SUBMISSIONS = {
  [VIDEO_GEN_MODE.GROK]: {
    prepare: (settings) => {
      const grok = settings.imageGen?.grok || {};
      return { usable: grok.enabled, extras: { grok } };
    },
    errorCode: 'GROK_IMAGEGEN_DISABLED',
    errorMessage: 'Grok Imagegen is disabled — enable it in Settings → Image Gen first',
    buildParams: (body, prepared) => ({
      grokPath: prepared.grok.grokPath,
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio || prepared.grok.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.grokDuration,
    }),
  },
  [VIDEO_GEN_MODE.FAL]: {
    prepare: (settings) => ({
      usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.FAL),
      extras: {},
    }),
    errorCode: 'FAL_NOT_CONFIGURED',
    errorMessage: 'No fal.ai API key configured — set it in Settings → Video Gen (or the FAL_KEY env var) first',
    // The model, resolution and audio flag are resolved against the curated
    // catalog by videoGen/fal.js (an unsupported resolution falls back to the
    // model's default there); provider audio is off unless asked for.
    buildParams: (body, prepared) => ({
      modelId: body.falModelId,
      ...(prepared.lastImagePath ? { lastImagePath: prepared.lastImagePath } : {}),
      ...(prepared.uploadedTempPaths?.length ? { uploadedTempPaths: prepared.uploadedTempPaths } : {}),
      aspectRatio: body.visualConditioning?.render?.parameters?.aspectRatio,
      width: body.width,
      height: body.height,
      duration: body.falDuration,
      ...(body.falResolution ? { resolution: body.falResolution } : {}),
      ...(body.falGenerateAudio === true ? { generateAudio: true } : {}),
    }),
  },
  [VIDEO_GEN_MODE.REACTOR]: {
    prepare: (settings) => ({
      usable: isVideoModeUsable(settings, VIDEO_GEN_MODE.REACTOR),
      extras: {},
    }),
    errorCode: 'REACTOR_NOT_CONFIGURED',
    errorMessage: 'No reactor.inc API key configured — set it in Settings → Video Gen (or the REACTOR_API_KEY env var) first',
    buildParams: (body) => ({
      continueFromClipId: body.reactorClipId,
      seconds: body.reactorSeconds,
      seed: body.reactorSeed,
      aspect: body.reactorAspect,
    }),
  },
};
