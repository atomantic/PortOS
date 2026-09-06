/**
 * Client-side vocabulary for the shared cast-integrity contract (#6415).
 *
 * Mirrors the display-relevant half of `server/lib/characterIntegrity.js` —
 * the finding kinds, the review statuses, and the five semantic dimensions —
 * plus the labels/tones the report UI renders them with.
 *
 * MIRRORED, not imported: the server module pulls `storyBible.js` (crypto +
 * fileUtils) through `universeBibleCompleteness.js`, which has no place in the
 * browser bundle. `server/lib/characterIntegrity.mirror.test.js` fails when the
 * two lists drift, so this is a checked copy rather than a hopeful one.
 */

/** @see INTEGRITY_FINDING_KINDS in server/lib/characterIntegrity.js */
export const INTEGRITY_FINDING_KINDS = Object.freeze(['missing', 'underspecified', 'contradictory']);

/** @see AUGMENTABLE_FINDING_KINDS — `contradictory` needs the author, not a model. */
export const AUGMENTABLE_FINDING_KINDS = Object.freeze(['missing', 'underspecified']);

/** @see CHARACTER_REVIEW_STATUSES */
export const CHARACTER_REVIEW_STATUSES = Object.freeze([
  'passed', 'findings', 'not-reviewed', 'truncated', 'stale',
]);

/** @see INCOMPLETE_REVIEW_STATUSES — none of these license "clean". */
export const INCOMPLETE_REVIEW_STATUSES = Object.freeze(['not-reviewed', 'truncated', 'stale']);

/** @see INTEGRITY_DEPTHS */
export const INTEGRITY_DEPTHS = Object.freeze(['explained', 'light', 'full']);

/** @see INTEGRITY_DIMENSION_IDS */
export const INTEGRITY_DIMENSION_IDS = Object.freeze([
  'control-predicts-behavior',
  'origin-supports-control',
  'drives-specific',
  'relationships-pressure',
  'challenge-testable',
]);

/**
 * How each finding kind reads and what the user can do about it. `tone` maps to
 * the badge color; `repairable` is what gates the Augment button — offering it
 * on a `contradictory` finding would promise a fix the model cannot make,
 * because it cannot know which of the two conflicting fields is the wrong one.
 */
export const FINDING_KIND_META = Object.freeze({
  missing: Object.freeze({ label: 'Missing', tone: 'amber', repairable: true, hint: 'Nothing authored — fill it in, or let Expand fill the blanks.' }),
  underspecified: Object.freeze({ label: 'Underspecified', tone: 'amber', repairable: true, hint: 'Authored but too generic to predict behavior — Augment can propose a sharper version.' }),
  contradictory: Object.freeze({ label: 'Contradictory', tone: 'rose', repairable: false, hint: 'Two authored fields disagree. Only you can decide which one is wrong.' }),
});

/** Per-status badge copy for the coverage table. */
export const REVIEW_STATUS_META = Object.freeze({
  passed: Object.freeze({ label: 'Passed', tone: 'emerald' }),
  findings: Object.freeze({ label: 'Findings', tone: 'amber' }),
  'not-reviewed': Object.freeze({ label: 'Not reviewed', tone: 'slate' }),
  truncated: Object.freeze({ label: 'Truncated', tone: 'slate' }),
  stale: Object.freeze({ label: 'Stale', tone: 'slate' }),
});

/** Why a character was held to a lighter standard — shown so the report doesn't look arbitrary. */
export const DEPTH_META = Object.freeze({
  full: Object.freeze({ label: 'Full', hint: 'Held to the whole framework.' }),
  light: Object.freeze({ label: 'Light', hint: 'A minor role or a declared flat arc — only the conscious pursuit is expected.' }),
  explained: Object.freeze({ label: 'Explained', hint: 'You ruled the interior unknown or not applicable and said why. That is a finished assessment.' }),
});

export const DIMENSION_LABELS = Object.freeze({
  'control-predicts-behavior': 'Belief predicts behavior',
  'origin-supports-control': 'Origin supports the belief',
  'drives-specific': 'Drives are specific',
  'relationships-pressure': 'Relationships create pressure',
  'challenge-testable': 'Strategy is testable',
});

/** Whether a finding can be handed to the augment flow. */
export const findingIsRepairable = (finding) =>
  FINDING_KIND_META[finding?.kind]?.repairable === true;

/**
 * Whether a report may be described as a clean pass — mirrors
 * `castIntegrityPassed`. Any incomplete coverage row disqualifies it, so the UI
 * cannot render a green summary over a half-reviewed cast.
 */
export const castIntegrityPassed = (report) => {
  const coverage = report?.coverage || [];
  if (coverage.length === 0) return false;
  return coverage.every((c) => c.status === 'passed' && c.semanticReviewed);
};

/** Coverage rows that keep the report from being a clean pass, for the summary line. */
export const incompleteCoverage = (report) =>
  (report?.coverage || []).filter((c) => INCOMPLETE_REVIEW_STATUSES.includes(c.status));
