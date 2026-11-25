// Structured session-condition options (issue #4442) — fixed enums instead
// of free text, so values are filterable/comparable across sessions rather
// than the prior "good/poor", "1 cup" free-text guesswork.
export const SLEEP_QUALITY_OPTIONS = ['poor', 'fair', 'good'];
export const CAFFEINE_OPTIONS = ['none', 'low', 'moderate', 'high'];
export const STRESS_OPTIONS = ['low', 'moderate', 'high'];

// Drives the three condition <select>s below — one entry per enum field, so
// adding/renaming a field is a one-line change instead of a copy-pasted block.
export const CONDITION_SELECT_FIELDS = [
  { key: 'sleepQuality', label: 'Sleep', options: SLEEP_QUALITY_OPTIONS },
  { key: 'caffeine', label: 'Caffeine', options: CAFFEINE_OPTIONS },
  { key: 'stress', label: 'Stress', options: STRESS_OPTIONS },
];
