/**
 * Live (Grammarly-style) manuscript section: the section stays a fully editable
 * `<textarea>`, with a backdrop layer behind it painting a severity-toned
 * underline under each anchored editorial comment. Clicking text on an underline
 * (or a pin chip) opens that comment's card as a popover anchored just below the
 * highlighted span.
 *
 * Why a backdrop instead of a rich editor: the save/version/accept pipeline
 * round-trips plain strings, and anchors are verbatim substrings — a transparent
 * mirror div with identical monospace metrics paints underlines exactly under
 * the words with zero changes to the editing/persistence path. See the plan at
 * docs/plans/2026-06-06-manuscript-editor-inline-feedback.md.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import useEscapeKey from '../../../hooks/useEscapeKey';
import { buildHighlightSegments } from '../../../lib/manuscriptAnchors';
import { CommentCardFromProps } from './ManuscriptCommentCard';
import ManuscriptSectionFrame from './ManuscriptSectionFrame';
import { SEVERITY_UNDERLINE, SEVERITY_TONE, CATEGORY_LABEL, rowsFor } from './constants';

// Identical typography on the textarea and its backdrop so underlines land under
// the right words. Monospace keeps alignment exact across the two layers.
const EDITOR_TYPO = 'px-3 py-2 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words';

export default function ManuscriptLiveSection({
  section, comments, spans, saveState, openCommentId, onOpenComment, onCloseComment,
  onContentChange, onBlurSave, onFormat, onReformat, onRevert, registerRef, commentCardProps,
}) {
  const content = section.content || '';
  const taRef = useRef(null);
  const backdropRef = useRef(null);
  const wrapRef = useRef(null);
  const [popTop, setPopTop] = useState(0);

  const segments = useMemo(() => buildHighlightSegments(content, spans), [content, spans]);

  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  const anchoredComments = useMemo(
    () => spans.map((s) => byId.get(s.commentId)).filter(Boolean),
    [spans, byId],
  );
  const unlocatedCount = comments.length - new Set(spans.map((s) => s.commentId)).size;

  const openComment = openCommentId && byId.get(openCommentId)?.status === 'open' ? byId.get(openCommentId) : null;

  // Open the comment whose anchor span covers the caret.
  const handleCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    const idx = ta.selectionStart;
    const hit = spans.find((s) => idx >= s.start && idx < s.end);
    if (hit) onOpenComment(hit.commentId);
  };

  // Position the popover just below the open comment's first underline mark.
  // `offsetTop` is a content coordinate, so subtract the textarea's scrollTop —
  // otherwise a note opened after scrolling a long (>400-row) section lands far
  // from the visible underline. Recomputed on scroll (see the textarea handler).
  const positionPopover = () => {
    const backdrop = backdropRef.current;
    if (!openComment || !backdrop) return;
    const marks = backdrop.querySelectorAll('mark[data-cids]');
    const mark = [...marks].find((m) => (m.dataset.cids || '').split(',').includes(openComment.id));
    const scrollTop = taRef.current?.scrollTop || 0;
    setPopTop(mark ? mark.offsetTop + mark.offsetHeight + 4 - scrollTop : 0);
  };
  useLayoutEffect(positionPopover, [openComment, content, segments]);

  // Esc closes the popover.
  useEscapeKey(openComment, onCloseComment);

  return (
    <ManuscriptSectionFrame section={section} saveState={saveState} onRevert={onRevert} onFormat={onFormat} onReformat={onReformat} registerRef={registerRef}>
      {/* Pin chips: a touch-friendly, count-bearing way into each anchored note. */}
      {anchoredComments.length > 0 || unlocatedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {anchoredComments.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpenComment(c.id)}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${SEVERITY_TONE[c.severity] || SEVERITY_TONE.low}`}
              title={c.problem}
            >
              {CATEGORY_LABEL[c.category] || c.category}
            </button>
          ))}
          {unlocatedCount > 0 ? (
            <span
              className="text-[10px] text-gray-500"
              title="These notes' anchor text was not found verbatim in the current draft — they're listed in the sidebar but have no in-text underline."
            >
              {unlocatedCount} not located in text
            </span>
          ) : null}
        </div>
      ) : null}

      <div ref={wrapRef} className="relative">
        {/* Backdrop: transparent text, only the per-comment underlines show
            through behind the textarea's real text. aria-hidden — the marks are
            decorative; the actionable surface is the pin chips + caret-open. */}
        <div
          ref={backdropRef}
          aria-hidden="true"
          className={`absolute inset-0 overflow-hidden border border-transparent text-transparent select-none pointer-events-none ${EDITOR_TYPO}`}
        >
          {segments.map((seg, i) => (
            seg.commentIds.length ? (
              <mark
                key={i}
                data-cids={seg.commentIds.join(',')}
                className={`bg-transparent border-b-2 ${SEVERITY_UNDERLINE[seg.topSeverity] || SEVERITY_UNDERLINE.low}`}
              >
                {seg.text}
              </mark>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          ))}
          {/* Trailing newline guard so the box height matches the textarea. */}
          {'\n'}
        </div>

        <textarea
          ref={(el) => { taRef.current = el; }}
          value={content}
          onChange={(e) => onContentChange(e.target.value)}
          onBlur={onBlurSave}
          onClick={handleCaret}
          // Escape closes the popover (useEscapeKey); don't let the trailing
          // keyup re-open it because the caret still sits inside the span.
          onKeyUp={(e) => { if (e.key !== 'Escape') handleCaret(); }}
          // Keep the underline backdrop aligned when a section longer than the
          // row cap scrolls internally (the backdrop is overflow-hidden), and
          // re-pin the open popover to its now-moved underline.
          onScroll={(e) => {
            if (backdropRef.current) {
              backdropRef.current.scrollTop = e.target.scrollTop;
              backdropRef.current.scrollLeft = e.target.scrollLeft;
            }
            positionPopover();
          }}
          rows={rowsFor(content)}
          spellCheck
          className={`relative w-full bg-transparent border border-port-border rounded text-gray-100 resize-y focus:border-port-accent/50 focus:outline-none ${EDITOR_TYPO}`}
        />

        {openComment ? (
          <div className="absolute left-0 right-0 z-20" style={{ top: popTop }}>
            <div className="rounded-lg border border-port-accent/50 bg-port-card shadow-xl shadow-black/50">
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-port-border">
                <span className="text-[10px] uppercase tracking-wider text-gray-400">Editorial note</span>
                <button type="button" onClick={onCloseComment} className="text-gray-500 hover:text-white" aria-label="Close note" title="Close note (Esc)">
                  <X size={13} />
                </button>
              </div>
              <div className="p-2">
                <CommentCardFromProps comment={openComment} commentCardProps={commentCardProps} idScope={`live-${openComment.id}`} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </ManuscriptSectionFrame>
  );
}
