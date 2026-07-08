/**
 * Pipeline — Iterate-to-quality revision loop: stop-condition + keep/revert logic
 * (CWQE Phase 7, #2171).
 *
 * Pure decision helpers for the Series Autopilot's optional revision loop
 * (`runRevisionCycle` in seriesAutopilot.js). They carry NO I/O so the whole
 * stopping/keep-revert policy is unit-testable on plain score/finding fixtures —
 * the autopilot only supplies the numbers and reads the verdict.
 *
 * Three decisions, ported from autonovel's revision phase:
 *
 *   1. keep/revert — a revision is kept only when the re-judged qualityScore did
 *      NOT regress (post ≥ pre). A regression restores the pre-revision snapshot.
 *   2. plateau — stop cycling once the mean series qualityScore stops moving
 *      (|Δ| < plateauDelta between the last two cycles), after a minimum count.
 *   3. qualification-aware convergence — "the reviewer will ALWAYS find
 *      something". Stop when the remaining findings read as hedged trade-offs
 *      ("individually fine", "deliberate choice", "costs of ambition") rather
 *      than actionable defects. Majority-hedged ⇒ converged.
 */

// Phrases that mark a finding as a HEDGED trade-off rather than an actionable
// defect (autonovel's "costs of ambition" language). Matched case-insensitively
// as substrings so surrounding prose ("this is individually fine, but…") still
// trips them. Kept deliberately small + specific — a broad list would classify
// genuine critique as hedged and stop the loop early.
export const HEDGE_PHRASES = Object.freeze([
  'individually fine',
  'deliberate choice',
  'deliberate decision',
  'costs of ambition',
  'not a flaw',
  'not really a flaw',
  'matter of taste',
  'matter of preference',
  'defensible choice',
  'works as intended',
  'nothing wrong with',
  'no notes',
  'stylistic choice',
  'author’s prerogative',
  "author's prerogative",
]);

/**
 * Classify one finding string as 'hedged' (a qualified trade-off) or 'actionable'
 * (a real defect). Non-string / empty input is 'actionable' by default — an
 * unlabeled finding shouldn't be treated as converged.
 */
export function classifyQualification(text) {
  if (typeof text !== 'string' || !text.trim()) return 'actionable';
  const lower = text.toLowerCase();
  return HEDGE_PHRASES.some((p) => lower.includes(p)) ? 'hedged' : 'actionable';
}

/**
 * True when the STRICT majority of non-empty findings are hedged. An empty list
 * is NOT majority-hedged (there's nothing to converge on — a fresh run with no
 * findings yet keeps its other stop conditions intact). Ties (exactly half) are
 * not a majority, so the loop keeps going while defects are still even with hedges.
 */
export function isMajorityHedged(findingTexts = []) {
  const texts = (Array.isArray(findingTexts) ? findingTexts : []).filter((t) => typeof t === 'string' && t.trim());
  if (texts.length === 0) return false;
  const hedged = texts.filter((t) => classifyQualification(t) === 'hedged').length;
  return hedged * 2 > texts.length;
}

/**
 * True when the mean series qualityScore has plateaued — the absolute change
 * between the two most recent cycles is below `plateauDelta`. Needs at least two
 * recorded scores; fewer than two is never a plateau (not enough signal).
 * Non-finite entries are ignored rather than poisoning the comparison.
 */
export function detectPlateau(scoreHistory = [], plateauDelta = 0.3) {
  const scores = (Array.isArray(scoreHistory) ? scoreHistory : []).filter((n) => Number.isFinite(n));
  if (scores.length < 2) return false;
  const last = scores[scores.length - 1];
  const prev = scores[scores.length - 2];
  return Math.abs(last - prev) < plateauDelta;
}

/**
 * Keep/revert gate for a single revised issue. Keep when the re-judged score did
 * NOT regress (post ≥ pre). Revert only on a genuine regression. When either
 * score is unknown (never judged / judge failed) we KEEP — we can't prove a
 * regression, and reverting a possibly-good revision on missing data is worse
 * than keeping it. Returns 'keep' | 'revert'.
 */
export function decideKeepRevert(preScore, postScore) {
  const pre = Number(preScore);
  const post = Number(postScore);
  if (!Number.isFinite(pre) || !Number.isFinite(post)) return 'keep';
  return post >= pre ? 'keep' : 'revert';
}

/**
 * Decide whether the revision loop should STOP after the cycle that just
 * completed. Precedence:
 *   1. maxCycles — a hard ceiling, always honored (cost cap).
 *   2. after minCycles: qualification-aware convergence (majority-hedged findings).
 *   3. after minCycles: plateau (mean series score stopped moving).
 * Otherwise keep cycling.
 *
 * @param {object}   p
 * @param {number}   p.cyclesRun     cycles completed so far (incl. the one just run)
 * @param {number}   p.minCycles     floor before hedge/plateau stops can fire
 * @param {number}   p.maxCycles     hard ceiling
 * @param {number[]} p.scoreHistory  mean series qualityScore per completed cycle
 * @param {number}   p.plateauDelta  |Δ| below which the score counts as plateaued
 * @param {string[]} p.findingTexts  remaining finding descriptions to classify
 * @returns {{ stop: boolean, reason: string|null, detail: string }}
 */
export function evaluateRevisionStop({
  cyclesRun = 0,
  minCycles = 1,
  maxCycles = 2,
  scoreHistory = [],
  plateauDelta = 0.3,
  findingTexts = [],
} = {}) {
  if (cyclesRun >= maxCycles) {
    return { stop: true, reason: 'maxCycles', detail: `reached the max of ${maxCycles} revision cycle(s)` };
  }
  if (cyclesRun >= minCycles) {
    if (isMajorityHedged(findingTexts)) {
      return {
        stop: true,
        reason: 'hedged',
        detail: 'remaining findings are majority-hedged trade-offs (qualification-aware convergence)',
      };
    }
    if (detectPlateau(scoreHistory, plateauDelta)) {
      const scores = scoreHistory.filter((n) => Number.isFinite(n));
      const delta = Math.abs(scores[scores.length - 1] - scores[scores.length - 2]);
      return {
        stop: true,
        reason: 'plateau',
        detail: `mean series quality plateaued (Δ ${delta.toFixed(2)} < ${plateauDelta})`,
      };
    }
  }
  return { stop: false, reason: null, detail: '' };
}
