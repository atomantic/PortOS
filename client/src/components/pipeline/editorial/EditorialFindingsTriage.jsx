/**
 * Findings triage for the Editorial Checks page (#1285): the check-sourced
 * comments seeded into the manuscript review store, grouped by check with
 * severity counts. Each finding deep-links into the manuscript editor (which
 * opens its comment card via the `?comment=` param) where the full edit flow
 * lives — but the common preview/accept/dismiss path is also available inline
 * here (#1598): an open finding with a suggested fix expands a collapsed
 * before/after diff (reusing the manuscript card's `InlineDiff` + edit helpers)
 * and applies or dismisses it without leaving the page. Heavier edits (editing
 * the replacement text, per-edit selection) still deep-link into the editor.
 */
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, History, Check, X, Loader2, GitCompareArrows } from 'lucide-react';
import { useMemo, useState } from 'react';
import { groupFindingsByCheck, findingManuscriptLink, openFindingsTotal } from '../../../lib/editorialChecks';
import { fixEditsOf, selectedEditsFor } from '../manuscript/ManuscriptCommentCard';
import InlineDiff from '../../ui/InlineDiff';
import toast from '../../ui/Toast';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { acceptPipelineManuscriptFix, patchPipelineManuscriptComment } from '../../../services/api';

const SEVERITY_DOT = {
  high: 'bg-rose-400',
  medium: 'bg-amber-400',
  low: 'bg-gray-400',
};
const STATUS_TONE = {
  open: 'text-gray-200',
  accepted: 'text-emerald-400 line-through',
  dismissed: 'text-gray-600 line-through',
};

function CountPills({ counts }) {
  return (
    <span className="flex items-center gap-1.5">
      {['high', 'medium', 'low'].map((sev) => (counts[sev] ? (
        <span key={sev} className="flex items-center gap-1 text-[10px] text-gray-400">
          <span className={`h-2 w-2 rounded-full ${SEVERITY_DOT[sev]}`} />
          {counts[sev]}
        </span>
      ) : null))}
    </span>
  );
}

// Findings whose analyzed manuscript/canon changed since the check last ran
// (#1345) — re-run the check (or dismiss) so the finding reflects current content.
function StaleBadge({ count }) {
  return (
    <span
      className="flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-400"
      title={count != null
        ? `${count} open finding${count === 1 ? '' : 's'} analyzed content that has since changed — re-run this check`
        : 'Analyzed content has changed since this check ran — re-run the check'}
    >
      <History size={10} className="shrink-0" />
      {count != null ? `${count} stale` : 'Stale'}
    </span>
  );
}

