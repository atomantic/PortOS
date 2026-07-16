/**
 * Pipeline — holistic "Review this series" flow (#2664).
 *
 * Composes the existing read-only review passes into ONE structured verdict the
 * user can act on: run the foundation judge + editorial checks + editorial
 * health/readiness + canon readiness, optionally route a free-text user
 * observation into an anchored finding, and return a single
 * `{ verdict: 'ready' | 'issues', foundation, health, canon, findings }` payload.
 *
 * This is a COMPOSITION layer — it reuses the existing runners verbatim and adds
 * no new AI plumbing and no second orchestrator:
 *   - foundation judge   → foundationJudge.judgeFoundation (writes only its own
 *                          snapshot; never touches the manuscript)
 *   - editorial checks   → editorial/checkRunner.runEditorialChecks (seeds the
 *                          shared manuscript-review store with findings — the
 *                          same store the fix path reads; NOT a manuscript write)
 *   - health/readiness   → editorialScore.getSeriesHealth
 *   - canon readiness    → canonReadiness.checkSeriesCanonReadiness (deterministic)
 *   - free-text feedback → routed through runStageScopedInlineLLM to the best
 *                          issue/section and seeded as an anchored finding
 *
 * The review performs NO manuscript writes, so it is safe to run repeatedly. The
 * FIX path is deliberately NOT here: "Fix these issues" drives the existing
 * Series Autopilot revision cycle (cos-domain gate + budget + SSE) and the
 * per-finding manuscriptFix routes — this service only produces the verdict.
 *
 * Progress streams over SSE via the shared `createSseRunner` (mirrors
 * checkRunner / editorialAnalysisRunner). The last verdict persists at
 * `data/pipeline-series-review/{seriesId}.json` so a (re)mounting client can
 * reload it without re-running.
 *
 * AI-provider policy: this fires ONLY from the explicit user "Review this
 * series" action — never at boot.
 */

import { join } from 'path';
import { unlink } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../lib/fileUtils.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { runStageScopedInlineLLM } from '../../lib/stageRunner.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { readReadinessGate, mergeSeverityWeights } from '../../lib/editorial/index.js';
import { loadState } from '../cosState.js';
import { getSettings } from '../settings.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { getSeries } from './series.js';
import { listIssues } from './issues.js';
import { judgeFoundation, DEFAULT_FOUNDATION_THRESHOLD } from './foundationJudge.js';
import { runEditorialChecks } from './editorial/checkRunner.js';
import { getSeriesHealth, isOpenFinding, DEFAULT_READINESS_GATE } from './editorialScore.js';
import { checkSeriesCanonReadiness } from './canonReadiness.js';
import { getReview, seedReviewFromFindings } from './manuscriptReview.js';
import { generateManuscriptFix, acceptManuscriptFix } from './manuscriptFix.js';

// The stage whose provider/model pins the free-text-feedback routing call, so a
// user observation about the manuscript is judged on the SAME provider the arc
// authoring uses (never silently routed elsewhere). Mirrors foundationJudge's
// WRITER_STAGE indirection.
const FEEDBACK_STAGE = 'pipeline-arc-overview';
const FEEDBACK_MAX = 4000;

const nowIso = () => new Date().toISOString();

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk snapshot path (series ids are `ser-<uuid>`). Mirrors the sibling
// pipeline services.
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

const reviewDir = () => join(PATHS.data, 'pipeline-series-review');
const snapshotPath = (seriesId) => join(reviewDir(), `${seriesId}.json`);

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

// ---------------------------------------------------------------------------
// Pure composition helpers (unit-tested in isolation).
// ---------------------------------------------------------------------------

/**
 * The single 'ready' | 'issues' verdict. A series is only "ready to move
 * forward" when the editorial-health readiness gate is clean AND the foundation
 * clears the quality threshold AND every drawn noun is described (canon ready)
 * AND the review actually completed (`incomplete` false — a stage that errored /
 * never ran means the verdict is untrustworthy and must never read 'ready').
 * Any of those failing → 'issues'. Pure.
 */
export function computeReviewVerdict({ health, foundation, canon, threshold = DEFAULT_FOUNDATION_THRESHOLD, incomplete = false } = {}) {
  const healthReady = health?.ready === true;
  const foundationReady = !foundation || !Number.isFinite(foundation.weightedScore)
    ? true
    : foundation.weightedScore >= threshold;
  const canonReady = canon?.ready !== false;
  return healthReady && foundationReady && canonReady && !incomplete ? 'ready' : 'issues';
}

