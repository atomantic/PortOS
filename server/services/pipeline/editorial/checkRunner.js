/**
 * Pipeline — Editorial Check Runner (#1284).
 *
 * Loads the enabled editorial checks (+ per-check config) from settings, builds
 * the shared `ctx` once (series, issues, universe canon, stitched manuscript),
 * runs each check, and seeds the resulting findings into the existing
 * `manuscriptReview` store — each finding stamped with its `checkId` so the
 * editor groups/filters by check and a dismissal stays suppressed per-check.
 *
 * Deterministic checks run inline; LLM checks reuse the staged-LLM provider
 * plumbing via the `ctx.callStagedLLM` injected here (the registry stays pure).
 *
 * The SSE wrapper at the bottom mirrors manuscriptCompletenessRunner.js: a
 * single in-memory `runs` map keyed by seriesId, terminal-frame replay for
 * late-connecting clients via lib/sseUtils.js.
 */

import { randomUUID, createHash } from 'crypto';
import { createSseRunner } from '../../../lib/sseUtils.js';
import { runStagedLLM } from '../../../lib/stageRunner.js';
import { getEnabledChecks, getEnabledCheckRows, getCheck } from '../../../lib/editorial/index.js';
import { getSettings } from '../../settings.js';
import { getSeries } from '../series.js';
import { listIssues } from '../issues.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus } from '../arcPlanner.js';
import { seedReviewFromFindings, getReview } from '../manuscriptReview.js';
import { canonicalStringify } from '../../../lib/objects.js';

// Source-content fingerprinting for finding staleness (#1345). Each finding is
// stamped with a hash of the exact content its check analyzed; the manuscript
// editor / triage view flags a finding `stale` once that content drifts.
//
// Two segments cover the inputs the checks actually read: a manuscript-consuming
// check (`needsManuscript`) hashes the stitched corpus + canon + style guide; a
// canon-only check hashes canon + the arc's ticking clock — so a canon-only
// finding (naming, object-attachment, ticking-clock) doesn't go stale on a pure
// prose edit, and a manuscript finding doesn't go stale on a ticking-clock edit.
// `canonicalStringify` (key-sorted) keeps the hash stable across machines so a
// synced finding isn't falsely flagged stale after an import re-orders keys.
//
// NOTE: the input set is derived from `needsManuscript` + a fixed series field
// set, NOT a per-check source declaration — so editing the style guide or ticking
// clock marks ALL findings in that segment stale, not only the checks that read
// it. That over-flag is the deliberate SAFE direction (never under-flag): a check
// added later that reads `styleGuide` still auto-stales, whereas a per-check
// allow-list would silently false-fresh it. Precise-and-safe scoping via declared
// per-check sources is tracked in #1387. NUL separates the segments so they can't
// run together ambiguously.
const HASH_SEP = '\u0000';
const sha256 = (text) => createHash('sha256').update(text || '').digest('hex');
function computeSourceHashes(manuscript, canon, series) {
  const canonStr = canonicalStringify(canon ?? null);
  const styleGuide = canonicalStringify(series?.styleGuide ?? null);
  const tickingClock = canonicalStringify(series?.arc?.tickingClock ?? null);
  return {
    // Manuscript checks (style.reading-level / style.conformance + the prose/object
    // LLM checks) read the corpus + canon + style guide.
    withManuscript: sha256([manuscript || '', canonStr, styleGuide].join(HASH_SEP)),
    // Canon-only checks read canon; arc.ticking-clock-hygiene also reads the arc's
    // ticking clock (folded in here since it's the only non-canon input they consult).
    canonOnly: sha256([canonStr, tickingClock].join(HASH_SEP)),
  };
}
const hashForCheck = (hashes, needsManuscript) => (needsManuscript ? hashes.withManuscript : hashes.canonOnly);

