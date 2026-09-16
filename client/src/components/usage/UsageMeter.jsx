import { Clock } from 'lucide-react';
import { timeUntil } from '../../utils/formatters';

/**
 * One quota window's meter — the shared rendering for a `limits[]` entry from
 * `GET /api/usage/providers`.
 *
 * Extracted from the Usage page (#7403) when the Subscriptions page needed the
 * same meter beside each plan's price and toggle. Two copies would have drifted
 * on the part that matters most: the colour thresholds that tell the user a
 * plan is nearly spent.
 */

// Every provider adapter normalizes its reset to ISO before it reaches here, so
// this localizes and adds the relative "in 3h" that makes a reset time useful at
// a glance. The raw-text fallback stays for a reading off an older peer that
// still emits its CLI's own wording.
export const formatResetsAt = (resetsAt) => {
  if (!resetsAt || !/^\d{4}-\d{2}-\d{2}T/.test(resetsAt)) return resetsAt;
  const d = new Date(resetsAt);
  if (Number.isNaN(d.getTime())) return resetsAt;
  const local = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const relative = timeUntil(d, '');
  return relative ? `${local} (${relative})` : local;
};

// Color a usage meter by how much is consumed: comfortable → warning → critical.
export function meterColor(percentUsed) {
  if (percentUsed == null) return 'bg-gray-500';
  if (percentUsed >= 90) return 'bg-port-error';
  if (percentUsed >= 70) return 'bg-port-warning';
  return 'bg-port-success';
}

export default function UsageMeter({ limit }) {
  const used = limit.percentUsed ?? 0;
  const remaining = limit.percentRemaining;
  return (
    <div className="py-1 sm:py-2 border-b border-port-border last:border-0">
      <div className="flex items-baseline justify-between gap-2 mb-0.5 sm:mb-1">
        <span className="text-white text-xs sm:text-base truncate" title={limit.label}>{limit.label}</span>
        <span className="shrink-0 text-gray-400 text-[10px] sm:text-sm">
          {remaining == null ? '—' : `${remaining}% left`}
        </span>
      </div>
      <div className="h-1.5 sm:h-2 rounded-full bg-port-bg overflow-hidden">
        <div
          className={`h-full rounded-full ${meterColor(limit.percentUsed)}`}
          style={{ width: `${Math.min(100, Math.max(0, used))}%` }}
        />
      </div>
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-0.5 sm:gap-1 mt-0.5 sm:mt-1">
        <span className="text-[9px] sm:text-xs text-gray-500">{used}% used</span>
        {limit.resetsAt && (
          <span className="flex min-w-0 text-[9px] sm:text-xs text-gray-500 items-start sm:justify-end gap-1 sm:text-right leading-tight">
            <Clock size={11} className="shrink-0" /> resets {formatResetsAt(limit.resetsAt)}
          </span>
        )}
      </div>
    </div>
  );
}
