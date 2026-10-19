/**
 * Curated Runway video model catalog.
 *
 * Re-export of `server/lib/runwayVideoModels.js` — the one definition of each
 * Runway model's request rules and list price, imported rather than copied so
 * the board's cost estimate and the server's request body cannot drift.
 */
export {
  RUNWAY_DEFAULT_IMAGE_VIDEO_MODEL,
  RUNWAY_VIDEO_MODELS,
  coerceRunwayVideoSeconds,
  describeRunwayVideoRate,
  estimateRunwayVideoCostUsd,
  getRunwayVideoModel,
  runwayVideoClipQuote,
  runwayModelTakesText,
  runwayVideoLengths,
  runwayVideoResolutions,
} from '../../../server/lib/runwayVideoModels.js';
