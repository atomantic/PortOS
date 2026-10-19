/**
 * Shared HTML → readable plain text converter.
 *
 * A single dependency-free strip-tags pipeline for the places PortOS turns
 * fetched/synced HTML into text (Gmail message bodies, SongBook URL imports).
 * Replaces the near-identical private copies that lived in
 * `services/messageGmailSync.js` and `services/brainSongbookImport.js`.
 *
 * Pipeline: drop <script>/<style>/<head>/<noscript> blocks wholesale, convert
 * <br> and block-element closes to newlines, strip every remaining tag, decode
 * entities via the shared `decodeXmlEntities`, normalize line endings, collapse
 * runs of 3+ newlines to a blank line, and trim.
 *
 * Options exist only to preserve each caller's historical observable output:
 *   - `extraEntities`     — merged on top of `{ nbsp: ' ' }` (Gmail adds
 *                           `{ zwnj: '' }` for mail-specific zero-width chars).
 *   - `paragraphBreak`    — what `</p>` becomes. Default `'\n'` (SongBook —
 *                           tab sheets want tight lines); Gmail passes `'\n\n'`
 *                           so paragraphs keep a blank line between them.
 *   - `collapseSpaces`    — collapse runs of spaces/tabs to one space. Default
 *                           false — NEVER enable for tab/chord sheets, whose
 *                           column alignment is meaningful. Gmail enables it.
 */

import { decodeXmlEntities } from './xmlEntities.js';

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
const CONTAINER_OPEN_RE = /<(script|style|head|noscript)\b/gi;

// Remove each container element with its content. A lazy `[\s\S]*?` between
// the open and close tags rescans to the end of the document for every open
// tag that has no close, which is quadratic on hostile HTML (inbound mail from
// any sender reaches this): 200 KB of bare `<head>` stalled the loop for
// seconds. Index scanning keeps the old semantics — an unclosed container is
// left in place — in linear time.
// ASCII-only fold: tag names are ASCII, and a full `toLowerCase()` can change
// the string length (U+0130 expands), which would skew every index below.
const asciiLower = (text) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

function stripContainerElements(html) {
  const lower = asciiLower(html);
  // Next close position per tag, so a run of unclosed opens does not rescan
  // to the end for each one (-1 = no close anywhere after the cached search).
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
