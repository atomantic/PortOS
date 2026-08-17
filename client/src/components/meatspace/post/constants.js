export const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
// Mirrors the server's POST_SUPPORTED_MEMORY_TYPES (server/lib/postValidation.js)
// — all three memory drill types are now fully scored in a POST session (issue
// #2099/#2116): usePostSession.finishDrill uses this to tag the result's
// module as `memory` (not `mental-math`) and preserve memoryItemId so the
// server's schedule/mastery advancement fires.
export const MEMORY_DRILL_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
// Deterministic cognitive drills (no LLM). Mirror the server's
// COGNITIVE_DRILL_TYPES in server/services/meatspacePostCognitive.js.
export const COGNITIVE_DRILL_TYPES = ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time', 'task-switching', 'go-no-go', 'flanker'];

// Drill types valid elsewhere but not yet wired into the interactive POST
// session drill picker. Multi-blank fill-in-the-blank is now wired end to end,
// so this remains empty until a future generation-only type needs the guard.
export const POST_UNSUPPORTED_DRILL_TYPES = [];

// The server generators have item-shape requirements: Sequence Recall needs a
// successor line, while Element Flash is backed by the built-in periodic-table
// item. Keep the launcher and Practice Plan preview from advertising a drill
// that would make generation return null.
export function memoryItemSupportsDrill(item, drillType) {
  if (drillType === 'memory-sequence') {
    return (item?.content?.lines || [])
      .filter(line => (typeof line === 'string' ? line : line?.text || '').trim())
      .length >= 2;
  }
  if (drillType === 'memory-element-flash') return item?.id === 'elements-song';
  return true;
}

/** Lowest-mastery enabled item that can generate a specific memory drill. */
export function selectMemoryItemForDrill(items, drillType) {
  const compatible = (items || []).filter(item => memoryItemSupportsDrill(item, drillType));
  if (!compatible.length) return null;
  return compatible.reduce((lowest, item) =>
    (item?.mastery?.overallPct ?? 0) < (lowest?.mastery?.overallPct ?? 0) ? item : lowest
  );
}

// The four wordplay drill types with a dedicated standalone trainer
// (WordplayTrainer.jsx) that shares its render+scoring core (WordplayDrillUI.jsx)
// with the in-session runner (PostLlmDrillRunner.jsx) — see issue #2097.
export const WORDPLAY_LLM_DRILL_TYPES = ['compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'];

// Score (0-100) at or above which an LLM-scored response counts as "correct"
// for training-log purposes. Matches the >=70 "success" color threshold
// already used across POST training UI (WordplayTrainer, PostLlmDrillRunner).
export const LLM_TRAINING_CORRECT_THRESHOLD = 70;

// Count how many scored LLM responses clear the correct threshold. Accepts
// either a `score` field (WordplayTrainer's per-response results array) or an
// `llmScore` field (scoreLlmDrill's server-returned `questions[]`) — the two
// entry points name the scored field differently.
export function countLlmCorrect(scoredResponses = []) {
  return scoredResponses.filter(r => (r?.llmScore ?? r?.score ?? 0) >= LLM_TRAINING_CORRECT_THRESHOLD).length;
}

// ---------------------------------------------------------------------------
// Practice topics (issue #3252)
// ---------------------------------------------------------------------------
// MIRROR of server/lib/postTopics.js `POST_TOPICS` — the single source of truth
// for "what am I actually studying?". Keep the two identical: id / label /
// module / surface / drillTypes are asserted field-for-field by
// server/lib/postTopics.mirror.test.js, which imports THIS file.
//
// Only the plain registry data lives here; the UI-only presentation (icon,
// color, per-domain time budget) is layered on in TOPIC_UI below, so a topic
// added server-side shows up here as soon as its UI row is filled in.
export const POST_TOPICS = [
  {
    id: 'math',
    label: 'Mental Math',
    module: 'mental-math',
    surface: 'session',
    drillTypes: ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation', 'applied-numeracy'],
  },
  {
    id: 'memory',
    label: 'Memory',
    module: 'memory',
    surface: 'session',
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
    drillTypes: ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time', 'task-switching', 'go-no-go', 'flanker'],
  },
  {
    id: 'morse',
    label: 'Morse',
    module: null,
    surface: 'standalone',
    drillTypes: ['morse-copy', 'morse-head-copy', 'morse-send'],
  },
];

export const TOPIC_IDS = POST_TOPICS.map(t => t.id);

