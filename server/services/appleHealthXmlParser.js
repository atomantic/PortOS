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
import { decodeXmlEntities } from '../lib/xmlEntities.js';

const RECORD_TAG = '<Record';

// A real Apple Health `<Record>` opening tag is at most a few hundred bytes. If
// an apparent record's opening tag grows past this without closing (a malformed
// / unterminated-quote tag that would otherwise swallow the rest of the file and
// stall the import), treat it as garbage and resync to the next `<Record` —
// preserving the "skip the bad record, keep importing" contract sax provided.
const MAX_OPEN_TAG = 64 * 1024;

// Apple Health source/device names occasionally carry `&amp;` and friends. The
// decoder lives in the shared `server/lib/xmlEntities.js` (named + decimal/hex
// numeric, double-decode-safe, out-of-range-tolerant); re-exported here because
// this module's tests and callers reference `decodeXmlEntities` by this path.
export { decodeXmlEntities };

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
    while (true) {
      const idx = buffer.indexOf(RECORD_TAG, i);
      if (idx === -1) {
        // No record token in flight — keep only a short tail so a `<Record`
        // token split across the next chunk boundary is still found. All the
        // scanned-past junk (DTD, other elements, false matches) is dropped, so
        // the buffer can't accumulate.
        buffer = buffer.slice(Math.max(0, buffer.length - (RECORD_TAG.length - 1)));
        return;
      }
      // The char after `<Record` must be a tag boundary (whitespace, `/`, `>`),
      // so a longer element like `<RecordingDevice` can't be taken for a Record.
      const after = buffer[idx + RECORD_TAG.length];
      if (after === undefined) { buffer = buffer.slice(idx); return; } // token split — wait for more
      if (after !== ' ' && after !== '\t' && after !== '\n' && after !== '\r'
        && after !== '/' && after !== '>') {
        i = idx + RECORD_TAG.length; // false match (e.g. <RecordingDevice) — skip past
        continue;
      }
      const end = findTagEnd(buffer, idx + RECORD_TAG.length);
      if (end === -1) {
        // Opening tag not closed in the buffer. Normally just a chunk boundary
        // mid-tag — retain and finish it next write. But a tag that never closes
        // (unterminated quote / truncation) would buffer the rest of the file
        // and stall; once it exceeds MAX_OPEN_TAG it can't be a real record, so
        // skip it and resync to the next `<Record`.
        if (buffer.length - idx > MAX_OPEN_TAG) { i = idx + RECORD_TAG.length; continue; }
        buffer = buffer.slice(idx);
        return;
      }
      onRecord({ name: 'record', attributes: parseAttributes(buffer.slice(idx, end + 1)) });
      i = end + 1;
    }
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
