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

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { buildHighlightSegments } from '../../../lib/manuscriptAnchors';
import ManuscriptCommentCard from './ManuscriptCommentCard';
import ManuscriptSectionFrame from './ManuscriptSectionFrame';
import { SEVERITY_UNDERLINE, SEVERITY_TONE, CATEGORY_LABEL, rowsFor } from './constants';

// Identical typography on the textarea and its backdrop so underlines land under
// the right words. Monospace keeps alignment exact across the two layers.
const EDITOR_TYPO = 'px-3 py-2 text-sm font-mono leading-relaxed whitespace-pre-wrap break-words';

export default function ManuscriptLiveSection({
  section, comments, spans, saveState, openCommentId, onOpenComment, onCloseComment,
  onContentChange, onBlurSave, onRevert, registerRef, commentCardProps,
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
  useLayoutEffect(() => {
    if (!openComment || !backdropRef.current) return;
    const marks = backdropRef.current.querySelectorAll('mark[data-cids]');
    const mark = [...marks].find((m) => (m.dataset.cids || '').split(',').includes(openComment.id));
    setPopTop(mark ? mark.offsetTop + mark.offsetHeight + 4 : 0);
  }, [openComment, content, segments]);

  // Esc closes the popover.
  useEffect(() => {
    if (!openComment) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onCloseComment(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openComment, onCloseComment]);

  return (
    <ManuscriptSectionFrame section={section} saveState={saveState} onRevert={onRevert} registerRef={registerRef}>
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
          onKeyUp={handleCaret}
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
                <ManuscriptCommentCard
                  comment={openComment}
                  idScope={`live-${openComment.id}`}
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
            </div>
          </div>
        ) : null}
      </div>
    </ManuscriptSectionFrame>
  );
}
