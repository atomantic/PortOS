/**
 * FableLoom validation panel — the deterministic graph checks plus the
 * optional AI story review. Structural checks run instantly server-side (no
 * LLM); "Review with AI" layers the story-editor critique on top. Clicking a
 * scene-anchored finding selects that node on the canvas.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CircleAlert, Loader2, Sparkles } from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { reviewLoomEpisode, validateLoomEpisode } from '../../services/api';

const severityIcon = (severity) => (severity === 'error' || severity === 'high'
  ? <CircleAlert size={13} className="text-port-error shrink-0 mt-0.5" />
  : <AlertTriangle size={13} className="text-port-warning shrink-0 mt-0.5" />);

export default function LoomValidationPanel({ loom, episode, onSelectNode }) {
  const [structural, setStructural] = useState(null);
  const [review, setReview] = useState(null);

  // Re-validate only when the graph STRUCTURE changes — a prose edit or a
  // node drag bumps episode.updatedAt but can't change reachability, so
  // keying on updatedAt would re-run the full-loom server analysis on every
  // blur-save.
  const structureKey = useMemo(
    () => [
      episode.startNodeId,
      ...episode.nodes.map((n) =>
        `${n.id}|${n.isEnding ? 1 : 0}|${n.playbackMode || 'decision'}|${(n.transitions || []).map((t) => `${t.targetNodeId}:${t.intent}`).join(',')}`),
    ].join(';'),
    [episode.startNodeId, episode.nodes],
  );

  useEffect(() => {
    validateLoomEpisode(loom.id, episode.id, { silent: true })
      .then(setStructural)
      .catch(() => setStructural(null));
  }, [loom.id, episode.id, structureKey]);

  const [runReview, reviewing] = useAsyncAction(async () => {
    const result = await reviewLoomEpisode(loom.id, episode.id, {}, { silent: true });
    setReview(result.review);
    setStructural(result.structural);
  }, { errorMessage: 'Story review failed' });

  const findingRow = (item, key, nodeId) => (
    <button
      key={key}
      type="button"
      onClick={() => nodeId && onSelectNode(nodeId)}
      disabled={!nodeId}
      className={`w-full text-left flex items-start gap-2 text-xs rounded px-2 py-1.5 border border-port-border ${
        nodeId ? 'hover:border-port-accent cursor-pointer' : 'cursor-default'
      }`}
    >
      {severityIcon(item.severity)}
      <span>
        {item.message || item.problem}
        {item.suggestion ? <span className="block text-port-text-muted mt-0.5">{item.suggestion}</span> : null}
      </span>
    </button>
  );

  return (
    <div className="p-4 space-y-4">
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Structure</h3>
          {structural?.stats && (
            <span className="text-xs text-port-text-muted">
              {structural.stats.automaticCutCount} cuts · {structural.stats.decisionCount} decisions ·{' '}
              {structural.stats.reachableEndingCount}/{structural.stats.endingCount} endings reachable
              · depth {structural.stats.maxDepth}
            </span>
          )}
        </div>
        {structural?.issues?.length ? (
          <div className="space-y-1.5">
            {structural.issues.map((issue, i) => findingRow(issue, `s-${i}`, issue.nodeId))}
          </div>
        ) : structural ? (
          <p className="text-xs text-port-success">Graph is sound — every path reaches an ending.</p>
        ) : (
          <p className="text-xs text-port-text-muted">Validating…</p>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Story review</h3>
          <button
            type="button"
            onClick={runReview}
            disabled={reviewing}
            className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
          >
            {reviewing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Review with AI
          </button>
        </div>
        {review ? (
          <div className="space-y-2">
            {review.summary && <p className="text-xs text-port-text-muted">{review.summary}</p>}
            {review.findings.length ? (
              <div className="space-y-1.5">
                {review.findings.map((finding, i) => findingRow(finding, `r-${i}`, finding.nodeId))}
              </div>
            ) : (
              <p className="text-xs text-port-success">No narrative issues found.</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-port-text-muted">
            Ask the AI story editor to critique intents, branches, and endings.
          </p>
        )}
      </div>
    </div>
  );
}
