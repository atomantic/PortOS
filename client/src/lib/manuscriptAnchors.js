/**
 * Manuscript anchor location + highlight segmentation for the in-context
 * editorial-feedback editor. Pure / no React.
 *
 * Editorial comments anchor to manuscript text by VERBATIM substring
 * (`anchorQuote`), not character offsets — mirroring the server. `locateFind`
 * is re-exported from `server/lib/manuscriptLocate.js` — the same implementation
 * the server splices accepted fixes with — so a highlight lands where an accepted
 * fix would actually splice. It is also reused by `applyManuscriptEdits.js` for the
 * client-side impact preview.
 *
 *   locateAnchors(content, comments) → [{ commentId, severity, start, end }]
 *   buildHighlightSegments(content, spans) → [{ text, commentIds, topSeverity }]
 *
 * `buildHighlightSegments` flattens possibly-overlapping/recurring spans into an
 * ordered list of non-overlapping segments that tile the whole content: a
 * segment with an empty `commentIds` is plain text; otherwise it's a highlight
 * carrying every comment covering it, toned by the highest severity present.
 */

import { locateFind, locateFindSpan } from '../../../server/lib/manuscriptLocate.js';

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

export { locateFind, locateFindSpan };

// Resolve each comment's anchorQuote to a [start, end) span in `content`.
// Comments whose anchor isn't present (edited since review, or fuzzy) are
// dropped — they stay listed in the sidebar but show no in-text highlight.
export function locateAnchors(content, comments) {
  const text = content || '';
  const spans = [];
  (comments || []).forEach((c) => {
    const quote = c?.anchorQuote || '';
    if (!quote) return;
    const start = text.indexOf(quote);
    if (start === -1) return;
    spans.push({ commentId: c.id, severity: c.severity || 'low', start, end: start + quote.length });
  });
  return spans;
}

// Flatten spans into ordered, non-overlapping segments tiling the whole content.
export function buildHighlightSegments(content, spans) {
  const text = content || '';
  const valid = (spans || [])
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(text.length, s.end) }))
    .filter((s) => s.end > s.start);
  if (valid.length === 0) {
    return text ? [{ text, commentIds: [], topSeverity: null }] : [];
  }

  // Boundary sweep: every span edge plus the document ends.
  const bounds = new Set([0, text.length]);
  valid.forEach((s) => { bounds.add(s.start); bounds.add(s.end); });
  const points = [...bounds].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i];
    const to = points[i + 1];
    if (to <= from) continue;
    const covering = valid.filter((s) => s.start <= from && s.end >= to);
    const commentIds = covering.map((s) => s.commentId);
    let topSeverity = null;
    covering.forEach((s) => {
      if (!topSeverity || (SEVERITY_RANK[s.severity] || 0) > (SEVERITY_RANK[topSeverity] || 0)) {
        topSeverity = s.severity;
      }
    });
    segments.push({ text: text.slice(from, to), commentIds, topSeverity });
  }
  return segments;
}
