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

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../../../lib/sseUtils.js';
import { runStagedLLM } from '../../../lib/stageRunner.js';
import { getEnabledChecks, resolveCheckState } from '../../../lib/editorial/index.js';
import { getSettings } from '../../settings.js';
import { getSeries } from '../series.js';
import { listIssues } from '../issues.js';
import { getSeriesCanon } from '../seriesCanon.js';
import { collectManuscriptSections, sectionsCorpus } from '../arcPlanner.js';
import { seedReviewFromFindings } from '../manuscriptReview.js';

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

  // Build the shared context once — every check reads from this.
  const series = await getSeries(seriesId);
  const [sections, canon, issues] = await Promise.all([
    collectManuscriptSections(seriesId),
    getSeriesCanon(series),
    listIssues({ seriesId }).catch(() => []),
  ]);
  const manuscript = sectionsCorpus(sections);
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
      const stamped = raw.map((f) => ({ ...f, checkId: check.id }));
      findings.push(...stamped);
      perCheck.push({ checkId: check.id, count: stamped.length });
      onProgress?.({ type: 'check:complete', checkId: check.id, count: stamped.length });
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 500);
      console.error(`❌ editorial check ${check.id} failed — series=${String(seriesId).slice(0, 12)} ${message}`);
      perCheck.push({ checkId: check.id, error: message });
      onProgress?.({ type: 'check:complete', checkId: check.id, error: message });
    }
  }

  // Seed in 'merge' mode (never 'fresh'): a per-series seed of only the editorial
  // checks' findings must not auto-dismiss completeness or other-check open
  // comments. Merge dedups via findingKey (which now includes checkId) and keeps
  // dismissed findings suppressed per-check.
  if (findings.length) {
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
  const subset = Array.isArray(checkIds) && checkIds.length ? new Set(checkIds) : null;
  const checks = resolveCheckState(resolved)
    .filter((row) => row.enabled && (!subset || subset.has(row.id)))
    .map((row) => ({ id: row.id, label: row.label, kind: row.kind, scope: row.scope }));
  return { seriesId, checks, enabledCount: checks.length };
}

// ---------------------------------------------------------------------------
// SSE run-tracking (mirrors manuscriptCompletenessRunner.js).
// ---------------------------------------------------------------------------

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished, cleanupTimer, startedAt, abort }>
const runs = new Map();

export function isEditorialChecksActive(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished;
}

function scheduleCleanup(seriesId, record) {
  record.cleanupTimer = setTimeout(() => {
    if (runs.get(seriesId) !== record) return;
    for (const c of record.clients) c.end();
    runs.delete(seriesId);
  }, SSE_CLEANUP_DELAY_MS);
}

export function attachClient(seriesId, res) {
  return attachSseClient(runs, seriesId, res);
}

export function cancelEditorialChecks(seriesId) {
  const run = runs.get(seriesId);
  if (!run) return false;
  run.cancelRequested = true;
  run.abort?.abort();
  return true;
}

function broadcast(seriesId, payload) {
  const run = runs.get(seriesId);
  if (!run) return;
  broadcastSse(run, payload);
}

/**
 * Kick off a streamed editorial-checks run. Returns the runId immediately;
 * progress lands via SSE. Re-calling while a run is in flight resolves to the
 * existing runId.
 */
export function startEditorialChecksRun(seriesId, options = {}) {
  const existing = runs.get(seriesId);
  if (existing && !existing.finished) {
    return { runId: existing.runId, alreadyRunning: true };
  }
  if (existing) {
    if (existing.cleanupTimer) clearTimeout(existing.cleanupTimer);
    for (const c of existing.clients) c.end();
  }
  const runId = randomUUID();
  const abort = new AbortController();
  const record = {
    runId,
    clients: [],
    lastPayload: null,
    cancelRequested: false,
    finished: false,
    cleanupTimer: null,
    startedAt: new Date().toISOString(),
    abort,
  };
  runs.set(seriesId, record);

  // Fire-and-forget coordinator. The try/catch is the permitted boundary use:
  // an unhandled LLM rejection here would crash the process on Node ≥15.
  (async () => {
    try {
      broadcast(seriesId, { type: 'start', runId });
      const result = await runEditorialChecks(seriesId, {
        checkIds: options.checkIds,
        providerOverride: options.providerOverride,
        modelOverride: options.modelOverride,
        signal: abort.signal,
        onProgress: (event) => broadcast(seriesId, { ...event, runId }),
      });
      if (record.cancelRequested || result.canceled) {
        broadcast(seriesId, { type: 'canceled', runId, canceledAt: new Date().toISOString() });
        console.log(`📝 editorial checks canceled — series=${String(seriesId).slice(0, 12)}`);
        return;
      }
      broadcast(seriesId, {
        type: 'complete',
        runId,
        findingCount: result.findings.length,
        perCheck: result.perCheck,
        completedAt: new Date().toISOString(),
      });
      console.log(`📝 editorial checks complete — series=${String(seriesId).slice(0, 12)} findings=${result.findings.length}`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ editorial checks failed — series=${String(seriesId).slice(0, 12)} ${message}`);
      broadcast(seriesId, { type: 'error', runId, error: message, failedAt: new Date().toISOString() });
    } finally {
      record.finished = true;
      scheduleCleanup(seriesId, record);
    }
  })();

  return { runId, alreadyRunning: false };
}

// Export internals for tests.
export const __testing = { runs };
