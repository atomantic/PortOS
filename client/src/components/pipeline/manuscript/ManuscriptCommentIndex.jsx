/**
 * Sidebar index for editorial comments — a navigable, filterable list rather
 * than the primary reading surface (the feedback now lives in-context in the
 * manuscript). Filter by severity; open notes list first, with collapsible
 * Accepted / Dismissed groups. A row reveals + opens that note in the manuscript.
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Check, X, MapPin } from 'lucide-react';
import { Badge, CommentCardFromProps } from './ManuscriptCommentCard';

const SEVERITIES = ['high', 'medium', 'low'];

function CommentRow({ comment, located, active, onReveal }) {
  return (
    <button
      type="button"
      onClick={() => onReveal(comment)}
      className={`block w-full text-left border rounded p-2 bg-port-bg/30 hover:border-port-accent/40 ${active ? 'border-port-accent/60' : 'border-port-border'}`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <Badge comment={comment} />
        <span className="flex items-center gap-1 text-[10px] text-gray-500">
          {comment.issueNumber != null ? `Issue ${comment.issueNumber}` : '—'}
          {located ? <MapPin size={10} className="text-port-accent" title="Located in the manuscript text" /> : null}
        </span>
      </div>
      <span className="text-[11px] text-gray-400 line-clamp-2">{comment.problem}</span>
    </button>
  );
}

function ResolvedGroup({ label, icon: Icon, items, located, openCommentId, onReveal }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-gray-500 hover:text-gray-300"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} /> {label} ({items.length})
      </button>
      {open ? (
        <div className="mt-1.5 space-y-1.5">
          {items.map((c) => (
            <CommentRow key={c.id} comment={c} located={located.has(c.id)} active={c.id === openCommentId} onReveal={onReveal} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function ManuscriptCommentIndex({ comments, locatedCommentIds, openCommentId, onReveal, commentCardProps }) {
  const [severityFilter, setSeverityFilter] = useState(null); // null = all

  const grouped = useMemo(() => ({
    open: comments.filter((c) => c.status === 'open'),
    accepted: comments.filter((c) => c.status === 'accepted'),
    dismissed: comments.filter((c) => c.status === 'dismissed'),
  }), [comments]);

  const openFiltered = severityFilter
    ? grouped.open.filter((c) => c.severity === severityFilter)
    : grouped.open;

  const locatedOpen = grouped.open.filter((c) => locatedCommentIds.has(c.id)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-xs uppercase tracking-wider text-gray-500">Editorial comments</h2>
        <span className="text-[11px] text-gray-600">{grouped.open.length} open</span>
      </div>

      {grouped.open.length > 0 ? (
        <>
          <div className="flex items-center gap-1 flex-wrap">
            <button
              type="button"
              onClick={() => setSeverityFilter(null)}
              className={`px-2 py-0.5 rounded text-[10px] border ${severityFilter === null ? 'bg-port-accent text-white border-port-accent' : 'text-gray-400 border-port-border hover:text-white'}`}
            >
              All
            </button>
            {SEVERITIES.map((s) => {
              const n = grouped.open.filter((c) => c.severity === s).length;
              if (n === 0) return null;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverityFilter(severityFilter === s ? null : s)}
                  className={`px-2 py-0.5 rounded text-[10px] border capitalize ${severityFilter === s ? 'bg-port-accent text-white border-port-accent' : 'text-gray-400 border-port-border hover:text-white'}`}
                >
                  {s} {n}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-gray-500" title="Notes whose anchor text was found verbatim in the current draft are highlighted in-context; the rest are listed here only.">
            {locatedOpen} of {grouped.open.length} located in text
          </p>
        </>
      ) : null}

      {comments.length === 0 ? (
        <p className="text-xs text-gray-500 italic">
          No comments yet. Run “Finish the draft” from the series arc to generate editorial feedback here.
        </p>
      ) : null}

      <div className="space-y-1.5">
        {openFiltered.map((c) => (
          <div key={c.id} className="space-y-1.5">
            <CommentRow comment={c} located={locatedCommentIds.has(c.id)} active={c.id === openCommentId} onReveal={onReveal} />
            {/* Story-level notes (no issueNumber) have no issue tab to live on, so
                they expand and stay actionable right here in the index. */}
            {c.id === openCommentId && c.issueNumber == null && commentCardProps ? (
              <CommentCardFromProps comment={c} commentCardProps={commentCardProps} idScope={`index-${c.id}`} />
            ) : null}
          </div>
        ))}
      </div>

      <ResolvedGroup label="Accepted" icon={Check} items={grouped.accepted} located={locatedCommentIds} openCommentId={openCommentId} onReveal={onReveal} />
      <ResolvedGroup label="Dismissed" icon={X} items={grouped.dismissed} located={locatedCommentIds} openCommentId={openCommentId} onReveal={onReveal} />
    </div>
  );
}
