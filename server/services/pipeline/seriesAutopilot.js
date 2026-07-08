/**
 * Pipeline — Series Autopilot (full autonomous mode)
 *
 * A *conductor* that drives a whole series from its current state to a terminal
 * "story-ready" state by composing the already-shipped pipeline service
 * functions (arc gen, episode gen, arc verify/resolve, volume beats, per-issue
 * text stages, structural script gate, manuscript editorial review). It does NOT
 * re-implement any generation logic — every step delegates to the same service
 * the manual route calls.
 *
 * Resume is a PURE FUNCTION of current state. `resolveNextStep(series, issues,
 * runState, options)` returns the first unmet step from the canonical records,
 * so the orchestrator never persists a step cursor: on restart the user just
 * starts again and it picks up at the first missing thing. Anything already
 * `ready`/`edited` is skipped (`isStageReady`) and every generation runs with
 * `force:false`, so an in-progress series is never clobbered.
 *
 * Lifecycle mirrors editorialAnalysisRunner.js: a single in-memory `runs` map
 * keyed by `seriesId`, a `finished` flag + cleanup timer for terminal-frame
 * replay, the one permitted try/catch boundary inside the fire-and-forget IIFE,
 * and a cancel flag checked between every step.
 *
 * Autonomy: gated on the **cos** domain (server/lib/domainAutonomy.js).
 *   - off      → start is rejected (route → 409).
 *   - dry-run  → emit a `plan` frame of what it WOULD do; no side effects.
 *   - execute  → full run, charging the cos daily action budget per step and
 *                pausing when the budget is exhausted.
 *
 * Two convergence guards stop unbounded LLM spend (a real observed condition —
 * arc verify can surface fresh findings every pass): the arc-verify and
 * editorial-review loops are bounded and, when they can't reach clean, set the
 * run to `paused` with the residual findings for human review rather than
 * looping forever.
 *
* CoS gap-filing (opt-in via `options.fileGaps`): when the autopilot hits a
 * capability/quality gap it can't resolve — a script that won't parse, a render
 * that keeps failing, a verify/editorial gate that stalls, or a run-ending
 * error — it files a deduped CoS task (`fileGap`) so the gap is tracked instead
 * of silently swallowed.
 *
 * SCRIPT VERIFICATION — the per-issue scriptVerify step has two gates: a
 * STRUCTURAL gate (does the script parse into pages/panels — a failure blocks
 * page extraction, so it files a gap) and a CRAFT gate (the
 * `pipeline-script-verify` LLM pass via verifyComicScript). The craft gate is
 * ADVISORY: script craft is subjective and the gating quality pass is the
 * series-level editorial review, so blocking craft findings are surfaced + filed
 * (not auto-rewritten, not a hard pause) and the run keeps moving toward a draft.
 *
* CANON GATE: before any visual production, a series-level canonVerify step
 * (canonReadiness.js) checks that every canon noun appearing where it'd be
 * DRAWN (comic-script panels / teleplay) has a description. Undescribed drawn
 * nouns pause the run for human review — an artist can't render a name. (An
 * off-page noun named only in prose narration is never drawn, so it doesn't
 * block here; it's a Nouns-stage quality note.)
 *
 * DRAFT VISUALS (Phase 2, VISUAL_DRAFT_ENABLED): once a story is text-ready,
 * extract comic pages from the script (if not already), then enqueue PROOF
 * (draft) renders for the front cover, back cover, and every interior page —
 * replicating the per-slot jobId persistence the render routes do at the route
 * layer (buildRenderSlot → updateStageWithLatest). Renders are async media jobs:
 * we fire the kickoff, persist the in-flight slot, and do NOT block on pixels
 * (mirrors autoRunner's episodeVideo fire-and-forget). Each render is one
 * billable cos action and is budget-gated individually (a comic is many GPU
 * jobs), and already-enqueued slots are skipped so a resumed run doesn't
 * re-render. Gated behind `options.includeVisual`.
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { parseComicScript } from '../../lib/comicScriptParser.js';
import { loadState } from '../cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import * as cosTaskStore from '../cosTaskStore.js';
import { getSeries, updateSeries } from './series.js';
import { listIssues, getIssue, isStageReady, updateStageWithLatest } from './issues.js';
import { compareIssuesByPosition } from './arcPlanner.js';
import { enqueueComicCover, enqueueComicBackCover, enqueueVisualComicPage } from './visualStages.js';
import { slotKeyForVariant } from './owners.js';
import { buildRenderSlot } from '../../lib/renderSlot.js';
import {
  generateArcOverview,
  commitSeasonsWithRemap,
  generateSeasonEpisodes,
  commitEpisodesToIssues,
  verifyArc,
  resolveVerifyIssues,
  analyzeBeatContinuity,
  resolveBeatContinuity,
  analyzeManuscriptCompleteness,
} from './arcPlanner.js';
import * as volumeBeatsRunner from './volumeBeatsRunner.js';
import * as autoRunner from './autoRunner.js';
import { seedReviewFromFindings, getReview } from './manuscriptReview.js';
import { runEditorialChecks, buildEditorialCheckPlan, enabledChecksConsumeReverseOutline, buildReverseOutlineGateContext, summarizeCheckErrors } from './editorial/checkRunner.js';
import { generateReverseOutline, getReverseOutline } from './reverseOutline.js';
import { computeHealth, openBlockers, READINESS_GATES, resolveReadinessGate, summarizeEditorialBlockers, formatBlockerSummary } from './editorialScore.js';
import { getSettings } from '../settings.js';
import { readReadinessGate, mergeSeverityWeights, resolveBlockingSet } from '../../lib/editorial/index.js';
import { generateManuscriptFix, acceptManuscriptFix } from './manuscriptFix.js';
import { verifyComicScript } from './scriptVerify.js';
import { checkSeriesCanonReadiness } from './canonReadiness.js';
import { judgeFoundation, applyFoundationFix, weakestDimension, residualFindings, DEFAULT_FOUNDATION_THRESHOLD } from './foundationJudge.js';
import { addNotification, removeByMetadata, NOTIFICATION_TYPES, PRIORITY_LEVELS } from '../notifications.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished,
//   cleanupTimer, startedAt, mode, options, runState, activeChild }>
const runs = new Map();

// In-process progress bus (CDO Phase 3, #2185). Every SSE frame the run
// broadcasts to attached HTTP clients is ALSO emitted here keyed by seriesId, so
// a SERVER-SIDE consumer — the Creative Director plan-advance loop running an
// autopilot as one plan step — can observe progress/pause/terminal frames
// without opening an HTTP/SSE client. SSE behavior is unchanged; this is a
// parallel tap, not a replacement. Listeners are per-seriesId and short-lived
// (attached for the life of one plan step), but a busy install could run several
// concurrently, so lift the default 10-listener cap to avoid a spurious leak
// warning. The payloads are the exact SSE frames (they carry `type`).
export const autopilotEvents = new EventEmitter();
autopilotEvents.setMaxListeners(0);

// The frame `type`s that mean the run reached a terminal/paused state — a
// server-side consumer settles its plan step on any of these. `complete` (or a
// dry-run `complete`), `paused` (convergence/budget/child pause), `canceled`
// (user stop), and `error` (run-ending throw) are exhaustive of the run's exit
// frames (see the fire-and-forget coordinator in startSeriesAutopilot).
export const AUTOPILOT_TERMINAL_TYPES = new Set(['complete', 'paused', 'canceled', 'error']);

// Bounded convergence loops — re-verify/re-review at most this many rounds, then
// pause for human review with the residual findings (see module header). These
// are the floor defaults; an install can raise them persistently via
// pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds} (or a single
// run can override per-run through the autopilot start options).
export const MAX_ARC_VERIFY_ROUNDS = 3;
export const MAX_EDITORIAL_ROUNDS = 2;
// Whole-manuscript beat-continuity convergence (#1510). The corpus is the
// compact per-issue beat sheets, so this gate sits between beat generation and
// the expensive text/script stage — bounded like the others, then pauses with
// the residual findings for human review.
export const MAX_BEAT_CONTINUITY_ROUNDS = 2;

// Foundation-quality gate (CWQE Phase 11, #2176). Before drafting, judge the
// whole foundation (world / characters / arc) against a weighted rubric and
// iterate on the weakest dimension until it clears a threshold — bounded like
// the other convergence loops, then pause with the residual per-dimension
// findings for human review. Defaults ON for autopilot runs (the point of the
// phase) but overridable per-run + via the persisted setting. 0 rounds skips
// the gate entirely (accept the foundation as-is).
export const MAX_FOUNDATION_ROUNDS = 3;
export const DEFAULT_FOUNDATION_GATE_ENABLED = true;

// Bounded retry budget for a delegated child runner (#1574). A child (volume
// beats / text auto-run) can finish with its target stage(s) still empty when
// the underlying LLM call failed. Before #1574 the autopilot marked the work
// attempted and advanced regardless — so a transient failure was caught only
// later (text) or not at all until a downstream emptiness check (beats). Now a
// child whose readiness check fails is retried up to MAX_CHILD_RETRIES more
// times (skip-existing, so a retry only fills the gap) before the work is
// marked attempted, an escalation frame is emitted, and the run pauses with the
// residual. 0 = single attempt, no retry (the legacy behavior). A per-run
// `maxChildRetries` option overrides it (plumbed through runOptions).
export const MAX_CHILD_RETRIES = 1;

// Resolve the effective round bounds for a run: an explicit per-run option wins,
// then the persisted pipelineEditorialChecks setting, then the module default.
// Returns integers only — a non-integer at any layer falls through to the next.
// Centralized so the loops, the dry-run plan, and the resume path all agree.
export function resolveAutopilotRounds(options = {}, settings = null) {
  const pec = settings?.pipelineEditorialChecks || {};
  const pick = (optKey, setKey, fallback) => {
    if (Number.isInteger(options?.[optKey])) return options[optKey];
    if (Number.isInteger(pec?.[setKey])) return pec[setKey];
    return fallback;
  };
  return {
    maxArcVerifyRounds: pick('maxArcVerifyRounds', 'maxArcVerifyRounds', MAX_ARC_VERIFY_ROUNDS),
    maxEditorialRounds: pick('maxEditorialRounds', 'maxEditorialRounds', MAX_EDITORIAL_ROUNDS),
    maxBeatContinuityRounds: pick('maxBeatContinuityRounds', 'maxBeatContinuityRounds', MAX_BEAT_CONTINUITY_ROUNDS),
    maxFoundationRounds: pick('maxFoundationRounds', 'maxFoundationRounds', MAX_FOUNDATION_ROUNDS),
  };
}

// Foundation-gate config (#2176): whether the gate runs, and the weighted [0,10]
// threshold the foundation must clear. Mirror resolveAutopilotRounds — per-run
// option wins, then the persisted pipelineEditorialChecks setting, then the
// default. The enable flag defaults ON (the point of the phase); the threshold
// falls through to DEFAULT_FOUNDATION_THRESHOLD in the loop when unset. Stamped
// onto run options once at start so the loop, the dry-run plan, and a resume all
// read the same effective values.
export function resolveAutopilotFoundationGate(options = {}, settings = null) {
  if (typeof options?.foundationGate === 'boolean') return options.foundationGate;
  const pec = settings?.pipelineEditorialChecks || {};
  if (typeof pec?.foundationGate === 'boolean') return pec.foundationGate;
  return DEFAULT_FOUNDATION_GATE_ENABLED;
}
export function resolveAutopilotFoundationThreshold(options = {}, settings = null) {
  if (Number.isFinite(options?.foundationThreshold)) return options.foundationThreshold;
  const pec = settings?.pipelineEditorialChecks || {};
  if (Number.isFinite(pec?.foundationThreshold)) return pec.foundationThreshold;
  return null;
}

// Resolve the effective editorial-health readiness gate for a run (#1580): an
// explicit per-run option wins, then the persisted
// pipelineEditorialChecks.readinessGate, then null — the caller resolves null to
// DEFAULT_READINESS_GATE via resolveReadinessGate. Mirrors resolveAutopilotRounds
// so the gate is overridable per-run exactly like the round bounds; stamped onto
// the run options once at start so the loop, the dry-run plan, and a later resume
// all read the same effective gate.
export function resolveAutopilotReadinessGate(options = {}, settings = null) {
  if (READINESS_GATES.includes(options?.readinessGate)) return options.readinessGate;
  return readReadinessGate(settings);
}

// Editorial-checks pause threshold (#1613): pause the run when the checks pass
// surfaces ≥ N high-severity findings. 0 = off (the default), so the gate is
// opt-in and existing installs are unchanged. Mirrors resolveAutopilotRounds —
// per-run option wins, then the persisted setting, then 0. A non-integer at any
// layer falls through to the next. Stamped onto run options once at start so the
// loop and a later resume read the same effective threshold.
export const DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD = 0;
export function resolveAutopilotCheckPauseThreshold(options = {}, settings = null) {
  if (Number.isInteger(options?.checkFindingsPauseThreshold)) return options.checkFindingsPauseThreshold;
  const pec = settings?.pipelineEditorialChecks || {};
  if (Number.isInteger(pec?.checkFindingsPauseThreshold)) return pec.checkFindingsPauseThreshold;
  return DEFAULT_CHECK_FINDINGS_PAUSE_THRESHOLD;
}

// Pause escalation (#1615): post an in-app notification (notification center,
// surfaced in the header dropdown) when a run pauses, so a paused run doesn't sit
// unnoticed until the user happens to open the status page. Unlike the other
// gates this defaults ON — it's a zero-cost informational signal that directly
// addresses the "paused runs go unnoticed" problem — but stays overridable per
// run and via the persisted setting for users who don't want the noise. Boolean
// at every layer: per-run option wins, then the persisted setting, then true.
export const DEFAULT_NOTIFY_ON_PAUSE = true;
export function resolveAutopilotNotifyOnPause(options = {}, settings = null) {
  if (typeof options?.notifyOnPause === 'boolean') return options.notifyOnPause;
  const pec = settings?.pipelineEditorialChecks || {};
  if (typeof pec?.notifyOnPause === 'boolean') return pec.notifyOnPause;
  return DEFAULT_NOTIFY_ON_PAUSE;
}

// Autopilot → CD teaser deliverable (CDO Phase 3, #2185). Once a comic issue is
// text-ready + drafted, the autopilot can OPTIONALLY mint + start a Creative
// Director video project (a teaser/trailer) seeded from the issue — the reverse
// of the CD→autopilot bridge. Defaults OFF: producing video is a fresh burst of
// LLM + render spend the user must opt into, so existing runs are unchanged.
// Per-run option wins, then the persisted setting, then false. Stamped onto run
// options once at start so the resolver, the dry-run plan, and a later resume
// all read the same effective flag.
export const DEFAULT_PRODUCE_TEASER = false;
export function resolveAutopilotProduceTeaser(options = {}, settings = null) {
  if (typeof options?.produceTeaser === 'boolean') return options.produceTeaser;
  const pec = settings?.pipelineEditorialChecks || {};
  if (typeof pec?.produceTeaser === 'boolean') return pec.produceTeaser;
  return DEFAULT_PRODUCE_TEASER;
}

// Does THIS run want to produce a teaser deliverable? Gated on the resolved
// `produceTeaser` flag AND that visuals ran (a teaser is a visual deliverable —
// pointless on a text-only run).
export function wantsTeaser(options = {}) {
  return options.produceTeaser === true && wantsVisual(options);
}

// Per-gate copy for the non-convergence pause — shared by the arc-verify and
// editorial loops so the two messages can't drift.
const PAUSE_GATES = {
  arc: { label: 'Arc verification', fix: 'Edit the arc/volumes to address them', limit: 'verify-rounds' },
  beatContinuity: { label: 'Beat continuity', fix: 'Edit the affected issue beats', limit: 'beat-continuity-rounds' },
  editorial: { label: 'Editorial review', fix: 'Address them in the manuscript editor', limit: 'editorial-rounds' },
  foundation: { label: 'Foundation quality', fix: 'Strengthen the world / characters / arc, or lower the threshold', limit: 'foundation-rounds' },
};
function convergencePauseReason(gate, maxRounds, blockingCount) {
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
function divergencePauseReason(gate, blockingCount, rounds) {
  const { label, fix } = PAUSE_GATES[gate];
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped converging — ${blockingCount} blocking finding(s) and no net progress over `
    + `${rounds} consecutive ${plural} of auto-resolve. Paused for review. ${fix}, then resume.`;
}

// Foundation gate pause reasons (#2176) — the gate converges on a WEIGHTED
// SCORE, not a finding count, so it needs its own wording (score vs. threshold)
// rather than the finding-count phrasing of convergencePauseReason. Shares
// PAUSE_GATES.foundation so the copy stays aligned with the other gates.
function foundationPauseReason(maxRounds, score, threshold) {
  const { label, fix, limit } = PAUSE_GATES.foundation;
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't reach the threshold (weighted ${score} < ${threshold}) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}
function foundationDivergenceReason(score, threshold, rounds) {
  const { label, fix } = PAUSE_GATES.foundation;
  const plural = rounds === 1 ? 'round' : 'rounds';
  return `${label} stopped improving — weighted ${score} still below ${threshold} with no net gain over `
    + `${rounds} consecutive ${plural} of auto-fix. Paused for review. ${fix}, then resume.`;
}

// Dry-run plan note for a bounded gate: "skipped (0 rounds)" or "up to N rounds".
const roundsNote = (rounds) => (rounds === 0 ? 'skipped (0 rounds)' : `up to ${rounds} rounds`);

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
const convergenceLoopActions = (rounds) => (rounds <= 0 ? 0 : 2 * rounds - 1);

// Sum a dry-run plan's per-step estimates into run totals. `estActions` is the
// budget-relevant total (cos daily-cap units); `estLlmCalls` aggregates the
// check-pass fan-out (editorialChecks bills a single cos action but issues many
// LLM calls — see the rough proxy at its plan.push). Pure — safe to call at
// broadcast time and in tests.
function summarizePlanCost(plan) {
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
const CHILD_POLL_MS = 750;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Pure next-step resolver — the heart of the conductor (no I/O; unit-tested).
// ---------------------------------------------------------------------------

const setHas = (s, v) => (s instanceof Set ? s.has(v) : Array.isArray(s) ? s.includes(v) : false);

const byNumber = (a, b) => (a?.number ?? 9999) - (b?.number ?? 9999);

// The script stages a series must have drafted to be "story-ready", derived
// from its targetFormat. prose is the intermediate source the scripts adapt
// from — we gate on the final scripts so a script-first import (prose empty,
// script authored) is already considered ready and never regenerated.
export function requiredScriptStages(series, options = {}) {
  const fmt = series?.targetFormat || 'comic+tv';
  // Per-run format restriction: a multi-format (comic+tv) series can be driven
  // to just one format's scripts in a single autopilot run — e.g. "produce the
  // comic draft only, skip the 24 teleplays." `options.targetFormats` is a
  // subset of ['comic','tv']; absent/empty means "all formats the series wants".
  const restrict = Array.isArray(options?.targetFormats) && options.targetFormats.length
    ? options.targetFormats
    : null;
  const wantComic = fmt.includes('comic') && (!restrict || restrict.includes('comic'));
  const wantTv = fmt.includes('tv') && (!restrict || restrict.includes('tv'));
  const stages = [];
  if (wantComic) stages.push('comicScript');
  if (wantTv) stages.push('teleplay');
  // Never strand the run with zero required script stages (which would mark every
  // issue text-ready with no script authored). If the restriction excludes
  // everything this series supports, ignore it and fall back to the series' own
  // formats.
  if (stages.length === 0) return requiredScriptStages(series);
  return stages;
}

export function isComicTarget(series) {
  return (series?.targetFormat || 'comic+tv').includes('comic');
}

// Does THIS run want the comic format? `isComicTarget` alone keys off the
// series' declared format, but a per-run `options.targetFormats` restriction can
// scope a comic+tv series to TV only — in which case the comic-only steps
// (scriptVerify, visual draft) must NOT run, or a TV-only pass would enter
// comic-script verification with no comicScript and pause on an unparseable
// script. Mirrors the restriction logic in requiredScriptStages: an empty/absent
// restriction (or one that excludes everything the series supports) means "all
// formats the series wants", so this stays true for the default whole-series run.
export function wantsComic(series, options = {}) {
  if (!isComicTarget(series)) return false;
  const restrict = Array.isArray(options?.targetFormats) && options.targetFormats.length
    ? options.targetFormats
    : null;
  if (!restrict) return true;
  // If the restriction excludes every format the series supports, requiredScriptStages
  // ignores it (never strand the run) — match that here so the gates agree.
  const wantComic = restrict.includes('comic');
  const wantTv = restrict.includes('tv') && (series?.targetFormat || '').includes('tv');
  if (!wantComic && !wantTv) return true; // restriction is a no-op → whole series
  return wantComic;
}

// Effective "produce draft visuals?" decision. The `target` option overrides
// the `includeVisual` flag: 'text' forces text-only (no canon gate, no render),
// 'visual' forces visuals, and 'auto' (the default) honors `includeVisual`
// (which itself defaults true). Without this, a `target:'text'` request on a
// comic series would still run canonVerify + queue draft renders.
export function wantsVisual(options = {}) {
  if (options.target === 'text') return false;
  if (options.target === 'visual') return true;
  return options.includeVisual !== false;
}

function orderedIssues(issues) {
  return [...(Array.isArray(issues) ? issues : [])].sort(compareIssuesByPosition);
}

function textReady(issue, series, options = {}) {
  return requiredScriptStages(series, options).every((stageId) => isStageReady(issue.stages?.[stageId]));
}

// An issue "has beats" once its idea stage carries expanded beat text
// (idea.output) — the unit the whole-manuscript beat-continuity pass (#1510)
// reads. isStageReady(idea) is exactly that: status ready/edited AND non-empty
// output.
function issueHasBeats(issue) {
  return isStageReady(issue?.stages?.idea);
}

// Structural script gate (pure): does the comic script parse into >=1 page with
// >=1 panel? Cheap, no LLM — this is the Phase-1 "verify the scripts work".
export function scriptStructurallyReady(issue) {
  const output = issue.stages?.comicScript?.output || '';
  if (!output.trim()) return false;
  const { pages } = parseComicScript(output);
  if (!Array.isArray(pages) || pages.length === 0) return false;
  return pages.some((p) => Array.isArray(p.panels) && p.panels.length > 0);
}

// A render slot counts as "enqueued" once it carries a jobId or a stamped
// filename (proof or final). Draft rendering only kicks off proof renders, but
// we accept either so a re-run never re-renders a slot the user already
// finalized manually.
// Include the legacy pre-proof/final fields (`imageJobId`/`filename`) the
// sanitizer still preserves on upgraded projects — otherwise an
// already-rendered legacy slot reads as un-enqueued and gets re-rendered.
const slotEnqueued = (slot) => !!(
  slot && (slot.proofImage?.jobId || slot.proofImage?.filename
    || slot.finalImage?.jobId || slot.finalImage?.filename
    || slot.imageJobId || slot.filename)
);
const pageEnqueued = (page) => !!(
  page && (page.proofImage?.jobId || page.proofImage?.filename
    || page.finalImage?.jobId || page.finalImage?.filename
    || page.imageJobId || page.filename)
);

/**
 * Has an issue's comic art been drafted? True once pages exist, the front cover
 * is enqueued, any authored back cover is enqueued, and every page that HAS
 * panels is enqueued. Pages with no panels can't be rendered, so they don't
 * block readiness.
 */
