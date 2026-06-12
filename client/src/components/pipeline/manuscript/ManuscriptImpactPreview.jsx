/**
 * Whole-manuscript impact preview — a modal that shows, per affected section, a
 * before/after diff of what accepting the currently-selected editorial fixes
 * would do, with an "Accept all" that applies them right here. Per-card diffs
 * don't convey cumulative impact; this applies every selected edit (via the
 * same `selectedEditsFor` logic Accept uses) to a COPY of each section
 * client-side. Accept all walks the same per-comment accept route the cards
 * use — one comment at a time, sequentially, so each accept re-anchors against
 * the freshest server-side text — reporting (and leaving in the preview) any
 * note whose edits the server rejects.
 *
 * Sections are diffed with the hunked `HunkDiff` (line-level blocks, unchanged
 * context collapsed, word-level highlights inside each changed block) — a whole
 * section is thousands of words, so a flat word diff would either drown the
 * change in unchanged text or trip the diff cell cap and render everything
 * red/green. Diffs per changed section, never one giant concatenation.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import Modal from '../../ui/Modal';
import HunkDiff from '../../ui/HunkDiff';
import toast from '../../ui/Toast';
import { planManuscriptEdits } from '../../../lib/applyManuscriptEdits';
import { selectedEditsFor } from './ManuscriptCommentCard';
import { acceptPipelineManuscriptFix } from '../../../services/api';
import { STAGE_LABEL } from './constants';

// Gather every selected edit across the given comments, grouped by the section
// (issueId:stageId) it targets, carrying its comment's anchorQuote for recurring
// find disambiguation.
function editsBySectionKey(comments, fixDrafts) {
  const map = new Map();
  comments.forEach((c) => {
    if (!c.fix) return;
    selectedEditsFor(c, fixDrafts[c.id]).forEach((e) => {
      if (!e.find) return;
      const key = `${e.issueId || ''}:${e.stageId || ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push({ find: e.find, replace: e.replace, anchorQuote: c.anchorQuote });
    });
  });
  return map;
}

export default function ManuscriptImpactPreview({ open, onClose, seriesId, sections, comments, fixDrafts, onAccepted }) {
  // null when idle, { done, total } while the accept-all pass runs.
  const [acceptState, setAcceptState] = useState(null);

  // The accept-all pass awaits one network round-trip per note; if the user
  // closes the preview mid-batch, late callbacks must not fire into a torn-down
  // parent. Never reset to true (handles dev-mode double-mount cleanly).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const changed = useMemo(() => {
    if (!open) return [];
    const edits = editsBySectionKey(comments, fixDrafts);
    return sections
      .map((s) => {
        const key = `${s.issueId}:${s.stageId}`;
        const sectionEdits = edits.get(key);
        if (!sectionEdits?.length) return null;
        const before = s.content || '';
        const { output: after, overlapping, notFound } = planManuscriptEdits(before, sectionEdits);
        if (after === before && !overlapping && !notFound) return null;
        return { section: s, before, after, count: sectionEdits.length, overlapping, notFound };
      })
      .filter(Boolean);
  }, [open, sections, comments, fixDrafts]);

  const totalEdits = changed.reduce((n, c) => n + c.count, 0);

  // Accept every previewed note, one comment per request (the accept route is
  // per-comment, and sequential application lets each accept anchor against the
  // text the previous one produced). Failures are reported and stay open — the
  // preview re-derives from comment status, so applied sections drop out live.
  const acceptAll = async () => {
    // Only accept edits that landed in a PREVIEWED section. `changed` drops any
    // edit whose section isn't in the current `sections` (e.g. a fix for a
    // different manuscript stage) or that produced no visible change — so
    // building targets from every comment would apply unseen edits and make the
    // "Accept all N edits" count lie. Restrict to the same section keys the
    // modal rendered, filtering at the edit level (a comment may span stages).
    const previewedKeys = new Set(changed.map((c) => `${c.section.issueId}:${c.section.stageId}`));
    const targets = comments
      .map((c) => ({
        comment: c,
        edits: selectedEditsFor(c, fixDrafts[c.id])
          .filter((e) => previewedKeys.has(`${e.issueId || ''}:${e.stageId || ''}`))
          .map(({ selected: _s, ...edit }) => edit),
      }))
      .filter((t) => t.edits.length);
    if (!targets.length) return;
    setAcceptState({ done: 0, total: targets.length });
    const errors = [];
    for (const target of targets) {
      const result = await acceptPipelineManuscriptFix(seriesId, target.comment.id, { edits: target.edits }, { silent: true })
        .catch((err) => {
          errors.push(err?.message || 'accept failed');
          return null;
        });
      if (!mountedRef.current) return;
      if (result) onAccepted(result);
      setAcceptState((s) => (s ? { ...s, done: s.done + 1 } : s));
    }
    if (!mountedRef.current) return;
    setAcceptState(null);
    const applied = targets.length - errors.length;
    if (errors.length) {
      toast.error(`Applied ${applied} of ${targets.length} notes — ${errors.length} failed (${errors[0]}). The failed notes stay in the preview; regenerate those fixes.`);
    } else {
      toast.success(applied === 1 ? 'Fix applied to the manuscript' : `${applied} notes applied to the manuscript`);
      onClose();
    }
  };

  return (
    <Modal open={open} onClose={onClose} size="3xl" align="top" ariaLabel="Manuscript impact preview">
      <div className="bg-port-card border border-port-border rounded-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-port-border">
          <div>
            <h2 className="text-base font-semibold text-white">Impact preview</h2>
            <p className="text-[11px] text-gray-500">
              {totalEdits === 0
                ? 'No selected edits to preview yet — generate a fix and keep its edits checked.'
                : `${totalEdits} edit${totalEdits === 1 ? '' : 's'} across ${changed.length} issue${changed.length === 1 ? '' : 's'} — accept them all here, or one note at a time from the cards`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {totalEdits > 0 ? (
              <button
                type="button"
                onClick={acceptAll}
                disabled={!!acceptState}
                title="Apply every previewed edit to the manuscript (each section keeps a version-history snapshot, so this is revertible per section)"
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-port-success/20 text-port-success border border-port-success/40 hover:bg-port-success/30 disabled:opacity-40 whitespace-nowrap"
              >
                {acceptState ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                {acceptState
                  ? `Accepting note ${Math.min(acceptState.done + 1, acceptState.total)} of ${acceptState.total}…`
                  : `Accept all ${totalEdits} edit${totalEdits === 1 ? '' : 's'}`}
              </button>
            ) : null}
            <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close preview" title="Close (Esc)">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {changed.length === 0 ? (
            <p className="text-sm text-gray-500 italic">
              Nothing to preview. Generate fixes on the open editorial notes (and leave the edits you want checked); they'll show here as before/after diffs.
            </p>
          ) : (
            changed.map(({ section, before, after, count, overlapping, notFound }) => (
              <div key={`${section.issueId}:${section.stageId}`} className="border border-port-border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-port-bg/60 border-b border-port-border text-sm text-gray-200">
                  Issue {section.number}{section.title ? ` — ${section.title}` : ''}
                  <span className="ml-2 text-[10px] uppercase tracking-wider text-gray-500">{STAGE_LABEL[section.stageId] || section.stageId}</span>
                  <span className="ml-2 text-[10px] text-port-accent">{count} edit{count === 1 ? '' : 's'}</span>
                </div>
                {notFound ? (
                  <p className="px-3 py-1.5 text-[11px] text-port-warning border-b border-port-border bg-port-warning/10">
                    {notFound} edit{notFound === 1 ? '' : 's'} couldn’t be located in the current draft — accepting will be rejected; regenerate the fix. Preview below shows only the edits that matched.
                  </p>
                ) : null}
                {overlapping ? (
                  <p className="px-3 py-1.5 text-[11px] text-port-warning border-b border-port-border bg-port-warning/10">
                    {overlapping} of these edits overlap — accepting will be rejected; regenerate the fix. Preview below shows the non-overlapping subset.
                  </p>
                ) : null}
                <HunkDiff oldText={before} newText={after} oldLabel="Current" newLabel="With edits" />
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
