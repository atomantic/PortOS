/**
 * Client re-export of prompt-stage model tier vocabulary: `STAGE_MODEL_TIER_OPTIONS` for selects and
 * `canonicalStageModelTier` to normalize legacy stored tiers.
 *
 * Re-export of `server/lib/stageModelTiers.js` — the prompt-stage tier vocabulary
 * (`STAGE_MODEL_TIER_OPTIONS` rows for every stage model select, `canonicalStageModelTier` so a legacy
 * stored `quick`/`coding` still selects Light/Medium, `isStageModelTier`).
 */

export { STAGE_MODEL_TIER_OPTIONS, canonicalStageModelTier } from '../../../server/lib/stageModelTiers.js';