/**
 * Run the enabled editorial checks for a series and seed their findings into the
 * manuscript review.
 *
 * @param {string} seriesId
 * @param {object} [options]
 *   - checkIds: string[] — run only this subset (default: all enabled)
 *   - settings: object — pre-loaded settings (default: read fresh)
 *   - providerOverride / modelOverride — forwarded to LLM checks
 *   - signal: AbortSignal — checked between checks for cancellation
 *   - onProgress: (event) => void — { type: 'check:start'|'check:complete', ... }
 * @returns {Promise<{ runId, findings, perCheck, canceled }>}
 */
export async function runEditorialChecks(seriesId, options = {}) {
  const { checkIds = null, providerOverride, modelOverride, signal, onProgress } = options;
  const settings = options.settings || await getSettings();
  const enabled = getEnabledChecks(settings, checkIds);

  const runId = randomUUID();
  if (enabled.length === 0) {
    return { runId, findings: [], perCheck: [], canceled: false };
  }

  // Build the shared context once — every check reads from this. Only pay the
  // manuscript section-collection I/O when an enabled check actually consumes
  // the stitched corpus (deterministic checks like naming use only the canon).
  const series = await getSeries(seriesId);
  const needsManuscript = enabled.some(({ check }) => check.needsManuscript);
  const [sections, canon, issues] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    listIssues({ seriesId }).catch(() => []),
  ]);
  const manuscript = sectionsCorpus(sections);
  // Fingerprint the analyzed content once per run — stamped onto every finding
  // below so the editor can flag it `stale` when the manuscript/canon/series-meta drifts (#1345).
  const sourceHashes = computeSourceHashes(manuscript, canon, series);
  const baseCtx = {
    seriesId,
    series,
    issues,
    sections,
    manuscript,
    canon,
    providerOverride,
    modelOverride,
    // Injected LLM caller — keeps server/lib/editorial pure. Forwards the
    // provider/model overrides so an LLM check honors the autopilot's choice.
    callStagedLLM: (stage, vars, opts = {}) =>
      runStagedLLM(stage, vars, { providerOverride, modelOverride, ...opts }),
  };

  const findings = [];
  const perCheck = [];
  let canceled = false;
  for (const { check, config } of enabled) {
    if (signal?.aborted) { canceled = true; break; }
    onProgress?.({ type: 'check:start', checkId: check.id, label: check.label });
    const ctx = { ...baseCtx, config, severityDefault: check.severityDefault };
    // Boundary try/catch: a check's run() calls into arbitrary logic / LLM
    // providers — one bad check must not abort the whole pass (mirrors the
    // per-comment fix guard in seriesAutopilot.runEditorial).
    try {
      if (typeof check.gate === 'function' && !check.gate(ctx)) {
        perCheck.push({ checkId: check.id, count: 0, skipped: true });
        onProgress?.({ type: 'check:complete', checkId: check.id, count: 0, skipped: true });
        continue;
      }
      const raw = (await check.run(ctx)) || [];
      const sourceContentHash = hashForCheck(sourceHashes, !!check.needsManuscript);
      const stamped = raw.map((f) => ({ ...f, checkId: check.id, sourceContentHash }));
      findings.push(...stamped);
      perCheck.push({ checkId: check.id, count: stamped.length });
      onProgress?.({ type: 'check:complete', checkId: check.id, count: stamped.length });
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 500);
      console.error(`❌ editorial check ${check.id} failed — series=${String(seriesId).slice(0, 12)} ${message}`);
      perCheck.push({ checkId: check.id, error: message });
      onProgress?.({ type: 'check:complete', checkId: check.id, error: message });
    }
    // Re-check AFTER the (possibly long-running LLM) check so a cancellation
    // during the final check is caught before the seed below — otherwise a
    // cancel mid-run would still persist the partial findings.
    if (signal?.aborted) { canceled = true; break; }
  }

  // Seed in 'merge' mode (never 'fresh'): a per-series seed of only the editorial
  // checks' findings must not auto-dismiss completeness or other-check open
  // comments. Merge dedups via findingKey (which now includes checkId) and keeps
  // dismissed findings suppressed per-check. Skip entirely on cancellation — a
  // canceled run emits a `canceled` terminal event and must not mutate the
  // review with partial findings collected before the abort.
  if (findings.length && !canceled) {
    await seedReviewFromFindings(seriesId, findings, { runId, mode: 'merge' });
  }
  return { runId, findings, perCheck, canceled };
}

