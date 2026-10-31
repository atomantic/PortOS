/**
 * Curated fal.ai video model catalog.
 *
 * Re-export of `server/lib/falVideoModels.js` — the one definition of each fal
 * model's request rules and list price, imported rather than copied so the
 * board's cost estimate and the server's request body cannot drift.
 */
export {
  FAL_AUDIO_VIDEO_MODEL,
  FAL_AUDIO_VIDEO_MODELS,
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_DEFAULT_TEXT_VIDEO_MODEL,
  FAL_IMAGE_VIDEO_MODELS,
  FAL_MUSIC_VIDEO_DEFAULT_MODEL,
  FAL_VIDEO_MODELS,
  coerceFalVideoSeconds,
  describeFalVideoRate,
  estimateFalVideoCostUsd,
  falHearsAudioReference,
  falImageVideoQuotes,
  falPromptExpansionAddition,
  falPromptExpansionMode,
  falVideoClipQuote,
  falVideoResolutions,
  getFalVideoModel,
} from '../../../server/lib/falVideoModels.js';
