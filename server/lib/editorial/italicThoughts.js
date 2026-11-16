/**
 * Italicized-internal-thought deterministic primitive for the editorial check registry
 * (backs `prose.italic-thoughts`). Pure and dependency-free, like ./cliches.js.
 *
 * Everything on the page is already the POV character's perspective, so a multi-word
 * italic clause is almost always a narrated thought. High-precision by design: a SHORT
 * span (stressed word, title, foreign term) is emphasis, so only runs of `minWords`+
 * words are flagged.
 */

import { countWords } from '../textUtils.js';

// Markdown italic delimiters: a single `*` not part of a `**`/`***` run, or a single `_`
// with non-word edges (so `snake_case` and `__bold__` never match). Spans are single-line.
const ASTERISK_ITALIC_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g;
const UNDERSCORE_ITALIC_RE = /(?<![\w_])_(?!_)([^_\n]+?)_(?![\w_])/g;

/**
 * Find italicized runs that read as internal-thought narration. Returns the FIRST
 * occurrence of each distinct run (deduped on normalized inner text), sorted by position.
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
  // Sort by position BEFORE deduping so "first" means first in the TEXT regardless of delimiter.
  const matches = [];
  const scan = (re) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const inner = m[1].trim();
      const words = countWords(inner);
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
