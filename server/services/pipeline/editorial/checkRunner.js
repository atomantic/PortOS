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
import { runStagedLLM, runInlineLLM, runStageScopedInlineLLM, resolveStageContext } from '../../../lib/stageRunner.js';
import { planManuscriptPass } from '../../../lib/contextBudget.js';
import { getEnabledChecks, getEnabledCheckRows, getAllChecks, EDITORIAL_SOURCES } from '../../../lib/editorial/index.js';
import { getSettings } from '../../settings.js';
import { getSeries } from '../series.js';
import { listIssues } from '../issues.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus, manuscriptSectionHeader } from '../arcPlanner.js';
import { getReverseOutline } from '../reverseOutline.js';
import { getSeriesEditorial } from '../editorialAnalysis.js';
import { seedReviewFromFindings, getReview } from '../manuscriptReview.js';
import { canonicalStringify } from '../../../lib/objects.js';

// Source-content fingerprinting for finding staleness (#1345, #1387). Each finding
// is stamped with a hash of the exact content its check analyzed; the manuscript
// editor / triage view flags a finding `stale` once that content drifts.
//
// Per-check declared sources (#1387): a check declares the inputs its run() reads
// via `check.sources` (a subset of EDITORIAL_SOURCES), and we fingerprint EXACTLY
// those — so a naming finding (sources: ['canon']) doesn't go stale on a prose or
// style-guide edit, and editing the ticking clock stales only the
// arc.ticking-clock-hygiene finding (sources: ['series.arc.tickingClock']) instead
// of every canon-only finding. This replaces the prior two-segment heuristic
// (manuscript-vs-canon) that over-flagged because it folded the style guide +
// ticking clock into shared segments.
//
// `SOURCE_RESOLVERS` maps each declared token to the exact content hashed.
// `canonicalStringify` (key-sorted) keeps the hash stable across machines so a
// synced finding isn't falsely flagged stale after an import re-orders keys. A
// load-time guard asserts every EDITORIAL_SOURCES token has a resolver here — a
// token with no resolver would silently contribute nothing (false-fresh).
const HASH_SEP = '\u0000';
const sha256 = (text) => createHash('sha256').update(text || '').digest('hex');
const SOURCE_RESOLVERS = {
  manuscript: ({ manuscript }) => manuscript || '',
  canon: ({ canon }) => canonicalStringify(canon ?? null),
  'series.styleGuide': ({ series }) => canonicalStringify(series?.styleGuide ?? null),
  'series.arc.tickingClock': ({ series }) => canonicalStringify(series?.arc?.tickingClock ?? null),
  // The authored reader-map hooks/payoffs the Chekhov check reconciles against (#1299).
  'series.arc.readerMap': ({ series }) => canonicalStringify(series?.arc?.readerMap ?? null),
  // The reverse-outline scenes the check reads (#1296). Fingerprinting the whole
  // scenes array is intentionally over-eager (any scene edit stales a finding)
  // rather than under: safe vs. false-fresh, and the check reads several scene fields.
  reverseOutline: ({ reverseOutline }) => canonicalStringify(reverseOutline ?? null),
  // The reverse-outline PLOTLINES the plot-structure check reconciles dropped
  // subplots against (#1310). Separate token from `reverseOutline` so a scene
  // edit that doesn't touch the plotline list doesn't needlessly stale a
  // plotline-only finding (and vice-versa) — same over-eager-but-safe policy.
  'reverseOutline.plotlines': ({ reverseOutlinePlotlines }) =>
    canonicalStringify(reverseOutlinePlotlines ?? null),
  // The detected per-character arc directions a POV check reads (#1295). The
  // injected `editorialArcs` is the stable projection (name/arcDirection/issueCount/
  // isProtagonist) — NOT the raw getSeriesEditorial output, which carries a
  // per-call `generatedAt` timestamp that would re-stale every finding each run.
  // The `complete` flag is folded in too: a prose edit that stales the analysis
  // (without re-running it) leaves the projection byte-identical but flips
  // completeness, and pov.justified's "absent from arcs" finding depends on that
  // flag — so a finding must go stale when it changes, not only when the arcs do.
  editorialArcs: ({ editorialArcs, editorialArcsComplete }) =>
    canonicalStringify({ arcs: editorialArcs ?? null, complete: editorialArcsComplete === true }),
  // The AUTHORED per-character story arcs the arc.transitions check reconciles
  // against (#1293). Lives on the already-loaded series record, so no extra I/O
  // — fingerprint the whole array so any arc/transition edit stales the findings.
  'series.characterArcs': ({ series }) => canonicalStringify(series?.characterArcs ?? null),
};

