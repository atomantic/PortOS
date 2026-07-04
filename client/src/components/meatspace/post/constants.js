export const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
// Mirrors the server's POST_SUPPORTED_MEMORY_TYPES (server/lib/postValidation.js)
// — all three memory drill types are now fully scored in a POST session (issue
// #2099/#2116): usePostSession.finishDrill uses this to tag the result's
// module as `memory` (not `mental-math`) and preserve memoryItemId so the
// server's schedule/mastery advancement fires.
export const MEMORY_DRILL_TYPES = ['memory-fill-blank', 'memory-sequence', 'memory-element-flash'];
// Deterministic cognitive drills (no LLM). Mirror the server's
// COGNITIVE_DRILL_TYPES in server/services/meatspacePostCognitive.js.
export const COGNITIVE_DRILL_TYPES = ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time'];

// Drill types valid elsewhere but not yet wired into the interactive POST
// session drill picker (DOMAINS.memory.drillTypes below) — memory-fill-blank's
// scoring path is fully correct now (see MEMORY_DRILL_TYPES above), it just
// isn't one of the types PostSessionLauncher offers to pick from yet.
export const POST_UNSUPPORTED_DRILL_TYPES = ['memory-fill-blank'];

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

// Domain definitions for 5-minute balanced sessions
export const DOMAINS = {
  math: {
    label: 'Mental Math',
    icon: 'Calculator',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/20',
    timeBudgetSec: 60,
    drillTypes: ['doubling-chain', 'serial-subtraction', 'multiplication', 'powers', 'estimation'],
  },
  memory: {
    label: 'Memory',
    icon: 'BookOpen',
    color: 'text-green-400',
    bgColor: 'bg-green-500/20',
    timeBudgetSec: 90,
    drillTypes: ['memory-sequence', 'memory-element-flash'],
  },
  wordplay: {
    label: 'Wordplay',
    icon: 'MessageCircle',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    timeBudgetSec: 60,
    drillTypes: ['pun-wordplay', 'word-association', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist'],
  },
  verbal: {
    label: 'Verbal Agility',
    icon: 'Mic',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    timeBudgetSec: 60,
    drillTypes: ['story-recall', 'verbal-fluency', 'wit-comeback'],
  },
  imagination: {
    label: 'Imagination',
    icon: 'Sparkles',
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    timeBudgetSec: 60,
    drillTypes: ['what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'],
  },
  cognitive: {
    label: 'Cognitive',
    icon: 'Brain',
    color: 'text-rose-400',
    bgColor: 'bg-rose-500/20',
    timeBudgetSec: 90,
    drillTypes: ['n-back', 'digit-span', 'stroop', 'schulte-table', 'mental-rotation', 'reaction-time'],
  },
};

// Map drill type → domain key
export const DRILL_TO_DOMAIN = {};
for (const [domainKey, domain] of Object.entries(DOMAINS)) {
  for (const dt of domain.drillTypes) {
    DRILL_TO_DOMAIN[dt] = domainKey;
  }
}

// Human-readable labels for all drill types
export const DRILL_LABELS = {
  'doubling-chain': 'Doubling Chain',
  'serial-subtraction': 'Serial Subtraction',
  'multiplication': 'Multiplication',
  'powers': 'Powers',
  'estimation': 'Estimation',
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
};

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
export const GOAL_DEFS = [
  { key: 'dailyMinutes', label: 'Minutes today', unit: 'min', metric: 'todayMinutes' },
  { key: 'weeklySessions', label: 'Sessions this week', unit: '', metric: 'weekSessions' },
  { key: 'streakTarget', label: 'Streak', unit: 'd', metric: 'currentStreak' },
  { key: 'morseWpmTarget', label: 'Morse WPM', unit: 'wpm', metric: 'morseWpm' },
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
