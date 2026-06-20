# Manuscript — Reformat (fix paste artifacts)

You are repairing the FORMATTING of a manuscript that was pasted out of a PDF or
similar export. The words are correct, but the line breaks and whitespace are
mangled. Common damage:

- Paragraphs hard-wrapped at the page margin — every visual line became a real
  line break, so one paragraph is a column of short lines.
- A stylized drop-cap split onto its own line (`T` then `he dawn …`), or the
  word `I`/`A` left alone on a line by a wrap.
- A word hyphenated across the wrap (`approxi-` then `mating`).
- Quotation marks orphaned from the text they belong to: a `"` alone on a line,
  wrapped to the start of the next line, duplicated, or with a stray space.

## Format being reformatted

{{format}}

## Text

Everything between the two `===MANUSCRIPT===` markers is the text to reformat.
The markers are not part of the text.

===MANUSCRIPT===
{{body}}
===MANUSCRIPT===

## Task

Return the SAME text with ONLY its formatting repaired:

- Re-flow hard-wrapped lines back into whole paragraphs — one paragraph per
  block, separated by a single blank line.
- Rejoin a split drop-cap and de-hyphenate a word broken across a wrap.
- Re-attach orphaned, wrapped, or duplicated quotation marks to the words they
  belong to, and remove a stray space sitting before a closing quote.
- Keep intentional structure on its own line: chapter and scene headings,
  epigraphs, attributions ("— Author, …"), and — for a comic script or teleplay
  — panel descriptions, scene headings, and character cue lines.
- Collapse runs of blank lines to a single blank line.

## Absolute constraints

- DO NOT change, add, or remove any words. Preserve every letter and digit, all
  spelling, names, and the author's punctuation and voice EXACTLY. You are only
  moving whitespace around and re-attaching quotation marks. (The output is
  rejected automatically if its sequence of letters and digits differs at all
  from the input.)
- Even if a WORD looks duplicated, leave it exactly as it is — do not delete it.
  You may drop a redundant quotation mark or a stray space (those are
  punctuation, not words), but never a letter or a word.
- DO NOT rewrite, rephrase, summarize, correct, translate, or "improve" anything.
- If a passage looks garbled or a word seems missing, leave it exactly as it is —
  do not guess or fill it in.
- DO NOT add headings, labels, commentary, or code fences of your own.

## Output contract

Return ONLY the reformatted text as plain text — no preamble, no closing remark,
no `===MANUSCRIPT===` markers, no code fence.