// Stable projection of the series editorial aggregate down to the arc fields a
// POV/arc check reads — drops the volatile `generatedAt` (and the rest) so the
// staleness fingerprint only moves when a character's detected arc actually does.
function projectEditorialArcs(editorial) {
  const chars = Array.isArray(editorial?.characters) ? editorial.characters : [];
  return chars.map((c) => ({
    name: c?.name || '',
    arcDirection: c?.arcDirection || 'flat',
    issueCount: Number.isFinite(c?.issueCount) ? c.issueCount : 0,
    isProtagonist: c?.isProtagonist === true,
  }));
}

// True only when every analyzable issue has a fresh, complete analysis — the
// signal pov.justified uses to tell "absent because arc-less" from "absent
// because not-yet-analyzed" (#1295). Injected into ctx for the check AND folded
// into the editorialArcs fingerprint above so a prose edit that stales coverage
// (without changing the arc projection) still stales the POV findings.
function editorialCoverageComplete(editorial) {
  const cov = editorial?.coverage;
  return !!cov && cov.withContent > 0 && cov.analyzed >= cov.withContent && (cov.stale || 0) === 0;
}
for (const token of EDITORIAL_SOURCES) {
  if (typeof SOURCE_RESOLVERS[token] !== 'function') {
    throw new Error(`checkRunner: editorial source "${token}" has no fingerprint resolver — keep SOURCE_RESOLVERS in sync with EDITORIAL_SOURCES`);
  }
}

// A check's declared sources, falling back to the legacy needsManuscript heuristic
// for any check synthesized before the declaration existed (e.g. an older custom
// check). Unknown tokens are dropped so a typo can't corrupt the hash.
function checkSources(check) {
  const declared = Array.isArray(check?.sources) && check.sources.length
    ? check.sources
    : (check?.needsManuscript ? ['manuscript', 'canon'] : ['canon']);
  return declared.filter((token) => SOURCE_RESOLVERS[token]);
}

// Resolve every source token's content ONCE for a given inputs object
// (`{ manuscript, canon, series }`), so fingerprinting many checks/comments doesn't
// re-stringify the canon per call. Returns a token→string map the fingerprint reads.
function resolveSources(inputs) {
  const resolved = {};
  for (const token of EDITORIAL_SOURCES) resolved[token] = SOURCE_RESOLVERS[token](inputs);
  return resolved;
}

// Fingerprint exactly the inputs a check reads, from a pre-resolved token→content
// map (see `resolveSources`). Tokens are de-duped and sorted so the hash is
// independent of declaration order; each segment is prefixed with its token so two
// source sets can't collide on equal content. NUL joins segments (it can't appear
// in the JSON the resolvers emit) so they can't run together ambiguously.
function fingerprintForCheck(check, resolved) {
  const segments = [...new Set(checkSources(check))]
    .sort()
    .map((token) => `${token}=${resolved[token]}`);
  // A custom check's run logic IS its authored prompt (user data, not code), so a
  // prompt edit must stale its prior findings even when the manuscript is unchanged
  // — fold it into the fingerprint. Built-in checks' logic lives in code (a code
  // change isn't user content and isn't fingerprinted), so only their declared
  // content sources matter. (#1346, #1387)
  if (check?.isCustom && typeof check.prompt === 'string') {
    segments.push(`definition=${check.prompt}`);
  }
  return sha256(segments.join(HASH_SEP));
}

