import { AlertTriangle, Link2, Play, X } from 'lucide-react';
import { ATTENTION_ANCHOR_ID } from '../../lib/musicVideoAttention.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2.5 text-xs disabled:opacity-50 sm:min-h-0 sm:py-1';
const PRIMARY = `${BUTTON} text-port-accent`;
const DANGER = `${BUTTON} text-port-error`;

// The inline exits for one row. Each names what it acts on, so two rows never
// share an accessible name.
function ItemActions({ item, busy, actions }) {
  switch (item.kind) {
    case 'revision':
      return (
        <>
          {item.canResume && (
            <button type="button" disabled={busy} aria-label="Resume the open revision" onClick={() => actions.onResumeRevision?.(item.revisionId)} className={PRIMARY}>
              <Play size={12} aria-hidden="true" /> Resume
            </button>
          )}
          <button type="button" disabled={busy} aria-label="Cancel the open revision" onClick={() => actions.onCancelRevision?.(item.revisionId)} className={DANGER}>
            <X size={12} aria-hidden="true" /> Cancel
          </button>
        </>
      );
    case 'cast-and-sets':
      return (
        <button type="button" disabled={busy} aria-label="Resume the Cast & Sets check-in" onClick={() => actions.onResumeCastAndSets?.()} className={PRIMARY}>
          <Play size={12} aria-hidden="true" /> Resume
        </button>
      );
    case 'auto-review':
      return (
        <>
          <button type="button" disabled={busy} aria-label="Continue the auto-review run" onClick={() => actions.onContinueAutoReview?.(item.runId)} className={PRIMARY}>
            <Play size={12} aria-hidden="true" /> Continue
          </button>
          <button type="button" disabled={busy} aria-label="Cancel the auto-review run" onClick={() => actions.onCancelAutoReview?.(item.runId)} className={DANGER}>
            <X size={12} aria-hidden="true" /> Cancel run
          </button>
        </>
      );
    case 'final-render':
      return (
        <button type="button" disabled={busy} aria-label="Reattach to the final render" onClick={() => actions.onReattachRender?.()} className={PRIMARY}>
          <Link2 size={12} aria-hidden="true" /> Reattach
        </button>
      );
    default:
      return null;
  }
}

/**
 * The Music Video header's "Needs attention" banner (#9940): one row per
 * server-held state a client-orchestrated workflow can strand — an open
 * revision, an interrupted Cast & Sets stage, an auto-review waiting on its
 * revised sections, a final render nobody is watching — each with the inline
 * exit (Resume / Continue / Cancel / Reattach) so a recoverable record never
 * looks permanently stuck. `items` comes from `deriveAttentionItems`; `actions`
 * are the page's handlers (`onResumeRevision(id)`, `onCancelRevision(id)`,
 * `onResumeCastAndSets()`, `onContinueAutoReview(runId)`,
 * `onCancelAutoReview(runId)`, `onReattachRender()`). Renders nothing when
 * there is nothing to attend to.
 */
export default function NeedsAttentionBanner({ items, busy = false, actions = {} }) {
  if (!items?.length) return null;
  return (
    <section
      id={ATTENTION_ANCHOR_ID}
      aria-label="Needs attention"
      className="max-h-[40vh] space-y-1.5 overflow-y-auto rounded border border-port-warning/40 bg-port-warning/5 p-2 text-xs"
    >
      <h3 className="flex items-center gap-1 font-medium text-port-warning">
        <AlertTriangle size={12} aria-hidden="true" /> Needs attention
      </h3>
      <ul className="space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 basis-60">
              <span className="font-medium">{item.title}</span>
              <span className="block text-port-text-muted">{item.detail}</span>
            </span>
            <span className="flex flex-wrap items-center gap-2">
              <ItemActions item={item} busy={busy} actions={actions} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
