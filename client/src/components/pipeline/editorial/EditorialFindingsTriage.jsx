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
 *
 * For reviewing a large batch, open findings carry a checkbox (#1599): select
 * across checks (or a whole group via the header checkbox) and a sticky action
 * bar bulk-accepts the selected findings that have an applicable fix and/or
 * bulk-dismisses the selection — each result reactively updates local state.
 */
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, ExternalLink, History, Check, X, Loader2, GitCompareArrows } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
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

// A fix is acceptable only when it carries usable replacement text — mirror the
// manuscript card so the inline/bulk Accept stays disabled for edge edits the
// editor must handle. Shared by the per-finding row and the bulk action bar.
const isAcceptableFix = (comment) =>
  !!comment.fix && fixEditsOf(comment).some((e) => (e.replace || '').trim());

// The edits payload the accept endpoint expects for a comment (drop the local
// `selected` flag). Shared by inline Accept and bulk Accept so both apply the
// same edits the editor would.
const acceptEditsOf = (comment) =>
  selectedEditsFor(comment, null).map(({ selected: _selected, ...edit }) => edit);

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

// Checkbox that can render the tri-state "some selected" indeterminate look —
// the DOM `indeterminate` flag is set imperatively since React has no prop for it.
function SelectCheckbox({ checked, indeterminate = false, onChange, label, className = '' }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className={`h-3.5 w-3.5 shrink-0 cursor-pointer accent-port-accent ${className}`}
    />
  );
}

