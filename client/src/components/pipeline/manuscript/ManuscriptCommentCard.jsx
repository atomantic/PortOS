/**
 * One editorial comment, in card form. Rendered in three places — the sidebar
 * index, the in-context popover/expansion, and the impact-preview list — so its
 * fix-edit draft state (replacement text + which edits are checked) is OWNED BY
 * THE PARENT (keyed by comment id) and passed in via `draft`/`onDraftChange`.
 * Two cards for the same comment therefore share one editing state. `idScope`
 * namespaces the form ids so two instances don't collide on label/htmlFor.
 *
 * The suggested-edit diff toggles between a columnar before/after
 * (`SideBySideDiff`, default) and the compact stacked `InlineDiff`.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, Check, X, Ban, Columns2, Rows2, Copy, ChevronLeft, ChevronRight, Undo2, Pencil } from 'lucide-react';
import InlineDiff from '../../ui/InlineDiff';
import SideBySideDiff from '../../ui/SideBySideDiff';
import toast from '../../ui/Toast';
import { copyToClipboard } from '../../../lib/clipboard';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import useKeyboardShortcuts from '../../../hooks/useKeyboardShortcuts';
import Kbd from '../../ui/Kbd';
import {
  patchPipelineManuscriptComment, generatePipelineManuscriptFix, acceptPipelineManuscriptFix,
  undoPipelineManuscriptFix,
} from '../../../services/api';
import { SEVERITY_TONE, CATEGORY_LABEL, subtypeLabel } from './constants';

// Truncated comment id + copy button — so a note that looks wrong can be quoted
// by id when reporting/debugging.
export function CopyId({ id }) {
  const short = id.length > 14 ? `${id.slice(0, 14)}…` : id;
  return (
    <button
      type="button"
      onClick={() => copyToClipboard(id, 'Comment id copied')}
      title={`Copy comment id: ${id}`}
      className="inline-flex items-center gap-1 text-[10px] font-mono text-gray-500 hover:text-gray-300"
    >
      <Copy size={10} /> {short}
    </button>
  );
}

// On-screen cheatsheet for the card's keyboard shortcuts (#1603) — only the
// actions actually available for this note are shown (prev/next when the card is
// part of a triage order, Accept/regenerate when a fix exists, Generate when not).
function ShortcutHints({ hasNav, hasFix, hasFalsePositive, hasManualEdit }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pt-1.5 text-[10px] text-gray-600">
      {hasNav ? (
        <span className="inline-flex items-center gap-1"><Kbd size="sm">←</Kbd><Kbd size="sm">→</Kbd> step</span>
      ) : null}
      {hasFix ? (
        <>
          <span className="inline-flex items-center gap-1"><Kbd size="sm">a</Kbd> accept</span>
          <span className="inline-flex items-center gap-1"><Kbd size="sm">g</Kbd> regenerate</span>
        </>
      ) : (
        <span className="inline-flex items-center gap-1"><Kbd size="sm">g</Kbd> generate</span>
      )}
      {hasManualEdit ? (
        <span className="inline-flex items-center gap-1"><Kbd size="sm">m</Kbd> manual edit</span>
      ) : null}
      <span className="inline-flex items-center gap-1"><Kbd size="sm">d</Kbd> dismiss</span>
      {hasFalsePositive ? (
        <span className="inline-flex items-center gap-1"><Kbd size="sm">f</Kbd> false positive</span>
      ) : null}
    </div>
  );
}

// Success toast for an accepted fix that carries an inline Undo (#1609). The
// accepted comment leaves the open-note flow (its card unmounts as the editor
// auto-advances), so this self-contained toast — not the card — owns the
// immediate "oops, undo that" affordance. `onUndo` resolves true on success;
// once undone the toast swaps to a confirmation and clears itself.
export function UndoFixToast({ t, count, onUndo }) {
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const label = count === 1 ? 'Fix applied to the manuscript' : `${count} fixes applied to the manuscript`;
  return (
    <span className="flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 text-gray-200">
        <Check size={14} className="text-port-success shrink-0" />
        {undone ? 'Fix undone — finding re-opened' : label}
      </span>
      {!undone ? (
        <button
          type="button"
          disabled={undoing}
          onClick={async () => {
            setUndoing(true);
            const ok = await onUndo();
            setUndoing(false);
            if (ok) { setUndone(true); setTimeout(() => toast.dismiss(t.id), 1500); }
          }}
          className="inline-flex items-center gap-1 rounded border border-port-border px-2 py-0.5 text-xs text-port-accent hover:border-port-accent/50 disabled:opacity-40"
        >
          {undoing ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
        </button>
      ) : null}
    </span>
  );
}

// Show the accept confirmation + Undo toast. `applyResult` re-applies the undo's
// { comment, section, sections } through the same handler an accept uses.
export function showAcceptedFixToast({ seriesId, commentId, count, applyResult }) {
  toast(
    (t) => (
      <UndoFixToast
        t={t}
        count={count}
        onUndo={async () => {
          const undone = await undoPipelineManuscriptFix(seriesId, commentId, { silent: true })
            .catch((err) => { toast.error(err.message || 'Failed to undo the fix'); return null; });
          if (!undone) return false;
          applyResult?.(undone);
          return true;
        }}
      />
    ),
    { duration: 10000 },
  );
}

export function Badge({ comment }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${SEVERITY_TONE[comment.severity] || SEVERITY_TONE.low}`}>
        {comment.severity}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{CATEGORY_LABEL[comment.category] || comment.category}</span>
      {comment.subtype ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-border text-gray-400" title="Why this line was flagged">
          {subtypeLabel(comment.subtype)}
        </span>
      ) : null}
      {comment.dismissReason === 'false-positive' ? (
        <span className="text-[10px] px-1.5 py-0.5 rounded border border-port-warning/40 text-port-warning" title="Flagged as a false positive">
          false positive
        </span>
      ) : null}
    </span>
  );
}

// Build the editable edit list off a comment's fix, tolerating both the
// multi-edit (`fix.edits`) and the legacy single find/replace shape.
export function fixEditsOf(comment) {
  if (Array.isArray(comment.fix?.edits) && comment.fix.edits.length) return comment.fix.edits;
  if (comment.fix?.find || comment.fix?.replace) {
    return [{
      issueNumber: comment.issueNumber,
      issueId: comment.issueId,
      stageId: comment.stageId,
      find: comment.fix.find || '',
      replace: comment.fix.replace || '',
      fuzzy: comment.fix.fuzzy,
    }];
  }
  return [];
}

// Stable signature of a fix's edits — a stored draft only applies when its
// fixKey still matches (a regenerated fix invalidates stale drafts).
export function fixKeyOf(edits) {
  return edits.map((e, i) => `${i}:${e.issueId || ''}:${e.stageId || ''}:${e.find}:${e.replace}`).join('\n---\n');
}

// The edits that would actually be accepted for a comment, honoring the parent's
// draft (replacement text + which edits are checked). Shared by the card's
// Accept and the impact preview so the two never diverge.
export function selectedEditsFor(comment, draft) {
  const edits = fixEditsOf(comment);
  const stored = draft && draft.fixKey === fixKeyOf(edits) ? draft : null;
  return edits
    .map((e, i) => ({
      ...e,
      replace: stored ? (stored.drafts[i] ?? e.replace ?? '') : (e.replace ?? ''),
      selected: stored ? stored.selected[i] !== false : true,
    }))
    .filter((e) => e.selected);
}

// Bind a comment card to the page's shared `commentCardProps` (handlers + the
// per-comment draft keyed by id). The card renders identically in the Live
// popover, the Review inline expansion, and the sidebar index — only `idScope`
// differs — so this wrapper is the single place that prop shape lives. When the
// page supplies `openNav` (the triage order over open notes + a goto handler),
// the card grows a ‹ N of M › stepper so a review pass never detours back
// through the sidebar between notes.
export function CommentCardFromProps({ comment, commentCardProps, idScope }) {
  const order = commentCardProps.openNav?.order || [];
  const idx = order.indexOf(comment.id);
  const nav = idx !== -1 && order.length > 1 ? {
    index: idx,
    total: order.length,
    onPrev: () => commentCardProps.openNav.goto(order[(idx - 1 + order.length) % order.length]),
    onNext: () => commentCardProps.openNav.goto(order[(idx + 1) % order.length]),
  } : null;
  return (
    <ManuscriptCommentCard
      comment={comment}
      idScope={idScope}
      seriesId={commentCardProps.seriesId}
      providerOverride={commentCardProps.providerOverride}
      modelOverride={commentCardProps.modelOverride}
      onCommentChange={commentCardProps.onCommentChange}
      onAccepted={commentCardProps.onAccepted}
      draft={commentCardProps.fixDrafts[comment.id]}
      onDraftChange={(entry) => commentCardProps.setCommentDraft(comment.id, entry)}
      nav={nav}
    />
  );
}

export default function ManuscriptCommentCard({
  comment, seriesId, providerOverride, modelOverride, onCommentChange, onAccepted, idScope, draft, onDraftChange, nav,
}) {
  // Namespace form ids so two copies of an open comment don't share ids.
  const scope = idScope || comment.id;
  const [diffStyle, setDiffStyle] = useState('side'); // 'side' | 'inline'
  // Manual-edit mode (#1610) — for findings whose suggested fix is wrong or
  // absent, free-text the replacement for the anchored span and apply it through
  // the same accept path a generated fix uses. Local (not parent-owned) state:
  // it's an in-the-moment action in the open-note flow, where only one card
  // mounts. Anchored on `comment.anchorQuote`, which the accept endpoint locates
  // (whitespace-tolerant) to splice the replacement in.
  const [manualMode, setManualMode] = useState(false);
  const [manualText, setManualText] = useState('');
  const hasFix = !!comment.fix;
  const fixEdits = useMemo(() => fixEditsOf(comment), [comment]);
  const fixKey = useMemo(() => fixKeyOf(fixEdits), [fixEdits]);
  // Use the stored draft only when it was derived from the current fix; a
  // (re)generated fix has a new fixKey, so stale drafts fall back to fresh
  // defaults (every edit checked, replacement prefilled).
  const stored = draft && draft.fixKey === fixKey ? draft : null;
  const editDrafts = stored ? stored.drafts : Object.fromEntries(fixEdits.map((e, i) => [i, e.replace || '']));
  const selectedEdits = stored ? stored.selected : Object.fromEntries(fixEdits.map((_, i) => [i, true]));
  const setEditDrafts = (updater) =>
    onDraftChange({ fixKey, drafts: typeof updater === 'function' ? updater(editDrafts) : updater, selected: selectedEdits });
  const setSelectedEdits = (updater) =>
    onDraftChange({ fixKey, drafts: editDrafts, selected: typeof updater === 'function' ? updater(selectedEdits) : updater });

  const [runGenerate, generating] = useAsyncAction(
    () => generatePipelineManuscriptFix(seriesId, comment.id, { providerOverride, modelOverride }, { silent: true }),
    { errorMessage: 'Failed to generate fix' },
  );
  const [runAccept, accepting] = useAsyncAction(
    (selected) => acceptPipelineManuscriptFix(seriesId, comment.id, { edits: selected }, { silent: true }),
    { errorMessage: 'Failed to apply fix' },
  );

  const generate = async () => {
    const result = await runGenerate();
    if (!result) return;
    if (result.comment) onCommentChange(result.comment);
    if (result.fix?.fuzzy) toast('The suggested anchor was not found verbatim — edit the manuscript directly, or adjust the replacement.');
  };

  const accept = async () => {
    if (!comment.fix) return;
    // Same selection the impact preview uses, so what you preview is what applies.
    const selected = selectedEditsFor(comment, draft).map(({ selected: _s, ...edit }) => edit);
    if (selected.length === 0) {
      toast('Select at least one suggested edit to apply');
      return;
    }
    const result = await runAccept(selected);
    if (!result) return;
    onAccepted(result);
    showAcceptedFixToast({
      seriesId,
      commentId: result.comment?.id || comment.id,
      count: selected.length,
      applyResult: onAccepted,
    });
  };

  // A manual edit needs a span to anchor against — without an anchorQuote the
  // accept path can't locate where to splice, so the option isn't offered.
  const canManualEdit = !!comment.anchorQuote;
  const openManualEdit = () => {
    // Seed with the current span so the diff starts as a no-op the user edits down.
    setManualText(comment.anchorQuote || '');
    setManualMode(true);
  };
  const applyManualEdit = async () => {
    if (!comment.anchorQuote) return;
    const edit = {
      issueId: comment.issueId,
      stageId: comment.stageId,
      issueNumber: comment.issueNumber,
      find: comment.anchorQuote,
      replace: manualText,
    };
    const result = await runAccept([edit]);
    if (!result) return;
    setManualMode(false);
    onAccepted(result);
    showAcceptedFixToast({
      seriesId,
      commentId: result.comment?.id || comment.id,
      count: 1,
      applyResult: onAccepted,
    });
  };
  // Leaving a note (nav/swap) abandons any half-typed manual edit so the next
  // note doesn't inherit stale replacement text.
  useEffect(() => { setManualMode(false); setManualText(''); }, [comment.id]);

  const dismiss = async () => {
    // A plain dismiss is "won't fix" — clear any prior false-positive reason so
    // re-dismissing a re-opened finding doesn't keep a stale mark.
    const result = await patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed', dismissReason: null }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to dismiss'); return null; });
    if (result?.comment) onCommentChange(result.comment);
  };

  // "This check is wrong here" (#1605) — distinct from a plain dismiss so broken
  // checks are tracked for the per-check quality view instead of silently
  // re-surfacing the same bad finding every run. Only offered for check-sourced
  // findings (completeness-pass findings carry no checkId to attribute it to).
  const markFalsePositive = async () => {
    const result = await patchPipelineManuscriptComment(seriesId, comment.id, { status: 'dismissed', dismissReason: 'false-positive' }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Failed to flag false positive'); return null; });
    if (result?.comment) onCommentChange(result.comment);
  };
  const canFlagFalsePositive = !!comment.checkId;

  const fuzzy = comment.fix?.fuzzy || fixEdits.some((e) => e.fuzzy);
  const Diff = diffStyle === 'side' ? SideBySideDiff : InlineDiff;
  // At least one selected edit carries usable replacement text — gates both the
  // Accept button and its `a` shortcut so neither fires an empty apply.
  const canAccept = hasFix && fixEdits.some((_, i) => selectedEdits[i] && (editDrafts[i] || '').trim());

  // Keyboard-driven triage over the open note (#1603): ←/→ (or k/j, vim-style)
  // step prev/next through the triage order, a=accept, d=dismiss, g=generate/
  // regenerate. Only one comment card mounts at a time (the open note), so the
  // single global binding can't collide with a sibling card. The hook ignores
  // keys typed into the replacement textarea / manuscript editor, drops OS key
  // auto-repeat (so a held a/d can't stampede through auto-advancing notes), and
  // suppresses itself while a manuscript modal (Impact preview / Read aloud) is
  // open over the still-mounted card — so letters never misfire.
  useKeyboardShortcuts(true, {
    ArrowLeft: nav?.onPrev,
    ArrowRight: nav?.onNext,
    k: nav?.onPrev,
    j: nav?.onNext,
    a: canAccept && !accepting && !manualMode ? accept : undefined,
    d: !accepting ? dismiss : undefined,
    f: canFlagFalsePositive && !accepting ? markFalsePositive : undefined,
    g: !generating && !accepting ? generate : undefined,
    m: canManualEdit && !accepting ? (manualMode ? () => setManualMode(false) : openManualEdit) : undefined,
  });

  return (
    <div className="border border-port-border rounded-lg bg-port-bg/40 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge comment={comment} />
        <span className="flex items-center gap-2">
          {nav ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-400">
              <button
                type="button"
                onClick={nav.onPrev}
                className="p-0.5 rounded hover:text-white hover:bg-port-border/60"
                aria-label="Previous open note"
                title="Previous open note"
              >
                <ChevronLeft size={13} />
              </button>
              <span className="tabular-nums whitespace-nowrap">{nav.index + 1} of {nav.total}</span>
              <button
                type="button"
                onClick={nav.onNext}
                className="p-0.5 rounded hover:text-white hover:bg-port-border/60"
                aria-label="Next open note"
                title="Next open note"
              >
                <ChevronRight size={13} />
              </button>
            </span>
          ) : null}
          <CopyId id={comment.id} />
        </span>
      </div>

      <p className="text-xs text-gray-200">{comment.problem}</p>
      {comment.suggestion ? <p className="text-[11px] text-gray-400"><span className="text-gray-500">Fix: </span>{comment.suggestion}</p> : null}
      {comment.anchorQuote ? <p className="text-[11px] text-gray-500 italic line-clamp-2">“{comment.anchorQuote}”</p> : null}

      {hasFix ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] uppercase tracking-wider text-gray-500">
              Suggested {fixEdits.length === 1 ? 'edit' : `${fixEdits.length} edits`}
            </p>
            {/* Diff layout toggle — columnar before/after (default) vs stacked. */}
            <div className="inline-flex rounded border border-port-border overflow-hidden">
              <button
                type="button"
                onClick={() => setDiffStyle('side')}
                aria-pressed={diffStyle === 'side'}
                aria-label="Side-by-side diff"
                title="Side-by-side diff"
                className={`px-1.5 py-0.5 ${diffStyle === 'side' ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <Columns2 size={12} />
              </button>
              <button
                type="button"
                onClick={() => setDiffStyle('inline')}
                aria-pressed={diffStyle === 'inline'}
                aria-label="Stacked inline diff"
                title="Stacked inline diff"
                className={`px-1.5 py-0.5 ${diffStyle === 'inline' ? 'bg-port-accent text-white' : 'text-gray-400 hover:text-white'}`}
              >
                <Rows2 size={12} />
              </button>
            </div>
          </div>
          {fixEdits.map((edit, i) => {
            const draftText = editDrafts[i] ?? edit.replace ?? '';
            const checked = selectedEdits[i] !== false;
            const label = edit.issueNumber != null ? `Issue ${edit.issueNumber}` : 'Manuscript';
            return (
              <div key={`${i}-${edit.issueId || ''}-${edit.find}`} className="border border-port-border rounded bg-port-card/60 overflow-hidden">
                <label className="flex items-center gap-2 px-2 py-1.5 border-b border-port-border text-[11px] text-gray-300">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setSelectedEdits((prev) => ({ ...prev, [i]: e.target.checked }))}
                    className="accent-port-accent"
                  />
                  <span className="font-medium">{label}{edit.title && edit.title !== label ? ` — ${edit.title}` : ''}</span>
                  {edit.fuzzy ? <span className="ml-auto text-port-warning">fuzzy</span> : null}
                </label>
                {edit.note ? <p className="px-2 pt-1.5 text-[11px] text-gray-500">{edit.note}</p> : null}
                <Diff oldText={edit.find || ''} newText={draftText} emptyLabel="No replacement changes." />
                <label htmlFor={`fix-replace-${scope}-${i}`} className="block px-2 pt-1.5 text-[10px] uppercase tracking-wider text-gray-500">Replacement (editable)</label>
                <textarea
                  id={`fix-replace-${scope}-${i}`}
                  value={draftText}
                  onChange={(e) => setEditDrafts((prev) => ({ ...prev, [i]: e.target.value }))}
                  rows={Math.min(14, Math.max(3, draftText.split('\n').length + 1))}
                  className="m-2 mt-1 w-[calc(100%-1rem)] px-2 py-1.5 bg-port-bg border border-port-border rounded text-[12px] text-gray-100 font-mono resize-y focus:border-port-accent/50 focus:outline-none"
                />
              </div>
            );
          })}
          {fuzzy ? (
            <p className="text-[10px] text-port-warning">Quote isn’t an exact match for the draft (often just spacing) — accepting matches it flexibly; if it truly can’t be located you’ll get an error and can edit directly.</p>
          ) : null}
        </div>
      ) : null}

      {manualMode ? (
        <div className="space-y-1.5 border border-port-accent/40 rounded bg-port-card/60 p-2">
          <p className="text-[10px] uppercase tracking-wider text-gray-500">Manual edit — rewrite the anchored span</p>
          <Diff oldText={comment.anchorQuote || ''} newText={manualText} emptyLabel="No replacement changes." />
          <label htmlFor={`manual-replace-${scope}`} className="block pt-0.5 text-[10px] uppercase tracking-wider text-gray-500">Replacement (editable)</label>
          <textarea
            id={`manual-replace-${scope}`}
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            rows={Math.min(14, Math.max(3, manualText.split('\n').length + 1))}
            className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-[12px] text-gray-100 font-mono resize-y focus:border-port-accent/50 focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={applyManualEdit}
              disabled={accepting || manualText === (comment.anchorQuote || '')}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium bg-port-success/20 text-port-success border border-port-success/40 hover:bg-port-success/30 disabled:opacity-40"
              title="Apply this replacement to the manuscript and resolve the finding"
            >
              {accepting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Apply edit
            </button>
            <button
              type="button"
              onClick={() => setManualMode(false)}
              disabled={accepting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-500 hover:text-white disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="flex items-center gap-2 pt-0.5">
        {!hasFix ? (
          <button
            type="button"
            onClick={generate}
            disabled={generating}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
          >
            {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Generate fix
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={accept}
              disabled={accepting || !canAccept}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-medium bg-port-success/20 text-port-success border border-port-success/40 hover:bg-port-success/30 disabled:opacity-40"
            >
              {accepting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              Accept
            </button>
            <button
              type="button"
              onClick={generate}
              disabled={generating || accepting}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-400 hover:text-white disabled:opacity-40"
              aria-label="Regenerate the suggested fix"
              title="Regenerate the suggested fix"
            >
              {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            </button>
          </>
        )}
        {canManualEdit && !manualMode ? (
          <button
            type="button"
            onClick={openManualEdit}
            disabled={accepting}
            className="inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-400 hover:text-white disabled:opacity-40"
            title="Manually rewrite the anchored span and apply it"
          >
            <Pencil size={12} /> Manual edit
          </button>
        ) : null}
        {canFlagFalsePositive ? (
          <button
            type="button"
            onClick={markFalsePositive}
            disabled={accepting}
            className="ml-auto inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-500 hover:text-port-warning disabled:opacity-40"
            title="Flag this finding as a false positive — the check is wrong here"
          >
            <Ban size={12} /> False positive
          </button>
        ) : null}
        <button
          type="button"
          onClick={dismiss}
          className={`${canFlagFalsePositive ? '' : 'ml-auto '}inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] text-gray-500 hover:text-white`}
        >
          <X size={12} /> Dismiss
        </button>
      </div>

      <ShortcutHints hasNav={!!nav} hasFix={hasFix} hasFalsePositive={canFlagFalsePositive} hasManualEdit={canManualEdit} />
    </div>
  );
}