export function visualReady(issue) {
  const cp = issue.stages?.comicPages;
  const pages = Array.isArray(cp?.pages) ? cp.pages : [];
  if (pages.length === 0) return false;
  if (!slotEnqueued(cp?.cover)) return false;
  if (!slotEnqueued(cp?.backCover)) return false; // always drafted (renderer has a fallback)
  return pages.every((p) => (Array.isArray(p.panels) && p.panels.length > 0 ? pageEnqueued(p) : true));
}

/**
 * Return the first unmet step for a series given its canonical records and the
 * in-run accumulator (`runState`). Pure — caller supplies fresh state.
 *
 * runState fields consulted (all optional): arcVerified, editorialReviewed,
 * reverseOutlineRefreshed (booleans); beatsAttempted, textAttempted, scriptChecked (Set|array of ids).
 * The *attempted* sets stop a perpetually-failing step (an issue whose LLM run
 * keeps erroring) from looping forever — the conductor records an attempt even
 * on failure, so the resolver moves past it within one run.
 */
export function resolveNextStep(series, issues, runState = {}, options = {}) {
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort(byNumber) : [];
  const ordered = orderedIssues(issues);

  // STEP 1 — arc. Also (re)generate when there are no seasons at all: an
  // arc-only series (arc text present, seasons: []) has nothing for the
  // episode/issue steps to expand, and would otherwise sail through verify/
  // review of an empty issue list and be marked done with no volumes. The
  // attempted-guard stops a re-loop if arc generation yields no seasons (the
  // dispatch pauses in that case).
  const noArc = !series?.arc?.logline && !series?.arc?.summary;
  if (!runState.arcAttempted && (noArc || seasons.length === 0)) {
    return { kind: 'generateArc', reason: seasons.length === 0 && !noArc ? 'series has no volumes' : 'series has no arc' };
  }

  // STEP 2 — a season with zero issues (in season order). Skip volumes already
  // attempted this run so an empty episode generation can't re-loop (the
  // dispatch pauses when it produces no issues).
  for (const season of seasons) {
    if (setHas(runState.episodesAttempted, season.id)) continue;
    const inSeason = ordered.filter((i) => i.seasonId === season.id);
    if (inSeason.length === 0) {
      return { kind: 'generateEpisodes', seasonId: season.id, reason: `volume ${season.number ?? '?'} has no issues` };
    }
  }

  // STEP 3 — arc verification (once per run; bounded loop happens in dispatch).
  if (!runState.arcVerified) {
    return { kind: 'verifyArc', reason: 'arc not yet verified this run' };
  }

  // STEP 3.5 — foundation-quality gate (#2176). After the arc/volumes exist and
  // arc structure is verified, judge the whole foundation (world / characters /
  // arc) BEFORE the expensive beat/text stages and iterate on the weakest
  // dimension until it clears the threshold. Once per run (bounded loop happens
  // in dispatch). Gated on `foundationGate` being enabled AND a non-zero round
  // budget — a disabled/0-round gate is treated as already satisfied so the
  // resolver falls straight through to beats (the dispatch never runs).
  if (!runState.foundationGated
    && options.foundationGate !== false
    && options.maxFoundationRounds !== 0) {
    return { kind: 'foundationGate', reason: 'foundation not yet judged this run' };
  }

  // STEP 4a — per-volume beat sheets (skip volumes already attempted this run).
  for (const season of seasons) {
    if (setHas(runState.beatsAttempted, season.id)) continue;
    const inSeason = ordered.filter((i) => i.seasonId === season.id);
    if (inSeason.some((i) => !isStageReady(i.stages?.idea))) {
      return { kind: 'beatSheet', seasonId: season.id, reason: `beats missing in volume ${season.number ?? '?'}` };
    }
  }

  // STEP 4a.5 — whole-manuscript beat continuity (#1510). Once every volume's
  // beats exist (the 4a loop above is exhausted), run ONE cross-issue beat-level
  // pass BEFORE the expensive text/script generation — catching dropped
  // cliffhangers, finale drift, unlanded through-lines, and duplicated "firsts"
  // at the cheap beat altitude instead of after 24 full scripts exist. Only
  // meaningful when at least one issue actually carries beats; a synopsis-only
  // run has nothing beat-level to check (and would just duplicate arc verify),
  // so it's skipped without ever marking the gate.
  if (!runState.beatContinuityChecked && ordered.some(issueHasBeats)) {
    return { kind: 'beatContinuity', reason: 'whole-manuscript beat continuity not yet checked this run' };
  }

  // STEP 4b — per-issue text stages (prose + required scripts).
  for (const issue of ordered) {
    if (setHas(runState.textAttempted, issue.id)) continue;
    if (!textReady(issue, series, options)) {
      return { kind: 'textStages', issueId: issue.id, reason: 'prose / scripts not ready' };
    }
  }

  // STEP 4c — structural script gate (comic targets only). Gate on wantsComic,
  // not bare isComicTarget, so a TV-only run of a comic+tv series doesn't enter
  // comic-script verification with no comicScript (which would pause on an
  // unparseable script).
  if (wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.scriptChecked, issue.id)) continue;
      return { kind: 'scriptVerify', issueId: issue.id, reason: 'comic script not yet structurally verified' };
    }
  }

  // STEP 5 — series-level editorial review via the manuscript editor (once).
  if (!runState.editorialReviewed) {
    return { kind: 'editorialReview', reason: 'editorial review not yet run this run' };
  }

  // STEP 5.1 — refresh the reverse-outline scene segmentation (#1349). Runs AFTER
  // the editorial completeness pass (STEP 5, which may edit the manuscript) and
  // BEFORE the registry checks (5.2) so the scene-consuming checks read fresh
  // scenes. The handler self-gates: a no-op (no budget) when no enabled check
  // reads the outline or the stored outline is already fresh.
  if (!runState.reverseOutlineRefreshed) {
    return { kind: 'reverseOutline', reason: 'reverse-outline segmentation not yet refreshed this run' };
  }

  // STEP 5.2 — registry-driven editorial checks (#1284). Runs the enabled
  // editorial checks once per run and seeds their findings into the same
  // manuscript-review comment set. A no-op when no checks are enabled.
  if (!runState.editorialChecksReviewed) {
    return { kind: 'editorialChecks', reason: 'editorial checks not yet run this run' };
  }

  // STEP 5.3 — editorial health convergence gate (#1316). After BOTH editorial
  // passes have seeded their findings, read the aggregate "ready" signal (no open
  // findings above the configured readiness gate). The completeness loop only
  // gates on its OWN high findings; the registry checks (5.2) can surface fresh
  // blockers after it converged, so this final gate reconciles the whole review
  // before visuals. Pauses with the residual blockers when not clean.
  if (!runState.editorialHealthReady) {
    return { kind: 'editorialHealthGate', reason: 'editorial health not yet confirmed clean this run' };
  }

  // STEP 5.5 — canon descriptive integrity. Before ANY visual production, every
  // canon noun that appears where it'd be drawn must be described (an artist
  // can't render a name). Runs once per run; the gate blocks (pauses) on
  // undescribed drawn nouns. Only relevant when visuals will be produced.
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options) && !runState.canonVerified) {
    return { kind: 'canonVerify', reason: 'canon descriptive integrity not yet verified this run' };
  }

  // STEP 6 — draft visuals (cover + back + all interior pages).
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.visualDrafted, issue.id)) continue;
      if (visualReady(issue)) continue;
      return { kind: 'visualDraft', issueId: issue.id, reason: 'comic pages not yet drafted' };
    }
  }

  // STEP 7 — teaser video deliverable (CDO Phase 3, #2185, opt-in, default off).
  // After every issue is text-ready + drafted, OPTIONALLY mint + start a Creative
  // Director video project seeded from each issue. Gated on wantsTeaser (which
  // itself requires visuals). Attempted-once per issue this run so a started (or
  // failed) teaser can't re-loop the resolver back here.
  if (VISUAL_DRAFT_ENABLED && wantsTeaser(options) && wantsComic(series, options)) {
    for (const issue of ordered) {
      if (setHas(runState.teaserProduced, issue.id)) continue;
      return { kind: 'produceTeaser', issueId: issue.id, reason: 'teaser video not yet produced' };
    }
  }

  return { kind: 'done' };
}

