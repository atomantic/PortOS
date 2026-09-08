/**
 * The cast-integrity vocabulary (#6415): the finding kinds, review statuses,
 * depths and semantic dimensions a report is stated in, plus the one predicate
 * that reads a whole report (`castIntegrityPassed`).
 *
 * A pure leaf on purpose. `characterIntegrity.js` (the passes and the merge)
 * reaches `storyBible.js` (crypto + fileUtils) through
 * `universeBibleCompleteness.js`, which has no place in the browser bundle —
 * yet the report UI decides which findings offer an Augment button, which
 * statuses keep a cast from reading as clean and how a dimension is labelled
 * from these same lists. Keeping them here lets both runtimes import ONE
 * definition (`client/src/lib/characterIntegrity.js` re-exports this module).
 * Import no Node built-in here.
 */

/**
 * What KIND of gap a finding reports. The three are genuinely different repairs
 * and must not collapse into one "incomplete" bucket:
 *   - `missing`        — the field is blank. Fill-blanks can close it.
 *     Deterministic; no model required.
 *   - `underspecified` — populated, but too generic to predict behavior
 *     ("wants to be happy"). Augmentation can close it.
 *   - `contradictory`  — populated and specific, but at odds with another
 *     authored field. NOBODY can close it automatically; it needs the author,
 *     because the report cannot know which of the two fields is the wrong one.
 */
export const INTEGRITY_FINDING_KINDS = Object.freeze(['missing', 'underspecified', 'contradictory']);

/** Only `missing` and `underspecified` are machine-repairable — see above. */
export const AUGMENTABLE_FINDING_KINDS = Object.freeze(['missing', 'underspecified']);

/**
 * The five questions the semantic review asks. Stated as checks on the
 * AUTHORED material, not as demands for a particular kind of character: each
 * one can be satisfied by a deliberately flat, opaque or minor character, and
 * "no finding" is the expected result for most of a cast.
 */
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
 * Per-character coverage. The whole point of the enum is that `passed` and
 * `not-reviewed` are NOT the same answer — a review that quietly skipped half
 * the cast and reported no findings would read as a clean bill of health.
 *   - `passed`       — reviewed, nothing found
 *   - `findings`     — reviewed, at least one finding
 *   - `not-reviewed` — outside the requested scope, or the pass never reached it
 *   - `truncated`    — the review ran but its budget cut this character off
 *   - `stale`        — the character changed after the report was measured
 */
export const CHARACTER_REVIEW_STATUSES = Object.freeze([
  'passed', 'findings', 'not-reviewed', 'truncated', 'stale',
]);

/** Statuses that do NOT license "this cast is clean". */
export const INCOMPLETE_REVIEW_STATUSES = Object.freeze(['not-reviewed', 'truncated', 'stale']);

/**
 * How much of the framework a character is expected to carry.
 *
 * The issue is explicit that minor roles, flat arcs, unknowns and deliberate
 * ambiguity get "lighter or explained requirements, not manufactured trauma or
 * mandatory redemption" — so the depth is COMPUTED from what the author already
 * declared rather than demanded uniformly:
 *
 *   - `explained` — the author ruled the interior out (`psychology.assessment`
 *     of `unknown` / `not-applicable`) AND said why. That is a finished
 *     assessment; the pass asks for nothing further.
 *   - `light`     — a declared minor role, or a flat arc. Wants the conscious
 *     pursuit (motivations/want) and nothing about origin damage.
 *   - `full`      — everything else.
 */
export const INTEGRITY_DEPTHS = Object.freeze(['explained', 'light', 'full']);

/**
 * Whether a report licenses "this cast has been reviewed and is clean".
 * False whenever ANY character is `not-reviewed` / `truncated` / `stale` —
 * incomplete coverage cannot pass.
 */
export const castIntegrityPassed = (report) => {
  const coverage = report?.coverage || [];
  if (coverage.length === 0) return false;
  return coverage.every((c) => c.status === 'passed' && c.semanticReviewed);
};
