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

// Divergence guard for the bounded loops (#1571): a round is profitable only if the
// next verify shows STRICTLY FEWER blocking findings. After DIVERGENCE_PATIENCE
// consecutive rounds without a drop, stop early with a `divergence` kind instead of
// burning the budget; the terminal maxRounds pause keeps its own kind so the UI can
// tell "needs a human" from "ran out of rounds". Default caps hit maxRounds first;
// the guard bites when a user raises a cap and the loop stalls.
export const DIVERGENCE_PATIENCE = 2;

// Convergence tracker for one verify->resolve round. `state` is { best, sinceBest }:
// `best` the fewest blocking findings seen this loop (null before the first round),
// `sinceBest` rounds since that minimum last STRICTLY improved. A stall, a
// regression, or an oscillation revisiting an old count all accrue sinceBest.
// Tracking the running minimum (not the previous round) catches 5->4->5->4.
// Pure + unit-tested.
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

// ---------------------------------------------------------------------------
// Auto-resolve REGRESSION guard: asks "did THIS round's edits make the draft
// worse?" so the caller can restore the pre-resolve state before pausing.
// ---------------------------------------------------------------------------

// Normalizer behind the finding matcher, hoisted so the regexes aren't rebuilt
// per finding per round.
const normFindingText = (v) => String(v ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Singularize a token so "volumes"/"volume" read as one word.
const stemToken = (tok) => (tok.endsWith('s') ? tok.slice(0, -1) : tok);

// Words with no identity for a finding: connectives plus structural nouns
// ("volume", "arc", ...) common to nearly every finding, so overlap reflects what a
// finding is ABOUT. Stemmed on the way in via `stemToken`.
const FINDING_STOPWORDS = new Set((
  'a an and are as at be been both but by can could did do does each ever every for from had has have in'
  + ' into is it more most never no not of on one only or other same should some still than that the'
  + ' their then there these this those to two was were when which while with would'
  + ' arc book chapter episode issue season series story volume'
).split(' ').map(stemToken));

// Content tokens of one finding field. Tokens shorter than 3 chars are noise
// (numbers, "v1", articles the normalizer already split off).
function contentTokens(value) {
  const out = new Set();
  for (const raw of normFindingText(value).split(' ')) {
    const tok = stemToken(raw);
    if (tok.length < 3 || FINDING_STOPWORDS.has(tok)) continue;
    out.add(tok);
  }
  return out;
}

// Shared content tokens plus containment score (shared over the SMALLER set, so a
// terse restatement of a long finding still scores high).
function overlapStats(a, b) {
  const left = contentTokens(a);
  const right = contentTokens(b);
  if (left.size === 0 || right.size === 0) return { shared: 0, score: 0 };
  let shared = 0;
  for (const tok of left) if (right.has(tok)) shared += 1;
  return { shared, score: shared / Math.min(left.size, right.size) };
}

/** Containment overlap of two findings' prose, 0..1. Pure. */
export const findingTextOverlap = (a, b) => overlapStats(a, b).score;

// Share of the smaller finding's prose, and number of content tokens, that must be
// shared for two findings to match. The token floor stops a one-word coincidence
// scoring 1.0.
export const FINDING_MATCH_MIN_OVERLAP = 0.4;
const FINDING_MATCH_MIN_SHARED = 2;
// Both relax when the two findings name the same place — a location that already
// agrees is corroboration, so less of the prose has to.
export const FINDING_MATCH_MIN_OVERLAP_SAME_LOCATION = 0.25;
const FINDING_MATCH_MIN_SHARED_SAME_LOCATION = 1;

/**
 * True when two locations name the same place. Whole-word containment covers
 * "volume 3" vs "volume 3 act two" (the same place at two altitudes) while
 * refusing prefixes, so "v1" can't swallow "v10" nor "volume 3" "volume 30".
 * Pure.
 */
export function sameFindingLocation(a, b) {
  const locA = normFindingText(a);
  const locB = normFindingText(b);
  if (!locA || !locB) return false;
  if (locA === locB) return true;
  const [short, long] = locA.length <= locB.length ? [locA, locB] : [locB, locA];
  return ` ${long} `.includes(` ${short} `);
}

/**
 * True when two findings from two SEPARATE verifier calls are the same underlying
 * problem. Pure.
 *
 * Loose about WORDING (the verifier re-punctuates, paraphrases and re-labels the
 * location after a renumber; an exact fingerprint read every round as new and
 * missed the 1 -> 3 -> 5 divergence the regression guard exists for). NOT loose
 * about SUBJECT: a shared location only lowers how much problem text must agree,
 * since distinct defects often share a volume. Severity is not part of identity:
 * the verifier moves findings between `high` and `medium` freely.
 */
export function sameFinding(a, b) {
  const corroborated = sameFindingLocation(a?.location, b?.location);
  const { shared, score } = overlapStats(a?.problem, b?.problem);
  return shared >= (corroborated ? FINDING_MATCH_MIN_SHARED_SAME_LOCATION : FINDING_MATCH_MIN_SHARED)
    && score >= (corroborated ? FINDING_MATCH_MIN_OVERLAP_SAME_LOCATION : FINDING_MATCH_MIN_OVERLAP);
}

// "Is this problem somewhere in that list?" Argument order is fixed (list, then
// finding) so call sites agree even if the matcher stops being symmetric.
export const containsFinding = (list, finding) => (
  Array.isArray(list) && list.some((candidate) => sameFinding(candidate, finding))
);

/**
 * True when the round that produced `after` REGRESSED: it left more blocking
 * findings than `before` AND at least one targeted finding still stands. Pure.
 *
 * A round that closed everything it targeted and merely exposed latent findings is
 * progress even if the count rose. A round that held the count is left to the
 * divergence guard's patience. Only a GROWING blocking set is reverted here.
 */
export function isResolveRegression(before, after) {
  const targeted = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (current.length <= targeted.length) return false;
  return targeted.some((t) => containsFinding(current, t));
}

const FINDING_SEVERITY_RANK = Object.freeze({ low: 1, medium: 2, high: 3 });

/**
 * Regression test for a bounded, finding-keyed exact-text patch: a sparse patch
 * that closes its target may expose unrelated latent findings. Revert only when a
 * targeted finding survives while the set grows, or returns at a higher severity.
 */
export function isTargetedPatchRegression(before, after) {
  const targeted = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (isResolveRegression(targeted, current)) return true;
  return targeted.some((prior) => current.some((candidate) => (
    sameFinding(prior, candidate)
    && (FINDING_SEVERITY_RANK[candidate?.severity] || 0) > (FINDING_SEVERITY_RANK[prior?.severity] || 0)
  )));
}

// The arc rollback guard's ordering. Total blockers are primary (accepting a larger
// set caused the original runaway repair loop); on ties severity breaks it, so a
// resolver can't trade a medium finding for a high one.
export function isBlockingSetRegression(before, after) {
  const prior = Array.isArray(before) ? before : [];
  const current = Array.isArray(after) ? after : [];
  if (current.length !== prior.length) return current.length > prior.length;
  const count = (findings, severity) => findings.filter((finding) => finding?.severity === severity).length;
  for (const severity of ['high', 'medium', 'low']) {
    const delta = count(current, severity) - count(prior, severity);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

// Per-finding ISOLATION acceptance (#3780): judges one single-finding patch (see
// `isolateArcFindings` in childRuns.js), where the guards above judge a whole round.

/**
 * May an isolated single-finding patch be KEPT? True only when `target` is gone
 * from the re-verify and the remainder is not a regression on the starting set.
 * Pure.
 *
 * "Not a regression" is `isBlockingSetRegression`, the same definition the
 * whole-round guard uses, so ties at an unchanged severity mix are allowed (the
 * divergence guard still catches a gate that only trades). Closure uses
 * `sameFinding`, not prose equality: the verifier re-words standing defects.
 */
export function isIsolatedFixSafe(target, before, after) {
  const current = Array.isArray(after) ? after : [];
  if (containsFinding(current, target)) return false;
  return !isBlockingSetRegression(before, current);
}

// Pause reason for a gate whose auto-resolve round was reverted: the user is
// handed the state from BEFORE the round, and saying so keeps the rewind explained.
export function regressionPauseReason(gate, beforeCount, afterCount, bestCount = beforeCount, severityEscalated = false) {
  const { label, fix } = PAUSE_GATES[gate];
  const outcome = severityEscalated
    ? `came back with the same count but a worse severity mix (${afterCount} total)`
    : `came back with ${afterCount}`;
  return `${label} auto-resolve made the draft worse — the round it ran on ${beforeCount} blocking finding(s) `
    + `${outcome}, so its edits were reverted regardless of how the verifier reworded the findings. `
    + `Paused for review with the best verified ${bestCount}-finding state from this gate. ${fix}, then resume.`;
}

// Foundation gate pause reasons (#2176): the gate converges on a WEIGHTED SCORE,
// not a finding count, so it has its own wording; shares PAUSE_GATES.foundation.
export function foundationPauseReason(maxRounds, score, threshold) {
  const { label, fix, limit } = PAUSE_GATES.foundation;
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't reach the threshold (weighted ${score} < ${threshold}) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}
// A foundation repair whose re-judge showed no gain for its target. `missed` is
// the shared head of the rewind notice, the unverified-restore pause and the
// next attempt's note, so the three can't disagree about the numbers.
export function foundationRepairMissed({ dimension, targetBefore, targetAfter, weightedBefore, weightedAfter }) {
  const missed = `Foundation ${dimension} repair did not improve its target `
    + `(${targetBefore} → ${targetAfter}; weighted ${weightedBefore} → ${weightedAfter})`;
  return {
    missed,
    rewind: `${missed}, so its edits were reverted to the pre-repair checkpoint.`,
    unverified: (reason) => `${missed}, and checkpoint verification failed after rollback: ${reason || 'unknown restore mismatch'}.`,
    // Handed to the retry so it changes strategy instead of re-proposing reverted edits.
    retryNote: (gap) => `A previous ${dimension} repair this run was REVERTED: it left the target score at ${targetAfter} `
      + `(weighted ${weightedBefore} → ${weightedAfter}), so none of its edits were kept. The re-judge of that attempt still `
      + `reported: ${gap || 'the same gap'}. Take a different approach — repeating those edits will be reverted again.`,
  };
}
export function foundationDivergenceReason(score, threshold, rounds) {
  const { label, fix } = PAUSE_GATES.foundation;
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped improving — weighted ${score} still below ${threshold} with no net gain over `
    + `${rounds} consecutive ${plural} of auto-fix. Paused for review. ${fix}, then resume.`;
}

// Dry-run plan note for a bounded gate: "skipped (0 rounds)" or "up to N rounds".
export const roundsNote = (rounds) => (rounds === 0 ? 'skipped (0 rounds)' : `up to ${rounds} rounds`);

// Dry-run cost model (#1576): each step's `estActions` is the cos actions it bills
// (the unit the daily cap gates on). Estimates lean high: loops counted at max
// rounds, per-item steps at one action per item. editorialHealthGate/canonVerify
// are 0. Known UNDER-count: editorial per-comment auto-fixes scale with findings
// unknowable at plan time.
//
// A verify->resolve loop bills one action per verify plus one per resolve; the
// final round never resolves: rounds verifies + (rounds-1) resolves.
export const convergenceLoopActions = (rounds) => (rounds <= 0 ? 0 : 2 * rounds - 1);

// Sum a dry-run plan's per-step estimates: `estActions` is the cos daily-cap total;
// `estLlmCalls` aggregates the check-pass fan-out. Pure.
export function summarizePlanCost(plan) {
  return (Array.isArray(plan) ? plan : []).reduce(
    (acc, step) => ({
      estActions: acc.estActions + (Number.isFinite(step?.estActions) ? step.estActions : 0),
      estLlmCalls: acc.estLlmCalls + (Number.isFinite(step?.estLlmCalls) ? step.estLlmCalls : 0),
    }),
    { estActions: 0, estLlmCalls: 0 },
  );
}

// When true, a comic-target run with `includeVisual` proceeds into draft rendering.
export const VISUAL_DRAFT_ENABLED = true;

// Blocking severities per gate are per-series configurable (#1616): defaults live
// in `lib/editorial/severityConfig.js`; `startSeriesAutopilot` resolves each gate's
// blocking Set once and stamps it on `record.options.blockingSets`.

// Poll cadence while awaiting a delegated child runner (volume beats / auto-run).
export const CHILD_POLL_MS = 750;