// ---------------------------------------------------------------------------
// Run registry helpers (mirror editorialAnalysisRunner.js).
// ---------------------------------------------------------------------------

export function isAutopilotActive(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished;
}

export function attachClient(seriesId, res) {
  return attachSseClient(runs, seriesId, res);
}

export function cancelSeriesAutopilot(seriesId) {
  const run = runs.get(seriesId);
  if (!run || run.finished) return false;
  run.cancelRequested = true;
  // Emit an immediate acknowledgement frame so the UI can switch to a
  // "cancelling…" state right away. Cancellation is cooperative and checked
  // between steps (the terminal `canceled` frame follows once the active
  // step/LLM call returns) — without this ack the user sees no feedback until
  // the loop unwinds, which can be the length of a long in-flight LLM call (#1617).
  broadcastSse(run, { type: 'cancel:acknowledged', runId: run.runId, requestedAt: new Date().toISOString() });
  // Propagate to the currently-delegated child so cancel is responsive
  // mid-step instead of only between steps.
  const child = run.activeChild;
  if (child?.kind === 'beats') volumeBeatsRunner.cancelVolumeBeatsRun(child.id);
  else if (child?.kind === 'text') autoRunner.cancelAutoRun(child.id);
  return true;
}

function broadcast(seriesId, payload) {
  const run = runs.get(seriesId);
  if (!run) return;
  broadcastSse(run, payload);
  // Mirror every frame onto the in-process bus (CDO Phase 3, #2185) so a
  // server-side consumer (CD plan step) sees the same progress/pause/terminal
  // frames as an SSE client. Emit is best-effort — a listener throw must never
  // abort the run (this runs inside the fire-and-forget coordinator).
  try {
    autopilotEvents.emit(seriesId, payload);
  } catch (err) {
    console.log(`⚠️ autopilot: event emit failed for ${seriesId.slice(0, 12)}: ${err.message}`);
  }
}

function scheduleCleanup(seriesId, record) {
  record.cleanupTimer = setTimeout(() => {
    if (runs.get(seriesId) !== record) return;
    for (const c of record.clients) c.end();
    runs.delete(seriesId);
  }, SSE_CLEANUP_DELAY_MS);
}

// Thin persisted marker for resume/paused UI + boot recovery. NOT a step
// cursor — see module header. Best-effort; a marker write must never abort a run.
async function persistMarker(seriesId, patch) {
  await updateSeries(seriesId, {
    autopilot: { ...patch, updatedAt: new Date().toISOString() },
  }).catch((err) => {
    console.log(`⚠️ autopilot: marker write failed for ${seriesId.slice(0, 12)}: ${err.message}`);
  });
}

// File a CoS task for a capability/quality gap the autopilot can't resolve on
// its own (a script that won't parse, a render that keeps failing, a stalled
// verify, a run-ending error). Opt-in via `options.fileGaps`; never fires in
// dry-run. The first description line is kept STABLE per (series, gapKind,
// issue) so cosTaskStore.addTask's pending/in_progress dedup collapses repeats
// instead of spamming a task per page / per run. Best-effort — a task-store
// failure must never abort the autopilot.
async function fileGap(record, sId, { gapKind, issueId = null, summary, context = '' }) {
  if (!record.options.fileGaps || record.mode !== 'execute') return;
  const idTag = `series ${sId}${issueId ? ` issue ${issueId}` : ''}`;
  const description = `Autopilot ${gapKind} gap — ${idTag}\n\n${summary}`;
  const result = await cosTaskStore.addTask({ description, context, app: 'pipeline' }, 'user')
    .catch((err) => { console.log(`⚠️ autopilot: fileGap (${gapKind}) failed: ${err.message}`); return null; });
  if (result && !result.duplicate) {
    broadcast(sId, { type: 'gap:filed', gapKind, issueId, taskId: result.id });
  }
}

// Pause escalation (#1615): post an in-app notification when a run pauses so the
// user is told actively, not only when they happen to open the status page. The
// SSE `paused` frame still fires for an attached client; this is the persistent
// out-of-band signal for a user who isn't watching. Opt-out via
// `options.notifyOnPause` / the persisted setting (default on); never fires in
// dry-run. Prior pause notifications for this series are cleared first so a
// resume→pause cycle leaves exactly one current banner instead of a stack, and
// the metadata field is series-scoped so removeByMetadata can't touch unrelated
// notifications. Best-effort — a notification failure must never abort the run.
// Drop any pause banner for this series. Called before posting a fresh one (so a
// resume→pause cycle leaves exactly one) AND when a new execute run starts (so a
// run resumed from a pause that then completes/errors doesn't leave a stale
// "paused" banner + dead resume link). Series-scoped metadata so it can't touch
// unrelated notifications. Best-effort.
async function clearPauseNotice(sId) {
  await removeByMetadata('autopilotPauseSeriesId', sId).catch(() => {});
}

async function notifyPause(record, sId, { reason, pauseKind = null, currentStep = null }) {
  if (record.options.notifyOnPause === false || record.mode !== 'execute') return;
  const series = await getSeries(sId).catch(() => null);
  const seriesName = series?.name || 'a series';
  await clearPauseNotice(sId);
  await addNotification({
    type: NOTIFICATION_TYPES.AUTOPILOT_PAUSED,
    title: `Autopilot paused — ${seriesName}`,
    description: reason || 'The run paused and needs human review before it can continue.',
    priority: PRIORITY_LEVELS.HIGH,
    link: `/pipeline/series/${sId}`,
    metadata: { autopilotPauseSeriesId: sId, runId: record.runId, pauseKind, currentStep },
  }).catch((err) => { console.log(`⚠️ autopilot: pause notification failed for ${sId.slice(0, 12)}: ${err.message}`); });
}

// Series Autopilot threads BOTH its run provider AND its run model as SOFT
// defaults, NOT hard overrides — so a deliberate per-stage pin (Prompts page /
// stage-config.json) still wins for that stage, matching what verifyComicScript
// already does (#1514 for provider; #1558 for model). Each run-level value lands
// on stageRunner's soft channel (`providerDefault` tier 3 / `modelDefault`): it
// applies only to UNPINNED stages and soft-falls-through (to the active provider
// / the provider's default model) when unavailable, rather than throwing
// PROVIDER_OVERRIDE_UNAVAILABLE or beating a stage's deliberate pin the way a
// hard override would. For the model dimension "unpinned" means a stage carrying
// only a *tier* value (default/quick/coding/heavy) — the run model overrides the
// tier but still loses to a deliberate explicit-model pin (see
// stageRunner.resolveModelHint). Before #1558 the model was threaded as a hard
// `modelOverride`, which let the run model beat even an explicit stage pin.
//
// Two shapes because the delegated services disagree on field names: the
// arc/episode/verify passes take `providerDefault`/`modelDefault`; the child
// runners (volumeBeatsRunner, autoRunner) and the `providerId`-style services
// take `providerIdDefault`/`modelIdDefault`. Each maps its incoming defaults to
// stageRunner's `providerDefault`/`modelDefault` at the leaf call while keeping
// its existing hard `providerOverride`/`providerId` + `modelOverride`/`model`
// params untouched for manual route callers.
const providerOverrideOpts = (record) => ({
  providerDefault: record.options.providerOverride,
  modelDefault: record.options.modelOverride,
});
const providerIdOpts = (record) => ({
  providerIdDefault: record.options.providerOverride,
  modelIdDefault: record.options.modelOverride,
  // Multi-candidate draft gate (#2169): bill one cos action per re-roll and stop
  // re-rolling when the daily budget is spent. Only ever invoked by
  // generateStage's runDraftGate on a judgeable stage with draftAttempts > 1 — a
  // no-op for every other stage/run. Check-then-bill so a skipped (budget-out)
  // attempt isn't charged. Returns false to halt further attempts (keep the best
  // so far); true when the attempt may proceed.
  chargeAction: async () => {
    const budget = await getDomainBudgetStatus('cos');
    if (!budget.withinBudget) return false;
    await recordDomainUsage('cos', { actions: 1 });
    return true;
  },
});

