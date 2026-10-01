/**
 * Shared limits and joint constraints for the POST cognitive drills whose
 * manual settings are RELATED pairs (digit-span span, reaction-time delay
 * window, Go/No-Go deadline vs stimulus). Browser-safe leaf: no imports.
 *
 * The generators (meatspacePostCognitive.js) normalize a pair that violates
 * its relation; this module lets the browser and the config route reject the
 * same pair up front so what is saved is what runs.
 */

/** `low` is the independent member; `high` must be >= `low`. */
export const COGNITIVE_PAIR_CONSTRAINTS = Object.freeze({
  'digit-span': {
    low: { key: 'startLength', label: 'Start Length', min: 3, max: 9, fallback: 3 },
    high: { key: 'maxLength', label: 'Max Length', min: 3, max: 12, fallback: 8 },
  },
  'reaction-time': {
    low: { key: 'minDelayMs', label: 'Min Delay (ms)', min: 300, max: 5000, fallback: 1000 },
    high: { key: 'maxDelayMs', label: 'Max Delay (ms)', min: 300, max: 8000, fallback: 3000 },
  },
  'go-no-go': {
    low: { key: 'stimulusMs', label: 'Stimulus (ms)', min: 100, max: 2000, fallback: 600 },
    high: { key: 'responseDeadlineMs', label: 'Response Deadline (ms)', min: 500, max: 5000, fallback: 1400 },
  },
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Ladder-managed types ignore manual pair values unless progressive is off. */
const LADDERED_TYPES = new Set(['digit-span', 'go-no-go']);

/**
 * Whether the stored pair values drive the run: reaction-time has no ladder,
 * the others only honor manual values when `progressive === false`.
 */
function pairIsManual(type, config) {
  return !LADDERED_TYPES.has(type) || config?.progressive === false;
}

/**
 * Relational errors for a drill's (merged) config: `[{ field, message }]`,
 * empty when the type has no pair, the values are unset, or the ladder owns them.
 */
export function validateCognitivePair(type, config) {
  const pair = COGNITIVE_PAIR_CONSTRAINTS[type];
  if (!pair || !config || !pairIsManual(type, config)) return [];
  const low = config[pair.low.key];
  const high = config[pair.high.key];
  if (!isNum(low) || !isNum(high) || high >= low) return [];
  return [{
    field: pair.high.key,
    message: `${pair.high.label} must be at least ${pair.low.label} (${low})`,
  }];
}

/** Effective minimum for the dependent (`high`) member given its partner. */
export function dependentMin(type, config) {
  const pair = COGNITIVE_PAIR_CONSTRAINTS[type];
  if (!pair) return undefined;
  const low = config?.[pair.low.key];
  return isNum(low) ? Math.max(pair.high.min, low) : pair.high.min;
}
