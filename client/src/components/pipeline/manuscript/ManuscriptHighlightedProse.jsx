/**
 * Read-only annotated prose for Review mode: renders manuscript text with each
 * anchored editorial comment as a clickable, severity-toned highlight. Clicking
 * a highlight opens its comment (handled by the parent, which expands the card
 * inline beneath the section). Plain (non-highlighted) text renders verbatim,
 * preserving whitespace.
 */

import { useMemo } from 'react';
import { buildHighlightSegments } from '../../../lib/manuscriptAnchors';
import { SEVERITY_TONE } from './constants';

export default function ManuscriptHighlightedProse({ content, spans, openCommentId, onOpenComment }) {
  const segments = useMemo(() => buildHighlightSegments(content || '', spans), [content, spans]);

  return (
    <div className="w-full px-3 py-2 bg-port-card border border-port-border rounded text-sm text-gray-100 font-mono leading-relaxed whitespace-pre-wrap break-words">
      {segments.map((seg, i) => {
        if (!seg.commentIds.length) return <span key={i}>{seg.text}</span>;
        const active = seg.commentIds.includes(openCommentId);
        const tone = SEVERITY_TONE[seg.topSeverity] || SEVERITY_TONE.low;
        return (
          <button
            key={i}
            type="button"
            onClick={() => onOpenComment(seg.commentIds[0])}
            aria-expanded={active}
            className={`rounded-sm border-b-2 px-0.5 -mx-0.5 text-left align-baseline ${tone} ${active ? 'ring-1 ring-port-accent/60' : ''}`}
            title="Open editorial note"
          >
            {seg.text}
          </button>
        );
      })}
    </div>
  );
}
