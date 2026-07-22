/**
 * Series Autopilot — convergence tracking & pause-reason copy (#2842 split of
 * seriesAutopilot.js). The bounded-loop bookkeeping (`trackConvergence`,
 * `DIVERGENCE_PATIENCE`) and the human-readable reason strings each gate pauses
 * with, plus the dry-run cost arithmetic they share.
 */

// Per-gate copy for the non-convergence pause — shared by the arc-verify and
// editorial loops so the two messages can't drift.
const PAUSE_GATES = {
  arc: { label: 'Arc verification', fix: 'Edit the arc/volumes to address them', limit: 'verify-rounds' },
  beatContinuity: { label: 'Beat continuity', fix: 'Edit the affected issue beats', limit: 'beat-continuity-rounds' },
  editorial: { label: 'Editorial review', fix: 'Address them in the manuscript editor', limit: 'editorial-rounds' },
  foundation: { label: 'Foundation quality', fix: 'Strengthen the world / characters / arc, or lower the threshold', limit: 'foundation-rounds' },
};
export function convergencePauseReason(gate, maxRounds, blockingCount) {
  const { label, fix, limit } = PAUSE_GATES[gate];
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't auto-resolve ${blockingCount} blocking finding(s) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}

// Divergence/oscillation guard for the bounded convergence loops (#1571). A
// verify→resolve round is "profitable" only when the next verify shows STRICTLY
// FEWER blocking findings. When the count fails to drop (stays equal, or rises —
// a resolve pass that introduced a new break while fixing another) for
// DIVERGENCE_PATIENCE consecutive rounds, the loop is no longer converging:
// stop early and pause with a `divergence` kind instead of burning the rest of
// the daily cos budget down to maxRounds. The terminal maxRounds pause keeps its
// own `maxRounds` kind — the two are distinguished in the pause SSE frame so the
// UI can tell "needs a human" (diverging) from "just ran out of rounds".
//
// With the default caps (arc 3 / beat 2 / editorial 2) the loop hits maxRounds
// before the streak can reach patience, so default runs are unaffected; the
// guard only bites when a user RAISES a cap and the loop then stalls.
export const DIVERGENCE_PATIENCE = 2;

// Convergence tracker for one verify→resolve round. `state` is
// { best, sinceBest }: `best` is the FEWEST blocking findings seen so far this
// loop (null before the first measured round), `sinceBest` the count of
// consecutive rounds since that minimum last STRICTLY improved. A round that
// reaches a new low is progress (sinceBest → 0); a stall, a regression (a fix
// that introduced a new break), OR an oscillation that merely revisits an old
// count all accrue sinceBest. The loop diverges once sinceBest reaches
// DIVERGENCE_PATIENCE. Tracking the running minimum (not just the previous
// round) is what lets this catch a 2-cycle oscillation — e.g. 5→4→5→4 never
// sets a new low after round 2, so it's caught — which a naive
// "compare to the previous round" check would miss. Pure + unit-tested.
export function trackConvergence(state, curr) {
  if (state.best === null || curr < state.best) {
    return { best: curr, sinceBest: 0 };
  }
  return { best: state.best, sinceBest: state.sinceBest + 1 };
}

// Pause reason for a gate that stopped converging early (#1571) — distinct
// wording from convergencePauseReason's "ran out of rounds".
export function divergencePauseReason(gate, blockingCount, rounds) {
  const { label, fix } = PAUSE_GATES[gate];
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped converging — ${blockingCount} blocking finding(s) and no net progress over `
    + `${rounds} consecutive ${plural} of auto-resolve. Paused for review. ${fix}, then resume.`;
}

// Foundation gate pause reasons (#2176) — the gate converges on a WEIGHTED
// SCORE, not a finding count, so it needs its own wording (score vs. threshold)
// rather than the finding-count phrasing of convergencePauseReason. Shares
// PAUSE_GATES.foundation so the copy stays aligned with the other gates.
export function foundationPauseReason(maxRounds, score, threshold) {
  const { label, fix, limit } = PAUSE_GATES.foundation;
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't reach the threshold (weighted ${score} < ${threshold}) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}
export function foundationDivergenceReason(score, threshold, rounds) {
  const { label, fix } = PAUSE_GATES.foundation;
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped improving — weighted ${score} still below ${threshold} with no net gain over `
    + `${rounds} consecutive ${plural} of auto-fix. Paused for review. ${fix}, then resume.`;
}

// Dry-run plan note for a bounded gate: "skipped (0 rounds)" or "up to N rounds".
export const roundsNote = (rounds) => (rounds === 0 ? 'skipped (0 rounds)' : `up to ${rounds} rounds`);

// Dry-run cost model (#1576) — each planned step carries an estimated
// `estActions`: the number of cos actions it bills via recordDomainUsage('cos',
// { actions }), i.e. the unit the daily budget cap gates on. Surfacing it lets a
// user see, before starting, whether a large series will exhaust the cap on
// text/verify and never reach editorial. Estimates are approximate and lean
// toward the high end — convergence loops counted at their max rounds (they
// usually converge sooner), per-item steps at one action per item (retries
// excluded). A few steps cost nothing against the cap (editorialHealthGate,
// canonVerify) and carry estActions: 0. One known UNDER-count: the editorial
// review's per-comment auto-fixes each bill an extra action and scale with the
// number of blocking findings, which isn't knowable at plan time — so a heavy
// editorial pass can exceed its estimate.
//
// A bounded verify→resolve convergence loop (arc, beat-continuity, editorial)
// bills one action per verify plus (roughly) one per resolve; the final round
// never resolves (it converges or pauses). Estimate: rounds verifies +
// (rounds-1) resolves.
export const convergenceLoopActions = (rounds) => (rounds <= 0 ? 0 : 2 * rounds - 1);

// Sum a dry-run plan's per-step estimates into run totals. `estActions` is the
// budget-relevant total (cos daily-cap units); `estLlmCalls` aggregates the
// check-pass fan-out (editorialChecks bills a single cos action but issues many
// LLM calls — see the rough proxy at its plan.push). Pure — safe to call at
// broadcast time and in tests.
export function summarizePlanCost(plan) {
  return (Array.isArray(plan) ? plan : []).reduce(
    (acc, step) => ({
      estActions: acc.estActions + (Number.isFinite(step?.estActions) ? step.estActions : 0),
      estLlmCalls: acc.estLlmCalls + (Number.isFinite(step?.estLlmCalls) ? step.estLlmCalls : 0),
    }),
    { estActions: 0, estLlmCalls: 0 },
  );
}

// When true, a comic-target run with `includeVisual` proceeds past the text +
// editorial terminal into draft cover/page rendering (see runVisualDraft).
export const VISUAL_DRAFT_ENABLED = true;

// Which severities block each verify/review gate (low is informational) is now
// PER-SERIES configurable (#1616): the defaults (arc/beatContinuity → high+medium,
// editorial → high) live in `lib/editorial/severityConfig.js` and a series may
// override any gate. `startSeriesAutopilot` resolves each gate's blocking Set
// once via `resolveBlockingSet(series.blockingSeverities, gate)` and stamps it on
// `record.options.blockingSets` so every read site uses the same resolved set.

// Poll cadence while awaiting a delegated child runner (volume beats / auto-run).
export const CHILD_POLL_MS = 750;
