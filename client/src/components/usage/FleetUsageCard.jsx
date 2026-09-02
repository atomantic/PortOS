import { useState } from 'react';
import { Network } from 'lucide-react';
import Pill from '../ui/Pill';
import ToggleSwitch from '../ToggleSwitch';
import toast from '../ui/Toast';
import * as api from '../../services/api';
import { formatCompactCountOrDash as formatNumber, formatUsd, timeAgo } from '../../utils/formatters';

/**
 * Overlay the viewer's in-flight Subscriptions toggles onto a fleet payload
 * and re-sum the combined total from the rows that still count. Used by the
 * card so a click updates the numbers immediately, and by the tests so they
 * can assert the same math the UI shows.
 */
export function applyFleetBilling(fleet, overrides = {}) {
  const instances = (fleet?.instances || []).map((row) => {
    const usesSubscriptions = Object.hasOwn(overrides, row.instanceId)
      ? overrides[row.instanceId]
      : row.usesSubscriptions !== false;
    return { ...row, usesSubscriptions };
  });
  const included = instances.filter((row) => row.usesSubscriptions);
  const totals = included.reduce((acc, r) => {
    for (const [field, value] of Object.entries(r.totals || {})) {
      if (typeof value === 'number') acc[field] = (acc[field] || 0) + value;
    }
    return acc;
  }, {});
  totals.estimatedCost = Math.round((totals.estimatedCost || 0) * 100) / 100;
  return { instances, totals, includedCount: included.length };
}

function BillingToggle({ row, disabled, onToggle }) {
  const name = row.name || row.instanceId;
  return (
    <ToggleSwitch
      size="sm"
      enabled={row.usesSubscriptions}
      disabled={disabled}
      onChange={() => onToggle(row)}
      ariaLabel={row.usesSubscriptions
        ? `Count ${name} toward subscription totals`
        : `Exclude ${name} from subscription totals (pays API rates)`}
    />
  );
}

/**
 * Per-instance AI usage across the federation, for the same report window the
 * rest of the page is showing.
 *
 * Renders nothing below two instances: a single-machine install has nothing to
 * compare against, and a one-row "fleet" is noise rather than information.
 *
 * A peer row is only as fresh as the last sync cycle, so each states when its
 * digest was captured rather than implying it is live.
 *
 * Each row has a Subscriptions toggle. Off means this instance pays API rates
 * rather than the viewer's plans: the row stays listed but drops out of the
 * combined total. The choice is this install's view and is persisted locally.
 */