/**
 * Project the manuscript-review store's OPEN comments into the review's flat
 * findings list, each carrying the `commentId` the per-finding fix path needs
 * plus the anchoring fields the UI groups + deep-links by. Sorted high→low
 * severity, then by issue number (series-scoped nulls last). Pure.
 */
export function collectReviewFindings(comments) {
  const open = (Array.isArray(comments) ? comments : []).filter((c) => c && typeof c === 'object' && isOpenFinding(c));
  return open
    .map((c) => ({
      commentId: c.id,
      severity: c.severity in SEVERITY_RANK ? c.severity : 'medium',
      checkId: typeof c.checkId === 'string' ? c.checkId : null,
      issueId: typeof c.issueId === 'string' ? c.issueId : null,
      issueNumber: Number.isInteger(c.issueNumber) ? c.issueNumber : null,
      location: typeof c.location === 'string' ? c.location : '',
      anchorQuote: typeof c.anchorQuote === 'string' ? c.anchorQuote : '',
      summary: typeof c.problem === 'string' ? c.problem : '',
    }))
    .sort((a, b) => {
      const s = (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1);
      if (s !== 0) return s;
      return (a.issueNumber ?? Infinity) - (b.issueNumber ?? Infinity);
    });
}

/**
 * Build the inline prompt that routes a free-text user observation to the best
 * issue + anchor. Given the issue roster (number + title) and the feedback, the
 * model returns a single finding JSON. Pure.
 */
export function buildFeedbackRoutePrompt(feedback, issues) {
  const roster = (Array.isArray(issues) ? issues : [])
    .map((i) => `- #${i.number}: ${i.title || '(untitled)'}`)
    .join('\n') || '(no issues yet)';
  return [
    'You are an editorial triage assistant. A reader has left a free-text note about a series.',
    'Route the note to the single BEST place to patch it, as one JSON object.',
    '',
    'Series issues (number: title):',
    roster,
    '',
    'Reader note:',
    `"""${feedback}"""`,
    '',
    'Return ONLY a JSON object with these keys:',
    '  issueNumber  — the issue number the note is about, or null if it is series-wide',
    '  severity     — "high" | "medium" | "low"',
    '  location     — a short human label for where this applies (e.g. "Volume 1 pacing")',
    '  problem      — a one-to-two sentence restatement of the concern as an editorial finding',
    '  suggestion   — a concrete suggested fix (may be empty)',
    '  anchorQuote  — a short verbatim quote from the manuscript to anchor the fix, or "" if unknown',
    '',
    'Do not invent an issue number that is not in the list above; use null when unsure.',
  ].join('\n');
}

/**
 * Shape the LLM's routed-feedback response into a finding for
 * seedReviewFromFindings, tolerant of malformed/absent output. Falls back to a
 * series-level finding carrying the raw feedback so a user observation ALWAYS
 * lands (never silently dropped). `validNumbers` is the set of real issue
 * numbers — a hallucinated number degrades to a series-level (null) finding.
 * Pure.
 */
export function shapeFeedbackFinding(parsed, { feedback, validNumbers } = {}) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  const valid = validNumbers instanceof Set ? validNumbers : new Set(validNumbers || []);
  const issueNumber = Number.isInteger(p.issueNumber) && valid.has(p.issueNumber) ? p.issueNumber : null;
  const severity = p.severity in SEVERITY_RANK ? p.severity : 'medium';
  const problem = (typeof p.problem === 'string' && p.problem.trim())
    ? p.problem.trim()
    : String(feedback || '').trim();
  return {
    issueNumber,
    severity,
    category: 'user-feedback',
    location: typeof p.location === 'string' ? p.location.slice(0, 200) : '',
    problem: problem.slice(0, 2000),
    suggestion: typeof p.suggestion === 'string' ? p.suggestion.slice(0, 8000) : '',
    anchorQuote: typeof p.anchorQuote === 'string' ? p.anchorQuote.slice(0, 400) : '',
    // Marks the finding as a user observation so it groups distinctly from the
    // automated checks and the dedup key can't collide with a real check.
    checkId: 'user-feedback',
  };
}

