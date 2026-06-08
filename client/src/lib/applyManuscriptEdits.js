/**
 * Client-side preview of applying editorial fix edits to a manuscript section.
 * Mirrors the server splice in `server/services/pipeline/manuscriptFix.js`
 * (`acceptManuscriptFix`): locate each `find` (nearest the anchor when it
 * recurs), then replace from the bottom up so earlier offsets stay valid.
 *
 * PREVIEW ONLY — the server route remains authoritative for the real accept.
 * This exists so the impact-preview modal can show before/after without
 * mutating anything. Shares `locateFind` with `manuscriptAnchors.js`.
 */

import { locateFindSpan } from './manuscriptAnchors.js';

// Plan how `edits` (each { find, replace, anchorQuote? }) apply to `content`:
// locate each (whitespace-tolerant, mirroring the server accept), splice the
// kept spans high-to-low, and report what couldn't apply. Edits whose `find`
// isn't present count as `notFound`; edits overlapping an earlier kept span
// count as `overlapping`. The server accept THROWS on overlap, so the preview
// uses `overlapping` to warn that accepting will fail rather than render a
// partial result the accept won't actually produce.
export function planManuscriptEdits(content, edits, anchorQuote) {
  const text = content || '';
  const located = [];
  let notFound = 0;
  (edits || []).forEach((e) => {
    const find = e?.find || '';
    if (!find) return;
    const span = locateFindSpan(text, find, e.anchorQuote ?? anchorQuote);
    if (!span) { notFound += 1; return; }
    located.push({ start: span.start, end: span.end, replace: e.replace ?? '' });
  });

  located.sort((a, b) => a.start - b.start);
  const kept = [];
  let overlapping = 0;
  let lastEnd = -1;
  located.forEach((l) => {
    if (l.start >= lastEnd) { kept.push(l); lastEnd = l.end; } else overlapping += 1;
  });

  let output = text;
  kept.slice().sort((a, b) => b.start - a.start).forEach((l) => {
    output = output.slice(0, l.start) + l.replace + output.slice(l.end);
  });
  return { output, applied: kept.length, notFound, overlapping };
}

// Convenience: just the resulting text (drops overlaps/not-found silently).
export function applyEditsToContent(content, edits, anchorQuote) {
  return planManuscriptEdits(content, edits, anchorQuote).output;
}
