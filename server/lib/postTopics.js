/**
 * POST practice-topic registry (issue #3252).
 *
 * The single, enumerable answer to "what am I actually studying?" — one entry
 * per practice area, each owning the drill types that belong to it. Every
 * composition/recommendation path gates on this registry, so adding the next
 * study area is a registry entry plus a toggle rather than a new bespoke gate.
 *
 * Shape: `{ id, label, module, surface, drillTypes[] }`
 *   - `id`        — stable topic key; what the user's `config.topics` map is keyed by.
 *   - `module`    — the coarse POST module this topic's scored tasks report as
 *                   (`mental-math` / `llm-drills` / `cognitive` / `memory`), or
 *                   `null` for a topic that never posts a scored POST task (Morse,
 *                   which logs through the separate training-entry path). Topics
 *                   with a non-null module are exactly the POST *domains* the
 *                   client's `DOMAINS` map renders.
 *   - `surface`   — `'session'` when the launcher can compose the topic's drills
 *                   into a Full/Quick session, `'standalone'` when it is practiced
 *                   from its own tab (Memory items, Elements, Morse).
 *   - `drillTypes`— every drill type owned by the topic, including ones not yet
 *                   offered by the session picker (see the client's
 *                   `POST_UNSUPPORTED_DRILL_TYPES`).
 *
 * Mirrored to the client in `client/src/components/meatspace/post/constants.js`
 * (`POST_TOPICS`), where the UI-only fields — icon, color, time budget — are
 * layered on. `server/lib/postTopics.mirror.test.js` asserts the two lists match,
 * the same mirroring convention `canonPrompt.js` and `MEMORY_DRILL_TYPES` use.
 *
 * Enablement convention — **absent = enabled**, matching the existing per-drill
 * `drillTypes` convention: only an explicit `false` disables. That is what keeps
 * this change additive with no migration — a config saved before `topics`
 * existed behaves exactly as it did.
 */

export const POST_TOPICS = [
  {
    id: 'math',
    label: 'Mental Math',
    module: 'mental-math',
    surface: 'session',
    drillTypes: ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation'],
  },
  {
    id: 'memory',
    label: 'Memory',
    module: 'memory',
    surface: 'standalone',
    drillTypes: ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'],
  },
  {
    id: 'wordplay',
    label: 'Wordplay',
    module: 'llm-drills',
    surface: 'session',
    drillTypes: ['pun-wordplay', 'word-association', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'],
  },
  {
    id: 'verbal',
    label: 'Verbal Agility',
    module: 'llm-drills',
    surface: 'session',
    drillTypes: ['story-recall', 'verbal-fluency', 'wit-comeback'],
  },
  {
    id: 'imagination',
    label: 'Imagination',
    module: 'llm-drills',
    surface: 'session',
    drillTypes: ['what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'],
  },
  {
    id: 'cognitive',
    label: 'Cognitive',
    module: 'cognitive',
    surface: 'session',
    drillTypes: ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time'],
  },
  {
    // Morse is deliberately outside POST_MODULES (it posts through the separate,
    // unrestricted training-entry path, never a scored POST task) — hence a null
    // module. It still needs a topic so a user who isn't learning CW can switch
    // off its "Up next" recommendations (issue #3252).
    id: 'morse',
    label: 'Morse',
    module: null,
    surface: 'standalone',
    drillTypes: ['morse-copy', 'morse-head-copy', 'morse-send'],
  },
];

export const TOPIC_IDS = POST_TOPICS.map(t => t.id);

/** Topics the launcher can compose into a Full/Quick session. */
export const SESSION_TOPIC_IDS = POST_TOPICS.filter(t => t.surface === 'session').map(t => t.id);

// drill type → topic, built once at module load.
const TOPIC_BY_DRILL_TYPE = {};
for (const topic of POST_TOPICS) {
  for (const type of topic.drillTypes) TOPIC_BY_DRILL_TYPE[type] = topic;
}

/**
 * The topic that owns a drill type, or `null` for an unmapped/legacy type.
 * Callers treat `null` as "not topic-gated" rather than "disabled", so a drill
 * type added ahead of its registry entry is never silently suppressed.
 */
export function resolveTopicForDrillType(type) {
  return TOPIC_BY_DRILL_TYPE[type] || null;
}

/** The topic entry for an id, or `null`. */
export function getTopic(topicId) {
  return POST_TOPICS.find(t => t.id === topicId) || null;
}

/**
 * Whether a topic participates in composition/recommendations under `config`.
 * Absent entry = enabled (see the module header) — only an explicit `false`
 * disables, so a legacy config with no `topics` key enables everything.
 * An unknown topic id is treated as enabled for the same forward-compat reason.
 */
export function isTopicEnabled(config, topicId) {
  if (!topicId) return true;
  return config?.topics?.[topicId]?.enabled !== false;
}

/** Ids of every currently-enabled topic, in registry order. */
export function enabledTopicIds(config) {
  return TOPIC_IDS.filter(id => isTopicEnabled(config, id));
}

/**
 * Whether memory practice participates AT ALL — the topic entry and the module
 * block, WITHOUT consulting any drill type.
 *
 * The drill-type exclusion is load-bearing: a due-memory recommendation links
 * into a practice MODE (`/post/memory/<id>/spaced`, `/post/memory/elements/
 * element-flash`), not into a specific POST drill type. Gating those recs on one
 * arbitrary type would mean switching off e.g. Memory Sequence silently killed
 * the whole spaced-repetition reminder feed, including items whose recs never
 * run that type.
 */
export function isMemoryPracticeEnabled(config) {
  return isTopicEnabled(config, 'memory') && config?.memory?.enabled !== false;
}

/**
 * Whether an individual memory item participates in recommendations and in
 * `generateMemoryDrill`'s lowest-mastery candidate pool. Same absent = enabled
 * convention. A disabled item keeps its full mastery/schedule history and stays
 * practiceable on demand from its own page — this only scopes the *automatic*
 * paths (issue #3252). A null/absent id means "no specific item", which is never
 * filtered on its own — but memory practice still has to be on.
 */
export function isMemoryItemEnabled(config, itemId) {
  if (!isMemoryPracticeEnabled(config)) return false;
  if (!itemId) return true;
  return config?.memory?.items?.[itemId]?.enabled !== false;
}
