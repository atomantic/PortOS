export const LLM_DRILL_TYPES = ['word-association', 'story-recall', 'verbal-fluency', 'wit-comeback', 'pun-wordplay', 'what-if', 'alternative-uses', 'story-prompt', 'invention-pitch', 'reframe'];
// memory-fill-blank excluded: uses answers[] array instead of expected, needs dedicated runner
export const MEMORY_DRILL_TYPES = ['memory-sequence', 'memory-element-flash'];

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
    drillTypes: ['pun-wordplay', 'word-association'],
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
};

// Map drill type → domain key
export const DRILL_TO_DOMAIN = {};
for (const [domainKey, domain] of Object.entries(DOMAINS)) {
  for (const dt of domain.drillTypes) {
    DRILL_TO_DOMAIN[dt] = domainKey;
  }
}
