/**
 * Scoring and accuracy helpers for post-training drill types shared between
 * server (`services/meatspacePost.js`) and client (drill UI, via
 * `components/meatspace/post/constants.js`).
 */

// Balanced (signal-detection) accuracy for n-back questions, derived from only
// `answered` + `correct` — fields both legacy stored sessions and pre-save
// client results carry. Works because `correct` was always computed as
// "(pressed ? match : no-match) === expected", so `isTarget = pressed === correct`
// is an identity across old and new scorers. A missing signal class counts as
// chance (0.5), matching scoreNBack.
export function nBackBalancedAccuracy(questions) {
  let hits = 0, misses = 0, falseAlarms = 0, correctRejections = 0;
  for (const q of Array.isArray(questions) ? questions : []) {
    const pressed = q?.answered === 'match';
    const isTarget = pressed === !!q?.correct;
    if (isTarget) { if (pressed) hits += 1; else misses += 1; }
    else if (pressed) falseAlarms += 1;
    else correctRejections += 1;
  }
  const hitRate = hits + misses ? hits / (hits + misses) : null;
  const crRate = correctRejections + falseAlarms ? correctRejections / (correctRejections + falseAlarms) : null;
  return hitRate == null && crRate == null ? null : ((hitRate ?? 0.5) + (crRate ?? 0.5)) / 2;
}
