import { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import Banner from '../ui/Banner';
import * as api from '../../services/api';
import { formatDurationMs, timeAgo } from '../../utils/formatters';
import { formatLiRejectionReason } from '../../utils/layeredIntelligenceReasons';

// Read-only dashboard (#2689): how this app's filed Layered Intelligence proposals
// fared. Display-only, so it fetches its own data OUTSIDE the drawer's controlled
// form state (unlike the config fields, which live in the parent's formData) and
// refetches whenever the app changes or the user retries. Renders nothing without
// an appId so the config tab's own render tests don't trigger a fetch.

const OUTCOME_META = {
  merged: { label: 'Merged', className: 'text-port-success' },
  rejected: { label: 'Rejected', className: 'text-port-error' },
  abandoned: { label: 'Abandoned', className: 'text-port-warning' },
  pending: { label: 'Open', className: 'text-gray-400' }
};

// The outcome/pending buckets, in the order the count strip renders them.
const COUNT_KEYS = ['merged', 'rejected', 'abandoned', 'pending'];

// How many recent rows the panel lists before collapsing the rest to a count —
// keeps the config tab compact (the API already caps the payload higher).
const RECENT_VISIBLE = 6;

function OutcomeBadge({ outcome }) {
  const meta = OUTCOME_META[outcome] || { label: outcome || 'Open', className: 'text-gray-400' };
  return <span className={`text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

export default function LayeredIntelligenceOutcomes({ appId }) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState({ status: 'loading', data: null });

  useEffect(() => {
    if (!appId) return;
    let active = true;
    setState({ status: 'loading', data: null });
    api.getAppLayeredIntelligenceOutcomes(appId)
      .then(res => { if (active) setState({ status: 'ready', data: res }); })
      .catch(() => { if (active) setState({ status: 'error', data: null }); });
    return () => { active = false; };
  }, [appId, nonce]);

  if (!appId) return null;

  const heading = (
    <div className="flex items-center gap-2">
      <BarChart3 size={14} className="text-port-accent shrink-0" />
      <span className="text-sm text-gray-400">Proposal outcomes</span>
    </div>
  );

  if (state.status === 'loading') {
    return (
      <div className="space-y-2">
        {heading}
        <p className="text-xs text-gray-500">Loading proposal outcomes…</p>
      </div>
    );
  }

  // A thrown request OR an explicit read:false (store unreadable) both mean we
  // can't show the record — distinct from a successful, empty history below.
  if (state.status === 'error' || !state.data?.read) {
    return (
      <div className="space-y-2">
        {heading}
        <Banner tone="error" size="sm">
          Couldn&apos;t load proposal outcomes for this app.
        </Banner>
        <button
          type="button"
          onClick={() => setNonce(n => n + 1)}
          className="text-xs px-3 py-1.5 bg-port-accent/20 text-port-accent hover:bg-port-accent/30 rounded"
        >
          Retry
        </button>
      </div>
    );
  }

  const { stats, execution, rejections, recent, tracked = true } = state.data;

  if (!stats || stats.total === 0) {
    return (
      <div className="space-y-2">
        {heading}
        {tracked ? (
          // "tracked" only means the store is being written now; proposals filed
          // BEFORE outcomes were enabled aren't backfilled, and resolved rows GC
          // ~30 days after they close — so scope the claim to the recent window
          // rather than asserting nothing was ever filed.
          <p className="text-xs text-gray-500">
            No recent tracked proposals. Once the loop files improvement issues, their outcomes (merge rate + why any were rejected) appear here — resolved ones drop off about 30 days after they close.
          </p>
        ) : (
          // The store is only written while the outcomes source is on, so an empty
          // history here doesn't mean the loop hasn't filed — it means nothing was
          // recorded. Say that instead of implying nothing was filed.
          <p className="text-xs text-gray-500">
            Outcome tracking is off for this app, so filed proposals aren&apos;t being recorded. Enable the <span className="text-gray-400">Proposal outcomes</span> telemetry source below to start tracking how they fare.
          </p>
        )}
      </div>
    );
  }

  const mergeRateText = stats.mergeRate == null ? '—' : `${Math.round(stats.mergeRate)}%`;
  const rejectionEntries = Array.isArray(rejections?.entries) ? rejections.entries : [];
  const unknown = rejections?.unknown || 0;
  const unclassified = rejections?.unclassified || 0;
  const visible = Array.isArray(recent) ? recent.slice(0, RECENT_VISIBLE) : [];
  // Count against the FULL population (`stats.total`), not just the fetched slice:
  // the API caps `recent` at a limit above what we render, so `recent.length` would
  // undercount the real remainder for an app with a long proposal history.
  const hiddenCount = Math.max(0, stats.total - visible.length);
  const executionScopes = Object.entries(execution?.byScope || {});

  return (
    <div className="space-y-3 bg-port-bg border border-port-border rounded-lg px-3 py-3">
      {heading}

      {!tracked && (
        // Records exist but the source is off now, so nothing new is recorded and
        // still-open proposals won't be reconciled — flag the data as possibly stale.
        <p className="text-xs text-port-warning">
          Outcome tracking is currently off — these may be stale. Re-enable the Proposal outcomes source below to keep them current.
        </p>
      )}

      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold text-white">{mergeRateText}</span>
        <span className="text-xs text-gray-500">
          merge rate
          {stats.resolved > 0
            ? ` — ${stats.merged} of ${stats.resolved} resolved merged`
            : ' — none resolved yet'}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="text-gray-500">{stats.total} filed:</span>
        {COUNT_KEYS.map(key => {
          const meta = OUTCOME_META[key];
          return (
            <span key={key} className="flex items-center gap-1">
              <span className={meta.className}>{stats[key]}</span>
              <span className="text-gray-500">{meta.label.toLowerCase()}</span>
            </span>
          );
        })}
      </div>

      {execution?.approved > 0 && (
        <div className="space-y-1 border-t border-port-border pt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold text-white">
              {execution.completionRate == null ? '—' : `${Math.round(execution.completionRate)}%`}
            </span>
            <span className="text-xs text-gray-500">post-approval hand-off completion</span>
          </div>
          <p className="text-xs text-gray-500">
            {execution.completed} completed · {execution.abandoned} abandoned · {execution.awaitingExecution} awaiting execution
          </p>
          {execution.duration?.count > 0 && (
            <p className="text-xs text-gray-500">
              Filed → completed: median {formatDurationMs(execution.duration.medianMs)} · p90 {formatDurationMs(execution.duration.p90Ms)}
            </p>
          )}
          {executionScopes.length > 0 && (
            <ul className="space-y-0.5">
              {executionScopes.map(([scope, summary]) => (
                <li key={scope} className="text-xs text-gray-500 flex justify-between gap-2">
                  <span className="min-w-0 break-all">{scope}</span>
                  <span className="shrink-0">
                    {summary.completionRate == null ? 'awaiting' : `${Math.round(summary.completionRate)}%`} · {summary.completed}/{summary.attempted || 0}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {(rejectionEntries.length > 0 || unknown > 0 || unclassified > 0) && (
        <div className="space-y-1">
          <span className="text-xs text-gray-500">Why non-merged proposals were closed</span>
          <ul className="space-y-0.5">
            {rejectionEntries.map(({ reason, count }) => (
              <li key={reason} className="text-xs text-gray-300 flex justify-between gap-2">
                <span>{formatLiRejectionReason(reason)}</span>
                <span className="text-gray-500 shrink-0">{count}</span>
              </li>
            ))}
            {unknown > 0 && (
              <li className="text-xs text-gray-500 flex justify-between gap-2">
                <span>closed with no recorded reason</span>
                <span className="shrink-0">{unknown}</span>
              </li>
            )}
            {unclassified > 0 && (
              <li className="text-xs text-gray-500 flex justify-between gap-2">
                <span>not yet classified</span>
                <span className="shrink-0">{unclassified}</span>
              </li>
            )}
          </ul>
        </div>
      )}

      {visible.length > 0 && (
        <div className="space-y-1">
          <span className="text-xs text-gray-500">Recent</span>
          <ul className="space-y-1">
            {visible.map(item => {
              const gloss = item.outcome !== 'merged' ? formatLiRejectionReason(item.rejectionReason) : '';
              const when = timeAgo(item.outcomeAt || item.filedAt);
              return (
                <li key={`${item.slug}-${item.filedAt}`} className="text-xs flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="text-gray-300 font-mono break-all">{item.slug}</span>
                    {item.scope && <span className="text-gray-500"> · {item.scope}</span>}
                    {gloss && <span className="block text-gray-500">{gloss}</span>}
                  </span>
                  <span className="flex flex-col items-end shrink-0">
                    <OutcomeBadge outcome={item.outcome || 'pending'} />
                    {when && <span className="text-gray-600">{when}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          {hiddenCount > 0 && (
            <p className="text-xs text-gray-600">+{hiddenCount} older</p>
          )}
        </div>
      )}
    </div>
  );
}