// ---------------------------------------------------------------------------
// Free-text feedback routing (one inline LLM call, seeded as a finding).
// ---------------------------------------------------------------------------

async function routeFeedbackToFinding(seriesId, feedback, { providerOverride, modelOverride, issues }) {
  const trimmed = String(feedback || '').trim();
  if (!trimmed) return null;
  const prompt = buildFeedbackRoutePrompt(trimmed.slice(0, FEEDBACK_MAX), issues);
  // Never fail the whole review on a bad routing call — fall back to a
  // series-level finding carrying the raw note so the observation still lands.
  let parsed = null;
  await runStageScopedInlineLLM(FEEDBACK_STAGE, prompt, {
    returnsJson: true,
    providerOverride,
    modelOverride,
    source: 'series-review-feedback',
  })
    .then((r) => { parsed = r?.content ?? null; })
    .catch((err) => { console.error(`⚠️ series-review feedback routing failed — series=${seriesId.slice(0, 12)} ${err.message}`); });
  const validNumbers = new Set((Array.isArray(issues) ? issues : []).map((i) => i.number).filter(Number.isInteger));
  const finding = shapeFeedbackFinding(parsed, { feedback: trimmed, validNumbers });
  const review = await seedReviewFromFindings(seriesId, [finding], { mode: 'merge', checkId: 'user-feedback' });
  return { finding, review };
}

// ---------------------------------------------------------------------------
// Core read-only review.
// ---------------------------------------------------------------------------

/**
 * Run the holistic read-only review. Returns the structured verdict. Emits
 * progress via `onProgress(event)` (each event a `{ type, ... }` frame). No
 * manuscript writes — safe to run repeatedly.
 *
 * @param {string} seriesId
 * @param {object} [opts]
 * @param {string} [opts.feedback]          optional free-text user observation
 * @param {string} [opts.providerOverride]  provider override for the LLM passes
 * @param {string} [opts.modelOverride]     model override for the LLM passes
 * @param {boolean} [opts.force]            re-judge an unchanged foundation
 * @param {string} [opts.readinessGate]     per-run readiness-gate override
 * @param {AbortSignal} [opts.signal]       cancellation
 * @param {(event: object) => void} [opts.onProgress]
 */
