import { Clock } from 'lucide-react';
import ProgressBar from '../ui/ProgressBar';
import { timeAgo, timeUntil } from '../../utils/formatters';

/**
 * One quota window's meter — the shared rendering for a `limits[]` entry from
 * `GET /api/usage/providers`.
 *
 * Extracted from the Usage page (#7403) when the Subscriptions page needed the
 * same meter beside each plan's price and toggle. Two copies would have drifted
 * on the part that matters most: the colour thresholds that tell the user a
 * plan is nearly spent.
 *
 * The bar itself is `ui/ProgressBar`, which owns the clamp and the
 * `role="progressbar"` + `aria-valuenow` trio this markup was missing — the
 * seventh hand-rolled track was not the place to re-learn that lesson.
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

/**
 * Color a meter by how much of the window is consumed: comfortable → warning →
 * critical, as ProgressBar's semantic tones. An unread percentage is `muted`,
 * never `success` — "we didn't measure it" must not read as "plenty left".
 */
export function meterTone(percentUsed) {
  if (percentUsed == null) return 'muted';
  if (percentUsed >= 90) return 'error';
  if (percentUsed >= 70) return 'warning';
  return 'success';
}

// How old a STAND-IN reading has to be before the meter says so. A federated
// card takes the freshest reading per window across machines, so a meter can be
// another instance's — fine when it was read moments ago, misleading once it is
// hours behind, because the account it describes has been spent since. Local
// readings (`readBy` null) are never captioned: their age is the card's own.
const STALE_READING_MS = 60 * 60 * 1000;

export function readingAttribution(limit) {
  if (!limit?.readBy) return null;
  // `?? ''` because an undated contribution carries `readAt: null`, and
  // `new Date(null)` is the epoch — a date, and a very stale one.
  const readMs = new Date(limit.readAt ?? '').getTime();
  const dated = Number.isFinite(readMs);
  if (dated && Date.now() - readMs < STALE_READING_MS) return null;
  const who = limit.readByName || 'another instance';
  return dated ? `read ${timeAgo(readMs)} on ${who}` : `read on ${who}`;
}

export default function UsageMeter({ limit }) {
  const used = limit.percentUsed ?? 0;
  const remaining = limit.percentRemaining;
  const attribution = readingAttribution(limit);
  return (
    <div className="py-1 sm:py-2 border-b border-port-border last:border-0">
      <div className="flex items-baseline justify-between gap-2 mb-0.5 sm:mb-1">
        <span className="text-white text-xs sm:text-base truncate" title={limit.label}>{limit.label}</span>
        <span className="shrink-0 text-gray-400 text-[10px] sm:text-sm">
          {remaining == null ? '—' : `${remaining}% left`}
        </span>
      </div>
      <ProgressBar percent={used} tone={meterTone(limit.percentUsed)} label={`${limit.label} quota used`} />
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-0.5 sm:gap-1 mt-0.5 sm:mt-1">
        {/* An unread percentage reads '—', never '0% used' — the same rule the
            remainder beside it and meterTone already keep. A plan that may be
            fully spent must not render as untouched. */}
        <span className="text-[9px] sm:text-xs text-gray-500">
          {limit.percentUsed == null ? '—' : `${used}% used`}
          {attribution && <span className="text-gray-600"> · {attribution}</span>}
        </span>
        {limit.resetsAt && (
          <span className="flex min-w-0 text-[9px] sm:text-xs text-gray-500 items-start sm:justify-end gap-1 sm:text-right leading-tight">
            <Clock size={11} className="shrink-0" /> resets {formatResetsAt(limit.resetsAt)}
          </span>
        )}
      </div>
    </div>
  );
}
