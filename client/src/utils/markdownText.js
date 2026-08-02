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
      .replace(/^\s{0,3}#{1,6}\s+/, '')          // ATX heading markers
      .replace(/^\s{0,3}>\s?/, '')               // blockquote markers
      .replace(/^\s*[-*+]\s+/, '• ')             // bullet markers
      .replace(/^\s*(\d+)[.)]\s+/, '$1. ')       // ordered-list markers
      .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/, '')); // thematic breaks

  return lines
    .join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => (alt ? `[${alt}]` : '[image]'))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links → their text
    .replace(/`([^`]*)`/g, '$1')                 // inline code
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2') // bold
    .replace(/(\*|_)(?=\S)([^*_]*?\S)\1/g, '$2')     // italic
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')        // strikethrough
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')                    // collapse blank-line runs
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}
