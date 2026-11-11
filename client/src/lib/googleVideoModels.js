/**
 * Curated Google Cloud Agent Platform video model catalog (Veo).
 *
 * Re-export of `server/lib/googleVideoModels.js`, the one definition of each
 * model's lengths, sizes and inputs, so the Video Gen picker offers exactly
 * what the server sends.
 */
export {
  GOOGLE_DEFAULT_VIDEO_MODEL,
  GOOGLE_VIDEO_MODELS,
  GOOGLE_VIDEO_MODEL_IDS,
  getGoogleVideoModel,
  coerceGoogleVideoSeconds,
  googleVideoLengths,
  googleShotRequestFields,
} from '../../../server/lib/googleVideoModels.js';
