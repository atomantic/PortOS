/**
 * Review-mode manuscript section: defaults to a read-only annotated prose view
 * (highlights + click-to-expand cards) for a focused editorial sweep, and flips
 * to the plain editable `<textarea>` on demand via an Edit toggle. Blur in edit
 * mode saves and returns to the annotated view, which re-locates anchors against
 * the new text. The open comment's card is injected into the prose at its
 * anchor (so acting on a note keeps the text it's about on screen); a note
 * whose anchor isn't located in the current draft falls back to expanding
 * beneath the prose.
 */

import { useEffect, useMemo, useRef } from 'react';
import { Pencil, Check, X } from 'lucide-react';
import useEscapeKey from '../../../hooks/useEscapeKey';
import ManuscriptHighlightedProse from './ManuscriptHighlightedProse';
import { CommentCardFromProps } from './ManuscriptCommentCard';
import ManuscriptSectionFrame from './ManuscriptSectionFrame';
import { rowsFor } from './constants';

export default function AnnotatedManuscriptSection({
  section, comments, spans, saveState, editing, onToggleEdit,
  openCommentId, onOpenComment, onCloseComment,
  onContentChange, onBlurSave, onFormat, onReformat, onRevert, registerRef, commentCardProps,
}) {
  const content = section.content || '';
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const openComment = openCommentId && byId.get(openCommentId)?.status === 'open' ? byId.get(openCommentId) : null;
  const located = openComment ? spans.some((s) => s.commentId === openComment.id) : false;
  const cardRef = useRef(null);

  // Bring the open card (and with it the anchor text it sits under) into view —
  // on open, and again when stepping prev/next between notes. Only the section
  // that actually owns the open comment scrolls.
  useEffect(() => {
    if (openComment) cardRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [openComment?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes the open note — parity with the Live popover.
  useEscapeKey(openComment, onCloseComment);

  const card = openComment && !editing ? (
    <div ref={cardRef} className="relative border-l-2 border-port-accent/50 pl-2">
      <button
        type="button"
        onClick={onCloseComment}
        className="absolute right-1 top-1 z-10 text-gray-500 hover:text-white"
        aria-label="Close note"
        title="Close note"
      >
        <X size={14} />
      </button>
      <CommentCardFromProps comment={openComment} commentCardProps={commentCardProps} idScope={`review-${openComment.id}`} />
    </div>
  ) : null;

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
    <ManuscriptSectionFrame section={section} saveState={saveState} onRevert={onRevert} onFormat={onFormat} onReformat={onReformat} headerExtra={editToggle} registerRef={registerRef}>
      {editing ? (
        <textarea
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
          inlineCard={located ? card : null}
        />
      )}

      {card && !located ? card : null}
    </ManuscriptSectionFrame>
  );
}
