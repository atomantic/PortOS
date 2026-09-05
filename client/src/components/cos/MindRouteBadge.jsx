import { Cpu } from 'lucide-react';
import { classifyMindRouteBilling, formatMindRoute, MIND_ROUTE_BILLING } from '../../lib/mindThinkingPresets.js';

const BILLING_TONE = Object.freeze({
  [MIND_ROUTE_BILLING.LOCAL]: 'border-port-success/30 bg-port-success/10 text-port-success',
  // An unclassifiable route is warned about exactly like an account-backed one:
  // the user's decision is the same either way.
  [MIND_ROUTE_BILLING.ACCOUNT]: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
  [MIND_ROUTE_BILLING.UNKNOWN]: 'border-port-warning/40 bg-port-warning/10 text-port-warning',
});

/**
 * One exact provider/model/effort route, plus what taking it can spend.
 *
 * The single rendering for "which model is this", shared by the preset list,
 * the composer preview, the live-route panel and the session receipts, so the
 * page cannot describe the same route four different ways — and so an
 * account-backed or unclassifiable route is warned about identically wherever
 * it appears.
 *
 * `route` is a plain `{ providerId, model, effort }` descriptor. `provider` is
 * the matching record from the provider catalog, or null when the catalog has
 * not settled or no longer lists it — which is itself reported, as unknown
 * rather than as free.
 */
export default function MindRouteBadge({ route, provider = null, className = '', showBilling = true }) {
  const billing = classifyMindRouteBilling(provider);
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className="truncate font-mono text-[11px] text-port-text">
        {formatMindRoute(route, { providerName: provider?.name || null })}
      </span>
      {showBilling && (
        <span
          title={billing.detail}
          className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${BILLING_TONE[billing.billing]}`}
        >
          <Cpu size={10} aria-hidden="true" /> {billing.label}
        </span>
      )}
    </span>
  );
}

export { BILLING_TONE };