export async function runSeriesReview(seriesId, {
  feedback, providerOverride, modelOverride, force = false, readinessGate, signal, onProgress = () => {},
} = {}) {
  assertValidSeriesId(seriesId);
  // Three independent reads — resolve concurrently.
  const [series, settings, issues] = await Promise.all([
    getSeries(seriesId),
    getSettings().catch(() => null),
    listIssues({ seriesId }).catch(() => []),
  ]);
  const gate = readinessGate || readReadinessGate(settings) || DEFAULT_READINESS_GATE;
  const weights = mergeSeverityWeights(series?.severityWeights);

  const aborted = () => signal?.aborted;
  // Stages that errored / never ran this pass — any of these makes the verdict
  // untrustworthy, so it must never read 'ready' (fail closed). Surfaced on the
  // result so the UI can warn the review is incomplete.
  const failedStages = [];

  // 1. Foundation judge (holistic pre-draft quality — catches "looks complete
  //    but no development"). Writes only its own snapshot. A throw is a genuine
  //    failure (judgeFoundation otherwise always returns a snapshot), not an
  //    absent-but-fine result — record it so the verdict fails closed.
  onProgress({ type: 'step:start', kind: 'foundation' });
  const foundation = await judgeFoundation(seriesId, { providerId: providerOverride, model: modelOverride, force })
    .catch((err) => { console.error(`⚠️ series-review foundation judge failed — series=${seriesId.slice(0, 12)} ${err.message}`); failedStages.push('foundation'); return null; });
  onProgress({ type: 'step:complete', kind: 'foundation', weightedScore: foundation?.weightedScore ?? null });
  if (aborted()) return null;

  // 2. Optional free-text feedback → anchored finding (before the checks pass so
  //    it merges into the same review the verdict reads).
  if (feedback && String(feedback).trim()) {
    onProgress({ type: 'step:start', kind: 'feedback' });
    await routeFeedbackToFinding(seriesId, feedback, { providerOverride, modelOverride, issues })
      .catch((err) => { console.error(`⚠️ series-review feedback seed failed — series=${seriesId.slice(0, 12)} ${err.message}`); });
    onProgress({ type: 'step:complete', kind: 'feedback' });
    if (aborted()) return null;
  }

  // 3. Editorial checks — registry-driven review; seeds the shared review store.
  onProgress({ type: 'step:start', kind: 'editorialChecks' });
  // A runner-level REJECT (e.g. it threw while building shared context, before
  // producing any perCheck entries) is a whole-pass failure — the checks never
  // ran, so mark the review incomplete rather than reporting an empty clean pass.
  let checksRunFailed = false;
  const checks = await runEditorialChecks(seriesId, {
    providerOverride,
    modelOverride,
    signal,
    onProgress,
  }).catch((err) => { console.error(`⚠️ series-review editorial checks failed — series=${seriesId.slice(0, 12)} ${err.message}`); checksRunFailed = true; failedStages.push('editorialChecks'); return { findings: [], perCheck: [], canceled: false }; });
  // A single check that threw (e.g. an unavailable LLM provider) is caught
  // internally by the runner and surfaced in perCheck as `{ checkId, error }` —
  // that dimension was never evaluated, so it too must block a 'ready' verdict.
  const erroredCheckIds = (Array.isArray(checks?.perCheck) ? checks.perCheck : [])
    .filter((p) => p && p.error).map((p) => p.checkId);
  const checksErrored = erroredCheckIds.length;
  onProgress({ type: 'step:complete', kind: 'editorialChecks', findingCount: checks?.findings?.length ?? 0, errored: checksErrored, failed: checksRunFailed });
  if (aborted() || checks?.canceled) return null;

  // 4. Canon readiness (deterministic — no LLM). A throw is a genuine failure —
  //    record it so the verdict fails closed rather than treating the missing
  //    result as "canon fine".
  onProgress({ type: 'step:start', kind: 'canon' });
  const canon = await checkSeriesCanonReadiness(seriesId)
    .catch((err) => { console.error(`⚠️ series-review canon readiness failed — series=${seriesId.slice(0, 12)} ${err.message}`); failedStages.push('canon'); return null; });
  onProgress({ type: 'step:complete', kind: 'canon', ready: canon?.ready !== false });

  // 5. Health + readiness + the seeded findings — both only READ the store the
  //    checks just seeded, so resolve them concurrently.
  onProgress({ type: 'step:start', kind: 'health' });
  const [health, review] = await Promise.all([
    getSeriesHealth(seriesId, { gate, weights }).catch(() => null),
    getReview(seriesId).catch(() => ({ comments: [] })),
  ]);
  onProgress({ type: 'step:complete', kind: 'health', ready: health?.ready === true, score: health?.score ?? null });
  const findings = collectReviewFindings(review.comments);
  if (!health) failedStages.push('health');
  const threshold = Number.isFinite(settings?.pipelineEditorialChecks?.foundationThreshold)
    ? settings.pipelineEditorialChecks.foundationThreshold
    : DEFAULT_FOUNDATION_THRESHOLD;
  // The review is incomplete when ANY dimension errored/never-ran OR an
  // individual check errored — the verdict then fails closed (never 'ready').
  const incomplete = failedStages.length > 0 || checksErrored > 0;
  const verdict = computeReviewVerdict({ health, foundation, canon, threshold, incomplete });

  const result = {
    seriesId,
    verdict,
    generatedAt: nowIso(),
    gate,
    foundationThreshold: threshold,
    foundation: foundation
      ? { weightedScore: foundation.weightedScore, dimensions: foundation.dimensions, oneLineVerdict: foundation.oneLineVerdict, weakest: foundation.weakest, stale: foundation.stale === true }
      : null,
    health: health
      ? { score: health.score, ready: health.ready, open: health.open, openBySeverity: health.openBySeverity, gate: health.gate }
      : null,
    canon: canon
      ? { ready: canon.ready, blockingIssues: canon.blockingIssues, undescribed: canon.undescribed }
      : null,
    findings,
    findingCount: findings.length,
    // Whether the review actually completed every dimension. When false, a stage
    // errored / never ran, so the verdict is forced to 'issues' and the UI warns
    // the review is incomplete (P2). `failedStages` names which dimensions failed;
    // `checksErrored`/`erroredCheckIds` detail individual check errors.
    incomplete,
    failedStages,
    checksErrored,
    erroredCheckIds,
    hadFeedback: !!(feedback && String(feedback).trim()),
  };
  await saveSnapshot(result);
  console.log(`🔎 series review — series=${seriesId.slice(0, 12)} verdict=${verdict} findings=${findings.length} foundation=${foundation?.weightedScore ?? '—'} health=${health?.score ?? '—'}`);
  return result;
}

