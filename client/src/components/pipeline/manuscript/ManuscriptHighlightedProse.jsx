/**
 * Read-only annotated prose for Review mode: renders manuscript text with each
 * anchored editorial comment as a clickable, severity-toned highlight. Clicking
 * a highlight opens its comment (handled by the parent). When the parent passes
 * `inlineCard`, the open note's card is injected INTO the prose flow at the end
 * of the line containing its highlight — acting on a note never means scrolling
 * away from the text it's about. Plain (non-highlighted) text renders verbatim,
 * preserving whitespace.
 */

import { useMemo, useRef } from 'react';
import { buildHighlightSegments } from '../../../lib/manuscriptAnchors';
import useAnchorReveal from '../../../hooks/useAnchorReveal';
import { SEVERITY_TONE } from './constants';

export default function ManuscriptHighlightedProse({ content, spans, openCommentId, onOpenComment, inlineCard }) {
  const text = content || '';
  const segments = useMemo(() => buildHighlightSegments(text, spans), [text, spans]);

  // Scroll the open finding's highlighted text into view and flash it on open /
  // prev-next step (#1601). `activeRef` points at the first highlight segment
  // carrying the open comment; it stays null when the anchor isn't located in
  // the draft, so the reveal is a no-op and the parent's card fallback scrolls.
  const activeRef = useRef(null);
  const located = useMemo(
    () => !!openCommentId && (spans || []).some((s) => s.commentId === openCommentId),
    [openCommentId, spans],
  );
  useAnchorReveal(() => activeRef.current, located ? openCommentId : null);

  // Character offset where the inline card splices into the prose: just past
  // the newline ending the line that contains the open note's highlight (or the
  // end of the text). -1 = no card to place. If the note's span isn't located
  // (shouldn't happen — the parent only passes inlineCard for located notes),
  // fall back to appending at the end rather than dropping the card.
  const cutAt = useMemo(() => {
    if (!inlineCard) return -1;
    const owned = (spans || []).filter((s) => s.commentId === openCommentId);
    if (!owned.length) return text.length;
    const end = Math.max(...owned.map((s) => s.end));
    const nl = text.indexOf('\n', end);
    return nl === -1 ? text.length : nl + 1;
  }, [inlineCard, openCommentId, spans, text]);

  const renderSegment = (seg, key, textOverride) => {
    const segText = textOverride ?? seg.text;
    if (!segText) return null;
    if (!seg.commentIds.length) return <span key={key}>{segText}</span>;
    const active = seg.commentIds.includes(openCommentId);
    const tone = SEVERITY_TONE[seg.topSeverity] || SEVERITY_TONE.low;
    return (
      <button
        key={key}
        ref={active ? activeRef : undefined}
        type="button"
        onClick={() => onOpenComment(seg.commentIds[0])}
        aria-expanded={active}
        className={`rounded-sm border-b-2 px-0.5 -mx-0.5 text-left align-baseline ${tone} ${active ? 'ring-1 ring-port-accent/60' : ''}`}
        title="Open editorial note"
      >
        {segText}
      </button>
    );
  };

  // The card is block content inside a pre-wrap container — reset whitespace
  // and font so it renders as a normal card, not monospace prose.
  const cardNode = (
    <div key="inline-card" className="my-2 font-sans whitespace-normal">
      {inlineCard}
    </div>
  );

  const nodes = [];
  let offset = 0;
  let injected = cutAt < 0;
  segments.forEach((seg, i) => {
    const len = seg.text.length;
    if (!injected && cutAt <= offset) {
      nodes.push(cardNode);
      injected = true;
    }
    if (!injected && cutAt < offset + len) {
      const at = cutAt - offset;
      nodes.push(renderSegment(seg, `${i}-a`, seg.text.slice(0, at)));
      nodes.push(cardNode);
      nodes.push(renderSegment(seg, `${i}-b`, seg.text.slice(at)));
      injected = true;
    } else {
      nodes.push(renderSegment(seg, i));
    }
    offset += len;
  });
  if (!injected) nodes.push(cardNode);

  return (
    <div className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-100 font-mono leading-relaxed whitespace-pre-wrap break-words">
      {nodes}
    </div>
  );
}
