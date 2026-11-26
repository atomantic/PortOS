/**
 * Re-export of `server/lib/goalFeatureMap.js` — deterministic goal `category` → PortOS feature-area
 * deep-link map (Daily Driver).
 *
 * `getGoalFeatureAreas(goal)` honors the per-goal `featureAreas` override.
 */

/**
 * Goal → instance-feature mapping.
 *
 * Re-export of `server/lib/goalFeatureMap.js` — the one definition of this rule,
 * imported rather than copied so the two runtimes cannot drift. The file stays
 * so every `lib/goalFeatureMap` import path in the client is unchanged.
 */
export { GOAL_FEATURE_AREAS, FEATURE_AREA_IDS, getGoalFeatureAreas } from '../../../server/lib/goalFeatureMap.js';
