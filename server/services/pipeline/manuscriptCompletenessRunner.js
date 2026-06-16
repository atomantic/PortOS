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

import { createSseRunner } from '../../lib/sseUtils.js';
import { analyzeManuscriptCompleteness } from './arcPlanner.js';
import { seedReviewFromFindings } from './manuscriptReview.js';

const runner = createSseRunner({ logLabel: 'completeness review' });

export function isCompletenessReviewActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelCompletenessReview(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off the streamed completeness review (always the generate-edits pass).
 * Returns the runId immediately; progress lands via SSE. Re-calling while a run
 * is in flight resolves to the existing runId.
 * `options`: { providerOverride, modelOverride, mode }.
 */
export function startCompletenessReview(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, signal, record, broadcast }) => {
    broadcast({ type: 'start', runId });
    const result = await analyzeManuscriptCompleteness(seriesId, {
      providerOverride: options.providerOverride,
      modelOverride: options.modelOverride,
      withEdits: true, // the streamed runner exists to pre-build per-finding edits
      signal,
      onProgress: (event) => {
        // Forward the analyzer's progress events to SSE, stamping the runId and
        // flattening `plan`'s mode into a `chunked` flag the client reads.
        if (event.type === 'plan') broadcast({ type: 'plan', runId, total: event.total, chunked: event.mode === 'chunked' });
        else if (event.type === 'chunk:start' || event.type === 'chunk:complete') {
          broadcast({ type: event.type, runId, done: event.done, total: event.total });
        }
      },
    });

    if (record.cancelRequested || result.canceled) {
      broadcast({ type: 'canceled', runId, canceledAt: new Date().toISOString() });
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
    broadcast({
      type: 'complete',
      runId,
      openCount,
      chunked: !!result.chunked,
      chunkCount: result.chunkCount || 1,
      completedAt: new Date().toISOString(),
    });
    console.log(`📚 completeness review complete — series=${String(seriesId).slice(0, 12)} open=${openCount} chunks=${result.chunkCount || 1}`);
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