// Output room reserved for an editorial check's findings JSON. Sized for the
// editorial output (a bounded findings list — far smaller than the completeness
// pass's full-page rewrites), NOT the 8_000-token contextBudget default: that
// default exceeds the 8_192-token fallback window, so inheriting it would drive
// the usable input budget to 0 on an unknown/small local provider — the exact
// case this chunking targets — and silently feed the model an empty manuscript.
const EDITORIAL_OUTPUT_RESERVE_TOKENS = 2_000;

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
  // Reverse-outline fetch is gated on the declared source (#1296) so a run with no
  // scene-segmentation check pays no extra I/O — mirrors the needsManuscript gate.
  // Either the scenes (`reverseOutline`) OR the plotline list (`reverseOutline.plotlines`,
  // #1310) is served by the same single outline fetch.
  const needsReverseOutline = enabled.some(({ check }) => {
    const sources = checkSources(check);
    return sources.includes('reverseOutline') || sources.includes('reverseOutline.plotlines');
  });
  // Editorial-arc fetch is gated on the declared source (#1295) so a run with no
  // POV/arc check pays no extra snapshot I/O — mirrors the needsReverseOutline gate.
  const needsEditorialArcs = enabled.some(({ check }) => checkSources(check).includes('editorialArcs'));
  const [sections, canon, issues, outline, editorial] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    listIssues({ seriesId }).catch(() => []),
    needsReverseOutline ? getReverseOutline(seriesId).catch(() => null) : Promise.resolve(null),
    // Reuse the already-loaded series so the aggregate skips a redundant getSeries.
    // (issues is fetched in this same Promise.all, so it can't be passed here —
    // it's still in the temporal dead zone — and stays an internal fetch.)
    needsEditorialArcs ? getSeriesEditorial(seriesId, { series }).catch(() => null) : Promise.resolve(null),
  ]);
  const manuscript = sectionsCorpus(sections);
  const reverseOutline = Array.isArray(outline?.scenes) ? outline.scenes : [];
  // The outline's plotline list (#1310) — injected separately from the scenes so a
  // plotline-reading check (plot.structure-momentum) can reconcile dropped subplots
  // against the author's tagged threads.
  const reverseOutlinePlotlines = Array.isArray(outline?.plotlines) ? outline.plotlines : [];
  const editorialArcs = projectEditorialArcs(editorial);
  // Whether every analyzable issue has been analyzed and is fresh — gates the
  // pov.justified "absent from detected arcs" finding so a partially-analyzed
  // series (canceled/early-stopped batch) doesn't flag a not-yet-analyzed POV
  // holder as arc-less (#1295). Folded into the editorialArcs fingerprint below.
  const editorialArcsComplete = editorialCoverageComplete(editorial);
  // Resolve every source token once — each finding's fingerprint reads from this
  // so the editor flags it `stale` when the content that check actually read (its
  // declared `sources`) drifts (#1345, #1387).
  const resolvedSources = resolveSources({ manuscript, canon, series, reverseOutline, reverseOutlinePlotlines, editorialArcs, editorialArcsComplete });
  const baseCtx = {
    seriesId,
    series,
    issues,
    sections,
    manuscript,
    reverseOutline,
    reverseOutlinePlotlines,
    editorialArcs,
    editorialArcsComplete,
    canon,
    providerOverride,
    modelOverride,
    // The run's AbortSignal, so a multi-chunk LLM check can stop launching
    // further chunk calls mid-run (the runner only checks it before/after each
    // check.run()). Mirrors the per-chunk cancel check in the completeness pass.
    signal,
    // Injected LLM caller — keeps server/lib/editorial pure. Forwards the
    // provider/model overrides so an LLM check honors the autopilot's choice.
    callStagedLLM: (stage, vars, opts = {}) =>
      runStagedLLM(stage, vars, { providerOverride, modelOverride, ...opts }),
    // Injected inline-prompt caller for user-defined checks (#1346) whose prompt
    // body is authored from the UI (no shipped stage template). Same provider/
    // model overrides as callStagedLLM so a custom check honors the run's choice.
    callInlineLLM: (prompt, opts = {}) =>
      runInlineLLM(prompt, { providerOverride, modelOverride, ...opts }),
    // Inline-prompt caller that resolves the provider/model from a NAMED STAGE's
    // pin (#1403). The cross-chunk setup-summary call rides alongside a stage-
    // pinned manuscript check, so it must run on the SAME provider as that stage —
    // routing it through the active provider (plain callInlineLLM) could leak
    // manuscript text to a different (e.g. cloud) provider than the stage chose.
    callStageScopedInlineLLM: (stage, prompt, opts = {}) =>
      runStageScopedInlineLLM(stage, prompt, { providerOverride, modelOverride, ...opts }),
    // Injected manuscript chunker — plans the stitched manuscript into chunks
    // sized to `stage`'s resolved provider context window (reusing the same
    // budgeter as the completeness pass), so a long series is fully reviewed
    // instead of truncated on a small/local provider. Returns the chunk-corpus
    // strings (one for a whole-fits provider) for an LLM check to iterate.
    // Lives here (not the pure registry) because it resolves the provider.
    planManuscriptChunks: async (stage, { overheadTokens = 0 } = {}) => {
      if (!sections.length) return [];
      const { contextWindow } = await resolveStageContext(stage, { providerOverride, modelOverride });
      const plan = planManuscriptPass({
        contextWindow,
        // Each section's full contribution = header + body, matching sectionsCorpus.
        sections: sections.map((s) => ({ ...s, text: `${manuscriptSectionHeader(s)}\n\n${s.content || ''}` })),
        overheadTokens,
        outputReserveTokens: EDITORIAL_OUTPUT_RESERVE_TOKENS,
      });
      // One whole chunk or many — the same usable-char budget caps each. Do NOT
      // floor this above plan.usableChars: on a genuinely small configured window
      // that would push the prompt back over the provider's context and get it
      // clipped/rejected. The editorial-sized output reserve above is what keeps
      // usableChars positive on the common unknown/8K-fallback provider.
      const corpora = plan.mode === 'whole'
        ? [manuscript]
        : plan.chunks.map((c) => sectionsCorpus(c.sections));
      const chunks = corpora.map((c) => c.slice(0, plan.usableChars));
      // Expose the per-chunk budget so a cross-chunk-digest check can fit its
      // digest into each chunk's spare room without overflowing the window or
      // displacing manuscript text (see runChunkedManuscriptCheck).
      chunks.usableChars = plan.usableChars;
      return chunks;
    },
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
      const sourceContentHash = fingerprintForCheck(check, resolvedSources);
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
  // Resolve checks against built-ins + the user's custom checks (#1346) so a
  // custom-check finding still gets staleness annotation. Build the id→check map
  // once (custom-check synthesis is not free) and look up per comment.
  const settings = await getSettings();
  const byId = new Map(getAllChecks(settings).map((c) => [c.id, c]));
  const checkFor = (id) => byId.get(id) || null;
  // Only recompute hashes when there's at least one hash-stamped finding from a
  // still-registered check — a pure completeness review pays no extra I/O.
  const evaluable = review.comments.filter((c) => c.checkId && c.sourceContentHash && checkFor(c.checkId));
  if (!evaluable.length) return review;
  // Only pay the manuscript-collection I/O when an evaluable check declares it as
  // a source (mirrors the run path's gate, now source-derived rather than the bare
  // needsManuscript flag so it stays correct as the source vocabulary grows).
  const needsManuscript = evaluable.some((c) => checkSources(checkFor(c.checkId)).includes('manuscript'));
  const needsReverseOutline = evaluable.some((c) => {
    const sources = checkSources(checkFor(c.checkId));
    return sources.includes('reverseOutline') || sources.includes('reverseOutline.plotlines');
  });
  const needsEditorialArcs = evaluable.some((c) => checkSources(checkFor(c.checkId)).includes('editorialArcs'));
  const series = await getSeries(seriesId);
  const [sections, canon, outline, editorial] = await Promise.all([
    needsManuscript ? collectManuscriptSections(seriesId) : Promise.resolve([]),
    getSeriesCanon(series),
    needsReverseOutline ? getReverseOutline(seriesId).catch(() => null) : Promise.resolve(null),
    // Reuse the already-loaded series (issues isn't fetched on this path).
    needsEditorialArcs ? getSeriesEditorial(seriesId, { series }).catch(() => null) : Promise.resolve(null),
  ]);
  const reverseOutline = Array.isArray(outline?.scenes) ? outline.scenes : [];
  const reverseOutlinePlotlines = Array.isArray(outline?.plotlines) ? outline.plotlines : [];
  const editorialArcs = projectEditorialArcs(editorial);
  const editorialArcsComplete = editorialCoverageComplete(editorial);
  const resolvedSources = resolveSources({ manuscript: sectionsCorpus(sections), canon, series, reverseOutline, reverseOutlinePlotlines, editorialArcs, editorialArcsComplete });
  return {
    ...review,
    comments: review.comments.map((c) => {
      const check = c.checkId && c.sourceContentHash ? checkFor(c.checkId) : null;
      if (!check) return c;
      const current = fingerprintForCheck(check, resolvedSources);
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
