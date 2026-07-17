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
export function htmlToText(html, { extraEntities, paragraphBreak = '\n', collapseSpaces = false } = {}) {
  if (typeof html !== 'string') return '';
  const stripped = html
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1>/gi, '')
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
