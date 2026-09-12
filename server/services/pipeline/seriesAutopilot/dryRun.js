/**
 * Series Autopilot — dry-run plan builder (#2842 split of seriesAutopilot.js).
 * Walks the same step resolver the live run uses to project the work, cost and
 * gates a run would perform, without executing anything.
 */

import { isStageReady } from '../issues.js';
import { collapseDuplicateSeasonNumbers, hasDuplicateSeasonNumbers } from '../arcPlanner.js';
import { resolveReadinessGate } from '../editorialScore.js';
import {
  MAX_ARC_VERIFY_ROUNDS, MAX_FOUNDATION_ROUNDS, MAX_BEAT_CONTINUITY_ROUNDS, MAX_EDITORIAL_ROUNDS,
  resolveAutopilotCheckPauseThreshold, resolveAutopilotRevision, wantsTeaser, wantsVisual,
  arcIsolationActions,
} from './config.js';
import { roundsNote, convergenceLoopActions, VISUAL_DRAFT_ENABLED } from './convergence.js';
import { orderedIssues, productionIssues, byNumber, issueHasBeats, textReady, wantsComic, visualReady } from './stepResolver.js';
import { editorialSubsetIds } from './editorialSteps.js';
import { countSeriesLocks } from './unlockPass.js';

// ---------------------------------------------------------------------------
// Dry-run planning — enumerate what execute WOULD do, no side effects.
// ---------------------------------------------------------------------------

