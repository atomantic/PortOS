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
  analyzeManuscriptCompleteness,
} from './arcPlanner.js';
import * as volumeBeatsRunner from './volumeBeatsRunner.js';
import * as autoRunner from './autoRunner.js';
import { seedReviewFromFindings, getReview } from './manuscriptReview.js';
import { runEditorialChecks, buildEditorialCheckPlan } from './editorial/checkRunner.js';
import { computeHealth, openBlockers } from './editorialScore.js';
import { getSettings } from '../settings.js';
import { readReadinessGate } from '../../lib/editorial/index.js';
import { generateManuscriptFix, acceptManuscriptFix } from './manuscriptFix.js';
import { verifyComicScript } from './scriptVerify.js';
import { checkSeriesCanonReadiness } from './canonReadiness.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished,
//   cleanupTimer, startedAt, mode, options, runState, activeChild }>
const runs = new Map();

// Bounded convergence loops — re-verify/re-review at most this many rounds, then
// pause for human review with the residual findings (see module header). These
// are the floor defaults; an install can raise them persistently via
// pipelineEditorialChecks.{maxArcVerifyRounds,maxEditorialRounds} (or a single
// run can override per-run through the autopilot start options).
export const MAX_ARC_VERIFY_ROUNDS = 3;
export const MAX_EDITORIAL_ROUNDS = 2;

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
  };
}

// Per-gate copy for the non-convergence pause — shared by the arc-verify and
// editorial loops so the two messages can't drift.
const PAUSE_GATES = {
  arc: { label: 'Arc verification', fix: 'Edit the arc/volumes to address them', limit: 'verify-rounds' },
  editorial: { label: 'Editorial review', fix: 'Address them in the manuscript editor', limit: 'editorial-rounds' },
};
function convergencePauseReason(gate, maxRounds, blockingCount) {
  const { label, fix, limit } = PAUSE_GATES[gate];
  const plural = maxRounds === 1 ? 'round' : 'rounds';
  return `${label} couldn't auto-resolve ${blockingCount} blocking finding(s) in ${maxRounds} ${plural} — `
    + `paused for review. ${fix}, or raise the ${limit} limit in Options and resume.`;
}

// Dry-run plan note for a bounded gate: "skipped (0 rounds)" or "up to N rounds".
const roundsNote = (rounds) => (rounds === 0 ? 'skipped (0 rounds)' : `up to ${rounds} rounds`);

// When true, a comic-target run with `includeVisual` proceeds past the text +
// editorial terminal into draft cover/page rendering (see runVisualDraft).
export const VISUAL_DRAFT_ENABLED = true;

