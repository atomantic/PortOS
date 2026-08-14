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
 * The foundation judge and canon readiness are kicked off at entry and awaited
 * just before the verdict, so they overlap the editorial-checks pass (#4108).
 * The only hard ordering constraint is the seed→read chain feedback-seed →
 * checks-seed → health/getReview, which stays strictly sequential.
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
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse, sha256Text } from '../../lib/fileUtils.js';
import { canonicalStringify } from '../../lib/objects.js';
import { createSseRunner } from '../../lib/sseUtils.js';
import { runStageScopedInlineLLM } from '../../lib/stageRunner.js';
import { getDomainMode } from '../../lib/domainAutonomy.js';
import { readReadinessGate, mergeSeverityWeights } from '../../lib/editorial/index.js';
import { loadState } from '../cosState.js';
import { getSettings } from '../settings.js';
import { getDomainBudgetStatus, recordDomainUsage } from '../domainUsage.js';
import { getUniverse } from '../universeBuilder.js';
import { getSeries, MANUSCRIPT_TYPES } from './series.js';
import { listIssues } from './issues.js';
import { judgeFoundation, foundationInputs, DEFAULT_FOUNDATION_THRESHOLD } from './foundationJudge.js';
import { runEditorialChecks } from './editorial/checkRunner.js';
import { getSeriesHealth, isOpenFinding, DEFAULT_READINESS_GATE } from './editorialScore.js';
import { checkSeriesCanonReadiness, canonDescriptionInputs } from './canonReadiness.js';
import { pickCanon } from './seriesCanon.js';
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

// ---------------------------------------------------------------------------
// Reviewed-source fingerprinting (#4111).
//
// The findingIds divergence below only notices findings being accepted/dismissed
// or appearing. It cannot see the manuscript being rewritten, canon being
// edited, or the foundation changing through some other path — so the stored
// verdict's foundation/canon/health dimensions could report old scores as
// current. Mirroring `foundationJudge`'s `sourceInputsHash` / `isFoundationStale`,
// a run pins a hash of everything it reviewed and the GET recomputes it.
// ---------------------------------------------------------------------------

// Separator for concatenated fields inside one fingerprint — a byte that can't
// occur in authored text, so two fields can't blur into each other. Mirrors
// checkRunner's per-finding fingerprinting.
const HASH_SEP = '\u0000';

/**
 * The manuscript text the editorial checks + canon readiness read, as a stable
 * projection: EVERY drafted manuscript stage per issue (not just the highest-
 * precedence one), each stage's input AND output hashed, so any authored edit
 * flips the fingerprint. Sorted by issue id so a listing re-order isn't an edit.
 * Pure.
 */
