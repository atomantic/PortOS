/** Splits structured comic scripts by issue or page headers while preserving the source excerpts. */

import { COMIC_NUM, COMIC_HEADER_TAIL } from '../../lib/comicScriptParser.js';
import { isStr } from '../../lib/textUtils.js';

// A comic script is already issue/page-structured prose, so re-running it
// through a heavy LLM to "propose" an issue split both costs tokens and
// risks the model rephrasing verbatim panel/dialogue text. When the script
// carries explicit ISSUE or PAGE headers we split on them deterministically
// instead — verbatim, instant, free. Falls back (returns null) to the LLM
// split when no headers are found so a header-less comic script still works.

// Default page bundle size when a script has PAGE markers but no ISSUE
// markers and the user didn't request a specific issue count. ~22 pages is
// the floppy-issue convention referenced in DEFAULT_TARGET_ISSUE_COUNT_HINT.
const COMIC_PAGES_PER_ISSUE = 22;

// Header-like line gate: comic ISSUE/PAGE headers sit on their own short,
// usually all-caps line. Capping length keeps a prose sentence that happens
// to open with "Page " or "Issue " from being mistaken for a structural
// marker (the LLM fallback still covers genuinely header-less scripts).
const COMIC_HEADER_MAX_LEN = 80;
// `ISSUE #3`, `ISSUE 3`, `ISSUE THREE`, `ISSUE 3: TITLE`, `ISSUE THREE - TITLE`.
// `COMIC_NUM` + `COMIC_HEADER_TAIL` (shared with the render-time parser via
// comicScriptParser.js) restrict the number token to digits/spelled-numbers
// AND require a standalone header form — so prose like "Issue resolved." or
// "Issue 1 of the saga lay open" (content that merely starts with the keyword)
// isn't mis-split. A title is captured only after a separator. Sharing the
// grammar keeps the import-time split and the render-time parse in agreement —
// except for the COMIC_HEADER_MAX_LEN (80) length cap applied here but NOT by
// the render-time bare parser, so a rare >80-char PAGE/ISSUE header folds into
// the prior segment at split time yet still opens a page at render time.
const ISSUE_HEADER_RE = new RegExp(`^issue\\b\\s*#?\\s*(${COMIC_NUM})\\b\\s*(?:[:.\\-–—]\\s*(.*))?\\s*$`, 'i');
// `PAGE 1`, `PAGE ONE`, `PAGES 2-3`, `PAGE ONE (FIVE PANELS)`
const PAGE_HEADER_RE = new RegExp(`^pages?\\b\\s*#?\\s*(${COMIC_NUM})\\b${COMIC_HEADER_TAIL}`, 'i');

// Locate header lines matching `re`. Returns `[{ idx, title }]` where `idx`
// is the 0-based line index and `title` is the trailing text after the
// number (ISSUE only; '' otherwise).
function findComicHeaders(lines, re) {
  const headers = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.length > COMIC_HEADER_MAX_LEN) continue;
    const m = re.exec(t);
    if (m) headers.push({ idx: i, title: (m[2] || '').trim() });
  }
  return headers;
}

// Slice `lines[startIdx..endIdx)` back into a verbatim string (newline-
// joined) and trim surrounding blank lines without touching interior text.
function joinSegment(lines, startIdx, endIdx) {
  return lines.slice(startIdx, endIdx).join('\n').replace(/^\n+|\n+$/g, '');
}

/**
 * Mechanically split a comic script into issue proposals on its ISSUE / PAGE
 * headers. Returns an array of `{ title, arcPosition, proseExcerpt }` (no
 * logline/synopsis — the split deliberately does NOT interpret), or `null`
 * when no usable headers are found (caller falls back to the LLM split).
 *
 * Pure + exported for unit testing. `targetIssueCount` (when a positive
 * integer) forces the PAGE-bundling path to produce exactly that many issues,
 * evenly distributed; ISSUE headers always win when present.
 */
export function splitComicScriptIssues(source, { targetIssueCount = null } = {}) {
  if (!isStr(source) || !source.trim()) return null;
  const lines = source.split(/\r\n|\r|\n/);

  // 1) Explicit ISSUE headers — one issue per header, verbatim. Any text
  //    before the first header (title page / credits) folds into issue 1.
  const issueHeaders = findComicHeaders(lines, ISSUE_HEADER_RE);
  if (issueHeaders.length > 0) {
    const out = [];
    for (let i = 0; i < issueHeaders.length; i++) {
      const startIdx = i === 0 ? 0 : issueHeaders[i].idx;
      const endIdx = i + 1 < issueHeaders.length ? issueHeaders[i + 1].idx : lines.length;
      const proseExcerpt = joinSegment(lines, startIdx, endIdx);
      if (!proseExcerpt.trim()) continue;
      out.push({
        // Preserve the script's own issue title verbatim when present;
        // otherwise label sequentially. Title-casing would be a rewrite.
        title: issueHeaders[i].title || `Issue ${i + 1}`,
        arcPosition: i + 1,
        proseExcerpt,
      });
    }
    return out.length > 0 ? out : null;
  }

  // 2) No ISSUE headers — bundle PAGE markers into issues.
  const pageHeaders = findComicHeaders(lines, PAGE_HEADER_RE);
  if (pageHeaders.length === 0) return null; // header-less → LLM fallback

  // Each page spans from its header to the next (preamble folds into page 1).
  const pages = pageHeaders.map((h, i) => {
    const startIdx = i === 0 ? 0 : h.idx;
    const endIdx = i + 1 < pageHeaders.length ? pageHeaders[i + 1].idx : lines.length;
    return joinSegment(lines, startIdx, endIdx);
  }).filter((p) => p.trim());
  if (pages.length === 0) return null;

  // How many issues to produce: explicit user count (clamped to page count)
  // beats the ~22-pages-per-issue default.
  const requested = Number.isInteger(targetIssueCount) && targetIssueCount > 0
    ? Math.min(targetIssueCount, pages.length)
    : Math.max(1, Math.ceil(pages.length / COMIC_PAGES_PER_ISSUE));

  // Distribute pages as evenly as possible across `requested` issues — the
  // first `remainder` issues get one extra page so no pages are dropped.
  const base = Math.floor(pages.length / requested);
  const remainder = pages.length % requested;
  const out = [];
  let cursor = 0;
  for (let i = 0; i < requested; i++) {
    const take = base + (i < remainder ? 1 : 0);
    const slice = pages.slice(cursor, cursor + take);
    cursor += take;
    const proseExcerpt = slice.join('\n\n').replace(/^\n+|\n+$/g, '');
    if (!proseExcerpt.trim()) continue;
    out.push({ title: `Issue ${i + 1}`, arcPosition: i + 1, proseExcerpt });
  }
  return out.length > 0 ? out : null;
}
