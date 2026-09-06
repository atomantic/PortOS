/**
 * Goal → instance-feature mapping.
 *
 * Re-export of `server/lib/goalFeatureMap.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/goalFeatureMap` import path in the client is unchanged.
 */
export {
  FEATURE_AREAS,
  FEATURE_AREA_IDS,
  GOAL_CATEGORY_FEATURE_MAP,
  getGoalFeatureAreas,
} from '../../../server/lib/goalFeatureMap.js';