export function manuscriptInputs(issues) {
  return [...(Array.isArray(issues) ? issues : [])]
    .map((iss) => ({
      id: iss?.id || '',
      stages: Object.fromEntries(MANUSCRIPT_TYPES.map((sid) => {
        const stage = iss?.stages?.[sid];
        // NUL-joined so text moving across the input/output boundary can't hash identically.
        return [sid, sha256Text([stage?.input || '', stage?.output || ''].join(HASH_SEP))];
      })),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Everything this review reads, as a stable projection. Pure.
 *
 * - `foundation` reuses `foundationInputs` verbatim, so the review's staleness
 *   and the foundation judge's can never disagree about what the foundation is.
 * - `manuscript` is the drafted text the editorial checks and canon readiness
 *   grade — absent from the foundation projection (which only carries the `idea`
 *   synopsis), and the single biggest silent-drift source.
 * - `canon` is the descriptive text canon readiness grades. It overlaps the
 *   foundation projection but is NOT covered by it: a character's plain
 *   `description` (the fallback canon readiness grades on) is not a foundation
 *   field, so a description-only edit would otherwise go unnoticed.
 * - `scoring` carries inputs that change how a dimension SCORES rather than what
 *   it reads (the canon source text depends on `targetFormat`; health weights
 *   the open findings by `severityWeights`).
 */
export function seriesReviewInputs({ series, universe, issues } = {}) {
  const list = Array.isArray(issues) ? issues : [];
  return {
    foundation: foundationInputs(series, universe, list),
    manuscript: manuscriptInputs(list),
    canon: canonDescriptionInputs(pickCanon(universe)),
    scoring: {
      targetFormat: series?.targetFormat || '',
      severityWeights: series?.severityWeights ?? null,
    },
  };
}

// Key-sorted so the hash is stable across machines (a synced/imported record can
// re-order keys without being an edit). Mirrors checkRunner's fingerprinting.
export const seriesReviewInputsHash = (parts) => sha256Text(canonicalStringify(seriesReviewInputs(parts)));

/**
 * Whether a stored verdict's reviewed sources have drifted. A snapshot written
 * before this feature carries no hash — it can't be judged, so it is NOT flagged
 * (the findings divergence still applies). A snapshot that HAS a hash we could
 * not recompute (`currentHash` null — the series/universe/issues were unreadable)
 * IS flagged: the verdict is unverifiable, and failing closed matches how the
 * review's own verdict treats a dimension it couldn't evaluate. Pure.
 */
export function isSeriesReviewSourceStale(snapshot, currentHash) {
  if (!snapshot?.sourceInputsHash) return false;
  if (!currentHash) return true;
  return snapshot.sourceInputsHash !== currentHash;
}

/**
 * Whether the live open-finding set has diverged from the one a stored verdict
 * was computed from — findings accepted/dismissed (e.g. via a "Fix here" link)
 * or new findings appearing. Falls back to the snapshot's embedded findings for
 * a snapshot written before `findingIds` existed. Pure.
 */
export function isSeriesReviewFindingsStale(snapshot, liveFindingIds) {
  const live = liveFindingIds instanceof Set ? liveFindingIds : new Set(liveFindingIds || []);
  const snapshotIds = Array.isArray(snapshot?.findingIds)
    ? snapshot.findingIds
    : (snapshot?.findings || []).map((f) => f?.commentId).filter(Boolean);
  return snapshotIds.length !== live.size || snapshotIds.some((id) => !live.has(id));
}

/**
 * Resolve the CURRENT reviewed-source hash for a series. Returns null when the
 * inputs can't be fully read — never a hash computed from a partial read, which
 * would silently report a changed foundation as unchanged.
 *
 * Pass the records the caller already holds to skip the re-read. Each is read
 * here ONLY when the caller omitted it (`undefined`): an explicit `null` is the
 * caller reporting its own read FAILED, and re-reading it here would hash a
 * source the verdict was never computed from.
 */
async function resolveSourceInputsHash(seriesId, { series, issues } = {}) {
  const ser = series === undefined ? await getSeries(seriesId).catch(() => null) : series;
  if (!ser) return null;
  const list = issues === undefined ? await listIssues({ seriesId }).catch(() => null) : issues;
  if (!list) return null;
  // `undefined` = a linked universe we failed to read (distinct from `null` = no
  // linked universe at all). Hashing the failed read as "unlinked" would produce
  // a fresh-looking hash for a world we never saw.
  const universe = ser.universeId ? await getUniverse(ser.universeId).catch(() => undefined) : null;
  if (universe === undefined) return null;
  return seriesReviewInputsHash({ series: ser, universe, issues: list });
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
  // Already canceled before we started — bail before spending an LLM round-trip
  // on a run whose verdict would be discarded anyway.
  if (signal?.aborted) return null;
  // Three independent reads — resolve concurrently.
  // `issuesRead` keeps `null` = the read FAILED distinct from `[]` = the series
  // genuinely has no issues: the composition below is happy with an empty list,
  // but the source fingerprint must not pin a hash computed from a failed read.
  const [series, settings, issuesRead] = await Promise.all([
    getSeries(seriesId),
    getSettings().catch(() => null),
    listIssues({ seriesId }).catch(() => null),
  ]);
  const issues = issuesRead || [];
  const gate = readinessGate || readReadinessGate(settings) || DEFAULT_READINESS_GATE;
  const weights = mergeSeverityWeights(series?.severityWeights);

  const aborted = () => signal?.aborted;

  // The ONLY hard ordering constraint in this flow is the seed→read chain:
  // feedback-seed → checks-seed → health/getReview (both of which read the store
  // the first two write). The foundation judge writes only its own snapshot and
  // canon readiness is deterministic + store-independent, so both are kicked off
  // here at entry and awaited just before the verdict — overlapping the full
  // foundation LLM round-trip with the editorial-checks pass instead of running
  // before/after it (#4108).
  //
  // Each background pass owns its own `step:start`/`step:complete` frames and
  // swallows its own failure, so it resolves to `{ value, failed }` and never
  // rejects on the normal path. `kickOff` still attaches a no-op catch the
  // instant the promise exists, so an unexpected throw (e.g. from the caller's
  // `onProgress`) can't surface as an unhandled rejection when an early cancel
  // returns before the `await`.
  const kickOff = (fn) => { const p = fn(); p.catch(() => {}); return p; };

  const foundationTask = kickOff(async () => {
    // Foundation judge (holistic pre-draft quality — catches "looks complete but
    // no development"). A throw is a genuine failure (judgeFoundation otherwise
    // always returns a snapshot), not an absent-but-fine result — record it so
    // the verdict fails closed.
    onProgress({ type: 'step:start', kind: 'foundation' });
    let failed = false;
    const value = await judgeFoundation(seriesId, { providerId: providerOverride, model: modelOverride, force })
      .catch((err) => { console.error(`⚠️ series-review foundation judge failed — series=${seriesId.slice(0, 12)} ${err.message}`); failed = true; return null; });
    onProgress({ type: 'step:complete', kind: 'foundation', weightedScore: value?.weightedScore ?? null, failed });
    return { value, failed };
  });

  const canonTask = kickOff(async () => {
    // Canon readiness (deterministic — no LLM). A throw is a genuine failure —
    // record it so the verdict fails closed rather than treating the missing
    // result as "canon fine".
    onProgress({ type: 'step:start', kind: 'canon' });
    let failed = false;
    const value = await checkSeriesCanonReadiness(seriesId)
      .catch((err) => { console.error(`⚠️ series-review canon readiness failed — series=${seriesId.slice(0, 12)} ${err.message}`); failed = true; return null; });
    // `failed` must gate `ready`: on a throw `value` is null, and a bare
    // `value?.ready !== false` would announce `ready: true` for a pass that never
    // produced a result. Mirrors how the verdict fails closed on the same signal.
    onProgress({ type: 'step:complete', kind: 'canon', ready: !failed && value?.ready !== false, failed });
    return { value, failed };
  });

  // A canceled run still settles the background passes before returning, so their
  // progress frames can never land after the SSE wrapper's `canceled` frame.
  const canceledResult = async () => { await Promise.allSettled([foundationTask, canonTask]); return null; };

  // 1. Optional free-text feedback → anchored finding (before the checks pass so
  //    it merges into the same review the verdict reads).
  if (feedback && String(feedback).trim()) {
    onProgress({ type: 'step:start', kind: 'feedback' });
    await routeFeedbackToFinding(seriesId, feedback, { providerOverride, modelOverride, issues })
      .catch((err) => { console.error(`⚠️ series-review feedback seed failed — series=${seriesId.slice(0, 12)} ${err.message}`); });
    onProgress({ type: 'step:complete', kind: 'feedback' });
    if (aborted()) return canceledResult();
  }

  // 2. Editorial checks — registry-driven review; seeds the shared review store.
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
  }).catch((err) => { console.error(`⚠️ series-review editorial checks failed — series=${seriesId.slice(0, 12)} ${err.message}`); checksRunFailed = true; return { findings: [], perCheck: [], canceled: false }; });
  // A single check that threw (e.g. an unavailable LLM provider) is caught
  // internally by the runner and surfaced in perCheck as `{ checkId, error }` —
  // that dimension was never evaluated, so it too must block a 'ready' verdict.
  const erroredCheckIds = (Array.isArray(checks?.perCheck) ? checks.perCheck : [])
    .filter((p) => p && p.error).map((p) => p.checkId);
  const checksErrored = erroredCheckIds.length;
  onProgress({ type: 'step:complete', kind: 'editorialChecks', findingCount: checks?.findings?.length ?? 0, errored: checksErrored, failed: checksRunFailed });
  if (aborted() || checks?.canceled) return canceledResult();

  // 3. Health + readiness + the seeded findings — both only READ the store the
  //    checks just seeded, so resolve them concurrently.
  onProgress({ type: 'step:start', kind: 'health' });
  const [health, review] = await Promise.all([
    getSeriesHealth(seriesId, { gate, weights }).catch(() => null),
    getReview(seriesId).catch(() => ({ comments: [] })),
  ]);
  onProgress({ type: 'step:complete', kind: 'health', ready: health?.ready === true, score: health?.score ?? null });
  const findings = collectReviewFindings(review?.comments);

  // 4. Join the background passes. Both resolve (never reject) with their own
  //    failure flag, so the failed-stage list is assembled here in ONE place and
  //    keeps a deterministic order regardless of which pass settled first.
  const [foundationRes, canonRes] = await Promise.all([foundationTask, canonTask]);
  const foundation = foundationRes.value;
  const canon = canonRes.value;
  // Stages that errored / never ran this pass — any of these makes the verdict
  // untrustworthy, so it must never read 'ready' (fail closed). Surfaced on the
  // result so the UI can warn the review is incomplete.
  const failedStages = [];
  if (foundationRes.failed) failedStages.push('foundation');
  if (checksRunFailed) failedStages.push('editorialChecks');
  if (canonRes.failed) failedStages.push('canon');
  if (!health) failedStages.push('health');
  const threshold = Number.isFinite(settings?.pipelineEditorialChecks?.foundationThreshold)
    ? settings.pipelineEditorialChecks.foundationThreshold
    : DEFAULT_FOUNDATION_THRESHOLD;
  // The review is incomplete when ANY dimension errored/never-ran OR an
  // individual check errored — the verdict then fails closed (never 'ready').
  const incomplete = failedStages.length > 0 || checksErrored > 0;
  const verdict = computeReviewVerdict({ health, foundation, canon, threshold, incomplete });
  // Pin what this verdict was computed FROM. The review performs no manuscript
  // writes, so the records read at entry are still the ones it reviewed.
  const sourceInputsHash = await resolveSourceInputsHash(seriesId, { series, issues: issuesRead });

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
    // The open-finding comment ids this verdict was computed from — so a later
    // GET can detect that the review is stale (findings were accepted/dismissed,
    // e.g. via a "Fix here" link) without re-running.
    findingIds: findings.map((f) => f.commentId),
    // A fingerprint of everything this verdict was computed FROM (manuscript,
    // canon, foundation inputs), so a later GET can detect that the reviewed
    // sources changed — not just the findings store (#4111). Null when the
    // inputs couldn't be fully read; a null hash is never flagged stale.
    sourceInputsHash,
    hadFeedback: !!(feedback && String(feedback).trim()),
  };
  // Don't persist (or return) a verdict for a run the user canceled mid-flight —
  // the SSE wrapper will broadcast `canceled`, and a reload must not restore a
  // verdict from a run that never finished.
  if (aborted()) return null;
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
 *
 * Stamps a `stale` flag when the stored verdict no longer describes the series,
 * from two independent signals, plus a `staleReason` naming which fired:
 *
 *  - `findings` — the live open-finding set no longer matches the snapshot's
 *    `findingIds` (findings accepted/dismissed via a "Fix here" link, or new
 *    ones appeared).
 *  - `sources` — the reviewed sources themselves drifted: the manuscript was
 *    edited, canon changed, or a foundation input moved (#4111). Without this,
 *    the verdict's foundation/canon/health dimensions could keep reporting old
 *    scores as current after a direct manuscript edit.
 *  - `both` — both fired.
 */
export async function getSeriesReview(seriesId) {
  assertValidSeriesId(seriesId);
  const content = await tryReadFile(snapshotPath(seriesId));
  const verdict = content === null
    ? null
    : safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
  const [fix, review, currentHash] = await Promise.all([
    getFixAvailability(),
    // `null` = the findings store couldn't be read (distinct from a store with no
    // open findings). Collapsing the two would read as "every pinned finding was
    // resolved" and falsely flag the verdict stale on a transient read failure.
    verdict ? getReview(seriesId).catch(() => null) : Promise.resolve(null),
    // Only worth the reads when there IS a snapshot to judge, and only when that
    // snapshot carries a hash (a pre-#4111 snapshot can't be judged this way).
    verdict?.sourceInputsHash ? resolveSourceInputsHash(seriesId) : Promise.resolve(null),
  ]);
  if (verdict) {
    const liveOpen = new Set(collectReviewFindings(review?.comments).map((f) => f.commentId));
    const reasons = [
      review && isSeriesReviewFindingsStale(verdict, liveOpen) && 'findings',
      isSeriesReviewSourceStale(verdict, currentHash) && 'sources',
    ].filter(Boolean);
    verdict.stale = reasons.length > 0;
    verdict.staleReason = reasons.length > 1 ? 'both' : (reasons[0] || null);
  }
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

/**
 * Identity of a review kickoff: what the run would actually do. Two starts with
 * the same signature produce the same verdict, so the second can safely attach
 * to the first's in-flight run (a reload/remount re-attaching to its own
 * request). A DIFFERENT signature would review with a different note, provider,
 * or gate — attaching to the running one would silently drop those options and
 * report its verdict as this request's, so the factory reports a `conflict`
 * instead (#4113). Pure.
 *
 * `feedback` is trimmed to match the service's own `feedback && trim()` gate, so
 * a blank note and an absent one are the same work.
 */
export function seriesReviewRequestSig({ feedback, providerOverride, modelOverride, force, readinessGate } = {}) {
  return JSON.stringify({
    feedback: String(feedback ?? '').trim() || null,
    providerOverride: providerOverride ?? null,
    modelOverride: modelOverride ?? null,
    force: !!force,
    readinessGate: readinessGate ?? null,
  });
}

export function startSeriesReviewRun(seriesId, options = {}) {
  // A second start while a review is in flight coalesces ONLY when it would run
  // the same review; a divergent one gets `{ alreadyRunning: true, conflict:
  // true }` so the caller can surface it rather than lose its options.
  const sig = seriesReviewRequestSig(options);
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
  }, { sig });
}

export const attachClient = (seriesId, res) => runner.attachClient(seriesId, res);
export const isSeriesReviewActive = (seriesId) => runner.isActive(seriesId);
export const cancelSeriesReview = (seriesId) => runner.cancel(seriesId);

// Separate runner instance for the fix pass, so a review and a fix are tracked
// independently per series (distinct keys are the same seriesId, but distinct
// runner maps — a review SSE and a fix SSE never collide).
const fixRunner = createSseRunner({ logLabel: 'series fix' });

/**
 * Identity of a fix kickoff. Same contract as `seriesReviewRequestSig`, and the
 * stakes are higher: the fix path WRITES the manuscript, so a start scoped to a
 * different finding set must never bind onto the in-flight run and report its
 * `fixed/skipped` totals as its own. `commentIds` is sorted (and deduped) so the
 * same finding set in a different order is the same work; absent/empty both mean
 * "every open finding", which is what `runSeriesFix` does with either. Pure.
 */
export function seriesFixRequestSig({ commentIds, providerOverride, modelOverride } = {}) {
  const ids = Array.isArray(commentIds) && commentIds.length ? [...new Set(commentIds)].sort() : null;
  return JSON.stringify({
    commentIds: ids,
    providerOverride: providerOverride ?? null,
    modelOverride: modelOverride ?? null,
  });
}

export function startSeriesFixRun(seriesId, options = {}) {
  const sig = seriesFixRequestSig(options);
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
  }, { sig });
}

export const attachFixClient = (seriesId, res) => fixRunner.attachClient(seriesId, res);
export const isSeriesFixActive = (seriesId) => fixRunner.isActive(seriesId);
export const cancelSeriesFix = (seriesId) => fixRunner.cancel(seriesId);

export const __testing = { runs: runner.runs, fixRuns: fixRunner.runs };
