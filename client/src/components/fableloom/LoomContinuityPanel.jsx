import { useState } from 'react';
import {
  AlertTriangle, CheckCircle2, CircleAlert, Film, Info, Loader2, Sparkles,
} from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { reviewLoomEpisodeContinuity } from '../../services/api';

const severityIcon = (severity) => {
  if (severity === 'error' || severity === 'high') {
    return <CircleAlert size={14} className="mt-0.5 shrink-0 text-port-error" />;
  }
  if (severity === 'warning') {
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-port-warning" />;
  }
  return <Info size={14} className="mt-0.5 shrink-0 text-port-accent" />;
};

export default function LoomContinuityPanel({
  loom,
  episode,
  review,
  onReviewChange,
  onSelectNode,
}) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [runReview, reviewing] = useAsyncAction(async () => {
    const requestedEpisodeId = episode.id;
    const result = await reviewLoomEpisodeContinuity(loom.id, requestedEpisodeId, {}, { silent: true });
    onReviewChange(requestedEpisodeId, result);
  }, { errorMessage: 'Continuity review failed' });
  const findings = (review?.findings || []).filter((finding) => (
    categoryFilter === 'all' || finding.category === categoryFilter
  ));

  return (
    <section className="space-y-4" aria-label="Continuity review">
      <header>
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Film size={14} className="text-port-accent" />
          Continuity & canon
        </h3>
        <p className="mt-1 text-xs text-port-text-muted">
          Run this after story and path review, before render settings. It checks character visuals, wardrobe, voice, pronunciation, playback, and convergence sources.
        </p>
      </header>

      <button
        type="button"
        onClick={runReview}
        disabled={reviewing}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {reviewing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        {reviewing ? 'Reviewing continuity…' : review ? 'Run continuity review again' : 'Run continuity review'}
      </button>

      {review ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className={`flex items-center gap-1 font-medium ${review.passed ? 'text-port-success' : 'text-port-error'}`}>
              {review.passed ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
              {review.passed
                ? 'All continuity checks passed'
                : `${review.summary?.errors || 0} error(s), ${review.summary?.warnings || 0} warning(s)`}
            </span>
            <span className="shrink-0 text-[11px] text-port-text-muted">{review.nodesEvaluated} scenes</span>
          </div>

          <div className="flex gap-1 overflow-x-auto pb-1 text-[11px]" role="group" aria-label="Continuity category">
            {['all', 'visual', 'voice', 'playback', 'graph'].map((category) => (
              <button
                key={category}
                type="button"
                aria-pressed={categoryFilter === category}
                onClick={() => setCategoryFilter(category)}
                className={`rounded px-2 py-1 capitalize ${
                  categoryFilter === category
                    ? 'bg-port-accent font-medium text-white'
                    : 'border border-port-border bg-port-card text-port-text-muted hover:text-port-text'
                }`}
              >
                {category}
              </button>
            ))}
          </div>

          {findings.length ? (
            <div className="space-y-1.5">
              {findings.map((finding) => (
                <button
                  key={finding.id}
                  type="button"
                  onClick={() => finding.nodeId && onSelectNode?.(finding.nodeId)}
                  disabled={!finding.nodeId}
                  className={`flex w-full items-start gap-2 rounded border border-port-border p-2 text-left text-xs ${
                    finding.nodeId ? 'cursor-pointer hover:border-port-accent' : 'cursor-default'
                  }`}
                >
                  {severityIcon(finding.severity)}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-port-text">{finding.message}</span>
                    {finding.remediation ? (
                      <span className="mt-0.5 block text-[11px] text-port-text-muted">Fix: {finding.remediation}</span>
                    ) : null}
                    {finding.nodeId ? (
                      <span className="mt-1 block text-[10px] text-port-accent">Open affected scene</span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-port-text-muted">No {categoryFilter === 'all' ? '' : categoryFilter} continuity issues found.</p>
          )}
        </div>
      ) : (
        <p className="rounded border border-port-border bg-port-bg/30 p-3 text-xs text-port-text-muted">
          No continuity review has run for this episode yet.
        </p>
      )}
    </section>
  );
}