export default function FleetUsageCard({ fleet, onSaved }) {
  const [overrides, setOverrides] = useState({});
  const [pending, setPending] = useState({});

  const rows = fleet?.instances || [];
  if (rows.length < 2) return null;

  const view = applyFleetBilling(fleet, overrides);
  const excludedCount = view.instances.length - view.includedCount;
  const combinedLabel = excludedCount > 0
    ? `${view.includedCount} of ${view.instances.length} instances on subscriptions`
    : `${view.instances.length} instances combined`;

  const label = (row) => (row.self
    ? <Pill tone="context" size="xs" className="ml-2">This machine</Pill>
    : row.capturedAt && (
      <span className="ml-2 text-[10px] text-gray-500" title={row.capturedAt}>
        synced {timeAgo(row.capturedAt)}
      </span>
    ));

  const toggleBilling = async (row) => {
    const next = !row.usesSubscriptions;
    setOverrides((prev) => ({ ...prev, [row.instanceId]: next }));
    setPending((prev) => ({ ...prev, [row.instanceId]: true }));
    const ok = await api.updateUsageFleetBilling(
      { instanceId: row.instanceId, usesSubscriptions: next },
      { silent: true },
    ).then(() => true).catch((err) => {
      toast.error(err?.message || 'Failed to update instance billing');
      return false;
    });
    if (!ok) {
      // Revert the optimistic overlay; a successful save keeps it so a slow
      // refetch can't flash the old combined total back onto the card.
      setOverrides((prev) => {
        const copy = { ...prev };
        delete copy[row.instanceId];
        return copy;
      });
    } else {
      await onSaved?.();
    }
    setPending((prev) => {
      const copy = { ...prev };
      delete copy[row.instanceId];
      return copy;
    });
  };

  const rowClass = (row) => (row.usesSubscriptions ? 'text-white' : 'text-gray-500');

  const instanceLabel = (row) => (
    <>
      <span className={`font-medium truncate ${rowClass(row)}`}>{row.name}</span>
      {label(row)}
      {!row.usesSubscriptions && <Pill tone="warning" size="xs" className="ml-2 shrink-0">API billed</Pill>}
    </>
  );

  return (
    <div className="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-2">
        <div>
          <h3 className="text-sm font-medium text-gray-400 flex items-center gap-1.5">
            <Network size={15} className="text-port-accent" />
            Across Instances
          </h3>
          <p className="text-[10px] sm:text-xs text-gray-500 mt-0.5">
            Every federated instance&rsquo;s usage over this period, priced the same way.
            Turn off Subscriptions on a machine that pays API rates so it stays listed but is left out of the combined total.
          </p>
        </div>
        <div className="text-left sm:text-right">
          <div className="text-xl font-bold text-port-success">{formatUsd(view.totals?.estimatedCost)}</div>
          <div className="text-[10px] sm:text-xs text-gray-500">{combinedLabel}</div>
        </div>
      </div>

      {/* Mobile view (< sm): card list, so the numbers stay readable without a
          horizontal scroll — same pairing the cost report uses. */}
      <div className="block sm:hidden space-y-2">
        {view.instances.map((row) => (
          <div key={row.instanceId} className={`bg-port-bg border border-port-border rounded-lg p-3 space-y-2 ${row.usesSubscriptions ? '' : 'opacity-70'}`}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center min-w-0 text-sm">
                {instanceLabel(row)}
              </div>
              <span className="text-sm font-semibold text-port-success shrink-0">{formatUsd(row.totals?.estimatedCost)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-gray-500">Subscriptions</span>
              <BillingToggle row={row} disabled={Boolean(pending[row.instanceId])} onToggle={toggleBilling} />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs bg-port-card/50 p-2 rounded border border-port-border/50">
              <div>
                <span className="text-gray-500 block text-[10px]">Sessions</span>
                <span className="text-white font-medium">{formatNumber(row.totals?.sessions)}</span>
              </div>
              <div>
                <span className="text-gray-500 block text-[10px]">Messages</span>
                <span className="text-white font-medium">{formatNumber(row.totals?.messages)}</span>
              </div>
              <div className="col-span-2">
                <span className="text-gray-500 block text-[10px]">Tokens (In / Out)</span>
                <span className="text-white font-medium">
                  {formatNumber(row.totals?.tokensIn)} / {formatNumber(row.totals?.tokensOut)}
                </span>
              </div>
            </div>
          </div>
        ))}
        <div className="bg-port-bg border border-port-border rounded-lg p-3 flex items-center justify-between text-xs font-semibold text-white">
          <span>Fleet total</span>
          <span className="text-port-success text-sm">{formatUsd(view.totals?.estimatedCost)}</span>
        </div>
      </div>

      {/* Desktop view (>= sm): table layout */}
      <div className="hidden sm:block overflow-x-auto">
        <table className="w-full text-sm min-w-[520px]">
          <thead>
            <tr className="text-left text-xs text-gray-500 border-b border-port-border">
              <th className="py-2 pr-2 font-medium">Instance</th>
              <th className="py-2 px-2 font-medium text-center" title="On your subscriptions. Turn off if this instance pays API rates.">Subscriptions</th>
              <th className="py-2 px-2 font-medium text-right">Sessions</th>
              <th className="py-2 px-2 font-medium text-right">Messages</th>
              <th className="py-2 px-2 font-medium text-right">Tokens In</th>
              <th className="py-2 px-2 font-medium text-right">Tokens Out</th>
              <th className="py-2 pl-2 font-medium text-right">Est. API Cost</th>
            </tr>
          </thead>
          <tbody>
            {view.instances.map((row) => (
              <tr key={row.instanceId} className={`border-t border-port-border ${rowClass(row)}`}>
                <td className="py-2 pr-2">
                  {instanceLabel(row)}
                </td>
                <td className="py-2 px-2">
                  <div className="flex justify-center">
                    <BillingToggle row={row} disabled={Boolean(pending[row.instanceId])} onToggle={toggleBilling} />
                  </div>
                </td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.sessions)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.messages)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.tokensIn)}</td>
                <td className="py-2 px-2 text-right">{formatNumber(row.totals?.tokensOut)}</td>
                <td className="py-2 pl-2 text-right text-port-success">{formatUsd(row.totals?.estimatedCost)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-port-border font-semibold text-white">
              <td className="py-2 pr-2" colSpan={2}>Fleet total</td>
              <td className="py-2 px-2 text-right">{formatNumber(view.totals?.sessions)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(view.totals?.messages)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(view.totals?.tokensIn)}</td>
              <td className="py-2 px-2 text-right">{formatNumber(view.totals?.tokensOut)}</td>
              <td className="py-2 pl-2 text-right text-port-success">{formatUsd(view.totals?.estimatedCost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
