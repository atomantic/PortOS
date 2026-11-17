// Markdown → plain text, for clamped previews.
//
// A queue card's body is arbitrary agent-authored markdown (CoS task prompts, stack traces); rendering it through the markdown renderer in a collapsed
// card is wrong twice: `line-clamp-N` does not clamp a subtree of block elements (the preview prints the whole document), and any `##` heading in that foreign body joins the page's heading outline.
// Flattening to one plain-text string fixes both; the full markdown renders once the card expands. A *display* flattener, not a parser: it strips syntax a three-line preview doesn't need.

// Fenced code blocks — keep the code, drop the fence lines (and any info string).
const FENCE_LINE = /^\s*(?:`{3,}|~{3,}).*$/;

// A pipe-delimited table row, e.g. `| a | b |`. Used only by the
// markup-loss predicate — see the note on `dropsMarkupWhenFlattened`.
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/m;

// The whitespace tail both exports share, so the "did the flatten drop markup?" predicate subtracts exactly the whitespace normalization `markdownToPlainText` performs.
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
      // Thematic breaks first: the spaced forms (`- - -`, `* * *`) also match the bullet rule below, and losing the race turns a divider into a bullet.
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
    // Emphasis. Two properties matter more than markdown fidelity:
    // 1. Every content class excludes its own delimiter and `\n`, so each pass is linear: an unbounded `[^\n]*?` rescans to end-of-line for every unmatched opener, and these bodies are routinely
    //    ONE enormous line (measured 1.3s for 50KB, ~8s for 112KB, on the main thread, per card).
    // 2. Underscore emphasis is gated on word boundaries, per CommonMark: otherwise real data is rewritten (`10_15_7` → `10157`, `snake_case` → `snakecase`). `__…__` additionally requires
    //    interior whitespace or dunder identifiers (`__init__`, `__proto__`) get eaten; single-word bold is written `**…**` anyway. Intra-word `*` emphasis IS conformant, so `*` needs no gate.
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1')                      // bold  **…**
    .replace(/(^|\W)__(?=\S)([^_\n]*?[ \t][^_\n]*?\S)__(?!\w)/gm, '$1$2') // bold  __…__
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')                          // italic *…*
    .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/gm, '$1$2')             // italic _…_
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, '$1');                         // strikethrough

  return collapseWhitespace(flattened);
}

/**
 * Did flattening `markdown` actually drop any markup (links, images, tables, emphasis, headings), as opposed to merely normalizing whitespace?
 *
 * A card previews the flattened text and hides the rendered markdown behind a disclosure, which must appear for a SHORT body that still lost markup (a one-line description holding a link)
 * but not for one that lost nothing (comparing raw source flags every trailing newline and shows a "Show more" that reveals nothing).
 *
 * Tables need their own probe: the flattener leaves pipe rows alone (the `| --- |` separator escapes the thematic-break rule), so a table flattens to itself and the diff sees no loss.
 */
export function dropsMarkupWhenFlattened(markdown) {
  if (typeof markdown !== 'string' || !markdown) return false;
  if (TABLE_ROW.test(markdown)) return true;
  return markdownToPlainText(markdown) !== collapseWhitespace(markdown.replace(/\r\n?/g, '\n'));
}