// ---------------------------------------------------------------------------
// Persistence — last verdict per series.
// ---------------------------------------------------------------------------

async function saveSnapshot(result) {
  await ensureDir(reviewDir());
  await atomicWrite(snapshotPath(result.seriesId), result);
}

// Drop the persisted verdict for a series so a reload/remount doesn't restore a
// now-stale review (e.g. after fixes accepted findings + mutated the manuscript).
// GET /review then returns `{ review: null }` until the user re-reviews.
async function clearSnapshot(seriesId) {
  await unlink(snapshotPath(seriesId)).catch(() => {}); // best-effort; ENOENT is fine
}

/**
 * Read the last stored review verdict for a series (null when never run). Also
 * reports whether the FIX path is currently available (cos-domain autonomy):
 * with the domain `off`, review still works read-only but fixing is disabled.
 */
export async function getSeriesReview(seriesId) {
  assertValidSeriesId(seriesId);
  const content = await tryReadFile(snapshotPath(seriesId));
  const verdict = content === null
    ? null
    : safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
  const fix = await getFixAvailability();
  return { review: verdict, fix };
}

/**
 * Whether the fix path can run right now, from the cos-domain autonomy mode.
 * Only `execute` applies fixes: `off` disables fixing (review stays read-only),
 * and `dry-run` is a plan-only preview that performs NO writes — so it must NOT
 * report the fix as available (P3), or the UI would claim "fixes complete" after
 * a no-op. The client renders a mode-specific reason for both non-execute cases.
 */
export async function getFixAvailability() {
  const state = await loadState().catch(() => ({ config: {} }));
  const mode = getDomainMode(state?.config, 'cos');
  return { mode, canFix: mode === 'execute' };
}

// ---------------------------------------------------------------------------
// Fix path (P1) — patch findings where best patched via the EXISTING per-finding
// manuscriptFix machinery, in a simple bulk loop.
//
// This deliberately does NOT start Series Autopilot: the autopilot's editorial
// step only auto-resolves manuscript-COMPLETENESS findings, so the editorial-
// CHECK findings this review surfaces stay open, the editorial-health gate
// pauses on them, and the revision cycle is never reached — a full-autopilot run
// can't actually fix the findings the review flagged. Looping
// generateManuscriptFix → acceptManuscriptFix over each open finding patches it
// at its anchor (the finding's `anchorQuote`/issue/stage), which is precisely
// "fix where best patched." It is not a second orchestrator — it reuses the
// per-finding fixers under the same cos-domain gate + budget the autopilot uses.
// ---------------------------------------------------------------------------

/**
 * Bulk-fix a series' open findings through the anchored per-finding fixer. Fails
 * closed on the cos autonomy gate (only `execute` writes) + the daily budget.
 * Findings whose fix can't be anchored are skipped (never mis-applied). Emits
 * progress via `onProgress`. Returns `{ fixed, skipped, total }` or, when gated
 * off, `{ rejected: true, mode | reason }`.
 */