// Pause result when the cos action budget is exhausted, else null. Used to gate
// EACH billable call inside the multi-call verify/editorial convergence loops —
// the conductor's per-step budget check only fires once before the step, so
// without this a single step could bill several actions past the daily cap.
// gapFiled:true so a budget pause doesn't also file a generic stalled gap
// (mirrors the conductor's own loop-level budget pause, which files none).
async function budgetPause() {
  const budget = await getDomainBudgetStatus('cos');
  if (budget.withinBudget) return null;
  return { pause: true, gapFiled: true, reason: `daily cos ${budget.exceeded || 'actions'} budget reached` };
}

// ---------------------------------------------------------------------------
// Step dispatch.
// ---------------------------------------------------------------------------

async function waitForChild(isActive, record) {
  while (isActive()) {
    if (record.cancelRequested) return;
    await sleep(CHILD_POLL_MS);
  }
}

async function runArcVerify(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxArcVerifyRounds)
    ? record.options.maxArcVerifyRounds
    : MAX_ARC_VERIFY_ROUNDS;
  // maxRounds === 0 means "skip verification entirely" — accept the arc as-is.
  if (maxRounds === 0) {
    record.runState.arcVerified = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeVerify = await budgetPause();
    if (beforeVerify) return beforeVerify;
    const { issues } = await verifyArc(seriesId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = issues.filter((i) => record.options.blockingSets.arc.has(i.severity));
    broadcast(seriesId, {
      type: 'verify:round', scope: 'arc', round, findings: issues.length, blocking: blocking.length,
    });
    if (blocking.length === 0) {
      record.runState.arcVerified = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('arc', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): if the resolve passes stop reducing blocking
    // findings, bail now rather than burning the remaining rounds + budget.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('arc', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    if (record.cancelRequested) return { canceled: true };
    // resolveVerifyIssues bills another action — recheck the budget so a single
    // step can't overspend the daily cap mid-loop.
    const beforeResolve = await budgetPause();
    if (beforeResolve) return beforeResolve;
    const resolved = await resolveVerifyIssues(seriesId, { findings: blocking, ...providerOverrideOpts(record) });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'resolve:round', scope: 'arc', round,
      episodesEdited: Array.isArray(resolved?.episodesResolved) ? resolved.episodesResolved.length : 0,
    });
  }
  return {};
}

// Whole-manuscript beat-continuity convergence loop (#1510). Mirrors
// runArcVerify one altitude down: verify the whole-book beat corpus, and on
// blocking findings resolve them by rewriting the offending issues' beats in
// place (resolveBeatContinuity → applyBeatResolutions, no beat-sheet
// regeneration), then re-verify. Bounded; pauses with the residual on
// non-convergence. Each verify + each resolve is budget-gated and bills one cos
// action, like the arc loop.
async function runBeatContinuity(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxBeatContinuityRounds)
    ? record.options.maxBeatContinuityRounds
    : MAX_BEAT_CONTINUITY_ROUNDS;
  // maxRounds === 0 means "skip the beat-continuity gate entirely".
  if (maxRounds === 0) {
    record.runState.beatContinuityChecked = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeVerify = await budgetPause();
    if (beforeVerify) return beforeVerify;
    const { issues } = await analyzeBeatContinuity(seriesId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = issues.filter((i) => record.options.blockingSets.beatContinuity.has(i.severity));
    broadcast(seriesId, {
      type: 'verify:round', scope: 'beatContinuity', round, findings: issues.length, blocking: blocking.length,
    });
    if (blocking.length === 0) {
      record.runState.beatContinuityChecked = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('beatContinuity', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): bail when the resolve passes stop reducing blocking findings.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('beatContinuity', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    if (record.cancelRequested) return { canceled: true };
    // resolveBeatContinuity bills another action — recheck the budget so a
    // single step can't overspend the daily cap mid-loop.
    const beforeResolve = await budgetPause();
    if (beforeResolve) return beforeResolve;
    const resolved = await resolveBeatContinuity(seriesId, { findings: blocking, ...providerOverrideOpts(record) });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'resolve:round', scope: 'beatContinuity', round,
      episodesEdited: Array.isArray(resolved?.episodesResolved)
        ? resolved.episodesResolved.filter((e) => e?.corrected).length
        : 0,
    });
  }
  return {};
}

// Foundation-quality convergence loop (#2176). Mirrors runArcVerify but gates on
// a WEIGHTED SCORE (not a blocking-findings count): judge the whole foundation,
// and while it's below the threshold, target the weakest dimension, apply the
// fix through the owning service (universe refine / character expand / arc
// resolve — force:false, never a raw write), then re-judge. The re-judge is
// content-hash-cached, so an unchanged foundation short-circuits (no LLM) and
// can't loop. Bounded; pauses with the residual per-dimension findings on
// non-convergence. Each judge + each fix bills one cos action, budget-gated like
// the arc loop. The improve-loop convergence is tracked on the weighted score
// (higher = better), so divergence = the score failing to reach a NEW HIGH.
async function runFoundationGate(seriesId, record) {
  const maxRounds = Number.isInteger(record.options.maxFoundationRounds)
    ? record.options.maxFoundationRounds
    : MAX_FOUNDATION_ROUNDS;
  // 0 rounds (or disabled) means "skip the gate entirely" — accept the
  // foundation as-is. The resolver already routes past a disabled gate, but a
  // dispatch that arrives here with 0 rounds still short-circuits cleanly.
  if (maxRounds === 0 || record.options.foundationGate === false) {
    record.runState.foundationGated = true;
    return {};
  }
  const threshold = Number.isFinite(record.options.foundationThreshold)
    ? record.options.foundationThreshold
    : DEFAULT_FOUNDATION_THRESHOLD;
  const providerId = record.options.providerOverride;
  const model = record.options.modelOverride;

  // Convergence tracker keyed on the weighted score (higher is better) — invert
  // to a "distance below 10" so trackConvergence's fewer-is-better minimum logic
  // applies unchanged (a new low distance = a new high score = progress).
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeJudge = await budgetPause();
    if (beforeJudge) return beforeJudge;
    // Never force: judgeFoundation is content-hash-cached, so an unchanged
    // foundation (a clean verdict from a prior run, or a fix that changed
    // nothing) returns the cached score with no LLM call — this IS the fast-pass
    // that stops an already-clean foundation looping. A real change (any fix, or
    // a user edit) flips the pinned hash and re-judges automatically.
    const snap = await judgeFoundation(seriesId, { providerId, model });
    // A cached (content-hash unchanged) verdict did no LLM work — don't bill it.
    if (!snap.cached) await recordDomainUsage('cos', { actions: 1 });
    const score = snap.weightedScore ?? 0;
    const weak = weakestDimension(snap.dimensions);
    broadcast(seriesId, {
      type: 'foundation:round', round, weightedScore: score, threshold, weakest: weak?.dimension || null,
    });
    if (score >= threshold) {
      record.runState.foundationGated = true;
      return {};
    }
    if (round === maxRounds || !weak) {
      return {
        pause: true,
        pauseKind: 'maxRounds',
        reason: foundationPauseReason(maxRounds, score, threshold),
        residual: residualFindings(snap.dimensions),
      };
    }
    // Divergence guard (#1571): bail when fixes stop improving the score.
    convergence = trackConvergence(convergence, 10 - score);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return {
        pause: true,
        pauseKind: 'divergence',
        reason: foundationDivergenceReason(score, threshold, DIVERGENCE_PATIENCE),
        residual: residualFindings(snap.dimensions),
      };
    }
    if (record.cancelRequested) return { canceled: true };
    const beforeFix = await budgetPause();
    if (beforeFix) return beforeFix;
    const fix = await applyFoundationFix(seriesId, weak.dimension, {
      finding: snap.dimensions?.[weak.dimension] || {},
      providerOverride: providerId,
      modelOverride: model,
    });
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(seriesId, {
      type: 'foundation:fix', round, dimension: weak.dimension, applied: fix?.applied === true, reason: fix?.reason || null,
    });
    // A dimension whose owning service can't apply a fix (no linked universe, a
    // fully-locked cast, nothing left to fill) would loop unproductively — treat
    // an inapplicable fix as immediate non-convergence and pause for human
    // review rather than burning the remaining rounds re-judging an unchanged
    // foundation.
    if (fix?.applied !== true) {
      return {
        pause: true,
        pauseKind: 'inapplicable',
        reason: `Foundation gate can't auto-fix the weakest dimension (${weak.dimension}): ${fix?.reason || 'no change applied'}. Strengthen it manually, or lower the threshold, and resume.`,
        residual: residualFindings(snap.dimensions),
      };
    }
  }
  return {};
}

// Resolve the effective retry budget for a delegated child runner this run: a
// per-run `maxChildRetries` option wins, else the module default. Negative
// values clamp to 0 (single attempt).
function childRetryBudget(record) {
  const v = record.options.maxChildRetries;
  return Number.isInteger(v) ? Math.max(0, v) : MAX_CHILD_RETRIES;
}

// Delegate to a child SSE runner, block until it finishes, then VERIFY the child
// actually produced its target output before advancing (#1574). Shared by the
// beats and text steps. `checkReady` returns null when the output landed, or a
// `{ reason, residual }` describing what's still missing. On a miss the child is
// retried (skip-existing, so a retry only fills the gap) up to the run's retry
// budget; each attempt is budget-gated and bills one cos action. When the budget
// is exhausted the retries stop. If the output is still missing after the last
// attempt the work is marked attempted (so the resolver can't loop back here), an
// escalation frame is emitted, and a pause result is returned for human review —
// instead of the pre-#1574 silent skip that let a failed child reach 'done'.
async function runChildToCompletion(seriesId, record, {
  attemptedSet, kind, id, start, isActive, checkReady,
}) {
  const maxAttempts = childRetryBudget(record) + 1;
  let miss = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (record.cancelRequested) return { canceled: true };
    // Each child run bills one cos action — budget-gate every attempt so a
    // retry can't overspend the daily cap (mirrors the verify loops).
    const beforeStart = await budgetPause();
    if (beforeStart) return beforeStart;
    await start();
    record.activeChild = { kind, id };
    await waitForChild(() => isActive(id), record);
    record.activeChild = null;
    await recordDomainUsage('cos', { actions: 1 });
    if (record.cancelRequested) return { canceled: true };
    miss = checkReady ? await checkReady() : null;
    if (!miss) {
      attemptedSet.add(id);
      return {};
    }
    if (attempt < maxAttempts) {
      broadcast(seriesId, {
        type: 'child:retry', kind, id, attempt, maxAttempts, reason: miss.reason,
      });
    }
  }
  // Output still missing after every attempt — escalate and pause. `pauseKind`
  // keeps this pause classifiable alongside the verify/editorial loops'
  // 'maxRounds'/'divergence' kinds (a child runner that couldn't produce output,
  // distinct from a convergence gate that ran out of rounds).
  attemptedSet.add(id);
  broadcast(seriesId, {
    type: 'child:escalate', kind, id, attempts: maxAttempts, reason: miss.reason,
  });
  return { pause: true, pauseKind: 'childFailed', reason: miss.reason, residual: miss.residual };
}

const runBeats = (seriesId, seasonId, record) => runChildToCompletion(seriesId, record, {
  attemptedSet: record.runState.beatsAttempted,
  kind: 'beats',
  id: seasonId,
  start: () => volumeBeatsRunner.startVolumeBeatsRun(seriesId, seasonId, { mode: 'skip-existing', ...providerIdOpts(record) }),
  isActive: volumeBeatsRunner.isVolumeBeatsRunActive,
  // Beats succeeded when every issue in the volume has a ready `idea` stage —
  // the same predicate the resolver uses to decide a volume still needs beats.
  // Before #1574 a failed beats run was silently marked attempted and only
  // surfaced (if at all) when a downstream stage found `idea` empty.
  checkReady: async () => {
    const inSeason = (await listIssues({ seriesId })).filter((i) => i.seasonId === seasonId);
    const missing = inSeason.filter((i) => !isStageReady(i.stages?.idea));
    if (missing.length === 0) return null;
    return {
      reason: `beat generation for volume ${seasonId} did not produce beats for ${missing.length} issue(s)`,
      residual: missing.map((i) => ({ severity: 'high', location: `issue ${i.number ?? '?'} / idea`, problem: 'beat sheet (idea stage) is still empty after the beats run (likely an LLM failure)' })),
    };
  },
});

const runText = (seriesId, issueId, record) => runChildToCompletion(seriesId, record, {
  attemptedSet: record.runState.textAttempted,
  kind: 'text',
  id: issueId,
  start: async () => {
    // Only adapt the target format's script(s) — a single-format series shouldn't
    // spend LLM calls populating the off-target script across every issue.
    const preIssue = await getIssue(issueId);
    const preSeries = await getSeries(preIssue.seriesId).catch(() => null);
    const scripts = requiredScriptStages(preSeries, record.options);
    // Forward the run's provider/model override so prose + scripts honor it like
    // every other step (autoRunner threads these into generateStage).
    await autoRunner.startAutoRunTextStages(issueId, { force: false, scripts, ...providerIdOpts(record) });
  },
  isActive: autoRunner.isAutoRunActive,
  // A delegated text run can end with required stages still empty (the child's
  // LLM call failed) — verify the required stages landed before advancing.
  checkReady: async () => {
    const issue = await getIssue(issueId);
    const series = await getSeries(issue.seriesId).catch(() => null);
    if (textReady(issue, series, record.options)) return null;
    const missing = requiredScriptStages(series, record.options).filter((s) => !isStageReady(issue.stages?.[s]));
    return {
      reason: `text generation for issue ${issue.number ?? issueId} did not produce required stage(s): ${missing.join(', ')}`,
      residual: missing.map((s) => ({ severity: 'high', location: `issue ${issue.number ?? '?'} / ${s}`, problem: 'stage is still empty after the text run (likely an LLM failure)' })),
    };
  },
});

