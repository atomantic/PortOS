/**
 * Scoring and accuracy helpers for post-training drill types shared between
 * server (`services/meatspace/meatspacePost.js`) and client (drill UI, via
 * `components/meatspace/post/constants.js`).
 */

// Balanced (signal-detection) accuracy for n-back questions from only `answered` + `correct`, which legacy stored sessions and pre-save client results both carry: `correct` was always "(pressed ? match : no-match) === expected", so `isTarget = pressed === correct` is an identity across old and new scorers. A missing signal class counts as chance (0.5), matching scoreNBack.
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

// The estimation band every surface must agree on: four copies of this `10` existed (server grading, the client's optimistic check, the shipped drill config, the adaptive baseline), and the drill UI states the band on screen, so the claimed number and the ✓/✗ number must be one object.
export const DEFAULT_ESTIMATION_TOLERANCE_PCT = 10;

/** Resolve a drill's stored tolerance to the percentage grading uses. `0` is a meaningful band (grade exact-match), so this is neither `|| DEFAULT` (reads 0 as unset, widening to 10%) nor bare `Number()` (`Number(null)`/`Number('')` are 0, turning an absent tolerance into exact-match): absent is rejected first, then the value validated. */
export function resolveEstimationTolerancePct(tolerancePct) {
  if (tolerancePct === null || tolerancePct === undefined || tolerancePct === '') {
    return DEFAULT_ESTIMATION_TOLERANCE_PCT;
  }
  const pct = Number(tolerancePct);
  return Number.isFinite(pct) && pct >= 0 ? pct : DEFAULT_ESTIMATION_TOLERANCE_PCT;
}
