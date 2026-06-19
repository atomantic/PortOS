/**
 * Italicized-internal-thought deterministic primitive (#1300) for the editorial
 * check registry. Pure and dependency-free (no side-effecting imports) so it
 * stays unit-testable in isolation — mirrors ./cliches.js and ./nameSimilarity.js.
 *
 * Backs the deterministic `prose.italic-thoughts` check in checkRegistry.js. The
 * editorial rule: everything on the page is already the POV character's
 * perspective, so setting internal thoughts in *italics* is a tell — a multi-word
 * italic clause is almost always a narrated thought that could simply be prose.
 *
 * High-precision by design (favors under-flagging, like the other deterministic
 * scanners): a SHORT italic span (a stressed word, a title, a foreign term) is
 * emphasis, not a thought, so only runs of `minWords`+ words are flagged. The LLM
 * siblings handle the judgment cases this can't.
 */

// Markdown italic delimiters. Asterisk italics are a single `*` NOT part of a
// `**`/`***` bold run; underscore italics are a single `_` with non-word edges
// (so `snake_case` and `__bold__` are never mistaken for emphasis). Each span is
// single-line (`[^*\n]` / `[^_\n]`) — a thought run that spans a blank line is a
// paragraph, not an inline italic clause.
const ASTERISK_ITALIC_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g;
const UNDERSCORE_ITALIC_RE = /(?<![\w_])_(?!_)([^_\n]+?)_(?![\w_])/g;

// Count whitespace-delimited words in an italic span's inner text.
function wordCount(text) {
  const m = String(text).trim().match(/\S+/g);
  return m ? m.length : 0;
}

/**
 * Find italicized runs in `text` that read as internal-thought narration —
 * multi-word italic spans (markdown `*…*` or `_…_`). Returns the FIRST occurrence
 * of each distinct run (deduped on the normalized inner text — the same thought
 * italicized twice is one tic to fix, not two), sorted by position.
 *
 * @param {string} text
 * @param {{ minWords?: number }} [opts]
 *   minWords — minimum word count for an italic span to count as a thought run
 *     (default 4; a shorter span is treated as emphasis and skipped). Floored at 1.
 * @returns {Array<{ inner: string, index: number, anchor: string, words: number }>}
 *   inner — the text between the markers; anchor — the verbatim span WITH markers.
 */
export function findItalicThoughts(text, opts = {}) {
  if (typeof text !== 'string' || !text) return [];
  const minWords = Math.max(1, Number.isInteger(opts.minWords) ? opts.minWords : 4);
  // Collect matches from BOTH delimiters first, then sort by position before
  // deduping — so "FIRST occurrence" is the first in the TEXT, regardless of
  // which delimiter the dedup-winner uses (an earlier `_…_` span must win over a
  // later `*…*` span with identical text).
  const matches = [];
  const scan = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[1].trim();
      const words = wordCount(inner);
      if (words < minWords) continue;
      matches.push({ inner, index: m.index, anchor: m[0], words });
    }
  };
  scan(ASTERISK_ITALIC_RE);
  scan(UNDERSCORE_ITALIC_RE);
  matches.sort((a, b) => a.index - b.index);
  const found = [];
  const seen = new Set();
  for (const match of matches) {
    const key = match.inner.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(match);
  }
  return found;
}