// One finding: deep-link header + (for open findings) an inline preview/accept/
// dismiss bar (#1598). The collapsed diff reuses the manuscript card's edit
// helpers + `InlineDiff` so the preview here matches what the editor applies.
function FindingRow({ seriesId, comment, onCommentChange }) {
  const [showFix, setShowFix] = useState(false);
  const hasFix = !!comment.fix;
  const isOpen = comment.status === 'open';
  const edits = useMemo(() => fixEditsOf(comment), [comment]);
  // Mirror the manuscript card: a fix with no usable replacement text can't be
  // applied, so the inline Accept stays disabled (the editor handles edge edits).
  const acceptable = hasFix && edits.some((e) => (e.replace || '').trim());

  const [runAccept, accepting] = useAsyncAction(
    () => acceptPipelineManuscriptFix(
      seriesId,
      comment.id,
      { edits: selectedEditsFor(comment, null).map(({ selected: _s, ...edit }) => edit) },
      { silent: true },
    ),
    { errorMessage: 'Failed to apply fix' },
  );
  const [runDismiss, dismissing] = useAsyncAction(
    () => patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed' }, { silent: true }),
    { errorMessage: 'Failed to dismiss' },
  );

  const accept = async () => {
    const result = await runAccept();
    if (!result?.comment) return;
    onCommentChange?.(result.comment);
    toast.success('Fix applied to the manuscript');
  };
  const dismiss = async () => {
    const result = await runDismiss();
    if (result?.comment) onCommentChange?.(result.comment);
  };

  return (
    <li className="p-2.5 space-y-2">
      <Link
        to={findingManuscriptLink(seriesId, comment)}
        className="group flex items-start justify-between gap-2"
      >
        <span className="min-w-0 space-y-0.5">
          <span className={`block text-xs ${STATUS_TONE[comment.status] || STATUS_TONE.open}`}>
            <span className={`mr-1.5 inline-block h-2 w-2 rounded-full align-middle ${SEVERITY_DOT[comment.severity] || SEVERITY_DOT.low}`} />
            {comment.problem}
          </span>
          <span className="flex items-center gap-2">
            {comment.location ? <span className="block text-[11px] text-gray-500">{comment.location}</span> : null}
            {isOpen && comment.stale ? <StaleBadge /> : null}
          </span>
        </span>
        <ExternalLink size={13} className="mt-0.5 shrink-0 text-gray-600 group-hover:text-port-accent" />
      </Link>

      {isOpen ? (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {hasFix ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowFix((v) => !v)}
                  aria-expanded={showFix}
                  className="inline-flex items-center gap-1 rounded border border-port-border px-1.5 py-0.5 text-[10px] text-gray-400 hover:text-white hover:border-port-accent/40"
                >
                  <GitCompareArrows size={11} />
                  {showFix ? 'Hide fix' : 'Preview fix'}
                  {showFix ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
                <button
                  type="button"
                  onClick={accept}
                  disabled={accepting || dismissing || !acceptable}
                  className="inline-flex items-center gap-1 rounded border border-port-success/40 bg-port-success/20 px-1.5 py-0.5 text-[10px] text-port-success hover:bg-port-success/30 disabled:opacity-40"
                >
                  {accepting ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                  Accept
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={dismiss}
              disabled={accepting || dismissing}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-gray-500 hover:text-white disabled:opacity-40"
            >
              {dismissing ? <Loader2 size={11} className="animate-spin" /> : <X size={11} />}
              Dismiss
            </button>
          </div>
          {hasFix && showFix ? (
            <div className="space-y-1.5 rounded border border-port-border/60 bg-port-card/40">
              {edits.map((edit, i) => (
                <div key={`${i}-${edit.issueId || ''}-${edit.find}`} className="overflow-hidden rounded border border-port-border/60">
                  <InlineDiff oldText={edit.find || ''} newText={edit.replace || ''} emptyLabel="No replacement changes." />
                </div>
              ))}
              <p className="px-2 pb-1.5 text-[10px] text-gray-500">
                Need to edit the replacement or pick individual edits? <Link to={findingManuscriptLink(seriesId, comment)} className="text-port-accent hover:underline">Open in the editor</Link>.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CheckGroup({ seriesId, group, onCommentChange }) {
  const [open, setOpen] = useState(group.open > 0);
  return (
    <div className="rounded-lg border border-port-border bg-port-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 p-2.5 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-1.5 min-w-0">
          {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}
          <span className="text-sm font-medium text-gray-100 truncate">{group.label}</span>
          <span className="text-[10px] text-gray-500 shrink-0">{group.open} open · {group.total} total</span>
        </span>
        <span className="flex items-center gap-1.5 shrink-0">
          {group.stale > 0 ? <StaleBadge count={group.stale} /> : null}
          <CountPills counts={group.counts} />
        </span>
      </button>
      {open ? (
        <ul className="divide-y divide-port-border/60 border-t border-port-border/60">
          {group.comments.map((c) => (
            <FindingRow key={c.id} seriesId={seriesId} comment={c} onCommentChange={onCommentChange} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default function EditorialFindingsTriage({ seriesId, comments = [], checksById = {}, onCommentChange }) {
  const groups = useMemo(() => groupFindingsByCheck(comments, checksById), [comments, checksById]);
  if (!groups.length) {
    return (
      <p className="rounded-lg border border-dashed border-port-border p-4 text-center text-xs text-gray-500">
        No editorial-check findings yet. Run the enabled checks to populate this list.
      </p>
    );
  }
  const totalOpen = openFindingsTotal(groups);
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-500">{totalOpen} open finding{totalOpen === 1 ? '' : 's'} across {groups.length} check{groups.length === 1 ? '' : 's'}</p>
      {groups.map((g) => <CheckGroup key={g.checkId} seriesId={seriesId} group={g} onCommentChange={onCommentChange} />)}
    </div>
  );
}
