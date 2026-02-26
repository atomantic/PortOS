import { useState, useEffect } from 'react';
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react';
import { getInsightThemes, refreshInsightThemes } from '../../services/api';
import InsightCard from './InsightCard';
import ConfidenceBadge from './ConfidenceBadge';
import EmptyState from './EmptyState';

// Map theme strength to confidence level
const STRENGTH_TO_LEVEL = {
  strong: 'strong',
  moderate: 'moderate',
  tentative: 'weak'
};

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

function EvidenceList({ evidence }) {
  const [expanded, setExpanded] = useState(false);
  if (!evidence || evidence.length === 0) return null;

  return (
    <div className="mt-3 border-t border-port-border/50 pt-2">
      <button
        onClick={() => setExpanded(prev => !prev)}
        className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{evidence.length} evidence {evidence.length === 1 ? 'item' : 'items'}</span>
      </button>

      {expanded && (
        <ul className="mt-2 space-y-2">
          {evidence.map((item, i) => (
            <li key={i} className="text-xs text-gray-500 leading-relaxed">
              <span className="text-gray-300 font-medium">{item.preference}</span>
              {item.domain && <span className="text-gray-600 ml-1">from {item.domain}</span>}
              {item.connection && <span className="text-gray-500"> — {item.connection}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThemeCard({ theme }) {
  const level = STRENGTH_TO_LEVEL[theme.strength] ?? 'unknown';

  return (
    <InsightCard
      title={theme.title}
      badge={
        <ConfidenceBadge
          level={level}
          label={theme.strength ? `${theme.strength.charAt(0).toUpperCase()}${theme.strength.slice(1)} pattern` : undefined}
        />
      }
    >
      {theme.narrative && (
        <p className="text-sm text-gray-300 mt-2 leading-relaxed">{theme.narrative}</p>
      )}
      <EvidenceList evidence={theme.evidence} />
    </InsightCard>
  );
}

export default function TasteIdentityTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    getInsightThemes()
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  const handleRefresh = () => {
    setRefreshing(true);
    refreshInsightThemes()
      .then(setData)
      .finally(() => setRefreshing(false));
  };

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="h-4 bg-gray-700 rounded w-2/3 mb-3" />
            <div className="h-3 bg-gray-800 rounded w-full mb-1" />
            <div className="h-3 bg-gray-800 rounded w-5/6 mb-1" />
            <div className="h-3 bg-gray-800 rounded w-4/5" />
          </div>
        ))}
      </div>
    );
  }

  if (!data?.available) {
    if (data?.reason === 'no_taste_data') {
      return (
        <EmptyState
          message="No taste profile completed yet. Complete the taste questionnaire to generate identity themes."
          linkTo="/digital-twin/taste"
          linkLabel="Complete Taste Profile"
        />
      );
    }

    // not_generated — show empty state with explanation and refresh option
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="text-gray-400 text-sm max-w-sm mb-2">
          No taste identity themes generated yet.
        </p>
        <p className="text-gray-500 text-xs max-w-sm mb-6">
          Generating themes uses your completed taste profile to identify cross-domain patterns — aesthetics, media, food, and values — and produce analytical theme cards.
        </p>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-4 py-2 bg-port-accent text-white rounded-lg text-sm font-medium hover:bg-port-accent/80 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Generating...' : 'Generate Themes'}
        </button>
      </div>
    );
  }

  const relativeTime = formatRelativeTime(data.generatedAt);

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-400">
            {data.themes?.length ?? 0} themes identified
          </span>
          {relativeTime && (
            <span className="text-xs text-gray-600">Generated {relativeTime}</span>
          )}
          {data.model && (
            <span className="text-xs text-gray-700 bg-gray-800 px-2 py-0.5 rounded">{data.model}</span>
          )}
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border rounded-lg text-sm text-gray-400 hover:text-white hover:border-port-accent/50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Theme cards grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(data.themes ?? []).map((theme, i) => (
          <ThemeCard key={i} theme={theme} />
        ))}
      </div>
    </div>
  );
}
