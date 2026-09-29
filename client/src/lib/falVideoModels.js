/**
 * Curated fal.ai video model catalog.
 *
 * Re-export of `server/lib/falVideoModels.js` — the one definition of each fal
 * model's request rules and list price, imported rather than copied so the
 * board's cost estimate and the server's request body cannot drift.
 */
export {
  FAL_DEFAULT_IMAGE_VIDEO_MODEL,
  FAL_DEFAULT_TEXT_VIDEO_MODEL,
  FAL_IMAGE_VIDEO_MODELS,
  FAL_VIDEO_MODELS,
  describeFalVideoRate,
  estimateFalVideoCostUsd,
  falVideoResolutions,
  getFalVideoModel,
} from '../../../server/lib/falVideoModels.js';