async function runScriptVerify(sId, issueId, record) {
  record.runState.scriptChecked.add(issueId);
  const issue = await getIssue(issueId);

  // Gate 1 — STRUCTURAL (pure, cheap): does the script parse into pages/panels?
  // This is the only structural validation before completion in text-only /
  // visual-disabled comic runs, so a failure must BLOCK (pause), not just mark
  // the issue checked — otherwise the run could report done with a script that
  // can't become pages.
  if (!scriptStructurallyReady(issue)) {
    await fileGap(record, sId, {
      gapKind: 'script-unparseable',
      issueId,
      summary: 'The comic script for this issue does not parse into pages/panels, so comic pages can\'t be extracted. It likely needs a manual fix or regeneration of the comicScript stage.',
      context: `issueId=${issueId}`,
    });
    return {
      pause: true,
      gapFiled: true,
      reason: `comic script for issue ${issue.number ?? issueId} does not parse into pages/panels`,
      residual: [{ severity: 'high', location: `issue ${issue.number ?? '?'} / comicScript`, problem: 'script did not parse into pages/panels — cannot extract comic pages' }],
    };
  }

  // Gate 2 — CRAFT (LLM): does the script function as a comic script? This is
  // ADVISORY — unlike arc continuity, script craft is subjective and the
  // gating quality pass is the series-level editorial review, so blocking
  // findings are surfaced + filed (not auto-rewritten, not a hard pause) and
  // the autopilot keeps moving toward a draft. Wrapped so an LLM failure
  // downgrades to a skip instead of aborting the whole run.
  let issues = [];
  try {
    const result = await verifyComicScript(issueId, providerIdOpts(record));
    issues = result.issues || [];
    await recordDomainUsage('cos', { actions: 1 });
  } catch (err) {
    broadcast(sId, { type: 'step:skip', kind: 'scriptVerify', issueId, reason: `craft verify unavailable: ${(err?.message || err).toString().slice(0, 200)}` });
    return {};
  }
  const blocking = issues.filter((i) => i.severity === 'high');
  broadcast(sId, { type: 'verify:round', scope: 'script', issueId, round: 1, findings: issues.length, blocking: blocking.length });
  if (blocking.length) {
    await fileGap(record, sId, {
      gapKind: 'script-craft',
      issueId,
      summary: `Comic script craft review found ${blocking.length} blocking issue(s): ${blocking.map((b) => b.problem).join(' | ').slice(0, 600)}`,
      context: JSON.stringify(blocking).slice(0, 1000),
    });
    // #1572 — fileGap is advisory and only persists a gap task when fileGaps is
    // on (mirror its predicate). Tally what was actually FILED so the terminal
    // "complete" frame can qualify itself instead of silently reporting clean.
    if (record.options.fileGaps && record.mode === 'execute') {
      record.runState.scriptCraftGapIssues.add(issueId);
      record.runState.scriptCraftBlocking += blocking.length;
    }
  }
  return {};
}

async function runEditorial(sId, record) {
  const maxRounds = Number.isInteger(record.options.maxEditorialRounds)
    ? record.options.maxEditorialRounds
    : MAX_EDITORIAL_ROUNDS;
  // maxRounds === 0 means "skip the editorial gate entirely" — which includes
  // the registry-driven editorial checks (the default info-dumping check is
  // LLM-backed, so a skip run must not spend budget on it). Mark both reviewed
  // so the resolver advances past editorialChecks too; the user can still run
  // checks on demand via the route.
  if (maxRounds === 0) {
    record.runState.editorialReviewed = true;
    // The reverse-outline refresh (#1349) only feeds the registry checks, so a run
    // that skips the whole editorial gate must skip it too — mark it refreshed so
    // the resolver advances past STEP 5.1 without spending budget.
    record.runState.reverseOutlineRefreshed = true;
    record.runState.editorialChecksReviewed = true;
    // Skipping the editorial gate also skips its health convergence check (#1316)
    // — the resolver must advance past editorialHealthGate too.
    record.runState.editorialHealthReady = true;
    return {};
  }
  let convergence = { best: null, sinceBest: 0 };
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeAnalyze = await budgetPause();
    if (beforeAnalyze) return beforeAnalyze;
    const { issues, runId } = await analyzeManuscriptCompleteness(sId, {
      withEdits: true,
      ...providerOverrideOpts(record),
    });
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = (issues || []).filter((i) => record.options.blockingSets.editorial.has(i.severity));
    broadcast(sId, {
      type: 'verify:round', scope: 'editorial', round, findings: (issues || []).length, blocking: blocking.length,
    });
    // Seed the manuscript-review comment set so the findings are visible in the
    // manuscript editor regardless of auto-fix outcome.
    await seedReviewFromFindings(sId, issues || [], { runId, mode: 'fresh' }).catch((err) => {
      console.log(`⚠️ autopilot: seed editorial review failed for ${sId.slice(0, 12)}: ${err.message}`);
    });
    if (blocking.length === 0) {
      record.runState.editorialReviewed = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, pauseKind: 'maxRounds', reason: convergencePauseReason('editorial', maxRounds, blocking.length), residual: blocking };
    }
    // Divergence guard (#1571): bail when the auto-fix passes stop reducing blocking findings.
    convergence = trackConvergence(convergence, blocking.length);
    if (convergence.sinceBest >= DIVERGENCE_PATIENCE) {
      return { pause: true, pauseKind: 'divergence', reason: divergencePauseReason('editorial', blocking.length, DIVERGENCE_PATIENCE), residual: blocking };
    }
    // Bounded auto-fix: apply a fix for each open high-severity comment, then
    // the loop re-analyzes. Each fix is wrapped so one bad anchor doesn't abort
    // the pass (boundary use of try/catch — these call into LLM/file paths).
    const review = await getReview(sId).catch(() => ({ comments: [] }));
    const open = (review.comments || []).filter((c) => c.status === 'open' && record.options.blockingSets.editorial.has(c.severity));
    for (const comment of open) {
      if (record.cancelRequested) return { canceled: true };
      // Each generated fix is its own LLM call — gate AND bill per comment so a
      // multi-comment pass can't overspend or under-count the daily budget.
      const beforeFix = await budgetPause();
      if (beforeFix) return beforeFix;
      try {
        // Thread the run's provider/model override into fix GENERATION (an LLM
        // call) so it honors the same provider as the review — without this the
        // fix silently runs on the active/default provider (and its runtime
        // fallback), which diverges from the run's chosen model and, when the
        // default is rate-limited, degrades fixes onto a weak fallback. Accept
        // is a deterministic edit application (no LLM), so it needs no override.
        if (!comment.fix) await generateManuscriptFix(sId, { commentId: comment.id, ...providerOverrideOpts(record) });
        await acceptManuscriptFix(sId, { commentId: comment.id });
        await recordDomainUsage('cos', { actions: 1 });
      } catch (err) {
        console.log(`⚠️ autopilot: editorial fix ${comment.id} failed: ${(err?.message || err)}`);
      }
    }
  }
  return {};
}

// STEP 5.1 — refresh the reverse-outline scene segmentation (#1349) before the
// registry-driven editorial checks (5.2), so the scene-consuming checks read the
// current draft's scenes rather than a segmentation staled by this run's editorial
// edits. Two cheap pre-gates keep this from spending budget needlessly:
//   1. skip entirely when no enabled editorial check declares a reverse-outline
//      source (mirrors the runner's own needsReverseOutline gate), and
//   2. skip when the stored outline is already fresh — using getReverseOutline's
//      canonical `stale` flag, NOT a stale-check reimplemented here.
// Only when a regenerate will actually occur do we gate the daily budget and bill a
// cos action — the same shape as runEditorialChecksPass, which gates+bills only when
// an enabled LLM check will actually run. `force:false`
// is a belt-and-suspenders second guard against the stored outline going fresh
// between the pre-check and the call. Failures are advisory (logged), never block.

// #1575 — the per-run editorial-check subset (null = all enabled). Absent/empty
// is normalized to null so EVERY consumer (this reverse-outline gate, the budget
// plan, the checks run) resolves the identical set — otherwise a subset of checks
// that skip the outline could still trigger/bill the refresh keyed off the global
// enabled set, or the gate could bill against checks the run skips.
const editorialSubsetIds = (options) =>
  Array.isArray(options?.editorialCheckIds) && options.editorialCheckIds.length
    ? options.editorialCheckIds
    : null;

async function runReverseOutlineRefresh(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  const settings = await getSettings();
  const checkIds = editorialSubsetIds(record.options);
  // Gate 1 — sources-only pre-filter: does any enabled check (narrowed to this
  // run's subset) even DECLARE the outline as a source? If not, nothing to do —
  // and a subset that skips outline-consuming checks must not pay for a refresh
  // those checks would have triggered.
  if (!enabledChecksConsumeReverseOutline(settings, checkIds)) {
    record.runState.reverseOutlineRefreshed = true;
    return {};
  }
  // Gate 2 — is the stored outline stale (or never generated against a draftable
  // manuscript)? `no-content` (nothing drafted) needs no outline; `none` (draftable
  // but never segmented) and a `complete`-but-`stale` outline both need a regen.
  const current = await getReverseOutline(sId).catch(() => null);
  const needsRegen = !!current
    && current.status !== 'no-content'
    && (current.status === 'none' || current.stale === true);
  if (!needsRegen) {
    record.runState.reverseOutlineRefreshed = true;
    return {};
  }
  // Gate 3 (#1614) — gate-aware consumption. A check that DECLARES the outline as
  // a source still won't run if its runtime gate declines for this series (e.g. a
  // canon-less roster). Evaluate each consumer's gate against the current outline
  // and skip the refresh when none would run. Gate on SCENE PRESENCE, not
  // `status`: the precondition is "there's scene content to evaluate gates
  // against" — a never-generated (`status:'none'`) or empty outline has none, so
  // we bootstrap the first generation unconditionally rather than chicken-and-egg
  // ourselves out of it. enabledChecksConsumeReverseOutline only trusts a
  // DECLINING gate that didn't read the outline (the refresh regenerates it, so
  // an outline-content gate's stale verdict can't be trusted and keeps the check
  // a consumer) — so a scoped run of only outline-gated checks still refreshes.
  if (Array.isArray(current.scenes) && current.scenes.length > 0) {
    const gateCtx = await buildReverseOutlineGateContext(sId, { outline: current }).catch(() => null);
    if (gateCtx && !enabledChecksConsumeReverseOutline(settings, checkIds, gateCtx)) {
      record.runState.reverseOutlineRefreshed = true;
      return {};
    }
  }
  // A regenerate WILL spend one LLM call — gate the budget and bill, like the
  // other LLM passes. Bridge autopilot cancellation into the stage's AbortSignal.
  const beforeRefresh = await budgetPause();
  if (beforeRefresh) return beforeRefresh;
  const signal = { get aborted() { return record.cancelRequested; } };
  const regen = (force) => generateReverseOutline(sId, { ...providerIdOpts(record), force, signal })
    .catch((err) => {
      console.log(`⚠️ autopilot: reverse-outline refresh failed for ${sId.slice(0, 12)}: ${err.message}`);
      return null;
    });
  let result = await regen(false);
  // Canceled mid-pass — don't bill, don't mark refreshed; let the loop unwind.
  if (result?.status === 'canceled' || record.cancelRequested) return { canceled: true };
  // (#1614) A `cached:true` result means the manuscript hash still matched the
  // stored outline at generate time. Re-confirm staleness against the LIVE
  // manuscript within this run: if a concurrent edit moved the manuscript again
  // after that cache check, the cached outline is now stale and the downstream
  // checks would read it — force exactly one regen so they don't.
  if (result?.cached === true) {
    const after = await getReverseOutline(sId).catch(() => null);
    if (after?.stale === true) {
      result = await regen(true);
      if (result?.status === 'canceled' || record.cancelRequested) return { canceled: true };
    }
  }
  // Bill ONLY when the call actually regenerated (an LLM run). A `cached` result
  // (outline still fresh in the race window) or a `no-content` series spent nothing.
  // No verify:round broadcast here — a refresh isn't a review round (it produces
  // scenes, not findings); the conductor's generic step:start/step:complete already
  // surface "Refreshing scene segmentation…" / "done" to the UI.
  if (result && result.cached !== true && result.status !== 'no-content') {
    await recordDomainUsage('cos', { actions: 1 });
  }
  record.runState.reverseOutlineRefreshed = true;
  return {};
}

