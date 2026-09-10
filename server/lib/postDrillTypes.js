/**
 * MeatSpace POST drill-type vocabulary.
 *
 * These lists sit below both validation and the POST services so a route
 * schema can enumerate a drill type without importing service-layer
 * orchestration (issue #4901). That mattered more than the layering nit:
 * `CACHEABLE_TYPES` used to live in `services/meatspacePostDrillCache.js`,
 * which imports the LLM drill generator — so `lib/postValidation.js`, loaded on
 * every POST route, transitively pulled in the LLM path just to know four
 * strings.
 *
 * A leaf module (no imports). The service modules re-export the lists they
 * used to own, so existing deep imports keep working, and the client's
 * `meatspace/post/constants.js` re-exports them too — each vocabulary has
 * exactly one definition instead of a hand-copied server/client mirror.
 */

// Every drill type the LLM drill generator (`services/meatspacePostLlm.js`)
// can produce and score. Also the enum behind the llm-drill config and task
// schemas in `lib/postValidation.js` and the client's "is this an LLM drill?"
// checks.
export const LLM_DRILL_TYPES = Object.freeze([
  'word-association',
  'story-recall',
  'verbal-fluency',
  'wit-comeback',
  'pun-wordplay',
  'compound-chain',
  'bridge-word',
  'double-meaning',
  'idiom-twist',
  'what-if',
  'alternative-uses',
  'story-prompt',
  'invention-pitch',
  'reframe',
]);

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

// Memory drills supported by the POST runner (client-side scoring with string
// comparison) — trusted for score + schedule/mastery advancement on session
// submit (issue #2099). Currently identical to MEMORY_DRILL_TYPES; kept as a
// separate list (rather than aliasing MEMORY_DRILL_TYPES directly) so a FUTURE
// memory drill type can ship generation-only, ahead of its scoring support,
// without silently trusting a client-supplied score for it.
export const POST_SUPPORTED_MEMORY_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
