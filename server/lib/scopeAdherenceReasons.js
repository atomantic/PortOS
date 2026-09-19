/**
 * Operator-facing labels for the codes `scoreAdherence` can return instead of
 * a verdict (`server/services/scopeAdherence.js`).
 *
 * ONE definition, here, re-exported by `client/src/lib/scopeAdherenceReasons.js`
 * — not a hand-maintained mirror with a parity test. The client may import a
 * pure `server/lib` leaf; the reverse edge is what
 * `scripts/server-imports-no-client.test.js` forbids, and a mirror would have
 * needed exactly that edge to be checked. This module keeps itself importable
 * from the browser by having no imports at all.
 *
 * Coverage of the code vocabulary is asserted by the sibling test, so a code
 * added to the service without a label fails rather than silently rendering as
 * the generic fallback.
 *
 * Every label reads as "no advisory", never as a verdict. A scorer that could
 * not answer has said nothing about the change.
 */

export const SCOPE_ADHERENCE_REASONS = Object.freeze({
  // Reachable only in a race — the panel hides itself when the feature is off,
  // but the toggle can move between render and response.
  'scope-adherence-disabled': 'The local scope scorer is turned off for this install.',
  'scope-adherence-change-empty': 'This row has no title or description to score.',
  'scope-adherence-corpus-missing': 'This repository has no PRD.md or GOALS.md to score against.',
  'scope-adherence-corpus-unreadable': 'This repository\'s PRD.md / GOALS.md could not be read.',
  'scope-adherence-no-clause': 'No stated goal in this repository is close enough to score against.',
  'jev-not-installed': 'The local scorer is not installed yet — see Models > LLMs > jev.',
  'jev-start-failed': 'The local scorer could not start. Check Models > LLMs > jev.',
  'jev-timeout': 'The local scorer did not answer in time.',
  'jev-request-invalid': 'The local scorer rejected the request for this change.',
  'jev-response-invalid': 'The local scorer returned an answer PortOS could not read.',
  'jev-premise-too-large': 'This change is too large for the local scorer to read at once.',
});

export const SCOPE_ADHERENCE_REASON_FALLBACK = 'The local scorer could not answer for this change.';

/**
 * Label for a reason code.
 *
 * Own-property lookup only: `REASONS[code] || fallback` on a code that happens
 * to name an `Object.prototype` key (`toString`, `constructor`) returns a
 * function, and React throws when one is rendered as a child.
 */
export function scopeAdherenceReasonLabel(reason, fallback = SCOPE_ADHERENCE_REASON_FALLBACK) {
  return Object.hasOwn(SCOPE_ADHERENCE_REASONS, reason ?? '') ? SCOPE_ADHERENCE_REASONS[reason] : fallback;
}