// One finding: deep-link header + (for open findings) a selection checkbox and
// an inline preview/accept/dismiss bar (#1598). The collapsed diff reuses the
// manuscript card's edit helpers + `InlineDiff` so the preview here matches what
// the editor applies.
function FindingRow({ seriesId, comment, onCommentChange, selected, onToggleSelect }) {
  const [showFix, setShowFix] = useState(false);
  const hasFix = !!comment.fix;
  const isOpen = comment.status === 'open';
  const edits = useMemo(() => fixEditsOf(comment), [comment]);
  const acceptable = isAcceptableFix(comment);

  const [runAccept, accepting] = useAsyncAction(
    () => acceptPipelineManuscriptFix(
      seriesId,
      comment.id,
      { edits: acceptEditsOf(comment) },
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
      <div className="flex items-start gap-2">
        {isOpen ? (
          <SelectCheckbox
            checked={selected}
            onChange={() => onToggleSelect?.(comment.id)}
            label={`Select finding: ${comment.problem}`}
            className="mt-1"
          />
        ) : null}
        <Link
          to={findingManuscriptLink(seriesId, comment)}
          className="group flex min-w-0 flex-1 items-start justify-between gap-2"
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
      </div>

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

function CheckGroup({ seriesId, group, onCommentChange, selectedIds, onToggleSelect, onSelectMany }) {
  const [open, setOpen] = useState(group.open > 0);
  const openIds = useMemo(
    () => group.comments.filter((c) => c.status === 'open').map((c) => c.id),
    [group.comments],
  );
  const selectedCount = openIds.reduce((n, id) => n + (selectedIds.has(id) ? 1 : 0), 0);
  const allSelected = openIds.length > 0 && selectedCount === openIds.length;
  return (
    <div className="rounded-lg border border-port-border bg-port-card">
      <div className="flex items-center gap-2 p-2.5">
        {openIds.length > 0 ? (
          <SelectCheckbox
            checked={allSelected}
            indeterminate={selectedCount > 0 && !allSelected}
            onChange={() => onSelectMany?.(openIds, !allSelected)}
            label={`Select all open findings in ${group.label}`}
          />
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
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
      </div>
      {open ? (
        <ul className="divide-y divide-port-border/60 border-t border-port-border/60">
          {group.comments.map((c) => (
            <FindingRow
              key={c.id}
              seriesId={seriesId}
              comment={c}
              onCommentChange={onCommentChange}
              selected={selectedIds.has(c.id)}
              onToggleSelect={onToggleSelect}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sticky bar shown while findings are selected (#1599): bulk-accept those with an
// applicable fix, bulk-dismiss the whole selection. Actions run sequentially so
// the accept endpoint's section writes don't race on the shared manuscript file.
function BulkActionBar({ seriesId, selected, onCommentChange, onClear }) {
  const [busy, setBusy] = useState(false);
  const acceptable = useMemo(() => selected.filter(isAcceptableFix), [selected]);

  const runBulk = async (mode) => {
    const targets = mode === 'accept' ? acceptable : selected;
    if (!targets.length) return;
    setBusy(true);
    let ok = 0;
    let failed = 0;
    for (const comment of targets) {
      const result = mode === 'accept'
        ? await acceptPipelineManuscriptFix(seriesId, comment.id, { edits: acceptEditsOf(comment) }, { silent: true }).catch(() => null)
        : await patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed' }, { silent: true }).catch(() => null);
      if (result?.comment) {
        onCommentChange?.(result.comment);
        ok += 1;
      } else {
        failed += 1;
      }
    }
    setBusy(false);
    onClear?.();
    if (ok) toast.success(`${mode === 'accept' ? 'Applied' : 'Dismissed'} ${ok} finding${ok === 1 ? '' : 's'}`);
    if (failed) toast.error(`${failed} finding${failed === 1 ? '' : 's'} failed — open them in the editor`);
  };

  return (
    <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-port-accent/40 bg-port-card p-2 shadow-lg">
      <span className="text-[11px] font-medium text-gray-200">{selected.length} selected</span>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => runBulk('accept')}
          disabled={busy || !acceptable.length}
          title={acceptable.length ? undefined : 'No selected finding has an applicable fix'}
          className="inline-flex items-center gap-1 rounded border border-port-success/40 bg-port-success/20 px-2 py-1 text-[11px] text-port-success hover:bg-port-success/30 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Accept {acceptable.length}
        </button>
        <button
          type="button"
          onClick={() => runBulk('dismiss')}
          disabled={busy || !selected.length}
          className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-1 text-[11px] text-gray-300 hover:text-white hover:border-port-accent/40 disabled:opacity-40"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <X size={12} />}
          Dismiss {selected.length}
        </button>
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="rounded px-2 py-1 text-[11px] text-gray-500 hover:text-white disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

export default function EditorialFindingsTriage({ seriesId, comments = [], checksById = {}, onCommentChange }) {
  const groups = useMemo(() => groupFindingsByCheck(comments, checksById), [comments, checksById]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // Selection only ever holds open findings — once a finding is accepted/dismissed
  // (here or in the editor) drop it so the bar's counts never count resolved ones.
  const openIds = useMemo(
    () => new Set(comments.filter((c) => c.checkId && c.status === 'open').map((c) => c.id)),
    [comments],
  );
  useEffect(() => {
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set();
      prev.forEach((id) => { if (openIds.has(id)) next.add(id); else changed = true; });
      return changed ? next : prev;
    });
  }, [openIds]);

  const toggleSelect = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectMany = (ids, on) => setSelectedIds((prev) => {
    const next = new Set(prev);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const clearSelection = () => setSelectedIds(new Set());

  const selectedComments = useMemo(
    () => comments.filter((c) => c.checkId && c.status === 'open' && selectedIds.has(c.id)),
    [comments, selectedIds],
  );

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
      {selectedComments.length > 0 ? (
        <BulkActionBar
          seriesId={seriesId}
          selected={selectedComments}
          onCommentChange={onCommentChange}
          onClear={clearSelection}
        />
      ) : (
        <p className="text-[11px] text-gray-500">{totalOpen} open finding{totalOpen === 1 ? '' : 's'} across {groups.length} check{groups.length === 1 ? '' : 's'}</p>
      )}
      {groups.map((g) => (
        <CheckGroup
          key={g.checkId}
          seriesId={seriesId}
          group={g}
          onCommentChange={onCommentChange}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectMany={selectMany}
        />
      ))}
    </div>
  );
}