export async function runSeriesFix(seriesId, { commentIds, providerOverride, modelOverride, signal, onProgress = () => {} } = {}) {
  assertValidSeriesId(seriesId);
  // Autonomy gate — mirror the autopilot start route (fail closed).
  const { mode } = await getFixAvailability();
  if (mode !== 'execute') return { rejected: true, mode };
  const budget = await getDomainBudgetStatus('cos');
  if (!budget.withinBudget) return { rejected: true, reason: `daily cos ${budget.exceeded} budget reached` };

  const review = await getReview(seriesId).catch(() => ({ comments: [] }));
  let open = collectReviewFindings(review.comments);
  if (Array.isArray(commentIds) && commentIds.length) {
    const wanted = new Set(commentIds);
    open = open.filter((f) => wanted.has(f.commentId));
  }

  let fixed = 0;
  let skipped = 0;
  let budgetStopped = false;
  for (const f of open) {
    if (signal?.aborted) break;
    // Re-check the budget before each fix (each generate is one cos action).
    const b = await getDomainBudgetStatus('cos');
    if (!b.withinBudget) { budgetStopped = true; break; }
    onProgress({ type: 'fix:start', commentId: f.commentId, severity: f.severity, issueNumber: f.issueNumber });
    const gen = await generateManuscriptFix(seriesId, { commentId: f.commentId, providerOverride, modelOverride })
      .catch((err) => { console.error(`⚠️ series-fix generate failed — comment=${String(f.commentId).slice(0, 12)} ${err.message}`); return null; });
    await recordDomainUsage('cos', { actions: 1 });
    const fix = gen?.fix;
    const hasEdits = fix && ((Array.isArray(fix.edits) && fix.edits.length > 0) || (fix.find && typeof fix.replace === 'string'));
    if (!hasEdits) { skipped += 1; onProgress({ type: 'fix:skip', commentId: f.commentId, reason: 'no anchored fix' }); continue; }
    // acceptManuscriptFix throws when the anchor can't be located — treat as a
    // skip (never a mis-applied edit).
    const applied = await acceptManuscriptFix(seriesId, { commentId: f.commentId, find: fix.find, replace: fix.replace, edits: fix.edits })
      .catch((err) => { console.error(`⚠️ series-fix apply failed — comment=${String(f.commentId).slice(0, 12)} ${err.message}`); return null; });
    if (applied) { fixed += 1; onProgress({ type: 'fix:done', commentId: f.commentId }); }
    else { skipped += 1; onProgress({ type: 'fix:skip', commentId: f.commentId, reason: 'could not anchor' }); }
  }
  // Fixes accepted findings + rewrote manuscript sections, so the persisted
  // verdict is now stale — drop it so a reload can't re-surface (and re-fix) it.
  if (fixed > 0) await clearSnapshot(seriesId);
  console.log(`🔧 series fix — series=${seriesId.slice(0, 12)} fixed=${fixed} skipped=${skipped}/${open.length}${budgetStopped ? ' (budget-stopped)' : ''}`);
  return { fixed, skipped, total: open.length, budgetStopped };
}

// ---------------------------------------------------------------------------
// SSE runner (shared factory — mirrors checkRunner / editorialAnalysisRunner).
// ---------------------------------------------------------------------------

const runner = createSseRunner({ logLabel: 'series review' });

export function startSeriesReviewRun(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await runSeriesReview(seriesId, {
      feedback: options.feedback,
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      force: options.force,
      readinessGate: options.readinessGate,
      signal,
      onProgress: (event) => broadcast({ ...event, runId }),
    });
    if (record.cancelRequested || result === null) {
      broadcast({ type: 'canceled', runId, canceledAt: nowIso() });
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      verdict: result.verdict,
      findingCount: result.findingCount,
      completedAt: nowIso(),
    });
  });
}

export const attachClient = (seriesId, res) => runner.attachClient(seriesId, res);
export const isSeriesReviewActive = (seriesId) => runner.isActive(seriesId);
export const cancelSeriesReview = (seriesId) => runner.cancel(seriesId);

// Separate runner instance for the fix pass, so a review and a fix are tracked
// independently per series (distinct keys are the same seriesId, but distinct
// runner maps — a review SSE and a fix SSE never collide).
const fixRunner = createSseRunner({ logLabel: 'series fix' });

export function startSeriesFixRun(seriesId, options = {}) {
  return fixRunner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await runSeriesFix(seriesId, {
      commentIds: options.commentIds,
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      signal,
      onProgress: (event) => broadcast({ ...event, runId }),
    });
    if (result?.rejected) {
      broadcast({ type: 'rejected', runId, mode: result.mode || null, reason: result.reason || null, rejectedAt: nowIso() });
      return;
    }
    if (record.cancelRequested) {
      broadcast({ type: 'canceled', runId, canceledAt: nowIso() });
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      fixed: result.fixed,
      skipped: result.skipped,
      total: result.total,
      budgetStopped: result.budgetStopped === true,
      completedAt: nowIso(),
    });
  });
}

export const attachFixClient = (seriesId, res) => fixRunner.attachClient(seriesId, res);
export const isSeriesFixActive = (seriesId) => fixRunner.isActive(seriesId);
export const cancelSeriesFix = (seriesId) => fixRunner.cancel(seriesId);

export const __testing = { runs: runner.runs, fixRuns: fixRunner.runs };