// Mirrors resolveNextStep's step ordering, but enumerates the FULL remaining
// plan (counts of every unmet step) rather than returning only the next one —
// so it can't reuse the single-step resolver. Kept deliberately in sync by
// hand; they share the same predicates (textReady, isComicTarget, isStageReady).
// `costContext.editorialLlmCheckCount` (optional) is the resolved number of
// enabled LLM-kind editorial checks for this run's subset — supplied by the
// caller (which has loaded settings) so this stays a pure, synchronous function.
// When provided it drives the editorialChecks step's estLlmCalls (issues × LLM
// checks) and whether that pass bills a cos action at all; absent, the step
// estimates a single LLM check.
export function buildDryRunPlan(series, issues, options, costContext = {}) {
  const plan = [];
  let ordered = orderedIssues(issues);
  let seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort(byNumber) : [];
  // Unlock pre-pass (opt-in). Costs nothing — it only clears lock bits — but it
  // is the one step that MUTATES records the user froze by hand, so the dry-run
  // plan must name it (and how many locks it would clear) before they commit.
  // The count comes from the pass's own `countSeriesLocks` so the promise can't
  // drift from what actually gets cleared; universe-side locks aren't included
  // (they need an async read, and this builder is synchronous).
  if (options?.unlockForRun === true) {
    plan.push({
      kind: 'unlockLocks',
      count: 1,
      note: `unlock ${countSeriesLocks(series, ordered)} series-record lock(s) + this series' universe canon — other series' canon stays locked; nothing is deleted`,
      estActions: 0,
    });
  }
  // Mirror the resolver: generateArc runs when arc text is missing OR there are
  // no volumes at all (an arc-only series), so a dry-run plan must show it too.
  const noArc = !series?.arc?.logline && !series?.arc?.summary;
  if (noArc || seasons.length === 0) {
    if (options?.foundationGate !== false && options?.maxFoundationRounds !== 0) {
      plan.push({
        kind: 'characterFoundation', count: 1, estActions: 1,
        note: 'complete the causal core cast before spending on the macro plot arc',
      });
    }
    plan.push({ kind: 'generateArc', count: 1, estActions: 1 });
  }
  // A present arc with duplicate volume numbers takes the deterministic repair
  // path before any empty-volume episode generation. Preview that collapse so
  // the plan does not advertise LLM calls for malformed records that execute
  // will absorb. When locks would block the repair, the execute run pauses at
  // this step, so downstream work is intentionally omitted from the plan.
  if (!noArc && seasons.length > 0 && hasDuplicateSeasonNumbers(seasons)) {
    const issueCounts = new Map();
    for (const issue of ordered) {
      if (issue.seasonId) issueCounts.set(issue.seasonId, (issueCounts.get(issue.seasonId) || 0) + 1);
    }
    const previewInput = options?.unlockForRun === true
      ? seasons.map((season) => ({ ...season, locked: false }))
      : seasons;
    const preview = collapseDuplicateSeasonNumbers(previewInput, issueCounts, { log: false });
    const blocked = (series?.locked?.arc === true && options?.unlockForRun !== true)
      || hasDuplicateSeasonNumbers(preview.seasons);
    plan.push({
      kind: 'repairArcStructure',
      count: 1,
      note: blocked
        ? 'normalize duplicate volume numbers before issue generation — pauses until full edit control clears the blocking locks'
        : 'normalize duplicate volume numbers and keep their existing issues attached before generation',
      estActions: 0,
    });
    if (blocked) return plan;
    seasons = preview.seasons;
    // Execute re-points children of an absorbed duplicate to the survivor in the
    // same commit. Mirror that projected identity here so the later empty-volume
    // and beat-sheet counts do not charge work for a survivor that will already
    // own those issues once the repair lands.
    if (preview.absorbed.size) {
      ordered = ordered.map((issue) => {
        const survivorId = preview.absorbed.get(issue.seasonId);
        return survivorId ? { ...issue, seasonId: survivorId } : issue;
      });
    }
  }
  const arcRounds = Number.isInteger(options?.maxArcVerifyRounds) ? options.maxArcVerifyRounds : MAX_ARC_VERIFY_ROUNDS;
  // A gate that can reach its regression guard can also reach the per-finding
  // isolation pass (#3780), which bills a resolve + a full verification per
  // attempt INSIDE a round — spend the round-based estimates above don't model.
  // Needs two rounds to be reachable at all (a rollback, then a round to verify
  // what isolation kept), so a 1-round gate projects none.
  const isolationActions = (volumes) => (arcRounds > 1 ? arcIsolationActions(options, volumes) : 0);
  plan.push({
    kind: 'verifyArcSpine',
    count: 1,
    note: `${roundsNote(arcRounds)}; protected intent + macro arc before issue generation`,
    estActions: convergenceLoopActions(arcRounds) + isolationActions(0),
  });
  const emptySeasons = seasons.filter((s) => !ordered.some((i) => i.seasonId === s.id));
  if (emptySeasons.length) plan.push({ kind: 'generateEpisodes', count: emptySeasons.length, estActions: emptySeasons.length });
  // Foundation runs first at synopsis altitude. Arc/volume repairs and
  // foundation fixes may invalidate one another, so execute can re-check these
  // two gates before moving on; the plan names the primary pass.
  const foundationRounds = Number.isInteger(options?.maxFoundationRounds) ? options.maxFoundationRounds : MAX_FOUNDATION_ROUNDS;
  if (options?.foundationGate !== false && foundationRounds !== 0) {
    plan.push({ kind: 'foundationGate', count: 1, note: `${roundsNote(foundationRounds)}; re-checks after arc repairs`, estActions: convergenceLoopActions(foundationRounds) });
  }
  const verificationActions = arcRounds === 0
    ? 0
    : arcRounds * (1 + seasons.length) + Math.max(0, arcRounds - 1) + isolationActions(seasons.length);
  plan.push({
    kind: 'verifyArc',
    count: 1,
    note: `${roundsNote(arcRounds)}; whole arc + ${seasons.length} volume(s) per round`,
    estActions: verificationActions,
  });
  const production = productionIssues(ordered, options);
  const reviewedCount = ordered.filter((issue) => production.some((target) => target.id === issue.id)
    || textReady(issue, series, options)).length;
  const beatsNeeded = seasons.filter((s) =>
    production.some((i) => i.seasonId === s.id && !isStageReady(i.stages?.idea))).length;
  if (beatsNeeded) plan.push({ kind: 'beatSheet', count: beatsNeeded, estActions: beatsNeeded });
  // beatContinuity (#1510) runs once when the run will have a beat corpus to
  // check: beats already exist, OR beatSheet will generate them this run. Mirror
  // the resolver's `ordered.some(issueHasBeats)` gate (post-generation), so a
  // synopsis-only run that produces no beats doesn't advertise a pass it skips.
  if (ordered.some(issueHasBeats) || beatsNeeded) {
    const bcRounds = Number.isInteger(options?.maxBeatContinuityRounds)
      ? options.maxBeatContinuityRounds
      : MAX_BEAT_CONTINUITY_ROUNDS;
    plan.push({ kind: 'beatContinuity', count: 1, note: roundsNote(bcRounds), estActions: convergenceLoopActions(bcRounds) });
  }
  const opening = production[0];
  if (opening && !textReady(opening, series, options)) {
    plan.push({ kind: 'pilotDraft', count: 1, estActions: 1 });
  }
  const edRounds = Number.isInteger(options?.maxEditorialRounds) ? options.maxEditorialRounds : MAX_EDITORIAL_ROUNDS;
  if (opening && edRounds !== 0) {
    plan.push({ kind: 'pilotReview', count: 1, note: `${roundsNote(edRounds)}; setup, character choices and aftermath before expanding the manuscript`, estActions: convergenceLoopActions(edRounds) });
  }
  const textNeeded = production.slice(1).filter((i) => !textReady(i, series, options)).length;
  if (textNeeded) plan.push({ kind: 'textStages', count: textNeeded, estActions: textNeeded });
  if (wantsComic(series, options)) plan.push({ kind: 'scriptVerify', count: production.length, estActions: production.length });
  // Editorial review is a verify→auto-fix convergence loop like the arc gate, so
  // the per-round estimate mirrors it (analyze + one resolve batch / round). The
  // per-comment auto-fixes within a round bill additionally and scale with the
  // number of blocking findings, which isn't knowable at plan time.
  if (textNeeded || !opening || edRounds === 0) {
    plan.push({ kind: 'editorialReview', count: 1, note: roundsNote(edRounds), estActions: convergenceLoopActions(edRounds) });
  }
  // maxEditorialRounds === 0 skips the whole editorial gate in execute mode
  // (runEditorial marks editorialReviewed + editorialChecksReviewed +
  // editorialHealthReady), so the plan must not advertise the registry checks or
  // the health gate that won't run.
  if (edRounds !== 0) {
    plan.push({ kind: 'reverseOutline', count: 1, note: 'refresh scene segmentation for editorial checks (#1349)', estActions: 1 });
    // #1575 — when a per-run subset is set, the plan must say so rather than imply
    // the full enabled set runs.
    const editorialSubset = editorialSubsetIds(options);
    // The checks pass bills a single cos action (only when an LLM check runs) but
    // fans out to many LLM calls. The real call count depends on how each check
    // chunks the stitched manuscript by provider context window, so it isn't
    // knowable at plan time — `issues × enabled LLM checks` is a rough proxy that
    // scales with both series size and check count, surfaced so a large series's
    // check cost is visible. When the caller didn't resolve the enabled-check
    // count, assume one LLM check runs.
    const llmCheckCount = Number.isInteger(costContext?.editorialLlmCheckCount)
      ? costContext.editorialLlmCheckCount
      : 1;
    // Only manuscripts already drafted or produced by THIS run reach these
    // checks. Synopsis placeholders are context, not 31 extra manuscripts.
    const estLlmCalls = reviewedCount * llmCheckCount;
    const checksNote = editorialSubset
      ? `per-run subset of ${editorialSubset.length} editorial check(s) (#1575)`
      : 'enabled editorial checks (#1284)';
    // Surface the optional pause threshold (#1613) when armed, mirroring how the
    // readiness gate is exposed below — so a per-run override is visible in the plan.
    const pauseThreshold = resolveAutopilotCheckPauseThreshold(options);
    const pauseNote = pauseThreshold > 0 ? ` — pauses at ≥ ${pauseThreshold} high finding(s) (#1613)` : '';
    plan.push({
      kind: 'editorialChecks',
      count: 1,
      note: (llmCheckCount > 0 ? `${checksNote} — ~${estLlmCalls} LLM call(s)` : checksNote) + pauseNote,
      estActions: llmCheckCount > 0 ? 1 : 0,
      estLlmCalls,
    });
    // Surface the effective readiness gate (#1580) so a per-run override is
    // visible in the dry-run plan, mirroring how roundsNote exposes the bounds.
    const gate = resolveReadinessGate(options?.readinessGate);
    plan.push({ kind: 'editorialHealthGate', count: 1, note: `editorial health readiness gate (#1316) — gate: ${gate}`, estActions: 0 });
  }
  // Iterate-to-quality revision loop (#2171, opt-in, default off). Each cycle
  // judges every drafted issue (cache-aware — only stale/unjudged content bills),
  // runs one adversarial-cut pass, and re-judges the revised issue: roughly
  // (issues + 2) actions per cycle, capped at maxCycles. High-end estimate — a
  // cycle stops early on plateau / hedged-convergence and cached judges are free.
  if (options?.revisionEnabled) {
    const rev = resolveAutopilotRevision(options);
    plan.push({
      kind: 'revisionCycle',
      count: rev.revisionMaxCycles,
      note: `iterate-to-quality (up to ${rev.revisionMaxCycles} cycle(s), min ${rev.revisionMinCycles}, plateau Δ ${rev.revisionPlateauDelta})`,
      estActions: rev.revisionMaxCycles * (reviewedCount + 2),
    });
  }
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options)) {
    // The deterministic check is free. When it finds a blank drawn noun it may
    // conditionally call the strict prose-grounded backfill before pausing; the
    // snapshot cannot know that future script reference set, so keep the base
    // estimate at zero and name the conditional spend explicitly.
    plan.push({ kind: 'canonVerify', count: 1, note: 'descriptive integrity of drawn nouns (may spend one LLM call per affected issue to backfill strictly from prose)', estActions: 0 });
    const visualNeeded = production.filter((i) => !visualReady(i)).length;
    // Each draft render bills one cos action: cover + back per issue, plus one per
    // interior page. The interior-page count isn't known until the script parses,
    // so the estimate counts the two covers and notes the per-page additions.
    if (visualNeeded) plan.push({ kind: 'visualDraft', count: visualNeeded, note: 'cover + back + all pages (draft) — +1 action per interior page', estActions: visualNeeded * 2 });
    // Teaser deliverable (#2185, opt-in, default off): one CD video project per
    // issue. Each mint+start bills one cos action for the treatment LLM call; the
    // CD project's own render spend is gated on the creative/cos budget its side.
    if (wantsTeaser(options)) plan.push({ kind: 'produceTeaser', count: production.length, note: 'mint + start a Creative Director teaser video per issue (opt-in)', estActions: production.length });
  }
  return plan;
}
