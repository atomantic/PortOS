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
 * KNOWN GAP — "script verification": there is no dedicated comic-script verify
 * endpoint. The scriptVerify step is a STRUCTURAL gate only (does the comic
 * script parse into pages+panels). A real craft-level LLM script-verify prompt
 * is a deliberate Phase-3 follow-up, not silently assumed solved.
 *
 * NOT YET IMPLEMENTED — draft visuals (cover + all interior pages). The render
 * endpoints persist their job ids at the ROUTE layer (the enqueue helpers only
 * return a jobId the caller must record), so faithful draft rendering needs that
 * persistence replicated per slot. Gated behind VISUAL_DRAFT_ENABLED (false) so
 * the Phase-1 terminal is "text-ready + editorial review"; flip the flag and
 * implement `runVisualDraft` in Phase 2.
 */

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { parseComicScript } from '../../lib/comicScriptParser.js';
import { loadState } from '../cosState.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { getSeries, updateSeries } from './series.js';
import { listIssues, getIssue, isStageReady } from './issues.js';
import { compareIssuesByPosition } from './arcPlanner.js';
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
import { generateManuscriptFix, acceptManuscriptFix } from './manuscriptFix.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished,
//   cleanupTimer, startedAt, mode, options, runState, activeChild }>
const runs = new Map();

// Bounded convergence loops — re-verify/re-review at most this many rounds, then
// pause for human review with the residual findings (see module header).
export const MAX_ARC_VERIFY_ROUNDS = 3;
export const MAX_EDITORIAL_ROUNDS = 2;

// Phase-2 flag — see module header. While false the terminal is text + editorial.
export const VISUAL_DRAFT_ENABLED = false;

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
export function requiredScriptStages(series) {
  const fmt = series?.targetFormat || 'comic+tv';
  if (fmt === 'comic') return ['comicScript'];
  if (fmt === 'tv') return ['teleplay'];
  return ['comicScript', 'teleplay'];
}

export function isComicTarget(series) {
  return (series?.targetFormat || 'comic+tv').includes('comic');
}

function orderedIssues(issues) {
  return [...(Array.isArray(issues) ? issues : [])].sort(compareIssuesByPosition);
}

