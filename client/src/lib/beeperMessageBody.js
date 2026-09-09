/**
 * Beeper message bodies: entity decoding, and the small HTML subset some
 * networks deliver (fork issue #1, final live pass).
 *
 * Beeper hands PortOS a message body verbatim, and on a real install 26% of
 * them are HTML — Discord and Matrix mostly, with paragraphs, line breaks,
 * blockquotes, bold, italic and links. `normalizeMessageRow` persists that
 * string as it arrives (correct: the mirror stores what the source said), and
 * the thread rendered it as a text node, so the tags showed up literally in the
 * bubble and in the rail preview.
 *
 * PortOS has no HTML sanitizer for this shape. The Messages inbox renders full
 * email documents in a sandboxed iframe (`MessageDetail.jsx`'s `SafeHtmlBody`),
 * which is the right tool for a whole document and the wrong one for a chat
 * bubble — one iframe per message in a scrolling list, with no intrinsic
 * height. So instead of injecting HTML anywhere, this module PARSES the
 * allowlisted subset into a plain data model and the caller renders it as React
 * elements. Nothing here ever reaches `dangerouslySetInnerHTML`, so a tag
 * outside the allowlist cannot execute, load, or style anything — it is simply
 * dropped, keeping its text.
 *
 * The allowlist is exactly what was observed: `p`, `div`, `br`, `blockquote`,
 * `strong`/`b`, `em`/`i`, `a[href]`. Everything else contributes its text and
 * nothing more.
 *
 * A body with none of those tags is NOT HTML and is left alone —
 * `parseMessageBody` answers `null` — so a plain message reading `5 < 6` or
 * `<3` renders exactly as it did before, through `decodeHtmlEntities` on its
 * own (the #59 fix).
 */

import { isHttpUrl } from '../utils/urlNormalize.js';

// Mirrors `server/lib/xmlEntities.js` `decodeXmlEntities` (also privately
// mirrored by `client/src/lib/tabNotation.js`). Keep the three in sync.
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// `decodeXmlEntities` takes an `extraEntities` map for exactly this case; the
// client copy inlines its one extra rather than growing a parameter. `&nbsp;`
// is routine in the HTML bodies below and decodes to U+00A0, written as an
// escape so the source never carries an invisible non-breaking space.
const HTML_ENTITIES = { ...NAMED_ENTITIES, nbsp: '\u00a0' };
const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Beeper Desktop delivers entity-encoded text for some bridged networks, so the
 * decode happens on the way OUT to the DOM. Everything decoded here is rendered
 * as a text node, so decoding only changes which characters are shown — it can
 * never introduce markup.
 */
export const decodeHtmlEntities = (str) => {
  if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (match, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    // `Object.hasOwn` rather than `in`: `&constructor;` must stay literal.
    return Object.hasOwn(HTML_ENTITIES, code) ? HTML_ENTITIES[code] : match;
  });
};

// The tags that mean anything here. `div` joins the block set because Matrix
// bodies wrap lines in one; anything absent from both sets keeps its text and
// loses its markup.
const BLOCK_TAGS = new Set(['p', 'div', 'blockquote']);
const INLINE_MARKS = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic' };
// The full tag-name surface the parser dispatches on: BLOCK_TAGS, INLINE_MARKS,
// plus the two handled by name below (`br`, `a`). Exported so a test can pin
// the module docblock's allowlist sentence to this set instead of the two
// drifting apart again (audit cluster 10, finding F10).
export const ALL_ALLOWED_TAGS = new Set(['br', 'a', ...BLOCK_TAGS, ...Object.keys(INLINE_MARKS)]);
const HTML_TAG_RE = /<\/?(p|div|br|blockquote|strong|b|em|i|a)(\s[^>]*)?\/?>/i;
// A tag name must follow `<` immediately, and an attribute run may not contain
// another `<` — otherwise `a < b and <p>x</p>` parses as one enormous `<b …>`
// tag and turns the whole message bold.
const TOKEN_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'<])*)\/?>/g;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Whether a body carries any of the tags this module understands. */
export const looksLikeHtmlBody = (body) => typeof body === 'string' && HTML_TAG_RE.test(body);

