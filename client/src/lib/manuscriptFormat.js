/**
 * Pure manuscript text normalizer for the Manuscript editor's "Format" button.
 *
 * The motivating mess: text pasted out of a PDF export arrives hard-wrapped at
 * the page margin (every visual line is a real `\n`), with stylized drop-caps
 * split onto their own line ("T\nhe dawn …") and words hyphenated across the
 * wrap ("approxi-\nmating"). `formatManuscript(text, stageId)` undoes those
 * paste artifacts so a paragraph reads as one logical line again.
 *
 * Two altitudes, chosen by stage:
 *   - prose  → full reflow: join soft-wrapped lines back into paragraphs.
 *   - comic / teleplay / anything else → conservative cleanup ONLY. Scripts
 *     carry meaning in their line breaks (scene headings, panel descriptions,
 *     character cues), so we never reflow them — we only fix the unambiguous
 *     artifacts (drop-caps, hyphen splits, trailing whitespace, blank-line runs).
 *
 * Reflow heuristic (the hard part — PDF paste usually has NO blank lines between
 * paragraphs, so we can't key on those alone):
 *   A newline between `prev` and `cur` is a SOFT WRAP (join the lines) when —
 *     1. `cur` begins with a lowercase letter. A real sentence/paragraph never
 *        starts lowercase, so this is the high-confidence signal and does the
 *        bulk of the work.
 *     2. `cur` begins with a capital/quote/dash (ambiguous: could be a new
 *        sentence OR a wrapped proper noun). Fall back to width: if `prev`
 *        reached near the measured wrap margin it was wrapped → join; if `prev`
 *        is short it ended deliberately (paragraph end, heading, dialogue) → keep.
 *   Blank lines always separate paragraphs and are never crossed.
 *
 * Pure + dependency-free (no DOM) so it runs in node test env too.
 */

// Stages whose line breaks are prose-structural and safe to reflow. Everything
// else (comicScript, teleplay, …) gets the conservative pass only.
export const REFLOW_STAGES = new Set(['prose']);

// A line at least this fraction of the measured wrap width is treated as "full"
// (i.e. it hit the margin and was wrapped). Only consulted when the NEXT line
// starts with a capital/quote/dash (ambiguous) — lowercase continuations join
// outright. Kept high so short heading/attribution lines stay below it and are
// not swallowed into the paragraph that follows; a wrapped line that ends a
// little early before a capitalized word just keeps its break (the safe miss).
const FULL_LINE_RATIO = 0.8;

const stripTrailingWs = (text) => text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');

// Join a syllable hyphenated across a wrap: "approxi-\nmating" → "approximating".
// Only letter-hyphen-newline-lowercase, so real line-final hyphens before a
// capitalized word or number are left alone.
const dehyphenate = (text) => text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');

// Re-attach a stylized drop-cap that landed on its own line: a line that is a
// single uppercase letter immediately followed by a line starting lowercase.
// "T\nhe dawn" → "The dawn". Lookahead keeps the next line's first char.
const rejoinDropCaps = (text) => text.replace(/^([A-Z])\n(?=[a-z])/gm, '$1');

// Collapse 3+ consecutive newlines to a single blank line, then trim the ends.
const tidyBlankLines = (text) => text.replace(/\n{3,}/g, '\n\n').trim();

function reflowProse(text) {
  const lines = text.split('\n');
  // reduce (not Math.max(...spread)) so a manuscript with very many lines can't
  // blow the argument-count limit and throw.
  const maxLen = lines.reduce((max, l) => (l.trim() ? Math.max(max, l.length) : max), 0);
  const fullThreshold = maxLen * FULL_LINE_RATIO;

  const out = [];
  let prevBlank = true;   // start-of-text behaves like just after a paragraph break
  let prevFull = false;   // was the last consumed line near the wrap margin?

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      out.push('');
      prevBlank = true;
      prevFull = false;
      continue;
    }
    // A newline is a soft wrap when the next line continues lowercase, or — when
    // ambiguous — when the previous line ran to the margin.
    const continuesLower = /^[a-z]/.test(line);
    const softWrap = !prevBlank && (continuesLower || prevFull);
    if (softWrap) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    } else {
      out.push(line);
    }
    prevBlank = false;
    prevFull = raw.length >= fullThreshold;
  }
  return out.join('\n');
}

/**
 * Normalize a manuscript section's text.
 * @param {string} text - raw section content
 * @param {string} stageId - 'prose' | 'comicScript' | 'teleplay' | …
 * @returns {string} formatted text (unchanged input → identical output)
 */
export function formatManuscript(text, stageId) {
  if (typeof text !== 'string' || text === '') return text || '';

  let out = text.replace(/\r\n?/g, '\n'); // CRLF / bare CR → LF
  out = stripTrailingWs(out);
  out = dehyphenate(out);
  out = rejoinDropCaps(out);
  if (REFLOW_STAGES.has(stageId)) out = reflowProse(out);
  out = tidyBlankLines(out);
  return out;
}
