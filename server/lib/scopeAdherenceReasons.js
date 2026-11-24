/**
 * Operator-facing labels for the codes `scoreAdherence` returns instead of a verdict (`server/services/scopeAdherence.js`).
 *
 * ONE definition re-exported by `client/src/lib/scopeAdherenceReasons.js`, not a mirror with a parity test (the client may import a pure `server/lib` leaf; the reverse edge is what `server/test/guards/modules/server-imports-no-client.test.js` forbids), importable from the browser by having no imports. Coverage is asserted by the sibling test, so a code added to the service without a label fails rather than rendering the generic fallback. Every label reads as "no advisory", never a verdict: a scorer that couldn't answer has said nothing about the change.
 */

/** The codes `scoreAdherence` adds on top of the shared `JEV_FAILURE_CODES` and untrusted-content ones (forwarded unchanged). Declared HERE rather than in the service: the sibling test asserts every code has a label, and importing the service would drag its closure into a leaf test (the shape `lib/importScoping.test.js` budgets against); the service imports this. */
export const SCOPE_ADHERENCE_FAILURE_CODES = Object.freeze([
  'scope-adherence-disabled',
  'scope-adherence-change-empty',
  'scope-adherence-corpus-missing',
  'scope-adherence-corpus-unreadable',
  'scope-adherence-no-clause',
  'scope-adherence-abuse-blocked',
  'scope-adherence-screening-unavailable',
]);

export const SCOPE_ADHERENCE_REASONS = Object.freeze({
  // Reachable only in a race: the panel hides itself when the feature is off, but the toggle can move between render and response.
  'scope-adherence-disabled': 'The local scope scorer is turned off for this install.',
  'scope-adherence-change-empty': 'This row has no title or description to score.',
  'scope-adherence-corpus-missing': 'This repository has no PRD.md or GOALS.md to score against.',
  'scope-adherence-corpus-unreadable': 'This repository\'s PRD.md / GOALS.md could not be read.',
  'scope-adherence-no-clause': 'No stated goal in this repository is close enough to score against.',
  'scope-adherence-abuse-blocked': 'No advisory: Abuse Guard flagged the supplied text.',
  'scope-adherence-screening-unavailable': 'No advisory: Abuse Guard could not screen this text. Check Models > LLMs > Abuse Guard.',
  'jev-not-installed': 'The local scorer is not installed yet — see Models > Decision Classifiers > Jev.',
  'jev-start-failed': 'The local scorer could not start. Check Models > Decision Classifiers > Jev.',
  'jev-timeout': 'The local scorer did not answer in time.',
  'jev-request-invalid': 'The local scorer rejected the request for this change.',
  'jev-response-invalid': 'The local scorer returned an answer PortOS could not read.',
  'jev-premise-too-large': 'This change is too large for the local scorer to read at once.',
  // A trained project head the scorer couldn't apply: reads as "no advisory" and points at Models > Decision Classifiers > Jev, where the head can be discarded (returning the decision to the stock scorer). Never answered by silently falling back: the operator adopted this head on three measured numbers, and substituting a classifier would make them describe something that didn't run.
  'jev-head-not-found': 'The adopted project head is missing — discard it in Models > Decision Classifiers > Jev to go back to the stock scorer.',
  'jev-head-invalid': 'The adopted project head could not be read — discard it in Models > Decision Classifiers > Jev.',
  'jev-head-too-large': 'The adopted project head is larger than PortOS will load — discard it in Models > Decision Classifiers > Jev.',
  'jev-head-unreadable': 'The adopted project head\'s file could not be read — discard it in Models > Decision Classifiers > Jev.',
  'jev-head-revision-mismatch': 'The adopted project head was trained on a different scorer version — retrain or discard it in Models > Decision Classifiers > Jev.',
});

export const SCOPE_ADHERENCE_REASON_FALLBACK = 'The local scorer could not answer for this change.';

/** Label for a reason code. Own-property lookup only: `REASONS[code] || fallback` on a code naming an `Object.prototype` key (`toString`, `constructor`) returns a function, and React throws rendering one as a child. */
export function scopeAdherenceReasonLabel(reason, fallback = SCOPE_ADHERENCE_REASON_FALLBACK) {
  return Object.hasOwn(SCOPE_ADHERENCE_REASONS, reason ?? '') ? SCOPE_ADHERENCE_REASONS[reason] : fallback;
}
