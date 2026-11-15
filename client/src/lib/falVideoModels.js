/**
 * Client re-export of the server's fal.ai video model catalog, including audio-to-video lanes,
 * per-model request rules and `estimateFalVideoCostUsd`.
 *
 * Re-export of `server/lib/falVideoModels.js` — the curated fal.ai video model catalog (including the
 * `FAL_AUDIO_VIDEO_MODELS` audio-to-video lanes), per-model request rules and
 * `estimateFalVideoCostUsd()`. Used by the Music Video fal model picker
 * (`components/musicVideo/VideoRenderSettings.jsx`) and the Video Gen page's fal model suggestions.
 */

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
  falCapabilityHint,
  falHearsAudioReference,
  falImageVideoQuotes,
  falPromptExpansionAddition,
  falPromptExpansionMode,
  falVideoClipQuote,
  falVideoResolutions,
  getFalVideoModel,
} from '../../../server/lib/falVideoModels.js';
