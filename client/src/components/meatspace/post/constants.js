export const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'compound-chain', 'bridge-word', 'double-meaning', 'idiom-twist', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
export const MEMORY_DRILL_TYPES = ['memory-sequence', 'memory-element-flash'];
// Deterministic cognitive drills (no LLM). Mirror the server's
// COGNITIVE_DRILL_TYPES in server/services/meatspacePostCognitive.js.
export const COGNITIVE_DRILL_TYPES = ['n-back', 'digit-span', 'stroop'];

// Drill types valid elsewhere but not yet supported by the POST runner.
// These use answers[] arrays instead of expected and need dedicated runners.
export const POST_UNSUPPORTED_DRILL_TYPES = ['memory-fill-blank'];

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
    drillTypes: ['n-back', 'digit-span', 'stroop'],
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

// Difficulty badge color helper
export const getDifficultyColor = (difficulty) => {
  if (difficulty === 'hard') return 'bg-port-error/20 text-port-error';
  if (difficulty === 'medium') return 'bg-port-warning/20 text-port-warning';
  return 'bg-port-success/20 text-port-success';
};