// Per-topic presentation. `timeBudgetSec` is only meaningful for topics that
// compose into a session (it sizes the drill's slice of a 5-minute Quick run);
// Morse carries none because it never composes.
export const TOPIC_UI = {
  math: { icon: 'Calculator', color: 'text-blue-400', bgColor: 'bg-blue-500/20', timeBudgetSec: 60 },
  memory: { icon: 'BookOpen', color: 'text-green-400', bgColor: 'bg-green-500/20', timeBudgetSec: 90 },
  wordplay: { icon: 'MessageCircle', color: 'text-purple-400', bgColor: 'bg-purple-500/20', timeBudgetSec: 60 },
  verbal: { icon: 'Mic', color: 'text-amber-400', bgColor: 'bg-amber-500/20', timeBudgetSec: 60 },
  imagination: { icon: 'Sparkles', color: 'text-cyan-400', bgColor: 'bg-cyan-500/20', timeBudgetSec: 60 },
  cognitive: { icon: 'Brain', color: 'text-rose-400', bgColor: 'bg-rose-500/20', timeBudgetSec: 90 },
  morse: { icon: 'Radio', color: 'text-sky-400', bgColor: 'bg-sky-500/20' },
};

/** The topic that owns a drill type, or `null` for an unmapped/legacy type. */
export function resolveTopicForDrillType(type) {
  return POST_TOPICS.find(t => t.drillTypes.includes(type)) || null;
}

/**
 * Whether a topic participates in composition/recommendations under `config`.
 * MIRRORS the server's `isTopicEnabled` — absent entry = enabled, so a config
 * that predates the `topics` key behaves exactly as it did before.
 */
export function isTopicEnabled(config, topicId) {
  if (!topicId) return true;
  return config?.topics?.[topicId]?.enabled !== false;
}

/**
 * MIRRORS the server's `isMemoryPracticeEnabled` — the topic entry plus the
 * module block, with no drill type consulted.
 */
export function isMemoryPracticeEnabled(config) {
  return isTopicEnabled(config, 'memory') && config?.memory?.enabled !== false;
}

/**
 * MIRRORS the server's `isMemoryItemEnabled` — a per-item opt-out that keeps the
 * item's mastery/schedule history and its own practice page, and only removes it
 * from the automatic rotation.
 */
export function isMemoryItemEnabled(config, itemId) {
  if (!isMemoryPracticeEnabled(config)) return false;
  if (!itemId) return true;
  return config?.memory?.items?.[itemId]?.enabled !== false;
}

// Domain definitions for 5-minute balanced sessions — DERIVED from POST_TOPICS
// so the domain list has exactly one owner. A POST *domain* is a topic that
// reports a coarse module (i.e. can produce a scored POST task); Morse has a
// null module and is therefore not a domain. Generation-only types are filtered
// out here through POST_UNSUPPORTED_DRILL_TYPES.
export const DOMAINS = Object.fromEntries(
  POST_TOPICS
    .filter(t => t.module)
    .map(t => [t.id, {
      label: t.label,
      ...TOPIC_UI[t.id],
      drillTypes: t.drillTypes.filter(dt => !POST_UNSUPPORTED_DRILL_TYPES.includes(dt)),
    }])
);

// Map drill type → domain key
export const DRILL_TO_DOMAIN = {};
for (const [domainKey, domain] of Object.entries(DOMAINS)) {
  for (const dt of domain.drillTypes) {
    DRILL_TO_DOMAIN[dt] = domainKey;
  }
}

// Coarse module → the config block that carries its per-drill `enabled` flags.
// Mirrors the server's MODULE_CONFIG_KEY (meatspacePost.js), extended with
// `memory` now that it has a real config block (issue #3252).
export const MODULE_CONFIG_KEY = {
  'mental-math': 'mentalMath',
  'llm-drills': 'llmDrills',
  cognitive: 'cognitive',
  memory: 'memory',
};

// Human label for a coarse module. Several topics share `llm-drills`, so no
// single topic label names it — hence an explicit map rather than deriving from
// the first topic. Shared by Config's Session Composition checkboxes and the
// Practice Plan's group headings so the same module can't be called two
// different things on two screens.
export const MODULE_LABELS = {
  'mental-math': 'Mental Math',
  'llm-drills': 'Wit & Memory (AI)',
  cognitive: 'Cognitive',
  memory: 'Memory',
};

/** Whether a coarse module passes the `sessionModules` composition filter. */
export function isModuleInSession(config, module) {
  const sm = Array.isArray(config?.sessionModules) ? config.sessionModules : null;
  // null = legacy/absent → all modules allowed; an explicit array (INCLUDING an
  // empty one) is honored as-is.
  return sm === null || sm.includes(module);
}

/**
 * The drill types a Full/Quick composed session would actually run right now,
 * grouped by topic id — the data behind the Practice Plan's "your daily POST
 * will include…" summary (issue #3252).
 *
 * MIRRORS PostSessionLauncher's filter chain, in the same order: topic enabled →
 * `sessionModules` → module `enabled` → per-drill `enabled`. It iterates the
 * SAVED config's `drillTypes` entries (not the registry's full list) for the
 * same reason the launcher does: a drill type absent from the config was never
 * offered by the launcher either, so the preview must not invent it. Math drills
 * are opt-IN (`enabled` truthy) while LLM/cognitive/memory are opt-OUT
 * (`enabled !== false`) — again matching the launcher exactly. When the loaded
 * memory item list is supplied, memory drills also require a compatible enabled
 * item, and drill types the session runner does not expose are always omitted.
 */