// STEP 5.2 — run the registry-driven editorial checks once per run, seeding
// their findings into the same manuscript-review comment set. Only LLM-kind
// checks cost tokens, so gate the daily budget AND bill a cos action only when
// an enabled LLM check will actually run — a deterministic-only (or all-checks-
// disabled) run does cheap local work and must neither pause on an exhausted
// budget nor consume quota. Failures are surfaced (logged) but never block the
// run — editorial checks are advisory.
async function runEditorialChecksPass(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  const settings = await getSettings();
  // #1575 — narrow the pass + its budget gate to this run's subset (null = all
  // enabled). The gate (buildEditorialCheckPlan) and the run (runEditorialChecks)
  // must resolve the SAME set so billing and execution agree.
  const checkIds = editorialSubsetIds(record.options);
  const plan = await buildEditorialCheckPlan(sId, { checkIds, settings });
  const hasLlmCheck = plan.checks.some((c) => c.kind === 'llm');
  if (hasLlmCheck) {
    const beforeChecks = await budgetPause();
    if (beforeChecks) return beforeChecks;
  }
  // Bridge autopilot cancellation into the runner's cooperative AbortSignal so a
  // mid-pass /autopilot/cancel stops before the next check and skips seeding
  // (the runner re-checks `signal.aborted` after each check). A live getter
  // reflects `record.cancelRequested` without a separate controller to manage.
  const signal = { get aborted() { return record.cancelRequested; } };
  // #1578 — forward the runner's per-check check:start/check:complete frames up
  // the autopilot SSE stream (tagged scope:'editorialChecks' so the UI groups
  // them with the editorialChecks verify:round). Without this the only signal
  // during a long (issues × checks) pass is the single terminal verify:round
  // total — no per-check progress or severity breakdown.
  const onProgress = (event) => broadcast(sId, { ...event, scope: 'editorialChecks' });
  const result = await runEditorialChecks(sId, { ...providerOverrideOpts(record), checkIds, settings, signal, onProgress }).catch((err) => {
    console.log(`⚠️ autopilot: editorial checks failed for ${sId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  // Canceled mid-pass — don't bill, don't mark the step reviewed; let the loop
  // unwind via its canceled branch.
  if (result?.canceled || record.cancelRequested) return { canceled: true };
  if (result) {
    if (hasLlmCheck) await recordDomainUsage('cos', { actions: 1 });
    // #1573 — a check whose run() threw is recorded in perCheck.error but the
    // pass otherwise looks clean. Surface the errored count + failing checkIds on
    // the round frame and accumulate them onto the run so the terminal summary
    // can flag a partial failure (no silent "complete").
    const { errored, erroredCheckIds } = summarizeCheckErrors(result.perCheck);
    erroredCheckIds.forEach((id) => record.runState.editorialCheckErroredIds.add(id));
    // #1613 — count the high-severity findings this pass surfaced. The round frame
    // previously hardcoded `blocking: 0`, which made a 50-high-finding pass look
    // "complete" — the misleading per-step signal the issue calls out. Report the
    // real high count so the step's `blocking` matches what it found, whether or
    // not the optional pause gate is armed.
    const highFindings = result.findings.filter((f) => f.severity === 'high');
    broadcast(sId, { type: 'verify:round', scope: 'editorialChecks', round: 1, findings: result.findings.length, blocking: highFindings.length, errored, erroredCheckIds });
    if (errored) {
      console.error(`❌ autopilot: ${errored} editorial check(s) errored — series=${sId.slice(0, 12)} ${erroredCheckIds.join(', ')}`);
    }
    // #1613 — optional gate: when armed (threshold > 0) and the pass surfaced at
    // least that many high findings, PAUSE for human review instead of silently
    // proceeding to the health gate. Off by default (threshold 0), so existing
    // runs are unchanged. Do NOT mark the step reviewed — a resume re-runs the
    // checks and reconciles (like the health gate), so once the human reduces the
    // high findings below the threshold (or lowers it) the run continues.
    const threshold = record.options.checkFindingsPauseThreshold || 0;
    if (threshold > 0 && highFindings.length >= threshold) {
      // Editorial findings already carry severity/location/problem (manuscriptReview
      // sanitizes them), so the residual uses the same shape as the other pauses;
      // keep checkId so the UI can link a residual back to the check that raised it.
      const residual = highFindings.map((f) => ({
        severity: f.severity, // already filtered to 'high' — carry it rather than re-asserting
        location: f.location || (f.checkId ? `check ${f.checkId}` : 'manuscript'),
        problem: f.problem || 'high-severity editorial finding',
        checkId: f.checkId,
      }));
      console.log(`🚦 editorial checks gate — series=${sId.slice(0, 12)} ${highFindings.length} high finding(s) ≥ threshold ${threshold}, pausing for review`);
      return {
        pause: true,
        pauseKind: 'checkFindings',
        reason: `Editorial checks surfaced ${highFindings.length} high-severity finding(s) (≥ threshold ${threshold}) — paused for review. Address them in the manuscript editor, or raise the editorial-check pause threshold above ${highFindings.length} (set it to 0 to disable) in Options and resume.`,
        residual,
      };
    }
  }
  record.runState.editorialChecksReviewed = true;
  return {};
}

// STEP 5.3 — editorial health convergence gate (#1316). A cheap, no-LLM gate:
// read the persisted review, compute the aggregate health under the configured
// readiness gate, and either mark the run clean (proceed to visuals) or PAUSE
// with the open blockers for human triage. This is the consolidated "ready"
// signal — distinct from the completeness loop's own per-round high-only gate —
// so a blocker the registry checks (5.2) surfaced after completeness converged
// still stops the run. No auto-fix here: the completeness loop already attempted
// fixes; remaining blockers need a human (or a re-run after edits).
async function runEditorialHealthGate(sId, record) {
  if (record.cancelRequested) return { canceled: true };
  // The effective gate (per-run override → persisted setting → null) was resolved
  // and stamped onto record.options at start (#1580), mirroring the round bounds —
  // so the loop and the dry-run plan can't disagree on which gate applied. null
  // falls through to DEFAULT_READINESS_GATE inside computeHealth/openBlockers.
  const gate = record.options.readinessGate || undefined;
  // Do NOT swallow a getReview error into an empty review — that would fail OPEN
  // (the gate would pass on a corrupt/unreadable store and let the run proceed to
  // visuals without verifying health). Let it bubble to the coordinator's
  // top-level catch, which records a clean `error` terminal state.
  const review = await getReview(sId);
  const comments = review.comments || [];
  // Per-series severity-weight override (#1616) resolved + stamped at start, so
  // the health score the gate reads matches the live + persisted scores.
  const health = computeHealth(comments, gate, { weights: record.options.severityWeights });
  broadcast(sId, {
    type: 'verify:round', scope: 'editorialHealth', round: 1,
    findings: health.open, blocking: health.ready ? 0 : health.open, score: health.score,
  });
  if (health.ready) {
    record.runState.editorialHealthReady = true;
    return {};
  }
  // Not clean — surface the open blockers (via the shared helper, so the residual
  // can't disagree with computeHealth's `ready` verdict) for the human triage.
  // No pauseKind (#1571): this is a single-pass gate, not a bounded verify→resolve
  // loop, so it has no maxRounds/divergence distinction — leave it null. If this
  // ever gains a retry loop, thread pauseKind through trackConvergence then.
  const blockers = openBlockers(comments, gate);
  // Surface the per-check / per-issue breakdown that drove the pause (#1579) —
  // a single emoji-prefixed line so "why did health reject my 50-issue series?"
  // is answerable from the logs, and the same breakdown on the marker so the UI
  // / resume banner can render it without re-hitting the health API.
  const healthBreakdown = summarizeEditorialBlockers(health);
  console.log(`🩺 editorial health gate not clean — series=${sId.slice(0, 12)} score=${health.score}, ${health.open} open: ${formatBlockerSummary(healthBreakdown)}`);
  return { pause: true, reason: `editorial health not clean (score ${health.score}, ${health.open} open finding(s))`, residual: blockers, healthBreakdown };
}

// Turn a render-enqueue result into the { slotKey, slot } pair the render
// routes persist (proof → proofImage, final → finalImage).
const slotFromRenderResult = (result) => {
  const slotKey = slotKeyForVariant(result.variant);
  return { slotKey, slot: buildRenderSlot({ slotKey, jobId: result.jobId, prompt: result.prompt, fromProof: result.fromProof }) };
};

// Persist an in-flight render slot the way the render routes do: enqueue the
// proof render, then splice the returned jobId onto the freshest persisted
// cover/backCover slot via updateStageWithLatest.
async function enqueueCoverDraft(issueId, slotField, enqueueFn) {
  const { slotKey, slot } = slotFromRenderResult(await enqueueFn(issueId, { target: 'proof' }));
  await updateStageWithLatest(issueId, 'comicPages', (current) => {
    const currentSlot = current?.[slotField] || {};
    return { [slotField]: { ...currentSlot, [slotKey]: slot } };
  });
}

async function enqueuePageDraft(issueId, pageIndex) {
  const { slotKey, slot } = slotFromRenderResult(await enqueueVisualComicPage(issueId, { pageIndex, target: 'proof' }));
  await updateStageWithLatest(issueId, 'comicPages', (current) => {
    const pages = Array.isArray(current?.pages) ? current.pages : [];
    if (!pages[pageIndex]) return {};
    const next = [...pages];
    next[pageIndex] = { ...pages[pageIndex], [slotKey]: slot };
    return { status: 'edited', pages: next };
  });
}

async function runVisualDraft(sId, issueId, record) {
  let issue = await getIssue(issueId);
  let cp = issue.stages?.comicPages;

  // Respect an explicit lock — the user froze this stage, so don't seed pages
  // or render. Skip (intentional, not a gap) and mark drafted so we don't loop.
  if (cp?.locked === true) {
    broadcast(sId, { type: 'step:skip', kind: 'visualDraft', issueId, reason: 'comicPages stage is locked — skipping draft render' });
    record.runState.visualDrafted.add(issueId);
    return {};
  }

  // 1. Seed pages + cover concepts from the comic script if not already done
  //    (mirrors the extract-pages route; pure parse, no LLM).
  if (!(Array.isArray(cp?.pages) && cp.pages.length > 0)) {
    const source = (issue.stages?.comicScript?.output || '').trim();
    if (source) {
      const { pages, coverConcept, backCoverConcept } = parseComicScript(source);
      await updateStageWithLatest(issueId, 'comicPages', (current) => {
        const coverScript = current?.cover?.script || '';
        const backScript = current?.backCover?.script || '';
        return {
          status: pages.length ? 'ready' : 'empty',
          pages,
          cover: coverConcept && !coverScript ? { script: coverConcept, imageJobId: null, prompt: null } : (current?.cover ?? null),
          backCover: backCoverConcept && !backScript ? { script: backCoverConcept, imageJobId: null, prompt: null } : (current?.backCover ?? null),
          errorMessage: '',
        };
      });
      issue = await getIssue(issueId);
      cp = issue.stages?.comicPages;
    }
  }

  const pageCount = Array.isArray(cp?.pages) ? cp.pages.length : 0;
  if (pageCount === 0) {
    // Nothing to draw — the comic script never parsed into pages. This is a real
    // production blocker, so pause for review rather than marking the issue done.
    await fileGap(record, sId, {
      gapKind: 'visual-no-pages',
      issueId,
      summary: 'Cannot draft comic art — the comic script did not parse into any pages. Fix the comicScript stage (PAGE/PANEL structure) first.',
      context: `issueId=${issueId}`,
    });
    return { pause: true, gapFiled: true, reason: `issue ${issue.number ?? issueId} has no comic pages to render — the script did not parse`, residual: [{ severity: 'high', location: `issue ${issue.number ?? '?'} / comicPages`, problem: 'comic script did not parse into pages' }] };
  }

  // Budget-gate + bill each render individually — a comic is many GPU jobs.
  // A failed enqueue (e.g. a page with no panels) is surfaced and skipped.
  const enqueueOne = async (target, fn) => {
    const budget = await getDomainBudgetStatus('cos');
    if (!budget.withinBudget) return { pause: true, reason: `daily cos ${budget.exceeded} budget reached` };
    try {
      await fn();
      await recordDomainUsage('cos', { actions: 1 });
      broadcast(sId, { type: 'render:queued', issueId, target });
    } catch (err) {
      const reason = (err?.message || String(err)).slice(0, 200);
      broadcast(sId, { type: 'step:skip', kind: 'visualDraft', issueId, target, reason });
      // Dedups to one task per issue (idTag has no target), so a broken page
      // doesn't file a task per page.
      await fileGap(record, sId, {
        gapKind: 'render-failed',
        issueId,
        summary: `A draft render failed for this issue (first failure: ${target} — ${reason}). The comic page/panel structure may be incomplete.`,
        context: `issueId=${issueId} target=${target}`,
      });
    }
    return {};
  };

  // 2. Front cover.
  if (!slotEnqueued(cp?.cover)) {
    const r = await enqueueOne('cover', () => enqueueCoverDraft(issueId, 'cover', enqueueComicCover));
    if (r.pause) return r;
  }
  // 3. Back cover — always queue it (like the front cover); the back-cover
  //    renderer has a fallback prompt when no concept script is set, so a
  //    "complete" draft shouldn't silently omit it.
  issue = await getIssue(issueId);
  cp = issue.stages?.comicPages;
  if (!slotEnqueued(cp?.backCover)) {
    const r = await enqueueOne('backCover', () => enqueueCoverDraft(issueId, 'backCover', enqueueComicBackCover));
    if (r.pause) return r;
  }
  // 4. Every interior page (re-read per page so each splice merges fresh state).
  for (let i = 0; i < pageCount; i += 1) {
    if (record.cancelRequested) return { canceled: true };
    const fresh = await getIssue(issueId);
    const page = fresh.stages?.comicPages?.pages?.[i];
    if (!page || !Array.isArray(page.panels) || page.panels.length === 0) continue;
    if (pageEnqueued(page)) continue;
    const r = await enqueueOne(`page ${i + 1}`, () => enqueuePageDraft(issueId, i));
    if (r.pause) return r;
  }
  // Only consider the issue drafted once every drawable slot is actually
  // enqueued. If a render errored (e.g. an un-renderable page), visualReady is
  // still false — mark it attempted so the resolver doesn't re-loop, but pause
  // for review instead of letting the run report a complete draft.
  const after = await getIssue(issueId);
  if (!visualReady(after)) {
    record.runState.visualDrafted.add(issueId);
    await fileGap(record, sId, {
      gapKind: 'visual-incomplete',
      issueId,
      summary: `Issue ${after.number ?? issueId} could not be fully drafted — some cover/page renders did not enqueue (likely an un-renderable page or missing panels). Review the comic page/panel structure.`,
      context: `issueId=${issueId}`,
    });
    return {
      pause: true,
      gapFiled: true,
      reason: `issue ${after.number ?? issueId} could not be fully drafted — some cover/page renders did not enqueue`,
      residual: [{ severity: 'high', location: `issue ${after.number ?? '?'} / comicPages`, problem: 'not every drawable cover/page render was enqueued (likely an un-renderable page or missing panels)' }],
    };
  }
  record.runState.visualDrafted.add(issueId);
  return {};
}

// Canon descriptive-integrity gate — deterministic (no LLM), so not billable.
// Pauses for human review when a canon noun that appears in the visual source
// has no description (it can't be drawn). Marks canonVerified when clean so the
// run proceeds to visual drafting.
async function runCanonVerify(sId, record) {
  const report = await checkSeriesCanonReadiness(sId);
  broadcast(sId, {
    type: 'verify:round', scope: 'canon', round: 1,
    findings: report.undescribed.length, blocking: report.undescribed.length,
  });
  if (report.ready) {
    record.runState.canonVerified = true;
    return {};
  }
  const residual = report.undescribed.map((n) => ({
    severity: 'high',
    location: `${n.kind} "${n.name}"`,
    problem: 'Appears where it would be drawn but has no description — can\'t be rendered.',
  }));
  await fileGap(record, sId, {
    gapKind: 'canon-undescribed',
    summary: `${report.undescribed.length} canon noun(s) appear in panels/scenes with no description: ${report.undescribed.map((n) => n.name).join(', ').slice(0, 400)}. Describe them on the Nouns stage before generating pages.`,
    context: JSON.stringify(report.undescribed).slice(0, 1000),
  });
  return {
    pause: true,
    reason: `${report.undescribed.length} canon noun(s) referenced in panels/scenes are undescribed — describe them before visual production`,
    residual,
    gapFiled: true,
  };
}

// Teaser deliverable (CDO Phase 3, #2185, opt-in). Mint + start a Creative
// Director video project seeded from this issue — the autopilot→CD direction of
// the bridge. Attempted-once per issue (marked up front so a failure can't
// re-loop the resolver). Bills one cos action like every other autopilot step
// (the CD project's own downstream render spend is gated by the creative/cos
// budget on its side). A teaser is an OPTIONAL, terminal-phase deliverable, so a
// failure is ADVISORY: it broadcasts a skip + files a gap, but does NOT pause the
// whole run (the story is already done — a failed trailer shouldn't strand it).
// bridgeFromIssue is imported dynamically to keep the pipeline↔creative-director
// module graph acyclic (it transitively pulls the CD plan loop + tool registry).
async function runProduceTeaser(sId, issueId, record) {
  record.runState.teaserProduced.add(issueId);
  const issue = await getIssue(issueId).catch(() => null);
  try {
    const { produceVideoFromIssue } = await import('../creativeDirector/bridgeFromIssue.js');
    // The treatment-from-prose LLM call runs through stageRunner's soft channel,
    // so thread the run's provider/model as providerDefault/modelDefault.
    const { project } = await produceVideoFromIssue(issueId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    broadcast(sId, { type: 'teaser:produced', issueId, projectId: project?.id });
    console.log(`🎬 autopilot teaser — series=${sId.slice(0, 12)} issue=${issue?.number ?? issueId} → CD project ${project?.id?.slice(0, 8) ?? '?'}`);
    return {};
  } catch (err) {
    const message = (err?.message || String(err)).slice(0, 300);
    broadcast(sId, { type: 'step:skip', kind: 'produceTeaser', issueId, reason: `teaser production failed: ${message}` });
    await fileGap(record, sId, {
      gapKind: 'teaser-failed',
      issueId,
      summary: `The optional teaser video for issue ${issue?.number ?? issueId} could not be produced: ${message}. The story is complete — this deliverable can be retried from the Creative Director.`,
      context: `issueId=${issueId}`,
    });
    return {};
  }
}

async function dispatchStep(sId, step, record) {
  switch (step.kind) {
    case 'generateArc': {
      // Mark attempted up front so the resolver won't re-route here if arc
      // generation yields no seasons (avoids an infinite generateArc loop).
      record.runState.arcAttempted = true;
      const r = await generateArcOverview(sId, providerOverrideOpts(record));
      const committed = await commitSeasonsWithRemap(await getSeries(sId), { arc: r.arc, seasons: r.seasons });
      await recordDomainUsage('cos', { actions: 1 });
      const seasonCount = committed?.series?.seasons?.length ?? (await getSeries(sId)).seasons?.length ?? 0;
      if (seasonCount === 0) {
        // No specific gap filed here — let the conductor file generateArc-stalled.
        return {
          pause: true,
          reason: 'arc generation produced no volumes — cannot create issues; review the series bible and regenerate the arc',
          residual: [{ severity: 'high', location: 'arc', problem: 'arc overview returned zero seasons/volumes' }],
        };
      }
      return {};
    }
    case 'generateEpisodes': {
      // Mark attempted up front so an empty/invalid episode list can't re-loop
      // the resolver back into generateEpisodes for the same still-empty volume.
      record.runState.episodesAttempted.add(step.seasonId);
      const r = await generateSeasonEpisodes(sId, step.seasonId, providerOverrideOpts(record));
      const cur = await getSeries(sId);
      const created = await commitEpisodesToIssues(sId, step.seasonId, r.episodes, { preloadedSeries: cur });
      await recordDomainUsage('cos', { actions: 1 });
      if (!Array.isArray(created) || created.length === 0) {
        return {
          pause: true,
          reason: `episode generation produced no issues for volume ${step.seasonId} — review the volume outline and regenerate`,
          residual: [{ severity: 'high', location: `volume ${step.seasonId}`, problem: 'episode breakdown returned zero episodes/issues' }],
        };
      }
      return {};
    }
    case 'verifyArc':
      return runArcVerify(sId, record);
    case 'beatSheet':
      return runBeats(sId, step.seasonId, record);
    case 'beatContinuity':
      return runBeatContinuity(sId, record);
    case 'foundationGate':
      return runFoundationGate(sId, record);
    case 'textStages':
      return runText(sId, step.issueId, record);
    case 'scriptVerify':
      return runScriptVerify(sId, step.issueId, record);
    case 'editorialReview':
      return runEditorial(sId, record);
    case 'reverseOutline':
      return runReverseOutlineRefresh(sId, record);
    case 'editorialChecks':
      return runEditorialChecksPass(sId, record);
    case 'editorialHealthGate':
      return runEditorialHealthGate(sId, record);
    case 'canonVerify':
      return runCanonVerify(sId, record);
    case 'visualDraft':
      return runVisualDraft(sId, step.issueId, record);
    case 'produceTeaser':
      return runProduceTeaser(sId, step.issueId, record);
    default:
      return {};
  }
}

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
function buildDryRunPlan(series, issues, options, costContext = {}) {
  const plan = [];
  const ordered = orderedIssues(issues);
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort(byNumber) : [];
  // Mirror the resolver: generateArc runs when arc text is missing OR there are
  // no volumes at all (an arc-only series), so a dry-run plan must show it too.
  const noArc = !series?.arc?.logline && !series?.arc?.summary;
  if (noArc || seasons.length === 0) plan.push({ kind: 'generateArc', count: 1, estActions: 1 });
  const emptySeasons = seasons.filter((s) => !ordered.some((i) => i.seasonId === s.id));
  if (emptySeasons.length) plan.push({ kind: 'generateEpisodes', count: emptySeasons.length, estActions: emptySeasons.length });
  const arcRounds = Number.isInteger(options?.maxArcVerifyRounds) ? options.maxArcVerifyRounds : MAX_ARC_VERIFY_ROUNDS;
  plan.push({ kind: 'verifyArc', count: 1, note: roundsNote(arcRounds), estActions: convergenceLoopActions(arcRounds) });
  // foundationGate (#2176) runs once between arc verify and beats, unless
  // disabled or 0-round. Bills judge + fix per round like the arc loop.
  const foundationRounds = Number.isInteger(options?.maxFoundationRounds) ? options.maxFoundationRounds : MAX_FOUNDATION_ROUNDS;
  if (options?.foundationGate !== false && foundationRounds !== 0) {
    plan.push({ kind: 'foundationGate', count: 1, note: roundsNote(foundationRounds), estActions: convergenceLoopActions(foundationRounds) });
  }
  const beatsNeeded = seasons.filter((s) =>
    ordered.some((i) => i.seasonId === s.id && !isStageReady(i.stages?.idea))).length;
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
  const textNeeded = ordered.filter((i) => !textReady(i, series, options)).length;
  if (textNeeded) plan.push({ kind: 'textStages', count: textNeeded, estActions: textNeeded });
  if (wantsComic(series, options)) plan.push({ kind: 'scriptVerify', count: ordered.length, estActions: ordered.length });
  const edRounds = Number.isInteger(options?.maxEditorialRounds) ? options.maxEditorialRounds : MAX_EDITORIAL_ROUNDS;
  // Editorial review is a verify→auto-fix convergence loop like the arc gate, so
  // the per-round estimate mirrors it (analyze + one resolve batch / round). The
  // per-comment auto-fixes within a round bill additionally and scale with the
  // number of blocking findings, which isn't knowable at plan time.
  plan.push({ kind: 'editorialReview', count: 1, note: roundsNote(edRounds), estActions: convergenceLoopActions(edRounds) });
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
    const estLlmCalls = ordered.length * llmCheckCount;
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
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && wantsComic(series, options)) {
    // canonVerify runs an LLM pass but bills no cos action (token-only) — 0 budget.
    plan.push({ kind: 'canonVerify', count: 1, note: 'descriptive integrity of drawn nouns (no budget cost)', estActions: 0 });
    const visualNeeded = ordered.filter((i) => !visualReady(i)).length;
    // Each draft render bills one cos action: cover + back per issue, plus one per
    // interior page. The interior-page count isn't known until the script parses,
    // so the estimate counts the two covers and notes the per-page additions.
    if (visualNeeded) plan.push({ kind: 'visualDraft', count: visualNeeded, note: 'cover + back + all pages (draft) — +1 action per interior page', estActions: visualNeeded * 2 });
    // Teaser deliverable (#2185, opt-in, default off): one CD video project per
    // issue. Each mint+start bills one cos action for the treatment LLM call; the
    // CD project's own render spend is gated on the creative/cos budget its side.
    if (wantsTeaser(options)) plan.push({ kind: 'produceTeaser', count: ordered.length, note: 'mint + start a Creative Director teaser video per issue (opt-in)', estActions: ordered.length });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Public entrypoint.
// ---------------------------------------------------------------------------

/**
 * Start (or no-op resume of) the autopilot for a series. Returns immediately;
 * progress lands via SSE. When the cos domain is `off`, returns
 * `{ rejected:true, mode:'off' }` WITHOUT starting (route maps to 409).
 */
export async function startSeriesAutopilot(sId, options = {}) {
  const existing = runs.get(sId);
  if (existing && !existing.finished) {
    return { runId: existing.runId, alreadyRunning: true, mode: existing.mode };
  }

  const state = await loadState().catch(() => ({ config: {} }));
  const mode = getDomainMode(state.config, 'cos');
  if (mode === 'off') {
    return { rejected: true, mode: 'off' };
  }

  // Resolve the convergence-round bounds ONCE at start (per-run option →
  // persisted setting → default) and stamp them onto the run's options so the
  // synchronous loops, the dry-run plan, and a later resume all read the same
  // effective values. A resume reuses this same path, so a raised persisted
  // setting takes effect on the next Resume without re-specifying it.
  const settings = await getSettings().catch(() => null);
  // Per-series severity config (#1616): resolve the (possibly overridden) health
  // severity weights + the per-gate blocking-severity Sets ONCE at start and
  // stamp them onto run options, mirroring the round bounds / readiness gate —
  // so every gate read site + the health gate use the same resolved values, and
  // a resume re-reads them fresh. Loading the series here is cheap; a missing
  // series (deleted mid-run) falls through to the frozen defaults.
  const seriesRecord = await getSeries(sId).catch(() => null);
  const runOptions = {
    ...options,
    ...resolveAutopilotRounds(options, settings),
    foundationGate: resolveAutopilotFoundationGate(options, settings),
    foundationThreshold: resolveAutopilotFoundationThreshold(options, settings),
    readinessGate: resolveAutopilotReadinessGate(options, settings),
    checkFindingsPauseThreshold: resolveAutopilotCheckPauseThreshold(options, settings),
    notifyOnPause: resolveAutopilotNotifyOnPause(options, settings),
    produceTeaser: resolveAutopilotProduceTeaser(options, settings),
    severityWeights: mergeSeverityWeights(seriesRecord?.severityWeights),
    blockingSets: {
      arc: resolveBlockingSet(seriesRecord?.blockingSeverities, 'arc'),
      beatContinuity: resolveBlockingSet(seriesRecord?.blockingSeverities, 'beatContinuity'),
      editorial: resolveBlockingSet(seriesRecord?.blockingSeverities, 'editorial'),
    },
  };

  if (existing) {
    // A finished run still in its replay window — evict it so this fresh run
    // fully replaces it (mirrors editorialAnalysisRunner).
    if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    for (const c of existing.clients) c.end();
  }

  const runId = randomUUID();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    cancelRequested: false,
    finished: false,
    cleanupTimer: null,
    startedAt: new Date().toISOString(),
    mode,
    options: runOptions,
    runState: {
      arcAttempted: false,
      arcVerified: false,
      // #2176 — foundation-quality gate satisfied this run (threshold cleared,
      // or the gate disabled/0-round). Boolean like arcVerified so the resolver
      // routes here at most once per run.
      foundationGated: false,
      beatContinuityChecked: false,
      editorialReviewed: false,
      reverseOutlineRefreshed: false,
      editorialChecksReviewed: false,
      editorialHealthReady: false,
      canonVerified: false,
      episodesAttempted: new Set(),
      beatsAttempted: new Set(),
      textAttempted: new Set(),
      scriptChecked: new Set(),
      visualDrafted: new Set(),
      // #2185 — issues whose optional teaser deliverable has been produced (or
      // attempted) this run, so the resolver can't re-loop into produceTeaser.
      teaserProduced: new Set(),
      // #1572 — issues whose ADVISORY craft gate filed a blocking gap task, and
      // the total blocking-finding count. Carried into the terminal `complete`
      // frame + persisted marker so a "clean complete" doesn't hide downstream
      // render blockers the user still has to resolve.
      scriptCraftGapIssues: new Set(),
      scriptCraftBlocking: 0,
      // #1573 — checkIds of editorial checks that threw during this run's checks
      // pass. Surfaced on the terminal `complete` frame + persisted marker so a
      // check that errors every run is visible instead of a silent "clean".
      editorialCheckErroredIds: new Set(),
    },
    activeChild: null,
  };
  runs.set(sId, record);

  // Fire-and-forget coordinator. The try/catch is the permitted boundary use —
  // an unhandled LLM rejection here would crash the process on Node ≥15.
  (async () => {
    try {
      // DRY-RUN: enumerate the plan, no side effects.
      if (mode === 'dry-run') {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        // Resolve the enabled LLM-check count (#1576) so the plan's editorialChecks
        // step can estimate its issues × checks LLM fan-out. Mirrors the actual
        // pass: same subset (editorialSubsetIds) and same settings the checks read.
        const settings = await getSettings().catch(() => null);
        const checkPlan = await buildEditorialCheckPlan(sId, { checkIds: editorialSubsetIds(runOptions), settings }).catch(() => null);
        const editorialLlmCheckCount = checkPlan ? checkPlan.checks.filter((c) => c.kind === 'llm').length : undefined;
        const plan = buildDryRunPlan(series, issues, runOptions, { editorialLlmCheckCount });
        const planTotals = summarizePlanCost(plan);
        broadcast(sId, { type: 'start', runId, mode, target: series.targetFormat, plan, planTotals });
        // Carry the plan on the terminal frame too: a dry-run emits start +
        // complete synchronously, often before the client attaches, and
        // attachSseClient replays only the LAST frame — so the plan would be
        // lost if it lived solely on the start frame.
        broadcast(sId, { type: 'complete', runId, dryRun: true, steps: plan.length, plan, planTotals, completedAt: new Date().toISOString() });
        console.log(`🧭 autopilot dry-run — series=${sId.slice(0, 12)} steps=${plan.length} est≈${planTotals.estActions} action(s) ${planTotals.estLlmCalls} LLM call(s)`);
        return;
      }

      // EXECUTE.
      const series0 = await getSeries(sId);
      broadcast(sId, { type: 'start', runId, mode, target: series0.targetFormat });
      await persistMarker(sId, { status: 'running', runId, currentStep: null, residualFindings: [], lastError: null });
      // A resume is a fresh start: drop any stale pause banner up front so a run
      // that completes/errors without re-pausing doesn't leave a dead resume link.
      await clearPauseNotice(sId);
      if (runOptions.includeVisual && !VISUAL_DRAFT_ENABLED) {
        broadcast(sId, { type: 'note', message: 'Draft visual rendering is not enabled in this build — running to text-ready + editorial review.' });
      }

      let ordinal = 0;
      while (!record.cancelRequested) {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        const step = resolveNextStep(series, issues, record.runState, runOptions);

        if (step.kind === 'done') {
          // #1572 — qualify "complete" when the advisory craft gate filed
          // blocking script-craft gaps during this run: the run is done, but
          // those gaps still block downstream visual rendering, so report them
          // on both the persisted marker and the terminal frame.
          const craftGapIssues = record.runState.scriptCraftGapIssues.size;
          const craftGapFindings = record.runState.scriptCraftBlocking;
          // #1573 — qualify "complete" when an editorial check threw this run: the
          // run finished, but a check that errored produced no findings, so its
          // dimension was never actually evaluated. Persist the count + carry the
          // failing checkIds on the frame so the UI flags it instead of "clean".
          const editorialCheckErroredIds = [...record.runState.editorialCheckErroredIds];
          const editorialCheckErrors = editorialCheckErroredIds.length;
          await persistMarker(sId, { status: 'done', runId, currentStep: null, craftGapIssues, craftGapFindings, editorialCheckErrors });
          broadcast(sId, { type: 'complete', runId, steps: ordinal, craftGapIssues, craftGapFindings, editorialCheckErrors, editorialCheckErroredIds, completedAt: new Date().toISOString() });
          console.log(`✅ autopilot complete — series=${sId.slice(0, 12)} steps=${ordinal}${craftGapIssues ? ` (${craftGapIssues} issue(s) with filed script-craft gaps)` : ''}${editorialCheckErrors ? ` (${editorialCheckErrors} editorial check(s) errored: ${editorialCheckErroredIds.join(', ')})` : ''}`);
          return;
        }

        // Budget gate (mirrors cosJobScheduler) — pause when today's cos action
        // budget is exhausted rather than burning past it. The editorialChecks
        // step is exempt from this blanket pre-dispatch gate because it
        // self-gates: runEditorialChecksPass only pauses/bills the budget when an
        // enabled LLM check will actually run (returning a pause result this loop
        // still handles), so a deterministic-only or all-disabled checks step can
        // complete a text-ready series even with the budget exhausted. The
        // editorialHealthGate (#1316) is likewise exempt — it's a pure read +
        // score with no LLM cost, so a budget-exhausted run can still produce its
        // readiness verdict (and pause on the findings, not the budget). The
        // reverseOutline refresh is exempt for the SAME reason as editorialChecks:
        // runReverseOutlineRefresh self-gates (it only calls budgetPause + bills
        // when it will actually regenerate), and it no-ops when no enabled check —
        // narrowed to this run's #1575 subset — consumes the outline. A blanket
        // pre-dispatch pause here would wrongly stall a deterministic-only subset
        // (whose refresh is a guaranteed no-op) on an exhausted budget. A gate
        // whose resolved rounds is 0 ("skip") is also exempt: runArcVerify /
        // runEditorial short-circuit with no LLM spend, so "0 skips the gate" must
        // hold even when the budget is exhausted (otherwise the run pauses on
        // budget instead of skipping).
        const zeroRoundSkip = (step.kind === 'verifyArc' && runOptions.maxArcVerifyRounds === 0)
          || (step.kind === 'beatContinuity' && runOptions.maxBeatContinuityRounds === 0)
          || (step.kind === 'editorialReview' && runOptions.maxEditorialRounds === 0)
          || (step.kind === 'foundationGate' && (runOptions.maxFoundationRounds === 0 || runOptions.foundationGate === false));
        const selfGatingStep = step.kind === 'editorialChecks'
          || step.kind === 'editorialHealthGate'
          || step.kind === 'reverseOutline';
        if (!selfGatingStep && !zeroRoundSkip) {
          const budget = await getDomainBudgetStatus('cos');
          if (!budget.withinBudget) {
            const budgetReason = `daily cos ${budget.exceeded} budget reached`;
            await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, lastError: budgetReason });
            broadcast(sId, { type: 'paused', runId, reason: budgetReason, completedAt: new Date().toISOString() });
            await notifyPause(record, sId, { reason: budgetReason, pauseKind: 'budget', currentStep: step.kind });
            console.log(`⏸️  autopilot paused (budget) — series=${sId.slice(0, 12)} after ${ordinal} steps`);
            return;
          }
        }

        ordinal += 1;
        await persistMarker(sId, { status: 'running', runId, currentStep: step.kind });
        broadcast(sId, { type: 'step:start', kind: step.kind, seasonId: step.seasonId, issueId: step.issueId, ordinal, reason: step.reason });

        const result = await dispatchStep(sId, step, record);

        if (result?.canceled || record.cancelRequested) break;
        if (result?.pause) {
          await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, residualFindings: result.residual || [], lastError: result.reason, pauseKind: result.pauseKind || null, healthBreakdown: result.healthBreakdown || null });
          broadcast(sId, { type: 'paused', runId, scope: step.kind, reason: result.reason, residualFindings: result.residual || [], pauseKind: result.pauseKind || null, healthBreakdown: result.healthBreakdown || null, completedAt: new Date().toISOString() });
          await notifyPause(record, sId, { reason: result.reason, pauseKind: result.pauseKind || null, currentStep: step.kind });
          // Only file the generic stalled task when the step didn't already file
          // a more specific gap (canon-undescribed, visual-no-pages, …) — else
          // fileGaps would create two CoS tasks for one underlying problem (the
          // differing gapKind defeats addTask's first-line dedup).
          if (!result.gapFiled) {
            await fileGap(record, sId, {
              gapKind: `${step.kind}-stalled`,
              issueId: step.issueId || null,
              summary: `Autopilot paused: ${result.reason}. Needs human review of the residual findings before it can continue.`,
              context: JSON.stringify(result.residual || []).slice(0, 1000),
            });
          }
          console.log(`⏸️  autopilot paused (${step.kind}) — series=${sId.slice(0, 12)}: ${result.reason}`);
          return;
        }
        broadcast(sId, { type: 'step:complete', kind: step.kind, seasonId: step.seasonId, issueId: step.issueId, ordinal });
      }

      // Cancelled.
      await persistMarker(sId, { status: 'paused', runId, currentStep: null, lastError: 'canceled by user' });
      broadcast(sId, { type: 'canceled', runId, steps: ordinal, completedAt: new Date().toISOString() });
      console.log(`🛑 autopilot canceled — series=${sId.slice(0, 12)} after ${ordinal} steps`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ autopilot failed — series=${sId.slice(0, 12)} ${message}`);
      await persistMarker(sId, { status: 'error', runId, lastError: message });
      broadcast(sId, { type: 'error', runId, error: message, failedAt: new Date().toISOString() });
      await fileGap(record, sId, {
        gapKind: 'run-error',
        summary: `The autonomous run failed and stopped: ${message}`,
        context: message,
      }).catch(() => {});
    } finally {
      record.finished = true;
      scheduleCleanup(sId, record);
    }
  })();

  return { runId, alreadyRunning: false, mode };
}

/**
 * Boot-time recovery: the in-memory run map is lost on restart, so any series
 * whose persisted marker still says `running` is demoted to `paused` (the user
 * can click Run to resume from the next missing step). Mirrors
 * recoverStuckAutoRuns in autoRunner.js. Best-effort; never blocks boot.
 */
export async function recoverStuckAutopilots() {
  const { listSeries } = await import('./series.js');
  const all = await listSeries().catch(() => []);
  const stuck = all.filter((s) => s.autopilot?.status === 'running');
  if (stuck.length === 0) return 0;
  for (const s of stuck) {
    await updateSeries(s.id, {
      autopilot: { ...s.autopilot, status: 'paused', lastError: 'interrupted by server restart', updatedAt: new Date().toISOString() },
    }).catch(() => null);
  }
  console.log(`📝 autopilot: recovered ${stuck.length} stuck run${stuck.length === 1 ? '' : 's'} on boot`);
  return stuck.length;
}

// Export internals for tests.
export const __testing = { runs, buildDryRunPlan, summarizePlanCost, providerOverrideOpts, providerIdOpts };
