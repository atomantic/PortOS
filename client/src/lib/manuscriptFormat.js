/**
 * Pure manuscript text normalizer for the Manuscript editor's "Format" button.
 *
 * `formatManuscript(text, stageId)` / `REFLOW_STAGES` undo PDF-paste artifacts (stylized drop-cap split onto its own line, hyphen-split words,
 * orphaned closing quotes, trailing whitespace, runaway blank lines) for every stage, and additionally reflow soft-wrapped lines back into
 * paragraphs for `prose` only: scripts (comic / teleplay / anything else) carry meaning in their line breaks, so they get the conservative cleanup only.
 *
 * Reflow heuristic: a document is often a MIX of joined and wrapped paragraphs with no blank lines between them, so a global line-width threshold is
 * unsound. Join a line onto the previous one ONLY when it begins with a lowercase letter; a real sentence, heading or attribution never does, so this is the
 * one near-zero-false-positive signal. A wrong join (merging paragraphs, swallowing a heading) is far worse than one extra break. Blank lines always separate paragraphs.
 *
 * Pure + dependency-free (no DOM) so it runs in the node test env too.
 */

// Stages whose line breaks are prose-structural and safe to reflow; everything else gets the conservative pass only.
export const REFLOW_STAGES = new Set(['prose']);

const stripTrailingWs = (text) => text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');

// Join a syllable hyphenated across a wrap ("approxi-\nmating"); only letter-hyphen-newline-lowercase.
// Accepted miss: a real compound wrapped at its hyphen ("over-\nride") loses it.
const dehyphenate = (text) => text.replace(/([A-Za-z])-\n([a-z])/g, '$1$2');

// Re-attach a stylized drop-cap on its own line ("T\nhe dawn" → "The dawn", no space). `I` and `A` are excluded: a lone one is almost always the WORD
// ("I\nam"), which must join WITH a space via reflowProse. Accepted miss: drop-cap "In"/"And".
const rejoinDropCaps = (text) => text.replace(/^([B-HJ-Z])\n(?=[a-z])/gm, '$1');

// Re-attach closing double-quotes the PDF export orphaned (straight quotes only; a closing quote follows text/whitespace, an opening one precedes a word).
const reattachQuotes = (text) => text
  // A `"` alone on its own line collapses onto the previous NON-BLANK line; the `(\S)` anchor keeps it off blank lines and makes the pass idempotent.
  //   …diagnostics.\n"\n— Maggie  →  …diagnostics."\n— Maggie
  .replace(/(\S)\n[ \t]*"[ \t]*(?=\n|$)/g, '$1"')
  // A `"` that wrapped to the START of the next line, followed by text, hugs the previous line:  Panel Seven,\n" I say  →  Panel Seven," I say
  // Accepted miss: an opening quote written with a space after it at line start is pulled up too; guarding on terminal punctuation would regress the common closing-quote case.
  .replace(/\n[ \t]*"(?=[ \t]+\S)/g, '"')
  // A stray space before a closing `"` at end of line, only after [.!?] so an OPENING quote whose dialogue wrapped (`said, "\nGood`) is left alone.
  //   relationships. "  →  relationships."
  .replace(/([.!?])[ \t]+"(?=[ \t]*$)/gm, '$1"');

// Drop a stray opening-quote fragment duplicated onto its own line before the real quoted line (PDF/LLM export artifact):
//   "I
//   "I need a calibration partner …   →   "I need a calibration partner …
// Only fires on an INCOMPLETE opening (`"` plus a few non-terminal chars, no closing quote) when the next line is the same fragment or begins with it
// followed by WHITESPACE; that keeps distinct dialogue apart (`"Wait` / `"Wait, no`, `"Yes. / "No.`, `"I / "Information`).
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