export function composedSessionDrillTypes(config, memoryItems = null) {
  const out = {};
  for (const topic of POST_TOPICS) {
    if (topic.surface !== 'session' || !topic.module) continue;
    if (!isTopicEnabled(config, topic.id)) continue;
    if (!isModuleInSession(config, topic.module)) continue;
    const mod = config?.[MODULE_CONFIG_KEY[topic.module]];
    if (!mod || mod.enabled === false) continue;
    const types = topic.drillTypes.filter((t) => {
      if (POST_UNSUPPORTED_DRILL_TYPES.includes(t)) return false;
      const cfg = mod.drillTypes?.[t];
      if (!cfg) return false;
      const enabled = topic.module === 'mental-math' ? !!cfg.enabled : cfg.enabled !== false;
      if (!enabled) return false;
      if (topic.module !== 'memory' || !Array.isArray(memoryItems)) return true;
      return memoryItems.some(item => isMemoryItemEnabled(config, item.id) && memoryItemSupportsDrill(item, t));
    });
    if (types.length) out[topic.id] = types;
  }
  return out;
}

// Human-readable labels for all drill types
export const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation',
  'applied-numeracy': 'Applied Numeracy',
  'word-association': 'Word Association',
  'story-recall': 'Story Recall',
  'verbal-fluency': 'Verbal Fluency',
  'wit-comeback': 'Wit & Comeback',
  'pun-wordplay': 'Pun & Wordplay',
  'compound-chain': 'Compound Chain',
  'bridge-word': 'Bridge Word',
  'double-meaning': 'Double Meaning',
  'idiom-twist': 'Idiom Twist',
  'memory-fill-blank': 'Memory Fill Blank',
  'memory-sequence': 'Memory Sequence',
  'memory-element-flash': 'Element Flash',
  // Standalone flash-card study mode (ElementsSong.jsx). Label only — NOT added
  // to MEMORY_DRILL_TYPES / DOMAINS.memory.drillTypes because it isn't a POST
  // session drill (the server has no memory-element-study generator).
  'memory-element-study': 'Element Study',
  'what-if': 'What If?',
  'alternative-uses': 'Alternative Uses',
  'story-prompt': 'Story Prompt',
  'invention-pitch': 'Invention Pitch',
  'reframe': 'Reframe',
  'n-back': 'N-Back',
  'digit-span': 'Digit Span',
  'stroop': 'Stroop',
  'schulte-table': 'Schulte Table',
  'mental-rotation': 'Mental Rotation',
  'reaction-time': 'Reaction Time',
  'task-switching': 'Task Switching',
  'go-no-go': 'Go / No-Go',
  'flanker': 'Flanker Control',
};

function parseAppliedNumeracyInput(value, question) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(-?(?:\d+|\d+\.\d+|\d+\s*\/\s*-?\d+))\s*([a-zA-Z]+)?$/);
  if (!match) return null;
  const fraction = match[1].match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
  const numeric = fraction
    ? Number(fraction[1]) / Number(fraction[2])
    : Number(match[1]);
  if (!Number.isFinite(numeric) || (fraction && Number(fraction[2]) === 0)) return null;
  const suppliedUnit = match[2]?.toLowerCase() || null;
  const unit = suppliedUnit ? (question.unitAliases?.[suppliedUnit] || suppliedUnit) : null;
  return { numeric, unit };
}

// The client provides immediate training feedback from public generated metadata;
// submitPostSession always reconstructs the seeded question server-side.
export function appliedNumeracyAnswerCorrect(value, question = {}) {
  const parsed = parseAppliedNumeracyInput(value, question);
  if (!parsed) return false;
  let expected = question.expected;
  let actual = parsed.numeric;
  if (question.unit) {
    const suppliedFactor = question.unitOptions?.[parsed.unit];
    const expectedFactor = question.unitOptions?.[question.unit];
    if (!suppliedFactor || !expectedFactor) return false;
    actual *= suppliedFactor;
    expected *= expectedFactor;
  } else if (parsed.unit) {
    return false;
  }
  const tolerance = question.tolerance || {};
  const margin = Math.max(tolerance.absolute || 0, Math.abs(expected) * (tolerance.relative || 0));
  return Math.abs(actual - expected) <= margin + 1e-9;
}

// Human-readable label for a domain key. `other` collects drills whose type
// isn't mapped to a DOMAINS bucket (e.g. legacy/removed drill types).
export const domainLabel = (key) => (key === 'other' ? 'Other' : DOMAINS[key]?.label || key);

