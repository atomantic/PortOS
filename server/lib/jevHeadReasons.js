/**
 * Operator-facing labels for why a trained project head cannot be adopted.
 *
 * ONE definition, here, re-exported by `client/src/lib/jevHeadReasons.js` — not
 * a table inside the panel component. Same contract as
 * `scopeAdherenceReasons.js`, and for the same reason: these codes are SERVER
 * vocabulary, produced by `headAdoptionBlocker` and enforced by `adoptJevHead`,
 * so a fourth blocker added there must fail a test rather than render as a raw
 * slug in a green suite. The client may import a pure `server/lib` leaf; the
 * reverse edge is what `scripts/server-imports-no-client.test.js` forbids.
 *
 * This module keeps itself importable from the browser by having no imports at
 * all. Coverage is asserted by `jevHead.test.js`, which owns the codes.
 *
 * Every label names WHICH baseline the head lost to, because the two send an
 * operator to different places: losing to the stock scorer means the corpus
 * taught it nothing the checkpoint did not already know, while losing to a
 * constant prediction means the corpus is too imbalanced for accuracy to be
 * measuring anything at all.
 */

export const JEV_HEAD_BLOCKER_REASONS = Object.freeze({
  'jev-head-below-zero-shot': 'Did not beat the stock zero-shot scorer, which needs no corpus at all.',
  'jev-head-below-majority-class': 'Did not beat always predicting the most common answer, so it learned the label balance rather than the product.',
  'jev-head-metrics-invalid': 'This head carries no readable scores.',
});

export const JEV_HEAD_BLOCKER_FALLBACK = 'This head cannot be adopted.';

/**
 * Label for a blocker code.
 *
 * Own-property lookup only: `REASONS[code] || fallback` on a code that happens
 * to name an `Object.prototype` key (`toString`, `constructor`) returns a
 * function, and React throws when one is rendered as a child.
 */
export function jevHeadBlockerLabel(code, fallback = JEV_HEAD_BLOCKER_FALLBACK) {
  return Object.hasOwn(JEV_HEAD_BLOCKER_REASONS, code ?? '') ? JEV_HEAD_BLOCKER_REASONS[code] : fallback;
}
