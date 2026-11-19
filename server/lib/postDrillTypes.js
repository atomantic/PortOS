/**
 * MeatSpace POST drill vocabularies, kept below validation and the POST services.
 *
 * MeatSpace POST drill vocabularies (`LLM_DRILL_TYPES`, `CACHEABLE_TYPES`, `COGNITIVE_DRILL_TYPES`, `POST_SUPPORTED_MEMORY_TYPES`), kept below validation and the POST services so a route schema can enumerate a drill type without importing service orchestration (#4901: `CACHEABLE_TYPES` lived in `services/meatspacePostDrillCache.js`, which imports the LLM drill generator, so `lib/postValidation.js`, loaded on every POST route, pulled in the LLM path for four strings).
 * A leaf (no imports): service modules re-export the lists they used to own and the client's `meatspace/post/constants.js` re-exports them, so each vocabulary has one definition.
 */

// Every drill type the LLM drill generator (`services/meatspacePostLlm.js`) can produce and score; also the enum behind the llm-drill config/task schemas in `lib/postValidation.js` and the client's "is this an LLM drill?" checks.
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

export const MEMORY_DRILL_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];

// Memory drills supported by the POST runner (client-side string-comparison scoring), trusted for score + schedule/mastery advancement on session submit (#2099). Currently identical to MEMORY_DRILL_TYPES but a separate list so a FUTURE memory drill can ship generation-only, ahead of scoring support, without trusting a client-supplied score.
export const POST_SUPPORTED_MEMORY_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
