/**
 * Operator-facing labels for why a trained project head cannot be adopted.
 *
 * ONE definition, re-exported by `client/src/lib/jevHeadReasons.js`. These codes are SERVER
 * vocabulary (`headAdoptionBlocker`, `adoptJevHead`), so a new blocker must fail a test
 * (`jevHead.test.js`) rather than render as a raw slug. No imports, so the browser can load it
 * (`server/test/guards/modules/server-imports-no-client.test.js` forbids the reverse edge). Each label names WHICH
 * baseline the head lost to, since they send an operator to different places.
 */

export const JEV_HEAD_BLOCKER_REASONS = Object.freeze({
  'jev-head-below-zero-shot': 'Did not beat the stock zero-shot scorer, which needs no corpus at all.',
  'jev-head-below-majority-class': 'Did not beat always predicting the most common answer, so it learned the label balance rather than the product.',
  'jev-head-metrics-invalid': 'This head carries no readable scores.',
});

export const JEV_HEAD_BLOCKER_FALLBACK = 'This head cannot be adopted.';

/** Own-property lookup only: a code naming an `Object.prototype` key would return a function React throws on. */
export function jevHeadBlockerLabel(code, fallback = JEV_HEAD_BLOCKER_FALLBACK) {
  return Object.hasOwn(JEV_HEAD_BLOCKER_REASONS, code ?? '') ? JEV_HEAD_BLOCKER_REASONS[code] : fallback;
}
