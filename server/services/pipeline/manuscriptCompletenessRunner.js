/**
 * Pipeline — Batch runner for the manuscript-completeness ("Finish the draft")
 * editorial review, streaming per-chunk progress to attached SSE clients.
 *
 * The synchronous `POST /manuscript/completeness` route stays the entry point
 * for the findings-only pass (and the ArcCanvas "Finish the draft" caller). This
 * runner backs the heavier "generate edits for every finding" pass, where the
 * model also returns a concrete `replace` per finding: a chunked large manuscript
 * would otherwise show a long opaque spinner, so we stream chunk progress.
 *
 * Mirrors editorialAnalysisRunner.js: a single in-memory `runs` map keyed by
 * `seriesId`, with terminal-frame replay for late-connecting clients via
 * lib/sseUtils.js. The actual chunk/merge/digest loop is NOT re-implemented here
 * — it lives in arcPlanner.analyzeManuscriptCompleteness, which this runner
 * drives via its `onProgress` + `signal` hooks. After analysis the runner seeds
 * the review (so each comment lands with its `fix` pre-attached) exactly as the
 * sync route does.
 */

import { randomUUID } from 'crypto';
import { broadcastSse, attachSseClient, SSE_CLEANUP_DELAY_MS } from '../../lib/sseUtils.js';
import { analyzeManuscriptCompleteness } from './arcPlanner.js';
import { seedReviewFromFindings } from './manuscriptReview.js';

// runs: Map<seriesId, { runId, clients[], lastPayload, cancelRequested, finished, cleanupTimer, startedAt, abort }>
// A finished run lingers in the map for SSE_CLEANUP_DELAY_MS so late-attaching
// clients can replay its terminal frame — but `finished` lets `isActive` and
// the restart guard treat it as done, so an immediate re-run isn't swallowed.
const runs = new Map();

export function isCompletenessReviewActive(seriesId) {
  const run = runs.get(seriesId);
  return !!run && !run.finished;
}

// Hold a finished run open briefly for terminal-frame replay, then evict it —
// but only if THIS record is still the one mapped, so a restart that replaced
// it within the window isn't clobbered by the prior run's timer.
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

export function cancelCompletenessReview(seriesId) {
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
 * Kick off the streamed completeness review (always the generate-edits pass).
 * Returns the runId immediately; progress lands via SSE. Re-calling while a run
 * is in flight resolves to the existing runId.
 * `options`: { providerOverride, modelOverride, mode }.
 */
export async function startCompletenessReview(seriesId, options = {}) {
  const existing = runs.get(seriesId);
  if (existing && !existing.finished) {
    return { runId: existing.runId, alreadyRunning: true };
  }
  if (existing) {
    // A finished run still in its replay window — cancel its pending eviction
    // and drop its replay clients so this fresh run fully replaces it.
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
      const result = await analyzeManuscriptCompleteness(seriesId, {
        providerOverride: options.providerOverride,
        modelOverride: options.modelOverride,
        withEdits: true, // the streamed runner exists to pre-build per-finding edits
        signal: abort.signal,
        onProgress: (event) => {
          // Forward the analyzer's progress events to SSE, stamping the runId and
          // flattening `plan`'s mode into a `chunked` flag the client reads.
          if (event.type === 'plan') broadcast(seriesId, { type: 'plan', runId, total: event.total, chunked: event.mode === 'chunked' });
          else if (event.type === 'chunk:start' || event.type === 'chunk:complete') {
            broadcast(seriesId, { type: event.type, runId, done: event.done, total: event.total });
          }
        },
      });

      if (record.cancelRequested || result.canceled) {
        broadcast(seriesId, { type: 'canceled', runId, canceledAt: new Date().toISOString() });
        console.log(`📚 completeness review canceled — series=${String(seriesId).slice(0, 12)}`);
        return;
      }

      // Seed the persisted review exactly as the sync route does, so each comment
      // lands with its pre-built `fix` (when the finding carried a replace).
      const review = await seedReviewFromFindings(seriesId, result.issues, {
        runId: result.runId,
        mode: options.mode,
      });
      const openCount = review.comments.filter((c) => c.status === 'open').length;
      broadcast(seriesId, {
        type: 'complete',
        runId,
        openCount,
        chunked: !!result.chunked,
        chunkCount: result.chunkCount || 1,
        completedAt: new Date().toISOString(),
      });
      console.log(`📚 completeness review complete — series=${String(seriesId).slice(0, 12)} open=${openCount} chunks=${result.chunkCount || 1}`);
    } catch (err) {
      const message = (err?.message || String(err)).slice(0, 1000);
      console.error(`❌ completeness review failed — series=${String(seriesId).slice(0, 12)} ${message}`);
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