// Derive per-domain averages from getPostStats().byDrill, which is keyed
// `${task.module}:${task.type}`. task.module is COARSE (`mental-math`,
// `llm-drills`, `memory`) so the real fine-grained domain must come from the
// drill TYPE via DRILL_TO_DOMAIN — NOT the module segment. The per-domain score
// is the mean of that domain's per-drill averages. Returns an array of
// { key, label, score } sorted by score descending (strongest first).
export function computeDomainAverages(byDrill = {}) {
  const groups = {};
  for (const [key, score] of Object.entries(byDrill)) {
    const type = key.slice(key.indexOf(':') + 1);
    const domain = DRILL_TO_DOMAIN[type] || 'other';
    if (!groups[domain]) groups[domain] = [];
    groups[domain].push(score);
  }
  return Object.entries(groups)
    .map(([key, scores]) => ({
      key,
      label: domainLabel(key),
      score: Math.round(scores.reduce((a, b) => a + b, 0) / scores.length),
    }))
    .sort((a, b) => b.score - a.score);
}

// Practice goals (issue #2100). A goal is "set" only when its target is a
// positive number, so an absent/legacy `goals` object (or `{}`) yields no goal
// rows and the UI hides cleanly.
// `max` mirrors postGoalsSchema's bounds (server/lib/postValidation.js) so the
// number inputs can't submit an out-of-range value that would 400 on save.
export const GOAL_DEFS = [
  { key: 'dailyMinutes', label: 'Minutes today', unit: 'min', metric: 'todayMinutes', max: 1440 },
  { key: 'weeklySessions', label: 'Sessions this week', unit: '', metric: 'weekSessions', max: 100 },
  { key: 'streakTarget', label: 'Streak', unit: 'd', metric: 'currentStreak', max: 3650 },
  { key: 'morseWpmTarget', label: 'Morse WPM', unit: 'wpm', metric: 'morseWpm', max: 100 },
];

export function hasGoals(goals) {
  if (!goals || typeof goals !== 'object') return false;
  return GOAL_DEFS.some(({ key }) => typeof goals[key] === 'number' && goals[key] > 0);
}

/**
 * Progress toward each set goal. `goals` is the config's `goals` block; `metrics`
 * supplies the current values (`todayMinutes`, `weekSessions`, `currentStreak`,
 * `morseWpm`). Returns one row per goal that's actually set AND whose current
 * metric is available (a goal whose metric is unknown — e.g. Morse WPM with no
 * Morse data — is skipped rather than shown as 0). Pure.
 */
export function computeGoalProgress(goals = {}, metrics = {}) {
  const rows = [];
  for (const def of GOAL_DEFS) {
    const target = goals?.[def.key];
    if (typeof target !== 'number' || !(target > 0)) continue;
    const current = metrics?.[def.metric];
    if (typeof current !== 'number' || Number.isNaN(current)) continue;
    const pct = Math.max(0, Math.min(100, Math.round((current / target) * 100)));
    rows.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      current: Math.round(current * 10) / 10,
      target,
      pct,
      met: current >= target,
    });
  }
  return rows;
}

// Difficulty badge color helper
export const getDifficultyColor = (difficulty) => {
  if (difficulty === 'hard') return 'bg-port-error/20 text-port-error';
  if (difficulty === 'medium') return 'bg-port-warning/20 text-port-warning';
  return 'bg-port-success/20 text-port-success';
};

// Balanced (signal-detection) accuracy for n-back questions, derived from only
// `answered` + `correct` — the fields BOTH legacy stored sessions and pre-save
// client results carry. `correct` has always been computed as
// "(pressed ? match : no-match) === expected", so `isTarget = pressed === correct`
// is an identity across old and new scorers; legacy raw `correct` flags must
// NOT be averaged directly (a never-press run would still read ~70%). A missing
// signal class counts as chance (0.5). Mirrors `nBackBalancedAccuracy` in
// server/services/meatspacePost.js — keep the two in sync (issue #2094).
export function nBackBalancedAccuracy(questions) {
  let hits = 0, misses = 0, falseAlarms = 0, correctRejections = 0;
  for (const q of Array.isArray(questions) ? questions : []) {
    const pressed = q?.answered === 'match';
    const isTarget = pressed === !!q?.correct;
    if (isTarget) { if (pressed) hits += 1; else misses += 1; }
    else if (pressed) falseAlarms += 1;
    else correctRejections += 1;
  }
  const hitRate = hits + misses ? hits / (hits + misses) : null;
  const crRate = correctRejections + falseAlarms ? correctRejections / (correctRejections + falseAlarms) : null;
  return hitRate == null && crRate == null ? null : ((hitRate ?? 0.5) + (crRate ?? 0.5)) / 2;
}