const emptyBlock = (type) => ({ type, spans: [] });

function pushText(block, text, marks) {
  if (!text) return;
  const last = block.spans[block.spans.length - 1];
  // Merge into the previous span when the marks match, so `<b>a</b><b>b</b>`
  // is one span rather than two adjacent identical ones.
  if (last && last.bold === marks.bold && last.italic === marks.italic && last.href === marks.href) {
    last.text += text;
    return;
  }
  block.spans.push({ text, bold: marks.bold, italic: marks.italic, href: marks.href });
}

const blockHasText = (block) => block.spans.some((span) => span.text.trim() !== '');

/**
 * Parse the allowlisted HTML subset into blocks of marked spans.
 *
 * @param {string} body
 * @returns {Array<{type: 'paragraph'|'quote', spans: Array<{text: string, bold: boolean, italic: boolean, href: string|null}>}>|null}
 *   `null` when the body carries none of the allowlisted tags — the caller then
 *   keeps its existing plain-text path.
 */
export function parseMessageBody(body) {
  if (!looksLikeHtmlBody(body)) return null;

  const blocks = [];
  let current = emptyBlock('paragraph');
  let bold = 0;
  let italic = 0;
  let quote = 0;
  const hrefStack = [];

  const marks = () => ({
    bold: bold > 0,
    italic: italic > 0,
    href: hrefStack.length > 0 ? hrefStack[hrefStack.length - 1] : null,
  });

  const flush = () => {
    if (blockHasText(current)) blocks.push(current);
    current = emptyBlock(quote > 0 ? 'quote' : 'paragraph');
  };

  let cursor = 0;
  TOKEN_RE.lastIndex = 0;
  let match = TOKEN_RE.exec(body);
  while (match !== null) {
    pushText(current, decodeHtmlEntities(body.slice(cursor, match.index)), marks());
    cursor = match.index + match[0].length;

    const tag = match[1].toLowerCase();
    const closing = match[0][1] === '/';
    const attrs = match[2] || '';

    if (tag === 'br') {
      // A newline in the text, not a block boundary: the renderer keeps
      // `whitespace-pre-wrap`, so one `<br>` is one line break inside the
      // paragraph it appeared in.
      pushText(current, '\n', marks());
    } else if (BLOCK_TAGS.has(tag)) {
      if (tag === 'blockquote') quote += closing ? -1 : 1;
      if (quote < 0) quote = 0;
      flush();
    } else if (Object.hasOwn(INLINE_MARKS, tag)) {
      const mark = INLINE_MARKS[tag];
      if (mark === 'bold') bold = closing ? Math.max(0, bold - 1) : bold + 1;
      else italic = closing ? Math.max(0, italic - 1) : italic + 1;
    } else if (tag === 'a') {
      if (closing) hrefStack.pop();
      else {
        const href = HREF_RE.exec(attrs);
        const value = decodeHtmlEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim());
        // http(s) only — the same rule `utils/urlNormalize.js` `isHttpUrl`
        // states, so a `javascript:` or `data:` href becomes plain text rather
        // than a clickable link.
        hrefStack.push(isHttpUrl(value) ? value : null);
      }
    }
    // Any other tag: dropped, its text already kept.

    match = TOKEN_RE.exec(body);
  }
  pushText(current, decodeHtmlEntities(body.slice(cursor)), marks());
  flush();

  // An HTML body with no text at all (`<p></p>`) is an empty message, not a
  // broken one — the caller renders the same empty bubble it would for `''`.
  return blocks;
}

/**
 * The rail preview: one line, tags gone, entities decoded. Line breaks and
 * block boundaries collapse to single spaces because the row truncates to one
 * line; a quoted block keeps a `>` so a reply preview still reads as a reply.
 */
export function messagePreviewText(body) {
  const blocks = parseMessageBody(body);
  if (blocks === null) return decodeHtmlEntities(body);
  return blocks
    .map((block) => {
      const text = block.spans.map((span) => span.text).join('').replace(/\s+/g, ' ').trim();
      return block.type === 'quote' && text ? `> ${text}` : text;
    })
    .filter(Boolean)
    .join(' ');
}
