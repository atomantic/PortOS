/**
 * Review-mode manuscript section: defaults to a read-only annotated prose view
 * (highlights + click-to-expand cards) for a focused editorial sweep, and flips
 * to the plain editable `<textarea>` on demand via an Edit toggle. Blur in edit
 * mode saves and returns to the annotated view, which re-locates anchors against
 * the new text. The open comment's card expands inline beneath the prose.
 */

import { useMemo } from 'react';
import { Pencil, Check } from 'lucide-react';
import ManuscriptHighlightedProse from './ManuscriptHighlightedProse';
import ManuscriptCommentCard from './ManuscriptCommentCard';
import ManuscriptSectionFrame from './ManuscriptSectionFrame';
import { rowsFor } from './constants';

export default function AnnotatedManuscriptSection({
  section, comments, spans, saveState, editing, onToggleEdit,
  openCommentId, onOpenComment,
  onContentChange, onBlurSave, onRevert, registerRef, commentCardProps,
}) {
  const content = section.content || '';
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const openComment = openCommentId && byId.get(openCommentId)?.status === 'open' ? byId.get(openCommentId) : null;

  const editToggle = (
    <button
      type="button"
      onClick={onToggleEdit}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-port-border text-gray-300 hover:text-white hover:border-port-accent/40"
      title={editing ? 'Done editing — back to annotated view' : 'Edit this section'}
    >
      {editing ? <><Check size={11} /> Done</> : <><Pencil size={11} /> Edit</>}
    </button>
  );

  return (
    <ManuscriptSectionFrame section={section} saveState={saveState} onRevert={onRevert} headerExtra={editToggle}>
      {editing ? (
        <textarea
          ref={registerRef}
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onBlur={onBlurSave}
          rows={rowsFor(content)}
          spellCheck
          autoFocus
          className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-100 font-mono leading-relaxed resize-y focus:border-port-accent/50 focus:outline-none"
        />
      ) : (
        <ManuscriptHighlightedProse
          content={content}
          spans={spans}
          openCommentId={openCommentId}
          onOpenComment={onOpenComment}
        />
      )}

      {!editing && openComment ? (
        <div className="border-l-2 border-port-accent/50 pl-2">
          <ManuscriptCommentCard
            comment={openComment}
            idScope={`review-${openComment.id}`}
            seriesId={commentCardProps.seriesId}
            providerOverride={commentCardProps.providerOverride}
            modelOverride={commentCardProps.modelOverride}
            onCommentChange={commentCardProps.onCommentChange}
            onAccepted={commentCardProps.onAccepted}
            draft={commentCardProps.fixDrafts[openComment.id]}
            onDraftChange={(entry) => commentCardProps.setCommentDraft(openComment.id, entry)}
            onJump={undefined}
          />
        </div>
      ) : null}
    </ManuscriptSectionFrame>
  );
}
