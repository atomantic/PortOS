/**
 * Shared HTML → readable plain text converter.
 *
 * Dependency-free strip-tags pipeline for fetched/synced HTML (Gmail bodies, SongBook URL imports):
 * drop script/style/head/noscript blocks, turn <br>/block closes into newlines, strip tags,
 * decode entities via `decodeXmlEntities`, collapse 3+ newlines, trim.
 *
 * Options preserve each caller's output: `extraEntities` (merged over `{ nbsp: ' ' }`; Gmail adds
 * `zwnj`), `paragraphBreak` (what `</p>` becomes; default `'\n'` for tab sheets, Gmail passes
 * `'\n\n'`), `collapseSpaces` (default false: NEVER enable for tab/chord sheets, whose column
 * alignment is meaningful).
 */

import { decodeXmlEntities } from './xmlEntities.js';

const CONTAINER_OPEN_RE = /<(script|style|head|noscript)\b/gi;

// Remove each container element with its content by index scanning: a lazy `[\s\S]*?` rescans to
// the end for every unclosed open tag, which is quadratic on hostile inbound mail. An unclosed
// container is left in place.
// ASCII-only fold: a full `toLowerCase()` can change string length (U+0130 expands) and skew indexes.
const asciiLower = (text) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

function stripContainerElements(html) {
  const lower = asciiLower(html);
  // Next close position per tag (-1 = none), so unclosed opens do not each rescan to the end.
  const nextClose = new Map();
  let out = '';
  let cursor = 0;
  CONTAINER_OPEN_RE.lastIndex = 0;
  for (let m = CONTAINER_OPEN_RE.exec(html); m !== null; m = CONTAINER_OPEN_RE.exec(html)) {
    const tag = m[1].toLowerCase();
    const from = m.index + m[0].length;
    let close = nextClose.get(tag);
    if (close === undefined || (close !== -1 && close < from)) {
      close = lower.indexOf(`</${tag}>`, from);
      nextClose.set(tag, close);
    }
    if (close === -1) continue;
    out += html.slice(cursor, m.index);
    cursor = close + tag.length + 3;
    CONTAINER_OPEN_RE.lastIndex = cursor;
  }
  return out + html.slice(cursor);
}

/**
 * Convert an HTML document/fragment to plain text.
 *
 * @param {string} html - Raw HTML. Non-strings return ''.
 * @param {object} [options]
 * @param {Object<string,string>} [options.extraEntities] - Extra named entities
 *   merged on top of `{ nbsp: ' ' }` and the predefined five.
 * @param {string} [options.paragraphBreak='\n'] - Replacement for `</p>`.
 * @param {boolean} [options.collapseSpaces=false] - Collapse space/tab runs.
 * @returns {string} Readable plain text, trimmed.
 */
export function htmlToText(html, { extraEntities, paragraphBreak = '\n', collapseSpaces = false } = {}) {
  if (typeof html !== 'string') return '';
  const stripped = stripContainerElements(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, paragraphBreak)
    .replace(/<\/(div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  let text = decodeXmlEntities(stripped, { nbsp: ' ', ...extraEntities })
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  if (collapseSpaces) text = text.replace(/[ \t]+/g, ' ');
  return text.trim();
}
