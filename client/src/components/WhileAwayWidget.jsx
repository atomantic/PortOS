import { Link } from 'react-router';
import {
  Moon,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  Loader2,
  Sparkles,
  AlertTriangle
} from 'lucide-react';
import { getCosWhileAwayActivity } from '../services/apiAgents.js';
import { useSocketResource } from '../hooks/useSocketResource';
import { timeAgo } from '../utils/formatters';
import { safeReadStorage, safeWriteStorage } from '../lib/safeStorage';

// Per-device "last visit" marker. The widget shows agent activity that
// completed since this timestamp; "Mark as seen" advances it to now. Kept in
// localStorage (per the issue's while-away briefing slice) so there's no
// server-side presence state to migrate — it's intentionally per-browser.
const LAST_SEEN_KEY = 'portos.whileAway.lastSeen';

const readLastSeen = () => {
  // safeReadStorage swallows the private-mode / storage-disabled / security-error
  // throws (including the property-access throw in sandboxed iframes) and returns
  // null so this never crashes the dashboard render.
  const raw = safeReadStorage(LAST_SEEN_KEY);
  // A finite, non-future ISO string is the only valid marker; anything else
  // (absent, garbage, clock-skewed) means "no marker" → server applies its
  // own 24h fallback so the card still renders.
  if (!raw) return null;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t) || t > Date.now()) return null;
  return raw;
};

// A write failure (quota / disabled / property-access throw) is swallowed by
// safeWriteStorage — "Mark as seen" still refetches; the window just isn't
// persisted this time.
const writeLastSeen = (iso) => safeWriteStorage(LAST_SEEN_KEY, iso);

function ActivityRow({ item, kind }) {
  const Icon = kind === 'incident' ? XCircle : CheckCircle;
  const tone = kind === 'incident' ? 'text-port-error' : 'text-port-success';
  return (
    <Link
      to={`/cos/agents/${encodeURIComponent(item.id)}`}
      className="flex items-start gap-2.5 p-2 rounded-lg border border-port-border bg-port-bg/40 hover:border-port-accent/40 transition-colors group"
    >
      <Icon size={14} className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-gray-200 truncate">{item.description}</div>
        <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
          <span className="truncate">{item.taskType}</span>
          {item.app && <span className="truncate text-gray-600">· {item.app}</span>}
          <span className="shrink-0 ml-auto">{item.completedRelative}</span>
        </div>
      </div>
    </Link>
  );
}

// A finished agent run can change the queue while you're looking at it, so the
// card refreshes on completion (mirrors ReviewHubCard).
const WHILE_AWAY_EVENTS = ['cos:agent:completed'];

// The marker is captured at fetch time so "Mark as seen" and the header label
// reflect the window we actually queried (not a value that drifted since).
const fetchWhileAway = async () => {
  const since = readLastSeen();
  return { ...(await getCosWhileAwayActivity(since, { silent: true })), since };
};

export default function WhileAwayWidget() {
  const { data, loading, error, refetch } = useSocketResource(fetchWhileAway, { events: WHILE_AWAY_EVENTS });

  const markSeen = () => {
    writeLastSeen(new Date().toISOString());
    refetch();
  };

  if (loading && !data) {
    return (
      <div className="@container bg-port-card border border-port-border rounded-xl p-4 flex items-center justify-center min-h-[120px]">
        <Loader2 className="w-5 h-5 text-gray-500 animate-spin" />
      </div>
    );
  }

  if (!data) {
    // A failed read is not "nothing happened": surface it with a retry.
    return error ? (
      <div role="alert" className="@container bg-port-card border border-port-border rounded-xl p-4 flex items-center gap-2 text-sm text-port-error">
        <AlertTriangle size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">Could not load recent agent activity.</span>
        <button type="button" onClick={refetch} className="px-2.5 py-1.5 min-h-[36px] text-xs bg-port-bg border border-port-border rounded-lg text-gray-300 hover:border-port-accent/50">Retry</button>
      </div>
    ) : null;
  }

  const { stats, time, accomplishments = [], incidents = [] } = data;
  const total = stats?.completed ?? 0;
  // The header window: prefer the per-device marker; if absent, the server
  // fell back to 24h and reports the window it actually used via sinceIso.
  const windowSince = data.since || data.sinceIso;

  return (
    <div className="@container min-w-0 bg-port-card border border-port-border rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-2 rounded-lg bg-port-accent/10 shrink-0">
            <Moon className="w-5 h-5 text-port-accent" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base @sm:text-lg font-semibold text-white">While You Were Away</h3>
            <p className="text-sm text-gray-500 truncate">
              {total > 0
                ? `${total} agent run${total !== 1 ? 's' : ''} since ${timeAgo(windowSince)}`
                : `Nothing since ${timeAgo(windowSince)}`}
            </p>
          </div>
        </div>
        {total > 0 && (
          <button
            type="button"
            onClick={markSeen}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-port-bg border border-port-border hover:border-port-accent/50 text-gray-300 rounded-lg transition-colors shrink-0 min-h-[36px]"
            title="Reset the window to now"
            aria-label="Mark as seen — reset the window to now"
          >
            <Eye size={13} />
            <span className="@max-sm:sr-only">Mark as seen</span>
          </button>
        )}
      </div>

      {total === 0 ? (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
          <Sparkles size={14} className="text-port-accent/60" />
          No agent activity while you were away.
        </div>
      ) : (
        <>
          {/* Stat strip */}
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-success/20 text-port-success">
              <CheckCircle size={10} />
              {stats.succeeded} succeeded
            </span>
            {stats.failed > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-error/20 text-port-error">
                <XCircle size={10} />
                {stats.failed} failed
              </span>
            )}
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-accent/20 text-port-accent">
              {stats.successRate}% success
            </span>
            {time?.totalDurationMs > 0 && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-port-bg text-gray-400 border border-port-border">
                <Clock size={10} />
                {time.totalDuration} of work
              </span>
            )}
          </div>

          {/* Accomplishments */}
          {accomplishments.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {accomplishments.map((item) => (
                <ActivityRow key={item.id} item={item} kind="accomplishment" />
              ))}
            </div>
          )}

          {/* Incidents */}
          {incidents.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-port-error/80 mt-2 mb-1">Needs a look</div>
              {incidents.map((item) => (
                <ActivityRow key={item.id} item={item} kind="incident" />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
