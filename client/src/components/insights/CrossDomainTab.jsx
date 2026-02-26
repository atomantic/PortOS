import { useState, useEffect } from 'react';
import { RefreshCw, GitCompare } from 'lucide-react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { getInsightNarrative, refreshInsightNarrative } from '../../services/api';
import EmptyState from './EmptyState';

function formatDate(isoString) {
  if (!isoString) return null;
  return new Date(isoString).toLocaleString();
}

function formatRelativeTime(isoString) {
  if (!isoString) return null;
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

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
              Last analyzed {formatRelativeTime(data.generatedAt)}
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
            <ReactDiffViewer
              oldValue={data.previousText}
              newValue={data.text}
              splitView={false}
              useDarkTheme
              hideLineNumbers
              styles={{
                variables: {
                  dark: {
                    diffViewerBackground: '#1a1a1a',
                    addedBackground: '#1a3a1a',
                    addedColor: '#22c55e',
                    removedBackground: '#3a1a1a',
                    removedColor: '#ef4444',
                    wordAddedBackground: '#1d4d1d',
                    wordRemovedBackground: '#4d1d1d',
                    gutterBackground: '#0f0f0f',
                    gutterColor: '#555',
                    codeFoldBackground: '#111',
                    codeFoldGutterBackground: '#111',
                    codeFoldContentColor: '#888'
                  }
                }
              }}
            />
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
