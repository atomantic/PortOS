/**
 * Pure manuscript text normalizer for the Manuscript editor's "Format" button.
 *
 * The motivating mess: text pasted out of a PDF export arrives hard-wrapped at
 * the page margin (every visual line is a real `\n`), with stylized drop-caps
 * split onto their own line ("T\nhe dawn …"), words hyphenated across the wrap
 * ("approxi-\nmating"), and closing quotes orphaned from the text they
 * terminate (alone on a line, wrapped to the next line, or with a stray space
 * before them). `formatManuscript(text, stageId)` undoes those paste artifacts
 * so a paragraph reads as one logical line again.
 *
 * Two altitudes, chosen by stage:
 *   - prose  → full reflow: join soft-wrapped lines back into paragraphs, plus
 *     quote re-attachment.
 *   - comic / teleplay / anything else → conservative cleanup ONLY. Scripts
 *     carry meaning in their line breaks (scene headings, panel descriptions,
 *     character cues), so we never reflow or touch their quotes — we only fix
 *     the unambiguous artifacts (drop-caps, hyphen splits, trailing whitespace,
 *     blank-line runs).
 *
 * Reflow heuristic (the hard part — PDF paste usually has NO blank lines between
 * paragraphs, and a document is often a MIX of already-joined single-line
 * paragraphs and genuinely-wrapped ones, so a global line-width threshold is
 * unsound — it both pulls the next paragraph into a long complete one and fails
 * to recognize a wrapped line once a longer paragraph raises the bar):
 *   Join a line onto the previous one ONLY when it begins with a lowercase
 *   letter. A real sentence, paragraph, heading, or attribution never starts
 *   lowercase, so this is the one near-zero-false-positive signal. A
 *   capital/quote/dash start keeps its break — it might be a new paragraph, and
 *   a wrong join (merging two paragraphs or swallowing a heading) is far more
 *   destructive than leaving one extra break. Blank lines always separate
 *   paragraphs and are never crossed.
 *
 * Pure + dependency-free (no DOM) so it runs in node test env too.
 */

// Stages whose line breaks are prose-structural and safe to reflow. Everything
// else (comicScript, teleplay, …) gets the conservative pass only.
export const REFLOW_STAGES = new Set(['prose']);

const stripTrailingWs = (text) => text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');

// Join a syllable hyphenated across a wrap: "approxi-\nmating" → "approximating".
// Only letter-hyphen-newline-lowercase, so real line-final hyphens before a
// capitalized word or number are left alone. Accepted miss: a genuinely
// hyphenated compound that happens to wrap at its hyphen ("over-\nride") is
// merged without the hyphen ("override") — unavoidable without a dictionary, and
// rare enough that reflowing the common case is the better trade.
const dehyphenate = (text) => text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');

// Re-attach a stylized drop-cap that landed on its own line: a line that is a
// single uppercase letter immediately followed by a line starting lowercase.
// "T\nhe dawn" → "The dawn" (joined with NO space — it's one word). `I` and `A`
// are excluded: they're the only single-letter English words, so a lone `I`/`A`
// is almost always the WORD wrapped to its own line ("I\nam …"), which must
// join WITH a space — left to reflowProse — not glue into "Iam". The rare
// drop-cap "In"/"And" is the accepted miss.
const rejoinDropCaps = (text) => text.replace(/^([B-HJ-Z])\n(?=[a-z])/gm, '$1');

// Re-attach closing double-quotes the PDF export orphaned. Three artifacts, all
// keyed on a `"` separated from the text it should hug. (Straight quotes only —
// a closing quote is one preceded by text / whitespace, never one immediately
// followed by a word, which is how an opening quote reads.)
const reattachQuotes = (text) => text
  // A `"` alone on its own line collapses up onto the previous NON-BLANK line.
  // The `(\S)` anchor both keeps the quote off a blank line and makes the pass
  // idempotent — without it a quote sitting after a blank line would hop one
  // line closer per run instead of stabilizing.
  //   …diagnostics.\n"\n— Maggie  →  …diagnostics."\n— Maggie
  .replace(/(\S)\n[ \t]*"[ \t]*(?=\n|$)/g, '$1"')
  // A `"` that wrapped to the START of the next line, followed by more text,
  // hugs the previous line instead (no inserted space — it's a closing quote):
  //   Panel Seven,\n" I say  →  Panel Seven," I say
  // Accepted miss: a non-standard opening quote written with a space after it
  // at line start (`\n" Wait`) is pulled up too; standard opening quotes hug
  // their word (`"Wait`) and are untouched. Not worth tightening — the obvious
  // guard (skip when the previous line ends in terminal punctuation) would
  // regress the common closing-quote-after-a-sentence case (`gone.\n" she`).
  .replace(/\n[ \t]*"(?=[ \t]+\S)/g, '"')
  // A stray space before a closing `"` at end of line — but only after
  // sentence-terminating punctuation, the real "stray space" shape. Gating on
  // [.!?] leaves an OPENING quote whose dialogue wrapped (`said, "\nGood`)
  // alone, since it sits after a comma, not a sentence-ender.
  //   relationships. "  →  relationships."
  .replace(/([.!?])[ \t]+"(?=[ \t]*$)/gm, '$1"');

// Drop a stray opening-quote fragment the source duplicated onto its own line
// just before the real quoted line — a PDF/LLM export artifact:
//   "I
//   "I need a calibration partner …   →   "I need a calibration partner …
// Only fires when the fragment is an INCOMPLETE opening (a `"` plus a few
// non-terminal chars, no closing quote) AND the next line is either the exact
// same fragment or begins with it followed by WHITESPACE — the same way a true
// duplicate continues (`"I` → `"I need …`, a space after the prefix). Requiring
// whitespace (not any non-word char) is what keeps two genuinely distinct
// dialogue lines apart: `"Wait` before `"Wait, no — …` continues into a comma,
// not a space, so it is left alone; so are "Yes. / "No. (terminal punctuation —
// not a fragment) and "I / "Information (the prefix runs into a letter).
const dropDuplicatedQuoteFragments = (text) => {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const cur = lines[i];
    const next = lines[i + 1];
    const isFragment = /^"[^".!?]{1,20}$/.test(cur);
    const dupOfNext = next !== undefined && next.startsWith(cur)
      && (next.length === cur.length || /\s/.test(next.charAt(cur.length)));
    if (isFragment && dupOfNext) continue; // drop the duplicated fragment line
    out.push(cur);
  }
  return out.join('\n');
};

// Collapse 3+ consecutive newlines to a single blank line, then trim the ends.
const tidyBlankLines = (text) => text.replace(/\n{3,}/g, '\n\n').trim();

function reflowProse(text) {
  const lines = text.split('\n');
  const out = [];
  let prevBlank = true; // start-of-text behaves like just after a paragraph break

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      out.push('');
      prevBlank = true;
      continue;
    }
    // Join onto the previous line only when this line continues it lowercase.
    if (!prevBlank && /^[a-z]/.test(line)) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`;
    } else {
      out.push(line);
    }
    prevBlank = false;
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
  if (REFLOW_STAGES.has(stageId)) {
    out = reattachQuotes(out);
    out = dropDuplicatedQuoteFragments(out);
    out = reflowProse(out);
  }
  out = tidyBlankLines(out);
  return out;
}
