/**
 * Pipeline — Batch runner for series-wide editorial analysis.
 *
 * Analyzes every issue in a series that has reader-facing content, streaming
 * per-issue progress to attached SSE clients. Mirrors autoRunner.js: a single
 * in-memory `runs` map keyed by `seriesId`, with replay for late-connecting
 * clients via lib/sseUtils.js.
 *
 * analyzeIssue() short-circuits to a cached snapshot when the content is
 * unchanged, so a re-run only spends LLM calls on new / edited / stale issues
 * (or all of them when `force: true`).
 */

import { createSseRunner } from '../../lib/sseUtils.js';
import { listIssues } from './issues.js';
import { analyzeIssue, pickAnalyzableContent } from './editorialAnalysis.js';

const runner = createSseRunner({ logLabel: 'editorial batch' });

export function isSeriesAnalysisActive(seriesId) {
  return runner.isActive(seriesId);
}

export function attachClient(seriesId, res) {
  return runner.attachClient(seriesId, res);
}

export function cancelSeriesAnalysis(seriesId) {
  return runner.cancel(seriesId);
}

/**
 * Kick off the series editorial-analysis batch. Returns the runId immediately;
 * progress lands via SSE. Re-calling while a run is in flight resolves to the
 * existing runId.
 */
export function startSeriesAnalysis(seriesId, options = {}) {
  return runner.start(seriesId, async ({ runId, record, broadcast }) => {
    const issues = await listIssues({ seriesId });
    const analyzable = issues.filter((i) => pickAnalyzableContent(i));
    const ordered = analyzable.sort(
      (a, b) => (a.arcPosition ?? 9999) - (b.arcPosition ?? 9999) || (a.number || 0) - (b.number || 0)
    );
    broadcast({ type: 'start', runId, total: ordered.length });

    let done = 0;
    for (const issue of ordered) {
      if (record.cancelRequested) break;
      broadcast({
        type: 'issue:start',
        issueId: issue.id,
        number: issue.number,
        title: issue.title,
        done,
        total: ordered.length,
      });
      const result = await analyzeIssue(issue.id, {
        providerId: options.providerId,
        model: options.model,
        force: !!options.force,
      }).catch((err) => ({ status: 'error', error: (err?.message || String(err)).slice(0, 500) }));
      done += 1;
      broadcast({
        type: result?.status === 'error' ? 'issue:error' : 'issue:complete',
        issueId: issue.id,
        number: issue.number,
        done,
        total: ordered.length,
        cached: !!result?.cached,
        sections: result?.sections?.length || 0,
        error: result?.status === 'error' ? result.error : undefined,
      });
    }

    broadcast({
      type: record.cancelRequested ? 'canceled' : 'complete',
      runId,
      analyzed: done,
      completedAt: new Date().toISOString(),
    });
    console.log(`📊 editorial batch ${record.cancelRequested ? 'canceled' : 'complete'} — series=${seriesId.slice(0, 12)} analyzed=${done}/${ordered.length}`);
  });
}

// Export internals for tests.
export const __testing = { runs: runner.runs };