// Severities that block a verify/review gate (low is informational).
const ARC_BLOCKING = new Set(['high', 'medium']);
const EDITORIAL_BLOCKING = new Set(['high']);

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
 * runState fields consulted (all optional): arcVerified, editorialReviewed
 * (booleans); beatsAttempted, textAttempted, scriptChecked (Set|array of ids).
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

  // STEP 4a — per-volume beat sheets (skip volumes already attempted this run).
  for (const season of seasons) {
    if (setHas(runState.beatsAttempted, season.id)) continue;
    const inSeason = ordered.filter((i) => i.seasonId === season.id);
    if (inSeason.some((i) => !isStageReady(i.stages?.idea))) {
      return { kind: 'beatSheet', seasonId: season.id, reason: `beats missing in volume ${season.number ?? '?'}` };
    }
  }

  // STEP 4b — per-issue text stages (prose + required scripts).
  for (const issue of ordered) {
    if (setHas(runState.textAttempted, issue.id)) continue;
    if (!textReady(issue, series, options)) {
      return { kind: 'textStages', issueId: issue.id, reason: 'prose / scripts not ready' };
    }
  }

  // STEP 4c — structural script gate (comic targets only).
  if (isComicTarget(series)) {
    for (const issue of ordered) {
      if (setHas(runState.scriptChecked, issue.id)) continue;
      return { kind: 'scriptVerify', issueId: issue.id, reason: 'comic script not yet structurally verified' };
    }
  }

  // STEP 5 — series-level editorial review via the manuscript editor (once).
  if (!runState.editorialReviewed) {
    return { kind: 'editorialReview', reason: 'editorial review not yet run this run' };
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
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && isComicTarget(series) && !runState.canonVerified) {
    return { kind: 'canonVerify', reason: 'canon descriptive integrity not yet verified this run' };
  }

  // STEP 6 — draft visuals (cover + back + all interior pages).
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && isComicTarget(series)) {
    for (const issue of ordered) {
      if (setHas(runState.visualDrafted, issue.id)) continue;
      if (visualReady(issue)) continue;
      return { kind: 'visualDraft', issueId: issue.id, reason: 'comic pages not yet drafted' };
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

// Two override shapes because the delegated services disagree on field names:
// the arc/episode/verify passes take { providerOverride, modelOverride }; the
// child runners (volumeBeatsRunner, autoRunner) take { providerId, model }.
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

const providerOverrideOpts = (record) => ({
  providerOverride: record.options.providerOverride,
  modelOverride: record.options.modelOverride,
});
const providerIdOpts = (record) => ({
  providerId: record.options.providerOverride,
  model: record.options.modelOverride,
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
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeVerify = await budgetPause();
    if (beforeVerify) return beforeVerify;
    const { issues } = await verifyArc(seriesId, providerOverrideOpts(record));
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = issues.filter((i) => ARC_BLOCKING.has(i.severity));
    broadcast(seriesId, {
      type: 'verify:round', scope: 'arc', round, findings: issues.length, blocking: blocking.length,
    });
    if (blocking.length === 0) {
      record.runState.arcVerified = true;
      return {};
    }
    if (round === maxRounds) {
      return { pause: true, reason: convergencePauseReason('arc', maxRounds, blocking.length), residual: blocking };
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

// Delegate to a child SSE runner and block until it finishes: mark the work as
// attempted (so a perpetually-failing child can't loop the resolver), start it,
// expose it as activeChild for responsive cancel, poll to completion, then bill
// one action. Shared by the beats and text steps.
async function runChildToCompletion(record, { attemptedSet, kind, id, start, isActive }) {
  attemptedSet.add(id);
  await start();
  record.activeChild = { kind, id };
  await waitForChild(() => isActive(id), record);
  record.activeChild = null;
  await recordDomainUsage('cos', { actions: 1 });
  return {};
}

const runBeats = (seriesId, seasonId, record) => runChildToCompletion(record, {
  attemptedSet: record.runState.beatsAttempted,
  kind: 'beats',
  id: seasonId,
  start: () => volumeBeatsRunner.startVolumeBeatsRun(seriesId, seasonId, { mode: 'skip-existing', ...providerIdOpts(record) }),
  isActive: volumeBeatsRunner.isVolumeBeatsRunActive,
});

async function runText(issueId, record) {
  record.runState.textAttempted.add(issueId);
  // Only adapt the target format's script(s) — a single-format series shouldn't
  // spend LLM calls populating the off-target script across every issue.
  const preIssue = await getIssue(issueId);
  const preSeries = await getSeries(preIssue.seriesId).catch(() => null);
  const scripts = requiredScriptStages(preSeries, record.options);
  // Forward the run's provider/model override so prose + scripts honor it like
  // every other step (autoRunner threads these into generateStage).
  await autoRunner.startAutoRunTextStages(issueId, { force: false, scripts, ...providerIdOpts(record) });
  record.activeChild = { kind: 'text', id: issueId };
  await waitForChild(() => autoRunner.isAutoRunActive(issueId), record);
  record.activeChild = null;
  await recordDomainUsage('cos', { actions: 1 });
  // A delegated text run can end with required stages still empty (the child's
  // LLM call failed). The issue is already marked attempted, so the resolver
  // would skip it and the run could reach 'done' with no script — verify the
  // required stages landed and pause for review if they didn't.
  const issue = await getIssue(issueId);
  const series = await getSeries(issue.seriesId).catch(() => null);
  if (!textReady(issue, series, record.options)) {
    const missing = requiredScriptStages(series, record.options).filter((s) => !isStageReady(issue.stages?.[s]));
    return {
      pause: true,
      reason: `text generation for issue ${issue.number ?? issueId} did not produce required stage(s): ${missing.join(', ')}`,
      residual: missing.map((s) => ({ severity: 'high', location: `issue ${issue.number ?? '?'} / ${s}`, problem: 'stage is still empty after the text run (likely an LLM failure)' })),
    };
  }
  return {};
}

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
    record.runState.editorialChecksReviewed = true;
    // Skipping the editorial gate also skips its health convergence check (#1316)
    // — the resolver must advance past editorialHealthGate too.
    record.runState.editorialHealthReady = true;
    return {};
  }
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
    const beforeAnalyze = await budgetPause();
    if (beforeAnalyze) return beforeAnalyze;
    const { issues, runId } = await analyzeManuscriptCompleteness(sId, {
      withEdits: true,
      ...providerOverrideOpts(record),
    });
    await recordDomainUsage('cos', { actions: 1 });
    const blocking = (issues || []).filter((i) => EDITORIAL_BLOCKING.has(i.severity));
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
      return { pause: true, reason: convergencePauseReason('editorial', maxRounds, blocking.length), residual: blocking };
    }
    // Bounded auto-fix: apply a fix for each open high-severity comment, then
    // the loop re-analyzes. Each fix is wrapped so one bad anchor doesn't abort
    // the pass (boundary use of try/catch — these call into LLM/file paths).
    const review = await getReview(sId).catch(() => ({ comments: [] }));
    const open = (review.comments || []).filter((c) => c.status === 'open' && EDITORIAL_BLOCKING.has(c.severity));
    for (const comment of open) {
      if (record.cancelRequested) return { canceled: true };
      // Each generated fix is its own LLM call — gate AND bill per comment so a
      // multi-comment pass can't overspend or under-count the daily budget.
      const beforeFix = await budgetPause();
      if (beforeFix) return beforeFix;
      try {
        if (!comment.fix) await generateManuscriptFix(sId, { commentId: comment.id });
        await acceptManuscriptFix(sId, { commentId: comment.id });
        await recordDomainUsage('cos', { actions: 1 });
      } catch (err) {
        console.log(`⚠️ autopilot: editorial fix ${comment.id} failed: ${(err?.message || err)}`);
      }
    }
  }
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
  const plan = await buildEditorialCheckPlan(sId, { settings });
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
  const result = await runEditorialChecks(sId, { ...providerOverrideOpts(record), settings, signal }).catch((err) => {
    console.log(`⚠️ autopilot: editorial checks failed for ${sId.slice(0, 12)}: ${err.message}`);
    return null;
  });
  // Canceled mid-pass — don't bill, don't mark the step reviewed; let the loop
  // unwind via its canceled branch.
  if (result?.canceled || record.cancelRequested) return { canceled: true };
  if (result) {
    if (hasLlmCheck) await recordDomainUsage('cos', { actions: 1 });
    broadcast(sId, { type: 'verify:round', scope: 'editorialChecks', round: 1, findings: result.findings.length, blocking: 0 });
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
  const settings = await getSettings().catch(() => null);
  const gate = readReadinessGate(settings) || undefined;
  // Do NOT swallow a getReview error into an empty review — that would fail OPEN
  // (the gate would pass on a corrupt/unreadable store and let the run proceed to
  // visuals without verifying health). Let it bubble to the coordinator's
  // top-level catch, which records a clean `error` terminal state.
  const review = await getReview(sId);
  const comments = review.comments || [];
  const health = computeHealth(comments, gate);
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
  const blockers = openBlockers(comments, gate);
  return { pause: true, reason: `editorial health not clean (score ${health.score}, ${health.open} open finding(s))`, residual: blockers };
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
    case 'textStages':
      return runText(step.issueId, record);
    case 'scriptVerify':
      return runScriptVerify(sId, step.issueId, record);
    case 'editorialReview':
      return runEditorial(sId, record);
    case 'editorialChecks':
      return runEditorialChecksPass(sId, record);
    case 'editorialHealthGate':
      return runEditorialHealthGate(sId, record);
    case 'canonVerify':
      return runCanonVerify(sId, record);
    case 'visualDraft':
      return runVisualDraft(sId, step.issueId, record);
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
function buildDryRunPlan(series, issues, options) {
  const plan = [];
  const ordered = orderedIssues(issues);
  const seasons = Array.isArray(series?.seasons) ? [...series.seasons].sort(byNumber) : [];
  // Mirror the resolver: generateArc runs when arc text is missing OR there are
  // no volumes at all (an arc-only series), so a dry-run plan must show it too.
  const noArc = !series?.arc?.logline && !series?.arc?.summary;
  if (noArc || seasons.length === 0) plan.push({ kind: 'generateArc', count: 1 });
  const emptySeasons = seasons.filter((s) => !ordered.some((i) => i.seasonId === s.id));
  if (emptySeasons.length) plan.push({ kind: 'generateEpisodes', count: emptySeasons.length });
  const arcRounds = Number.isInteger(options?.maxArcVerifyRounds) ? options.maxArcVerifyRounds : MAX_ARC_VERIFY_ROUNDS;
  plan.push({ kind: 'verifyArc', count: 1, note: roundsNote(arcRounds) });
  const beatsNeeded = seasons.filter((s) =>
    ordered.some((i) => i.seasonId === s.id && !isStageReady(i.stages?.idea))).length;
  if (beatsNeeded) plan.push({ kind: 'beatSheet', count: beatsNeeded });
  const textNeeded = ordered.filter((i) => !textReady(i, series, options)).length;
  if (textNeeded) plan.push({ kind: 'textStages', count: textNeeded });
  if (isComicTarget(series)) plan.push({ kind: 'scriptVerify', count: ordered.length });
  const edRounds = Number.isInteger(options?.maxEditorialRounds) ? options.maxEditorialRounds : MAX_EDITORIAL_ROUNDS;
  plan.push({ kind: 'editorialReview', count: 1, note: roundsNote(edRounds) });
  // maxEditorialRounds === 0 skips the whole editorial gate in execute mode
  // (runEditorial marks editorialReviewed + editorialChecksReviewed +
  // editorialHealthReady), so the plan must not advertise the registry checks or
  // the health gate that won't run.
  if (edRounds !== 0) {
    plan.push({ kind: 'editorialChecks', count: 1, note: 'enabled editorial checks (#1284)' });
    plan.push({ kind: 'editorialHealthGate', count: 1, note: 'editorial health readiness gate (#1316)' });
  }
  if (VISUAL_DRAFT_ENABLED && wantsVisual(options) && isComicTarget(series)) {
    plan.push({ kind: 'canonVerify', count: 1, note: 'descriptive integrity of drawn nouns' });
    const visualNeeded = ordered.filter((i) => !visualReady(i)).length;
    if (visualNeeded) plan.push({ kind: 'visualDraft', count: visualNeeded, note: 'cover + back + all pages (draft)' });
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
  const runOptions = { ...options, ...resolveAutopilotRounds(options, settings) };

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
      editorialReviewed: false,
      editorialChecksReviewed: false,
      editorialHealthReady: false,
      canonVerified: false,
      episodesAttempted: new Set(),
      beatsAttempted: new Set(),
      textAttempted: new Set(),
      scriptChecked: new Set(),
      visualDrafted: new Set(),
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
        const plan = buildDryRunPlan(series, issues, runOptions);
        broadcast(sId, { type: 'start', runId, mode, target: series.targetFormat, plan });
        // Carry the plan on the terminal frame too: a dry-run emits start +
        // complete synchronously, often before the client attaches, and
        // attachSseClient replays only the LAST frame — so the plan would be
        // lost if it lived solely on the start frame.
        broadcast(sId, { type: 'complete', runId, dryRun: true, steps: plan.length, plan, completedAt: new Date().toISOString() });
        console.log(`🧭 autopilot dry-run — series=${sId.slice(0, 12)} steps=${plan.length}`);
        return;
      }

      // EXECUTE.
      const series0 = await getSeries(sId);
      broadcast(sId, { type: 'start', runId, mode, target: series0.targetFormat });
      await persistMarker(sId, { status: 'running', runId, currentStep: null, residualFindings: [], lastError: null });
      if (runOptions.includeVisual && !VISUAL_DRAFT_ENABLED) {
        broadcast(sId, { type: 'note', message: 'Draft visual rendering is not enabled in this build — running to text-ready + editorial review.' });
      }

      let ordinal = 0;
      while (!record.cancelRequested) {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        const step = resolveNextStep(series, issues, record.runState, runOptions);

        if (step.kind === 'done') {
          await persistMarker(sId, { status: 'done', runId, currentStep: null });
          broadcast(sId, { type: 'complete', runId, steps: ordinal, completedAt: new Date().toISOString() });
          console.log(`✅ autopilot complete — series=${sId.slice(0, 12)} steps=${ordinal}`);
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
        // readiness verdict (and pause on the findings, not the budget). A gate
        // whose resolved rounds is 0 ("skip") is also exempt: runArcVerify /
        // runEditorial short-circuit with no LLM spend, so "0 skips the gate" must
        // hold even when the budget is exhausted (otherwise the run pauses on
        // budget instead of skipping).
        const zeroRoundSkip = (step.kind === 'verifyArc' && runOptions.maxArcVerifyRounds === 0)
          || (step.kind === 'editorialReview' && runOptions.maxEditorialRounds === 0);
        if (step.kind !== 'editorialChecks' && step.kind !== 'editorialHealthGate' && !zeroRoundSkip) {
          const budget = await getDomainBudgetStatus('cos');
          if (!budget.withinBudget) {
            await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, lastError: `daily cos ${budget.exceeded} budget reached` });
            broadcast(sId, { type: 'paused', runId, reason: `daily cos ${budget.exceeded} budget reached`, completedAt: new Date().toISOString() });
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
          await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, residualFindings: result.residual || [], lastError: result.reason });
          broadcast(sId, { type: 'paused', runId, scope: step.kind, reason: result.reason, residualFindings: result.residual || [], completedAt: new Date().toISOString() });
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
export const __testing = { runs, buildDryRunPlan };
