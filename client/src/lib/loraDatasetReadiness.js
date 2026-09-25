/**
 * LoRA dataset training-readiness thresholds, trigger-word matching, and
 * caption-invariant analysis.
 *
 * Re-export of `server/lib/loraDataset.js` — the one definition of these
 * rules, imported rather than copied so the page-local advisory (which
 * updates the instant a caption is edited or an image deleted, without a
 * server round-trip — see `client/src/pages/LoraDatasetDetail.jsx`) cannot
 * drift from `computeDatasetReadiness` / `validateDatasetReady`, the
 * authoritative gate the server applies at train time (#8297). The server
 * module is dependency-free (`isPlainObject`, `escapeRegExp` — no Node
 * builtins), so it is safe to bundle into the browser build; see
 * `scripts/client-server-import-purity.test.js`.
 */
export {
  MIN_TRAINING_IMAGES,
  RECOMMENDED_TRAINING_IMAGES,
  TRAINING_IMAGE_SWEET_SPOT_MAX,
  INVARIANT_SHARE_THRESHOLD,
  MIN_CAPTIONS_FOR_INVARIANT_ANALYSIS,
  isValidTriggerWord,
  captionHasTriggerWord,
  datasetQualityTier,
  computeDatasetReadiness,
  analyzeCaptionInvariants,
} from '../../../server/lib/loraDataset.js';