function textReady(issue, series) {
  return requiredScriptStages(series).every((stageId) => isStageReady(issue.stages?.[stageId]));
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

  // STEP 1 — arc.
  if (!series?.arc?.logline && !series?.arc?.summary) {
    return { kind: 'generateArc', reason: 'series has no arc' };
  }

  // STEP 2 — a season with zero issues (in season order).
  for (const season of seasons) {
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
    if (!textReady(issue, series)) {
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

  // STEP 6 — draft visuals (Phase 2; gated off for now).
  if (VISUAL_DRAFT_ENABLED && options.includeVisual && isComicTarget(series)) {
    for (const issue of ordered) {
      if (setHas(runState.visualDrafted, issue.id)) continue;
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
const providerOverrideOpts = (record) => ({
  providerOverride: record.options.providerOverride,
  modelOverride: record.options.modelOverride,
});
const providerIdOpts = (record) => ({
  providerId: record.options.providerOverride,
  model: record.options.modelOverride,
});

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
      return { pause: true, reason: `arc verification did not converge after ${maxRounds} rounds`, residual: blocking };
    }
    if (record.cancelRequested) return { canceled: true };
    await resolveVerifyIssues(seriesId, { findings: blocking, ...providerOverrideOpts(record) });
    await recordDomainUsage('cos', { actions: 1 });
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

const runText = (issueId, record) => runChildToCompletion(record, {
  attemptedSet: record.runState.textAttempted,
  kind: 'text',
  id: issueId,
  start: () => autoRunner.startAutoRunTextStages(issueId, { force: false }),
  isActive: autoRunner.isAutoRunActive,
});

async function runScriptVerify(sId, issueId, record) {
  record.runState.scriptChecked.add(issueId);
  const issue = await getIssue(issueId);
  if (!scriptStructurallyReady(issue)) {
    // Structural gap — surface it but don't block the run (Phase 3 will file a
    // CoS task / run a craft-level LLM verify). Not billable.
    broadcast(sId, {
      type: 'step:skip',
      kind: 'scriptVerify',
      issueId,
      reason: 'comic script did not parse into pages/panels — flagged for review',
    });
  }
  return {};
}

async function runEditorial(sId, record) {
  const maxRounds = Number.isInteger(record.options.maxEditorialRounds)
    ? record.options.maxEditorialRounds
    : MAX_EDITORIAL_ROUNDS;
  // maxRounds === 0 means "skip the editorial gate entirely".
  if (maxRounds === 0) {
    record.runState.editorialReviewed = true;
    return {};
  }
  for (let round = 1; round <= maxRounds; round += 1) {
    if (record.cancelRequested) return { canceled: true };
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
      return { pause: true, reason: `editorial review did not converge after ${maxRounds} round(s)`, residual: blocking };
    }
    // Bounded auto-fix: apply a fix for each open high-severity comment, then
    // the loop re-analyzes. Each fix is wrapped so one bad anchor doesn't abort
    // the pass (boundary use of try/catch — these call into LLM/file paths).
    const review = await getReview(sId).catch(() => ({ comments: [] }));
    const open = (review.comments || []).filter((c) => c.status === 'open' && EDITORIAL_BLOCKING.has(c.severity));
    for (const comment of open) {
      if (record.cancelRequested) return { canceled: true };
      try {
        if (!comment.fix) await generateManuscriptFix(sId, { commentId: comment.id });
        await acceptManuscriptFix(sId, { commentId: comment.id });
      } catch (err) {
        console.log(`⚠️ autopilot: editorial fix ${comment.id} failed: ${(err?.message || err)}`);
      }
    }
    await recordDomainUsage('cos', { actions: 1 });
  }
  return {};
}

async function dispatchStep(sId, step, record) {
  switch (step.kind) {
    case 'generateArc': {
      const r = await generateArcOverview(sId, providerOverrideOpts(record));
      const cur = await getSeries(sId);
      await commitSeasonsWithRemap(cur, { arc: r.arc, seasons: r.seasons });
      await recordDomainUsage('cos', { actions: 1 });
      return {};
    }
    case 'generateEpisodes': {
      const r = await generateSeasonEpisodes(sId, step.seasonId, providerOverrideOpts(record));
      const cur = await getSeries(sId);
      await commitEpisodesToIssues(sId, step.seasonId, r.episodes, { preloadedSeries: cur });
      await recordDomainUsage('cos', { actions: 1 });
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
  if (!series?.arc?.logline && !series?.arc?.summary) plan.push({ kind: 'generateArc', count: 1 });
  const emptySeasons = seasons.filter((s) => !ordered.some((i) => i.seasonId === s.id));
  if (emptySeasons.length) plan.push({ kind: 'generateEpisodes', count: emptySeasons.length });
  plan.push({ kind: 'verifyArc', count: 1, note: `up to ${MAX_ARC_VERIFY_ROUNDS} rounds` });
  const beatsNeeded = seasons.filter((s) =>
    ordered.some((i) => i.seasonId === s.id && !isStageReady(i.stages?.idea))).length;
  if (beatsNeeded) plan.push({ kind: 'beatSheet', count: beatsNeeded });
  const textNeeded = ordered.filter((i) => !textReady(i, series)).length;
  if (textNeeded) plan.push({ kind: 'textStages', count: textNeeded });
  if (isComicTarget(series)) plan.push({ kind: 'scriptVerify', count: ordered.length });
  plan.push({ kind: 'editorialReview', count: 1, note: `up to ${MAX_EDITORIAL_ROUNDS} rounds` });
  if (VISUAL_DRAFT_ENABLED && options.includeVisual && isComicTarget(series)) {
    plan.push({ kind: 'visualDraft', count: ordered.length });
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
    options,
    runState: {
      arcVerified: false,
      editorialReviewed: false,
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
        const plan = buildDryRunPlan(series, issues, options);
        broadcast(sId, { type: 'start', runId, mode, target: series.targetFormat, plan });
        broadcast(sId, { type: 'complete', runId, dryRun: true, steps: plan.length, completedAt: new Date().toISOString() });
        console.log(`🧭 autopilot dry-run — series=${sId.slice(0, 12)} steps=${plan.length}`);
        return;
      }

      // EXECUTE.
      const series0 = await getSeries(sId);
      broadcast(sId, { type: 'start', runId, mode, target: series0.targetFormat });
      await persistMarker(sId, { status: 'running', runId, currentStep: null, residualFindings: [], lastError: null });
      if (options.includeVisual && !VISUAL_DRAFT_ENABLED) {
        broadcast(sId, { type: 'note', message: 'Draft visual rendering is not enabled in this build — running to text-ready + editorial review.' });
      }

      let ordinal = 0;
      while (!record.cancelRequested) {
        const series = await getSeries(sId);
        const issues = await listIssues({ seriesId: sId });
        const step = resolveNextStep(series, issues, record.runState, options);

        if (step.kind === 'done') {
          await persistMarker(sId, { status: 'done', runId, currentStep: null });
          broadcast(sId, { type: 'complete', runId, steps: ordinal, completedAt: new Date().toISOString() });
          console.log(`✅ autopilot complete — series=${sId.slice(0, 12)} steps=${ordinal}`);
          return;
        }

        // Budget gate (mirrors cosJobScheduler) — pause when today's cos action
        // budget is exhausted rather than burning past it.
        const budget = await getDomainBudgetStatus('cos');
        if (!budget.withinBudget) {
          await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, lastError: `daily cos ${budget.exceeded} budget reached` });
          broadcast(sId, { type: 'paused', runId, reason: `daily cos ${budget.exceeded} budget reached`, completedAt: new Date().toISOString() });
          console.log(`⏸️  autopilot paused (budget) — series=${sId.slice(0, 12)} after ${ordinal} steps`);
          return;
        }

        ordinal += 1;
        await persistMarker(sId, { status: 'running', runId, currentStep: step.kind });
        broadcast(sId, { type: 'step:start', kind: step.kind, seasonId: step.seasonId, issueId: step.issueId, ordinal, reason: step.reason });

        const result = await dispatchStep(sId, step, record);

        if (result?.canceled || record.cancelRequested) break;
        if (result?.pause) {
          await persistMarker(sId, { status: 'paused', runId, currentStep: step.kind, residualFindings: result.residual || [], lastError: result.reason });
          broadcast(sId, { type: 'paused', runId, scope: step.kind, reason: result.reason, residualFindings: result.residual || [], completedAt: new Date().toISOString() });
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
