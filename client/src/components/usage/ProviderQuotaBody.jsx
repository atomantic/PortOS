import { AlertTriangle } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import UsageMeter from './UsageMeter';
import { formatCompactCount } from '../../utils/formatters';

/**
 * The state ladder a subscription-quota reading renders through:
 * unsupported → still reading → errored → nothing to meter → meters.
 *
 * Extracted from the Usage page's `ProviderQuotaCard` (#7403) when the
 * Subscriptions page needed the same reading beside each plan. It had already
 * started to drift in its first copy — an inverted branch order, different
 * empty-state copy, and a dropped `metrics[]` branch, which is exactly the
 * branch that exists for a backend whose quota cannot be queried at all. One
 * ladder means a new provider shape is handled everywhere at once.
 *
 * Body only: the header, plan pill and per-card Refresh belong to each host,
 * because the Usage card and a Subscriptions row frame the same reading very
 * differently.
 */

// Small labelled stat, used for both the per-period activity counts and the
// `metrics[]` a backend returns when its quota can't be queried at all.
export function StatTile({ label, value, detail }) {
  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-1.5 sm:p-2.5">
      <div className="text-[10px] sm:text-xs text-gray-400 mb-0.5">{label}</div>
      <div className="text-xs sm:text-sm text-white">{value}</div>
      {detail && <div className="text-[9px] sm:text-xs text-gray-500 mt-0.5">{detail}</div>}
    </div>
  );
}

export default function ProviderQuotaBody({ quota, showActivity = true, showNote = true }) {
  if (!quota) return null;
  if (!quota.supported) {
    return (
      <p className="text-xs sm:text-sm text-gray-500">
        {quota.note || 'Usage reporting is not available for this provider.'}
      </p>
    );
  }

  // The reading is still being taken. It comes BEFORE the error and empty
  // branches because a pending card has no limits — rendering it through those
  // says "No rate-limit data reported", which is a verdict about the provider
  // rather than a statement about a scrape still in flight.
  if (quota.pending) {
    return (
      <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-gray-400 py-1">
        <BrailleSpinner />
        <span>{quota.note || 'Reading quota…'}</span>
      </div>
    );
  }

  // `error` is also how a card that read fine says it has nothing to meter, so
  // the note rides along — otherwise the one state where the reading's age
  // matters most is the one state that hides it.
  if (quota.error) {
    return (
      <div role="status" className="flex items-start gap-1.5 sm:gap-2 text-xs sm:text-sm text-gray-400 py-1">
        <AlertTriangle size={15} className="text-port-warning mt-0.5 shrink-0" />
        <span>
          {quota.error}
          {quota.note && <span className="block text-xs text-gray-500 mt-1">{quota.note}</span>}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-1 sm:space-y-2">
      {quota.limits?.length > 0 && (
        <div>
          {quota.limits.map((limit) => (
            <UsageMeter key={limit.key} limit={limit} />
          ))}
        </div>
      )}

      {!quota.limits?.length && !quota.metrics?.length && (
        <div className="text-xs sm:text-sm text-gray-500">No rate-limit data reported</div>
      )}

      {/* Backends with no queryable quota report observed counts instead of
          a meter — a percentage we cannot measure must not be invented. */}
      {quota.metrics?.length > 0 && (
        // One tile per row on a phone: these cells sit inside an already
        // half-width mobile card, and two columns of it wrapped a tile's
        // label and detail onto four lines apiece.
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {quota.metrics.map((m) => (
            <StatTile key={m.key} label={m.label} value={m.value} detail={m.detail} />
          ))}
        </div>
      )}

      {showActivity && quota.activity?.length > 0 && (
        <div className="hidden sm:grid sm:grid-cols-2 gap-2 pt-1">
          {quota.activity.map((a) => (
            <StatTile
              key={a.period}
              label={a.period}
              value={(
                <>
                  {formatCompactCount(a.requests)} requests
                  <span className="mx-2 text-gray-600">•</span>
                  {formatCompactCount(a.sessions)} sessions
                </>
              )}
            />
          ))}
        </div>
      )}

      {showNote && quota.note && (
        <p className="hidden sm:block text-xs text-gray-500">{quota.note}</p>
      )}
    </div>
  );
}
