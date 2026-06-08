/**
 * Manuscript anchor location + highlight segmentation for the in-context
 * editorial-feedback editor. Pure / no React.
 *
 * Editorial comments anchor to manuscript text by VERBATIM substring
 * (`anchorQuote`), not character offsets — mirroring the server. `locateFind`
 * here mirrors `locateFind` in `server/services/pipeline/manuscriptFix.js`
 * (nearest-occurrence disambiguation) so a highlight lands where an accepted fix
 * would actually splice. It is also reused by `applyManuscriptEdits.js` for the
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

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

// Locate the `find` span to highlight/replace. `indexOf` alone targets the FIRST
// match, which is the wrong spot when `find` recurs. When ambiguous, pick the
// occurrence nearest the `anchorQuote`. Returns the start index, or -1 if absent.
export function locateFind(text, find, anchorQuote) {
  if (!find) return -1;
  const first = text.indexOf(find);
  if (first === -1) return -1;
  if (text.indexOf(find, first + 1) === -1) return first; // unique
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  if (anchorIdx === -1) return first; // can't disambiguate — first match
  let best = first;
  let bestDist = Math.abs(first - anchorIdx);
  for (let i = text.indexOf(find, first + 1); i !== -1; i = text.indexOf(find, i + 1)) {
    const dist = Math.abs(i - anchorIdx);
    if (dist < bestDist) { best = i; bestDist = dist; }
  }
  return best;
}

// Locate `find` tolerating whitespace-only differences (LLMs reformat spacing
// when quoting). Tries exact first, then a regex where each run of whitespace
// matches any run of whitespace. Returns the matched { start, end } in the
// original text (the span length may differ from find.length) or null. Mirrors
// `locateFindSpan` in `server/services/pipeline/manuscriptFix.js`.
export function locateFindSpan(text, find, anchorQuote) {
  if (!find) return null;
  const exact = locateFind(text, find, anchorQuote);
  if (exact !== -1) return { start: exact, end: exact + find.length };

  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped.replace(/\s+/g, '\\s+'), 'g');
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  let best = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cand = { start: m.index, end: m.index + m[0].length };
    if (!best) best = cand;
    else if (anchorIdx !== -1 && Math.abs(cand.start - anchorIdx) < Math.abs(best.start - anchorIdx)) best = cand;
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return best;
}

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
