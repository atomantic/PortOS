import { useEffect } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { timeUntil } from '../utils/formatters';

// Humanize a perpetual work-detector park reason for a user-facing toast. The
// raw reason strings are the same ones surfaced in the CoS → Schedule tab; here
// they get a plain-language gloss so an explicit "Run" that found nothing tells
// the user WHAT it checked rather than an opaque token.
const PARK_REASON_LABELS = {
  'no-actionable-issues': 'no claimable issues',
  'no-open-issues': 'no open issues',
  'no-in-flight-branches': 'no branches in flight',
  'no-zombie-issues': 'no stale issues to reconcile',
  'no-actionable-plan-items': 'no unblocked PLAN items',
  'no-progress': 'already up to date',
  'no-detector': 'no work detector for this task'
};

/**
 * Global subscriber that toasts when a user-initiated on-demand task run
 * produced no work. The server emits `cos:schedule:on-demand-empty` ONLY for
 * explicit "Run" triggers (never background parks), so this fires exactly when
 * the user is waiting for feedback and otherwise gets a silent no-op. Mount once
 * high in the tree (Layout), alongside useErrorNotifications.
 */
export function useOnDemandTaskToast() {
  useEffect(() => {
    socket.emit('cos:subscribe');

    const handleEmpty = (data) => {
      const task = data?.taskType || 'task';
      const scope = data?.appName ? ` for ${data.appName}` : '';

      // No park record ⇒ the detector did NOT park this run — a transient probe
      // failure (gh/glab down) or a non-perpetual skip. Never claim "nothing to
      // do" here; the check didn't complete.
      if (!data?.parked) {
        toast(`${task}${scope}: couldn't complete the check just now (a transient forge/network issue) — try again shortly.`, {
          duration: 7000,
          icon: '⚠️'
        });
        return;
      }

      const reasonLabel = PARK_REASON_LABELS[data?.parkReason] || data?.parkReason || 'nothing to do';

      // Detector breakdown ({ open, inFlight, filtered }) explains WHY an
      // apparently-full queue is empty — the common case being issues already
      // shipped whose stale claim branches still count as in-flight. Only shown
      // when the detector reported a denominator (open > 0).
      const c = data?.counts;
      let countSuffix = '';
      if (c && typeof c.open === 'number' && c.open > 0) {
        const parts = [];
        if (c.inFlight) parts.push(`${c.inFlight} in-flight`);
        if (c.filtered) parts.push(`${c.filtered} filtered`);
        const detail = parts.length ? ` — ${parts.join(', ')}` : '';
        countSuffix = ` (0 of ${c.open} claimable${detail})`;
      }

      const recheckSuffix = data?.parkedUntil
        ? ` Next auto-recheck ${timeUntil(data.parkedUntil, 'soon')}.`
        : '';

      // Re-checked live on this trigger — say so, since the confusing case is a
      // "parked until <future>" line that reads like a cached refusal.
      toast(`${task}${scope}: re-checked now — ${reasonLabel}${countSuffix}.${recheckSuffix}`, {
        duration: 7000,
        icon: '💤'
      });
    };

    socket.on('cos:schedule:on-demand-empty', handleEmpty);
    return () => {
      socket.off('cos:schedule:on-demand-empty', handleEmpty);
      // Don't unsubscribe from cos — other components share the room.
    };
  }, []);
}
