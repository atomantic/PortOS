/**
 * Apple Health XML Record Parser
 *
 * A dependency-free streaming parser for Apple Health `export.xml` files
 * (500MB+). Apple Health exports are machine-generated flat XML where every
 * sample is a self-contained `<Record .../>` element, so we only need to pull
 * the attributes off each `<Record>` opening tag — no general-purpose XML/DOM
 * parser required.
 *
 * This replaces the `sax` dependency (issue #1824): a ~Writable that splits the
 * byte stream on `<Record` tag boundaries, parses attributes with a quote-aware
 * scan, and invokes `onRecord({ name: 'record', attributes })` with lowercased
 * attribute names — matching what `sax.createStream(false, { lowercase: true })`
 * emitted on `opentag`. Backpressure is preserved by the caller pausing the
 * source read stream; malformed input is skipped rather than fatal (records with
 * missing required attributes are dropped downstream by `normalizeXmlRecord`).
 */

import { Writable } from 'stream';
import { StringDecoder } from 'string_decoder';

const RECORD_TAG = '<Record';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Decode the XML entities that can appear in attribute values (named + numeric).
 * Apple Health source/device names occasionally carry `&amp;` and friends.
 *
 * @param {string} str - Raw attribute value
 * @returns {string} Decoded value (unchanged if it contains no entities)
 */
export function decodeXmlEntities(str) {
  if (!str || str.indexOf('&') === -1) return str;
  return str.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, code) => {
    if (code[0] === '#') {
      const cp = code[1] === 'x' || code[1] === 'X'
        ? parseInt(code.slice(2), 16)
        : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[code] ?? match;
  });
}

const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Parse the attribute string of an element's opening tag into a lowercased-key
 * map, decoding entity references in each value. Mirrors sax's lowercase mode:
 * attribute NAMES are lowercased; VALUES are preserved (the caller lowercases
 * the bits it needs).
 *
 * @param {string} openTag - The opening tag text, e.g. `<Record type="HK..." value="72">`
 * @returns {Object} Map of lowercased attribute name → decoded value
 */
export function parseAttributes(openTag) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(openTag)) !== null) {
    const key = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2] : m[3];
    attrs[key] = decodeXmlEntities(raw);
  }
  return attrs;
}

/**
 * Find the index of the `>` that closes an opening tag, ignoring any `>` that
 * sits inside a quoted attribute value (legal in XML attribute values).
 *
 * @param {string} str - The working buffer
 * @param {number} from - Index to start scanning from (just past `<Record`)
 * @returns {number} Index of the closing `>`, or -1 if not yet in the buffer
 */
function findTagEnd(str, from) {
  let quote = null;
  for (let i = from; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      return i;
    }
  }
  return -1;
}

/**
 * Create a Writable stream that parses Apple Health `<Record>` elements out of a
 * piped XML byte stream and calls `onRecord` for each one. Non-`Record` content
 * (the DOCTYPE/DTD, `<Workout>`, `<ActivitySummary>`, `<MetadataEntry>` children,
 * the `<HealthData>` root) is skipped without buffering — only the in-flight
 * fragment around a `<Record>` boundary is retained, so memory stays flat across
 * a multi-hundred-MB file.
 *
 * @param {{ onRecord: (node: { name: 'record', attributes: Object }) => void }} opts
 * @returns {import('stream').Writable}
 */
export function createAppleHealthRecordStream({ onRecord }) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const drain = () => {
    let i = 0;
    // Index we must retain from because a *valid* record is only partially
    // buffered (token or opening tag split across a chunk boundary). -1 = none.
    let pending = -1;
    while (true) {
      const idx = buffer.indexOf(RECORD_TAG, i);
      if (idx === -1) break;
      // The char after `<Record` must be a tag boundary (whitespace, `/`, `>`),
      // so a longer element like `<RecordingDevice` can't be taken for a Record.
      const after = buffer[idx + RECORD_TAG.length];
      if (after === undefined) { pending = idx; break; } // token split — wait for more
      if (after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r'
        && after !== '/' && after !== '>') {
        i = idx + RECORD_TAG.length; // false match (e.g. <RecordingDevice) — skip past
        continue;
      }
      const end = findTagEnd(buffer, idx + RECORD_TAG.length);
      if (end === -1) { pending = idx; break; } // opening tag not fully buffered — wait
      onRecord({ name: 'record', attributes: parseAttributes(buffer.slice(idx, end + 1)) });
      i = end + 1;
    }
    // Retain only the incomplete-record fragment, or a short tail so a `<Record`
    // token split across the next chunk boundary is still found. Rejected
    // false-matches are dropped, so junk can't accumulate in the buffer.
    buffer = pending !== -1
      ? buffer.slice(pending)
      : buffer.slice(Math.max(0, buffer.length - (RECORD_TAG.length - 1)));
  };

  return new Writable({
    write(chunk, _enc, cb) {
      buffer += decoder.write(chunk);
      drain();
      cb();
    },
    final(cb) {
      buffer += decoder.end();
      drain();
      cb();
    },
  });
}
