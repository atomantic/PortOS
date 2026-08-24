/**
 * MeatSpace POST drill-type vocabulary.
 *
 * These two lists sit below both validation and the POST services so a route
 * schema can enumerate a drill type without importing service-layer
 * orchestration (issue #4901). That mattered more than the layering nit:
 * `CACHEABLE_TYPES` used to live in `services/meatspacePostDrillCache.js`,
 * which imports the LLM drill generator — so `lib/postValidation.js`, loaded on
 * every POST route, transitively pulled in the LLM path just to know four
 * strings.
 *
 * A leaf module (no imports). The service modules re-export both lists, so
 * existing deep imports keep working.
 */

// Wordplay drills the cache can pre-generate and hold. A subset of the LLM
// drill types — the ones cheap and deterministic enough to prime ahead of use.
export const CACHEABLE_TYPES = Object.freeze([
  'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist',
]);

// Non-LLM cognitive drills, each backed by a generator in
// `services/meatspacePostCognitive.js`.
export const COGNITIVE_DRILL_TYPES = Object.freeze([
  'n-back',
  'digit-span',
  'stroop',
  'schulte-table',
  'mental-rotation',
  'reaction-time',
  'task-switching',
  'go-no-go',
  'flanker',
]);
