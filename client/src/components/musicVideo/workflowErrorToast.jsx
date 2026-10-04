import toast from '../ui/Toast';
import { revealAttention } from '../../lib/musicVideoAttention.js';

/**
 * Toast a failed Music Video workflow request (production, auto-review or a
 * revision start). A refusal because a revision is open (`REVISION_IN_PROGRESS`
 * — the server's `context.revisionId` names it) carries a "Show revision" link
 * to the "Needs attention" banner, where Resume and Cancel live, instead of a
 * dead-end message about a revision the page does not point to (#9940).
 *
 * `reload()` refreshes the local record first: the revision may have been
 * opened where this tab never saw it, and the banner can only show what the
 * local project holds.
 */
export function toastWorkflowError(err, fallback, { reload } = {}) {
  if (err?.code !== 'REVISION_IN_PROGRESS') {
    toast.error(err?.message || fallback);
    return;
  }
  Promise.resolve(reload?.()).catch(() => {});
  toast.error((t) => (
    <span className="flex flex-wrap items-center gap-3 text-xs">
      <span className="text-gray-200">{err.message || 'Finish or cancel the open revision first'}</span>
      <button
        type="button"
        onClick={() => { revealAttention(); toast.dismiss(t.id); }}
        className="inline-flex min-h-[44px] shrink-0 items-center rounded border border-port-border px-2 py-0.5 text-[11px] text-port-accent hover:border-port-accent/40 hover:text-white sm:min-h-0"
      >
        Show revision
      </button>
    </span>
  ), { duration: 12000, label: 'An open revision is blocking this' });
}
