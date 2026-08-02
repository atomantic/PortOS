// Markdown → plain text, for clamped previews.
//
// A queue card's body is arbitrary agent-authored markdown (CoS task prompts,
// stack traces, error payloads). Rendering it through the markdown renderer in
// a collapsed card is wrong twice over: `line-clamp-N` does not clamp a subtree
// of block elements (the `-webkit-box` clamp only applies to the inline content
// of the element carrying it), so the "preview" prints the whole document; and
// any `##` heading inside that foreign body joins the page's own heading
// outline. Flattening to one plain-text string fixes both — the preview clamps,
// and no foreign structure leaks out. The full markdown is still rendered once
// the user expands that card.
//
// This is a *display* flattener, not a parser: it strips the syntax a reader
// doesn't need in a three-line preview and keeps the words.

// Fenced code blocks — keep the code, drop the fence lines (and any info string).
const FENCE_LINE = /^\s*(?:`{3,}|~{3,}).*$/;

// A pipe-delimited table row, e.g. `| a | b |`. Used only by the
// markup-loss predicate — see the note on `dropsMarkupWhenFlattened`.
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/m;

// The whitespace tail both exports share. Kept as one function so the
// "did the flatten drop markup?" predicate below can subtract exactly the
// whitespace normalization `markdownToPlainText` performs — no more, no less.
const collapseWhitespace = (text) => text
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{2,}/g, '\n')       // collapse blank-line runs
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .join('\n');

/**
 * Flatten markdown source to a single plain-text string suitable for a clamped
 * preview. Returns `''` for anything that isn't a non-empty string.
 */
export function markdownToPlainText(markdown) {
  if (typeof markdown !== 'string' || !markdown) return '';

  const lines = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')   // HTML comments
    .split('\n')
    .filter(line => !FENCE_LINE.test(line))
    .map(line => line
      // Thematic breaks first: the spaced forms (`- - -`, `* * *`) also match
      // the bullet rule below, and losing the race turns a divider into a
      // bullet that eats one of only three preview lines.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')          // ATX heading markers
      .replace(/^\s{0,3}>\s?/, '')               // blockquote markers
      .replace(/^\s*[-*+]\s+/, '• ')             // bullet markers
      .replace(/^\s*(\d+)[.)]\s+/, '$1. '));     // ordered-list markers

  const flattened = lines
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[${alt}]` : '[image]'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links → their text
    .replace(/`([^`]*)`/g, '$1')                 // inline code
    // Emphasis. Two properties matter more than markdown fidelity here:
    //
    // 1. Every content class excludes its own delimiter and `\n`, so each pass
    //    is linear. An unbounded `[^\n]*?` rescans to end-of-line for every
    //    unmatched opener, and these bodies are routinely ONE enormous line (a
    //    pasted transcript, an unwrapped stack dump) — measured at 1.3s for a
    //    50KB body and ~8s for 112KB, on the main thread, per card.
    // 2. Underscore emphasis is gated on word boundaries, per CommonMark. Without
    //    that gate the preview silently rewrites real data: `Mac OS X 10_15_7` →
    //    `10157`, `__webpack_require__` → `webpackrequire`, `snake_case` →
    //    `snakecase`. These bodies are stack traces and user-agent strings, so a
    //    corrupted-but-plausible preview is worse than an unstripped marker.
    //    Intra-word `*` emphasis IS conformant, so `*` needs no such gate.
    //    `__…__` additionally requires interior whitespace, because the
    //    word-boundary gate alone still eats the dunder identifiers these
    //    bodies are full of — `__init__` → `init`, `__proto__` → `proto`. Real
    //    `__strong__` prose is multi-word, and single-word bold in these bodies
    //    is written `**…**` anyway, so the trade lands on the safe side: a
    //    visible `__init__` beats a silently rewritten stack frame.
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')                      // bold  **…**
    .replace(/(^|\W)__(?=\S)([^_\n]*?[ \t][^_\n]*?\S)__(?!\w)/gm, '$1$2') // bold  __…__
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')                          // italic *…*
    .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/gm, '$1$2')             // italic _…_
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1');                         // strikethrough

  return collapseWhitespace(flattened);
}

/**
 * Did flattening `markdown` actually drop any markup — links, images, tables,
 * emphasis, headings — as opposed to merely normalizing whitespace?
 *
 * A card previews the flattened text and hides the rendered markdown behind a
 * disclosure. The disclosure has to appear for a SHORT body that still lost
 * markup (a one-line description holding a scan-report link would otherwise be
 * stranded as inert text), but must NOT appear for a body that lost nothing —
 * comparing raw source to flattened output flags every trailing newline and
 * double space, putting a "Show more" that reveals nothing on the most common
 * short-body shape, on a page whose whole purpose is removing queue noise.
 *
 * Tables need their own probe: the flattener leaves pipe rows alone (and the
 * `| --- |` separator escapes the thematic-break rule because it starts with a
 * pipe), so a table flattens to itself and the diff below sees no loss — while
 * the preview shows raw pipe soup with no route to the rendered table.
 */
export function dropsMarkupWhenFlattened(markdown) {
  if (typeof markdown !== 'string' || !markdown) return false;
  if (TABLE_ROW.test(markdown)) return true;
  return markdownToPlainText(markdown) !== collapseWhitespace(markdown.replace(/\r\n?/g, '\n'));
}
