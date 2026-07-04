/**
 * Shared XML / HTML entity decoder.
 *
 * A single dependency-free decoder for the entity references that appear in the
 * various feeds and exports PortOS parses (Apple Health `export.xml`, GitHub
 * release Atom feeds, Pinterest/RSS/Atom feeds, Gmail HTML bodies). It replaces
 * what used to be four near-identical private copies (issue #1876).
 *
 * Handles, in a single left-to-right pass:
 *   - the five predefined named entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`)
 *   - decimal numeric refs (`&#NN;`)
 *   - hex numeric refs (`&#xNN;` / `&#XNN;`)
 *   - any extra named entities supplied by the caller (e.g. `&nbsp;`, `&zwnj;`)
 *
 * Single-pass is intentionally double-decode-safe: because `&amp;` is consumed
 * in the same scan as everything else, a literal `&amp;lt;` in the source
 * decodes to `&lt;` (not `<`) — the scanner does not re-examine the `&` it just
 * emitted. Unknown entities and out-of-range numeric code points are left
 * untouched rather than dropped or thrown on, so one malformed reference can't
 * corrupt or abort the surrounding parse.
 */

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * Decode the XML/HTML entities in a string.
 *
 * @param {string} str - Raw text that may contain entity references.
 * @param {Object<string,string>} [extraEntities] - Optional extra named-entity
 *   map (without the surrounding `&`/`;`), merged on top of the predefined five.
 *   Lets callers decode feed-specific entities such as `{ nbsp: ' ', zwnj: '' }`
 *   while sharing the numeric-reference and double-decode handling.
 * @returns {string} Decoded string. Non-strings and entity-free input are
 *   returned unchanged.
 */
export function decodeXmlEntities(str, extraEntities) {
  if (typeof str !== 'string' || str.indexOf('&') === -1) return str;
  return str.replace(ENTITY_RE, (match, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      // Leave out-of-range / non-Unicode code points untouched — String
      // .fromCodePoint throws a RangeError for cp < 0 or > 0x10FFFF. A malformed
      // numeric entity in one record must not fail the whole parse/import.
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (extraEntities && Object.prototype.hasOwnProperty.call(extraEntities, code)) {
      return extraEntities[code];
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}
