/**
 * Manuscript `find` locator shared by the server (accepted editorial edits,
 * `services/pipeline/manuscriptFix.js`) and the client (highlighting and the
 * impact preview, via `client/src/lib/manuscriptAnchors.js`). One implementation
 * so the preview always selects the span the persisted accept will replace.
 * Pure / browser-safe.
 */

import { escapeRegExp } from './textUtils.js';

// `indexOf` alone targets the FIRST match, which is the wrong spot when `find`
// recurs. When ambiguous, pick the occurrence nearest the `anchorQuote`.
// Returns the start index, or -1 if absent.
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

// LLMs reformat whitespace when quoting a passage, so exact `find` often isn't
// verbatim. Try exact first, then a regex where each whitespace run matches any
// whitespace run. Returns { start, end } in the ORIGINAL text (span length may
// differ from find.length) or null.
export function locateFindSpan(text, find, anchorQuote) {
  if (!find) return null;
  const exact = locateFind(text, find, anchorQuote);
  if (exact !== -1) return { start: exact, end: exact + find.length };

  const re = new RegExp(escapeRegExp(find).replace(/\s+/g, '\\s+'), 'g');
  const anchorIdx = anchorQuote ? text.indexOf(anchorQuote) : -1;
  let best = null;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const cand = { start: m.index, end: m.index + m[0].length };
    if (!best) best = cand;
    else if (anchorIdx !== -1 && Math.abs(cand.start - anchorIdx) < Math.abs(best.start - anchorIdx)) best = cand;
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width matches
  }
  return best;
}
