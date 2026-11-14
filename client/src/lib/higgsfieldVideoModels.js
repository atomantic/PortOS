/**
 * Curated Higgsfield video model catalog.
 *
 * Re-export of `server/lib/higgsfieldVideoModels.js`, the one definition of
 * each family's lengths, sizes and inputs, so the Video Gen picker offers
 * exactly what the server sends.
 */
export {
  HIGGSFIELD_DEFAULT_VIDEO_MODEL,
  HIGGSFIELD_VIDEO_MODELS,
  HIGGSFIELD_VIDEO_MODEL_IDS,
  getHiggsfieldVideoModel,
  higgsfieldCapabilityHint,
  higgsfieldVideoLengths,
} from '../../../server/lib/higgsfieldVideoModels.js';
