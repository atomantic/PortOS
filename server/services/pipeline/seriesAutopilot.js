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
import { generateManuscriptFix, acceptManuscriptFix } from './manuscriptFix.js';
import { verifyComicScript } from './scriptVerify.js';
import { checkSeriesCanonReadiness } from './canonReadiness.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished,
//   cleanupTimer, startedAt, mode, options, runState, activeChild }>
const runs = new Map();

// Bounded convergence loops — re-verify/re-review at most this many rounds, then
// pause for human review with the residual findings (see module header).
export const MAX_ARC_VERIFY_ROUNDS = 3;
export const MAX_EDITORIAL_ROUNDS = 2;

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
export function requiredScriptStages(series) {
  const fmt = series?.targetFormat || 'comic+tv';
  if (fmt === 'comic') return ['comicScript'];
  if (fmt === 'tv') return ['teleplay'];
  return ['comicScript', 'teleplay'];
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

// A render slot counts as "enqueued" once it carries a jobId or a stamped
// filename (proof or final). Draft rendering only kicks off proof renders, but
// we accept either so a re-run never re-renders a slot the user already
// finalized manually.
const slotEnqueued = (slot) => !!(
  slot && (slot.proofImage?.jobId || slot.proofImage?.filename
    || slot.finalImage?.jobId || slot.finalImage?.filename)
);
const pageEnqueued = (page) => !!(
  page && (page.proofImage?.jobId || page.proofImage?.filename
    || page.finalImage?.jobId || page.finalImage?.filename)
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
  if (cp?.backCover?.script && !slotEnqueued(cp?.backCover)) return false;
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

async function runText(issueId, record) {
  record.runState.textAttempted.add(issueId);
  // Forward the run's provider/model override so prose + scripts honor it like
  // every other step (autoRunner threads these into generateStage).
  await autoRunner.startAutoRunTextStages(issueId, { force: false, ...providerIdOpts(record) });
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
  if (!textReady(issue, series)) {
    const missing = requiredScriptStages(series).filter((s) => !isStageReady(issue.stages?.[s]));
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
  // A structural failure blocks page extraction, so surface + file a gap.
  if (!scriptStructurallyReady(issue)) {
    broadcast(sId, {
      type: 'step:skip',
      kind: 'scriptVerify',
      issueId,
      reason: 'comic script did not parse into pages/panels — flagged for review',
    });
    await fileGap(record, sId, {
      gapKind: 'script-unparseable',
      issueId,
      summary: 'The comic script for this issue does not parse into pages/panels, so comic pages can\'t be extracted. It likely needs a manual fix or regeneration of the comicScript stage.',
      context: `issueId=${issueId}`,
    });
    return {};
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
  record.runState.visualDrafted.add(issueId);
  let issue = await getIssue(issueId);
  let cp = issue.stages?.comicPages;

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
    broadcast(sId, { type: 'step:skip', kind: 'visualDraft', issueId, reason: 'no comic pages to render (script did not parse)' });
    return {};
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
  // 3. Back cover (only when a concept/script exists to render).
  issue = await getIssue(issueId);
  cp = issue.stages?.comicPages;
  if (cp?.backCover?.script && !slotEnqueued(cp?.backCover)) {
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
  };
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
      canonVerified: false,
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
          await fileGap(record, sId, {
            gapKind: `${step.kind}-stalled`,
            issueId: step.issueId || null,
            summary: `Autopilot paused: ${result.reason}. Needs human review of the residual findings before it can continue.`,
            context: JSON.stringify(result.residual || []).slice(0, 1000),
          });
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
