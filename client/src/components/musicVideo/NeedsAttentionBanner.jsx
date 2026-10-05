import { useState } from 'react';
import { AlertTriangle, ExternalLink, Link2, Play, X } from 'lucide-react';
import { Link } from 'react-router';
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
    case 'autonomous':
      return (
        <>
          {item.canResume && (
            <button type="button" disabled={busy} aria-label={`${item.resumeLabel} the autonomous run`} onClick={() => actions.onResumeAutonomous?.()} className={PRIMARY}>
              <Play size={12} aria-hidden="true" /> {item.resumeLabel}
            </button>
          )}
          <OpenLink item={item} />
        </>
      );
    case 'production':
      return (
        <>
          {item.canResume && (
            <button type="button" disabled={busy} aria-label="Resume production" onClick={() => actions.onResumeProduction?.(item.runId, item.acceptBasis ? { acceptBasis: true } : {})} className={PRIMARY}>
              <Play size={12} aria-hidden="true" /> Resume
            </button>
          )}
          <OpenLink item={item} />
        </>
      );
    case 'auto-review-parked':
      return (
        <>
          {item.canResume && (
            <button type="button" disabled={busy} aria-label="Resume the stopped auto-review run" onClick={() => actions.onContinueAutoReview?.(item.runId)} className={PRIMARY}>
              <Play size={12} aria-hidden="true" /> Resume
            </button>
          )}
          <OpenLink item={item} />
          <button type="button" disabled={busy} aria-label="Cancel the stopped auto-review run" onClick={() => actions.onCancelAutoReview?.(item.runId)} className={DANGER}>
            <X size={12} aria-hidden="true" /> Cancel run
          </button>
        </>
      );
    case 'stale-approvals':
      return <OpenLink item={item} />;
    default:
      return null;
  }
}

// Opens the tab (and anchor) the row's state is cleared from.
function OpenLink({ item }) {
  return (
    <Link to={`/music-video/${encodeURIComponent(item.projectId)}/${item.openTo}`} aria-label={`Open ${item.title}`} className={PRIMARY}>
      <ExternalLink size={12} aria-hidden="true" /> Open
    </Link>
  );
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
 * `onCancelAutoReview(runId)`, `onReattachRender()`, and for the parked-run
 * rows `onResumeAutonomous()` / `onResumeProduction(runId, opts)`). Renders nothing when
 * there is nothing to attend to.
 */
export default function NeedsAttentionBanner({ items, busy = false, actions = {} }) {
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  const countLabel = items.length === 1 ? '1 needs attention' : `${items.length} need attention`;
  return (
    <section
      id={ATTENTION_ANCHOR_ID}
      aria-label="Needs attention"
      className="text-xs sm:max-h-[40vh] sm:space-y-1.5 sm:overflow-y-auto sm:rounded sm:border sm:border-port-warning/40 sm:bg-port-warning/5 sm:p-2"
    >
      <button
        type="button"
        className="inline-flex h-8 items-center gap-1 rounded border border-port-warning/40 bg-port-warning/5 px-2 font-medium text-port-warning sm:hidden"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AlertTriangle size={12} aria-hidden="true" /> {countLabel}
      </button>
      <div className={open ? 'max-sm:mt-1.5 max-sm:max-h-[40vh] max-sm:space-y-1.5 max-sm:overflow-y-auto max-sm:rounded max-sm:border max-sm:border-port-warning/40 max-sm:bg-port-warning/5 max-sm:p-2' : 'max-sm:hidden'}>
        <h3 className="flex items-center gap-1 font-medium text-port-warning">
          <AlertTriangle size={12} aria-hidden="true" /> Needs attention
        </h3>
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1 basis-60">
                <span className="font-medium">{item.title}</span>
                <span className="block text-port-text-muted">{item.detail}</span>
                {item.scenes?.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1.5">
                    {item.scenes.map((s) => (
                      <Link
                        key={s.sceneId}
                        to={`/music-video/${item.projectId || ''}/board/scene/${s.sceneId}`}
                        className="rounded bg-port-accent/10 px-1.5 py-0.5 text-[11px] text-port-accent hover:underline"
                      >
                        {s.label || `Scene ${(s.order ?? 0) + 1}`}
                      </Link>
                    ))}
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <ItemActions item={item} busy={busy} actions={actions} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
