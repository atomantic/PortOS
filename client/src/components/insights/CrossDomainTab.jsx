import { useState, useEffect, memo } from 'react';
import { RefreshCw, GitCompare } from 'lucide-react';
import { getInsightNarrative, refreshInsightNarrative } from '../../services/api';
import { formatDate, timeAgo } from '../../utils/formatters';

// Inline word-level diff using Myers LCS algorithm
function lcs(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  const seq = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i-1] === b[j-1]) { seq.unshift(a[i-1]); i--; j--; }
    else if (dp[i-1][j] >= dp[i][j-1]) i--;
    else j--;
  }
  return seq;
}

const InlineDiff = memo(function InlineDiff({ oldText, newText }) {
  const oldWords = (oldText || '').split(/(\s+)/);
  const newWords = (newText || '').split(/(\s+)/);
  const common = new Set(lcs(oldWords, newWords));

  const render = (words, added) => {
    const spans = [];
    let run = [];
    words.forEach((w, i) => {
      if (common.has(w)) {
        if (run.length) { spans.push(<span key={i + 'r'} className={added ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}>{run.join('')}</span>); run = []; }
        spans.push(w);
      } else { run.push(w); }
    });
    if (run.length) spans.push(<span key="last" className={added ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'}>{run.join('')}</span>);
    return spans;
  };

  return (
    <div className="font-mono text-xs p-4 space-y-2 bg-port-bg">
      {oldText !== newText && (
        <>
          <div className="text-red-400 leading-relaxed">{render(oldWords, false)}</div>
          <div className="text-green-400 leading-relaxed">{render(newWords, true)}</div>
        </>
      )}
      {oldText === newText && <div className="text-gray-500">No changes.</div>}
    </div>
  );
});

export default function CrossDomainTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  useEffect(() => {
    getInsightNarrative()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    setShowDiff(false);
    refreshInsightNarrative()
      .then(result => {
        setData(result);
      })
      .finally(() => setRefreshing(false));
  };

  if (loading) {
    return (
      <div className="animate-pulse space-y-3">
        <div className="h-5 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="h-4 bg-gray-700 rounded w-full" />
        <div className="h-4 bg-gray-700 rounded w-11/12" />
        <div className="h-4 bg-gray-700 rounded w-5/6" />
        <div className="h-4 bg-gray-700 rounded w-full" />
        <div className="h-4 bg-gray-700 rounded w-4/5" />
      </div>
    );
  }

  if (!data?.available) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-gray-400 text-sm max-w-sm mb-2">
          No cross-domain narrative generated yet.
        </p>
        <p className="text-gray-500 text-xs max-w-sm mb-6">
          Click Refresh to analyze patterns across all your data — genome health correlations, taste identity themes, and biometric trends — and synthesize a unified personal narrative.
        </p>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Analyzing...' : 'Generate Narrative'}
        </button>
      </div>
    );
  }

  const hasPrevious = data.previousText && data.previousText.trim() !== data.text?.trim();

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {data.generatedAt && (
            <span className="text-xs text-gray-500">
              Last analyzed {timeAgo(data.generatedAt)}
            </span>
          )}
          {data.model && (
            <span className="text-xs text-gray-700 bg-gray-800 px-2 py-0.5 rounded">{data.model}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasPrevious && !refreshing && (
            <button
              onClick={() => setShowDiff(prev => !prev)}
              className={`flex items-center gap-2 px-3 py-1.5 border rounded-lg text-sm transition-colors ${
                showDiff
                  ? 'bg-port-accent/10 border-port-accent/50 text-port-accent'
                  : 'bg-port-card border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
              }`}
            >
              <GitCompare size={14} />
              {showDiff ? 'Hide changes' : 'Show changes'}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-port-accent/50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Analyzing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Narrative text */}
      {!showDiff && (
        <div className="bg-port-card border border-port-border rounded-lg p-6">
          <div className="prose prose-sm prose-invert max-w-none">
            {(data.text ?? '').split('\n').filter(Boolean).map((paragraph, i) => (
              <p key={i} className="text-gray-300 leading-relaxed mb-3 last:mb-0">{paragraph}</p>
            ))}
          </div>
        </div>
      )}

      {/* Diff view */}
      {showDiff && hasPrevious && (
        <div className="border border-port-border rounded-lg overflow-hidden">
          {data.previousGeneratedAt && (
            <div className="px-4 py-2 bg-port-card border-b border-port-border text-xs text-gray-500">
              Previous analysis: {formatDate(data.previousGeneratedAt)}
            </div>
          )}
          <div className="text-xs">
            <InlineDiff oldText={data.previousText} newText={data.text} />
          </div>
        </div>
      )}

      {/* No changes message */}
      {showDiff && !hasPrevious && (
        <div className="bg-port-card border border-port-border rounded-lg p-4 text-center">
          <p className="text-sm text-gray-500">No significant changes detected between analyses.</p>
        </div>
      )}
    </div>
  );
}
