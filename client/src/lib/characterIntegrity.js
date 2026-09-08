/**
 * Client-side half of the shared cast-integrity contract (#6415): the badge
 * copy, tones and hints the report renders the server's vocabulary with. The
 * vocabulary itself — finding kinds, review statuses, depths, dimensions and
 * `castIntegrityPassed` — is re-exported from the server's pure leaf, not
 * copied; `characterIntegrity.test.js` checks every value has a row here.
 */

import {
  AUGMENTABLE_FINDING_KINDS,
  CHARACTER_REVIEW_STATUSES,
  INCOMPLETE_REVIEW_STATUSES,
  INTEGRITY_DEPTHS,
  INTEGRITY_DIMENSIONS,
  INTEGRITY_DIMENSION_IDS,
  INTEGRITY_FINDING_KINDS,
  castIntegrityPassed,
} from '../../../server/lib/characterIntegrityVocabulary.js';

export {
  AUGMENTABLE_FINDING_KINDS,
  CHARACTER_REVIEW_STATUSES,
  INCOMPLETE_REVIEW_STATUSES,
  INTEGRITY_DEPTHS,
  INTEGRITY_DIMENSIONS,
  INTEGRITY_DIMENSION_IDS,
  INTEGRITY_FINDING_KINDS,
  castIntegrityPassed,
};

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

/** Dimension id → label, read off the server's own dimension table. */
export const DIMENSION_LABELS = Object.freeze(
  Object.fromEntries(INTEGRITY_DIMENSIONS.map((d) => [d.id, d.label])),
);

/** Whether a finding can be handed to the augment flow. */
export const findingIsRepairable = (finding) =>
  FINDING_KIND_META[finding?.kind]?.repairable === true;

/** Coverage rows that keep the report from being a clean pass, for the summary line. */
export const incompleteCoverage = (report) =>
  (report?.coverage || []).filter((c) => INCOMPLETE_REVIEW_STATUSES.includes(c.status));

/**
 * `psychology.drives.status.fear` → `Psychology › Drives › Status › Fear`.
 * Shared so every surface that lists findings names a field path the same way.
 */
export const humanizeIntegrityField = (field) => String(field || '')
  .split('.')
  .map((part) => part.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim())
  .join(' › ');