/**
 * Dry-run preview: which checks would run for the current settings (+ optional
 * subset), without executing them. Used by the run route's plan response and by
 * callers that want to show the user what's enabled.
 */
export async function buildEditorialCheckPlan(seriesId, { checkIds = null, settings } = {}) {
  const resolved = settings || await getSettings();
  const checks = getEnabledCheckRows(resolved, checkIds)
    .map((row) => ({ id: row.id, label: row.label, kind: row.kind, scope: row.scope }));
  return { seriesId, checks, enabledCount: checks.length };
}

/**
 * Read the manuscript review and annotate each editorial-check finding with a
 * `stale` flag (#1345): true when the content the check analyzed has changed
 * since the finding was seeded. Mirrors `editorialAnalysis.isSnapshotStale` —
 * recompute the current source hash and compare against the one stamped on the
 * finding. Findings without a `sourceContentHash` (completeness-pass comments,
 * older peers, legacy records) or whose check is no longer registered are left
 * unannotated → the UI treats absent `stale` as not-stale.
 *
 * Staleness is derived per-read (never stored), so it stays local to each
 * install's current content and never rides the synced review document.
 */
export async function getReviewWithStaleness(seriesId) {
  const review = await getReview(seriesId);
  // Only recompute hashes when there's at least one hash-stamped finding from a
  // still-registered check — a pure completeness review pays no extra I/O.
  const evaluable = review.comments.filter((c) => c.checkId && c.sourceContentHash && getCheck(c.checkId));
  if (!evaluable.length) return review;
  const needsManuscript = evaluable.some((c) => getCheck(c.checkId).needsManuscript);
  const series = await getSeries(seriesId);
  const [sections, canon] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
  ]);
  const sourceHashes = computeSourceHashes(sectionsCorpus(sections), canon, series);
  return {
    ...review,
    comments: review.comments.map((c) => {
      const check = c.checkId && c.sourceContentHash ? getCheck(c.checkId) : null;
      if (!check) return c;
      const current = hashForCheck(sourceHashes, !!check.needsManuscript);
      return { ...c, stale: c.sourceContentHash !== current };
    }),
  };
}

// ---------------------------------------------------------------------------
// SSE run-tracking — shared lifecycle via createSseRunner (server/lib/sseUtils.js),
// the same factory backing manuscriptCompletenessRunner + editorialAnalysisRunner.
// ---------------------------------------------------------------------------

const runner = createSseRunner({ logLabel: 'editorial checks' });

export function isEditorialChecksActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelEditorialChecks(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off a streamed editorial-checks run. Returns the runId immediately;
 * progress lands via SSE. Re-calling while a run is in flight resolves to the
 * existing runId.
 */
export function startEditorialChecksRun(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await runEditorialChecks(seriesId, {
      checkIds: options.checkIds,
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      signal,
      onProgress: (event) => broadcast({ ...event, runId }),
    });
    if (record.cancelRequested || result.canceled) {
      broadcast({ type: 'canceled', runId, canceledAt: new Date().toISOString() });
      console.log(`📝 editorial checks canceled — series=${String(seriesId).slice(0, 12)}`);
      return;
    }
    broadcast({
      type: 'complete',
      runId,
      findingCount: result.findings.length,
      perCheck: result.perCheck,
      completedAt: new Date().toISOString(),
    });
    console.log(`📝 editorial checks complete — series=${String(seriesId).slice(0, 12)} findings=${result.findings.length}`);
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
