/**
 * Whole-manuscript impact preview — a modal that shows, per affected section, a
 * before/after side-by-side diff of what accepting the currently-selected
 * editorial fixes would do. Per-card diffs don't convey cumulative impact; this
 * applies every selected edit (via the same `selectedEditsFor` logic Accept
 * uses) to a COPY of each section client-side. Preview only — accept still goes
 * through the authoritative server route.
 *
 * Diffs per changed section (never one giant concatenation) so the diff cell
 * cap isn't tripped on a long manuscript.
 */

import { useMemo } from 'react';
import { X } from 'lucide-react';
import Modal from '../../ui/Modal';
import SideBySideDiff from '../../ui/SideBySideDiff';
import { planManuscriptEdits } from '../../../lib/applyManuscriptEdits';
import { selectedEditsFor } from './ManuscriptCommentCard';
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

export default function ManuscriptImpactPreview({ open, onClose, sections, comments, fixDrafts }) {
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

  return (
    <Modal open={open} onClose={onClose} size="3xl" align="top" ariaLabel="Manuscript impact preview">
      <div className="bg-port-card border border-port-border rounded-lg max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-port-border">
          <div>
            <h2 className="text-base font-semibold text-white">Impact preview</h2>
            <p className="text-[11px] text-gray-500">
              {totalEdits === 0
                ? 'No selected edits to preview yet — generate a fix and keep its edits checked.'
                : `${totalEdits} edit${totalEdits === 1 ? '' : 's'} across ${changed.length} issue${changed.length === 1 ? '' : 's'} (preview only — accept from each note)`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white" aria-label="Close preview" title="Close (Esc)">
            <X size={18} />
          </button>
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
                <SideBySideDiff oldText={before} newText={after} oldLabel="Current" newLabel="With edits" />
              </div>
            ))
          )}
        </div>
      </div>
    </Modal>
  );
}
