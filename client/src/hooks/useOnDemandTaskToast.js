import { useEffect } from 'react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { timeUntil } from '../utils/formatters';
import { formatLiReason } from '../utils/layeredIntelligenceReasons';

// Humanize a perpetual work-detector park reason for a user-facing toast. The
// raw reason strings are the same ones surfaced in the CoS → Schedule tab; here
// they get a plain-language gloss so an explicit "Run" that found nothing tells
// the user WHAT it checked rather than an opaque token.
const PARK_REASON_LABELS = {
  'no-actionable-issues': 'no claimable issues',
  'no-open-issues': 'no open issues',
  'no-authored-issues': 'open issues exist, but none match the author filter — set it to "any"',
  'owner-is-org': 'the "owner" filter matches an org, which can\'t author issues — set it to "self" or "any"',
  'owner-is-group': 'the "owner" filter matches a group, which can\'t author issues — set it to "self" or "any"',
  'no-in-flight-branches': 'no branches in flight',
  'branches-held-by-live-owners': 'the only branches left belong to sessions still running — nothing to finish',
  'merged-branches-held-back': 'every remaining branch is already merged and waiting on a protected worktree',
  'no-zombie-issues': 'no stale issues to reconcile',
  'no-actionable-plan-items': 'no unblocked PLAN items',
  'no-progress': 'already up to date',
  'drain-cap': 'paused after several back-to-back runs — the rest waits for the next scheduled check',
  'no-detector': 'no work detector for this task'
};

// pr-reviewer's on-demand skip reasons (server: runPrReviewerSecurityPreflight in
// cosTaskGenerator.js). An unlisted code falls back to the raw string rather than
// the generic "nothing to do" — the reason IS the actionable detail here, since a
// per-PR "Review this PR" trigger names a specific PR the maintainer wants reviewed.
const PR_REVIEWER_REASON_LABELS = {
  'parked': 'paused after repeated failures — it will retry on its normal cadence',
  'no-external-open-prs': 'no open external pull requests to review',
  'target-pull-request-not-reviewable': "that pull request isn't eligible right now (not open against the default branch, or authored by a trusted collaborator)",
  'security-scan-report-pending': 'a security scan for this pull request is already in progress',
  'security-guard-not-ready': "the local model-abuse classifier (Settings → Models → LLMs → Abuse Guard) isn't ready — finish or repair its setup, then try again",
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

      // A perpetual task that did NOT park ⇒ the detector couldn't complete (a
      // gh/glab probe failure). Never claim "nothing to do" — the check didn't
      // finish. When the server classified the forge CLI as broken in a way that
      // will NOT clear on its own (not installed / not authenticated / blocked
      // outbound), say THAT and give the remedy — "try again shortly" is a dead
      // end when every future tick fails identically.
      if (data?.outcome === 'transient') {
        const forge = data?.forge;
        toast(forge?.remedy
          ? `${task}${scope}: the ${forge.cli} check couldn't run — ${forge.remedy}`
          : `${task}${scope}: couldn't complete the check just now (a transient forge/network issue) — try again shortly.`, {
          duration: forge?.remedy ? 12000 : 7000,
          icon: '⚠️'
        });
        return;
      }

      // A non-perpetual task produced no task ⇒ genuinely nothing to do right
      // now (not a failure, not a park). Keep it calm and neutral — UNLESS the
      // server surfaced an actionable reason (e.g. Layered Intelligence pinned to
      // an api-only provider that can't drive the reasoning agent). Then say WHY
      // and warn, so a misconfiguration isn't hidden behind "nothing to do".
      if (data?.outcome === 'idle') {
        if (data?.taskType === 'layered-intelligence' && data?.reason) {
          toast(`${task}${scope}: ${formatLiReason({ action: 'skipped', reason: data.reason })}.`, {
            duration: 8000,
            icon: '⚠️'
          });
          return;
        }
        if (data?.taskType === 'pr-reviewer' && data?.reason) {
          toast(`${task}${scope}: ${PR_REVIEWER_REASON_LABELS[data.reason] || data.reason}.`, {
            duration: 8000,
            icon: '⚠️'
          });
          return;
        }
        toast(`${task}${scope}: re-checked now — nothing to do right now.`, {
          duration: 6000,
          icon: '💤'
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
      // branch-reconcile's breakdown instead names merged branches whose worktree
      // a protection guard still holds — the park is a wait, not an empty repo, so
      // the count has to show or the toast reads as "nothing exists".
      if (c && typeof c.heldBackMerged === 'number' && c.heldBackMerged > 0) {
        countSuffix = ` (${c.heldBackMerged} merged branch(es) held back)`;
      } else if (c && typeof c.open === 'number' && c.open > 0) {
        const parts = [];
        if (c.inFlight) parts.push(`${c.inFlight} in-flight`);
        if (c.filtered) parts.push(`${c.filtered} filtered`);
        const detail = parts.length ? ` — ${parts.join(', ')}` : '';
        countSuffix = ` (0 of ${c.open} open${detail})`;
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
