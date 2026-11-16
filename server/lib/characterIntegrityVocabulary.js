/**
 * Pure vocabulary for cast-integrity reports: finding kinds, review statuses, depths, dimensions, plus
 * `castIntegrityPassed` and the machine-repairable `AUGMENTABLE_FINDING` kinds.
 *
 * Cast-integrity vocabulary (#6415). A pure leaf on purpose: `characterIntegrity.js`
 * reaches `storyBible.js` (crypto + fileUtils), which has no place in the browser
 * bundle, yet the report UI needs these same lists (`client/src/lib/characterIntegrity.js`
 * re-exports this module). Import no Node built-in here.
 */

/**
 * What KIND of gap a finding reports; distinct repairs that must not collapse:
 *   - `missing`        — blank; fill-blanks closes it (deterministic).
 *   - `underspecified` — populated but too generic; augmentation can close it.
 *   - `contradictory`  — specific but at odds with another field; needs the author,
 *     since the report cannot know which field is wrong.
 */
export const INTEGRITY_FINDING_KINDS = Object.freeze(['missing', 'underspecified', 'contradictory']);

export const AUGMENTABLE_FINDING_KINDS = Object.freeze(['missing', 'underspecified']);

/** Semantic review questions: checks on the AUTHORED material, satisfiable by a deliberately flat, opaque or minor character. */
export const INTEGRITY_DIMENSIONS = Object.freeze([
  Object.freeze({
    id: 'control-predicts-behavior',
    label: 'Belief predicts behavior',
    question: 'Does the stated control belief actually predict the behavior the profile describes?',
  }),
  Object.freeze({
    id: 'origin-supports-control',
    label: 'Origin supports the belief',
    question: 'Does the Ghost/Wound history make this belief a plausible thing for this character to have concluded?',
  }),
  Object.freeze({
    id: 'drives-specific',
    label: 'Drives are specific',
    question: 'Are the survival, connection and status desires/fears distinct and specific to this character, rather than one sentiment restated three times?',
  }),
  Object.freeze({
    id: 'relationships-pressure',
    label: 'Relationships create pressure',
    question: 'Do the authored relationships put meaningful pressure on the belief, rather than only describing who knows whom?',
  }),
  Object.freeze({
    id: 'challenge-testable',
    label: 'Strategy is testable',
    question: 'Can a plausible story challenge test this strategy — is there something that would actually cost this character to hold onto it?',
  }),
]);
export const INTEGRITY_DIMENSION_IDS = Object.freeze(INTEGRITY_DIMENSIONS.map((d) => d.id));

/**
 * Per-character coverage. `passed` and `not-reviewed` must NOT be the same answer, or a
 * review that skipped half the cast would read as clean.
 *   - `not-reviewed` — outside the requested scope, or the pass never reached it
 *   - `truncated`    — the review's budget cut this character off
 *   - `stale`        — the character changed after the report was measured
 */
export const CHARACTER_REVIEW_STATUSES = Object.freeze([
  'passed', 'findings', 'not-reviewed', 'truncated', 'stale',
]);

export const INCOMPLETE_REVIEW_STATUSES = Object.freeze(['not-reviewed', 'truncated', 'stale']);

/**
 * How much of the framework a character carries, COMPUTED from what the author declared
 * (minor roles and flat arcs get lighter requirements, not manufactured trauma):
 *   - `explained` — author ruled the interior out (`psychology.assessment` of
 *     `unknown` / `not-applicable`) AND said why; nothing further is asked.
 *   - `light`     — declared minor role or flat arc; wants only motivations/want.
 *   - `full`      — everything else.
 */
export const INTEGRITY_DEPTHS = Object.freeze(['explained', 'light', 'full']);

/** Whether a report licenses "reviewed and clean"; incomplete coverage cannot pass. */
export const castIntegrityPassed = (report) => {
  const coverage = report?.coverage || [];
  if (coverage.length === 0) return false;
  return coverage.every((c) => c.status === 'passed' && c.semanticReviewed);
};
