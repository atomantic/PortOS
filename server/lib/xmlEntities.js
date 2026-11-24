/**
 * Shared dependency-free XML/HTML entity decoder.
 *
 * `decodeXmlEntities(str, extraEntities?)`, a single left-to-right pass decoding the five predefined named entities, decimal (`&#NN;`) and hex (`&#xNN;`) refs and a caller-supplied extra-entity map (e.g. `{ nbsp: ' ', zwnj: '' }`). Replaces four private copies (#1876); used by the Apple Health `export.xml` parser, GitHub/Claude changelog Atom feeds, Pinterest/RSS, Gmail HTML-to-text and the SongBook paste and Beeper browser wrappers. Single-pass is double-decode-safe (`&amp;` is consumed in the same scan, so a literal `&amp;lt;` decodes to `&lt;`, not `<`), and unknown entities and out-of-range code points are left untouched rather than dropped or thrown on, so one malformed reference can't corrupt or abort the surrounding parse.
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
      // Leave out-of-range / non-Unicode code points untouched: `String.fromCodePoint` throws RangeError for cp < 0 or > 0x10FFFF, and one malformed entity must not fail the whole parse/import.
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    if (extraEntities && Object.hasOwn(extraEntities, code)) {
      return extraEntities[code];
    }
    return Object.hasOwn(NAMED_ENTITIES, code) ? NAMED_ENTITIES[code] : match;
  });
}
