/**
 * Hosted preparation policy and provider-specific queue fields. Configuration
 * is read from this submission's live settings; fal/Reactor credentials never
 * enter prepared output or persisted params (their workers resolve them).
 */
import { ServerError } from '../../lib/errorHandler.js';
import { isDefaultI2vReferenceMode } from '../../lib/videoReferenceModes.js';
import { VIDEO_GEN_MODE, isVideoModeUsable } from './modes.js';

// Every hosted backend anchors a reference image as frame one, so a loose
// reference mode is a local-runtime promise it can never keep. Submission
// refuses it up front (prepareParams); a retry replays persisted params past
// that gate, so the same refusal has to be stated here (#4874).
const assertAnchoredReference = (backend, params) => {
  if (isDefaultI2vReferenceMode(params.i2vReferenceMode)) return;
  throw new ServerError(
    `The ${backend} backend always anchors a reference image as frame one — retry this job with the Anchor reference mode, or render it locally on LTX-2.5.`,
    { status: 400, code: 'I2V_REFERENCE_MODE_UNSUPPORTED' },
  );
};

export const HOSTED_VIDEO_SUBMISSIONS = {
  [VIDEO_GEN_MODE.GROK]: {
    prepare: (settings) => {
      const grok = settings.imageGen?.grok || {};
      return { usable: grok.enabled, extras: { grok } };
    },
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.GROK, params),
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
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.FAL, params),
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
    validateRetry: (params) => assertAnchoredReference(VIDEO_GEN_MODE.REACTOR, params),
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

/**
 * Retry validator for a persisted hosted video job, or null for a local job.
 * Hosted retries replay provider params the local model catalog knows nothing
 * about (a fal provider id, Reactor's seconds/seed), so they are validated by
 * the backend's own `validateRetry` and never by the local validator. Own-key
 * lookup: `params.mode` is persisted data, so `constructor`/`__proto__` must
 * not resolve to an inherited member.
 */
export const hostedVideoRetryValidator = (mode) => (
  typeof mode === 'string' && Object.hasOwn(HOSTED_VIDEO_SUBMISSIONS, mode)
    ? HOSTED_VIDEO_SUBMISSIONS[mode].validateRetry
    : null
);
