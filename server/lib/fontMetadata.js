/**
 * Read a font file's family name without a font library (#10345).
 *
 * The cover lettering names an uploaded typeface by the family the renderer
 * registers it under, which is the family inside the file, not its filename.
 * Handles TrueType/OpenType (`name` table, preferring the typographic family)
 * and WOFF2 (the `name` table is stored untransformed inside the container's
 * one brotli stream). Returns null for anything else, including collections.
 */
import { brotliDecompressSync } from 'zlib';

const FAMILY_NAME_IDS = [16, 1];
const SFNT_FLAVORS = new Set([0x00010000, 0x4f54544f, 0x74727565]); // 1.0 (TrueType), 'OTTO' (CFF), 'true'
// WOFF2 table directory: the registered tags by index (63 means an explicit 4-byte tag follows).
const WOFF2_KNOWN_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill'];

/** The container a buffer is, from its first four bytes: 'sfnt', 'woff2', or null. */
export function fontContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 4) === 'wOF2') return 'woff2';
  return SFNT_FLAVORS.has(buf.readUInt32BE(0)) ? 'sfnt' : null;
}

function familyFromNameTable(table) {
  if (table.length < 6) return null;
  const count = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);
  const names = new Map();
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 12;
    if (at + 12 > table.length) break;
    const platform = table.readUInt16BE(at);
    const nameId = table.readUInt16BE(at + 6);
    const length = table.readUInt16BE(at + 8);
    const start = storage + table.readUInt16BE(at + 10);
    if (!FAMILY_NAME_IDS.includes(nameId) || start + length > table.length) continue;
    const raw = table.subarray(start, start + length);
    // Windows (3) and Unicode (0) names are UTF-16BE; Macintosh (1) names are single-byte.
    const text = platform === 3 || platform === 0 ? Buffer.from(raw).swap16().toString('utf16le') : raw.toString('latin1');
    // Windows names win over Mac ones for the same id: they carry the full Unicode name.
    if (text.trim() && (!names.has(nameId) || platform === 3)) names.set(nameId, text.trim());
  }
  return FAMILY_NAME_IDS.map((id) => names.get(id)).find(Boolean) || null;
}

function sfntNameTable(buf) {
  const tables = buf.readUInt16BE(4);
  for (let i = 0; i < tables; i += 1) {
    const at = 12 + i * 16;
    if (at + 16 > buf.length) return null;
    if (buf.toString('latin1', at, at + 4) !== 'name') continue;
    const offset = buf.readUInt32BE(at + 8);
    const length = buf.readUInt32BE(at + 12);
    return offset + length <= buf.length ? buf.subarray(offset, offset + length) : null;
  }
  return null;
}

// WOFF2 "UIntBase128": 7 bits per byte, high bit set while more follow.
function readBase128(buf, at) {
  let value = 0;
  for (let i = 0; i < 5; i += 1) {
    const byte = buf[at + i];
    if (byte === undefined) return null;
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: at + i + 1 };
  }
  return null;
}

function woff2NameTable(buf) {
  if (buf.length < 48) return null;
  const count = buf.readUInt16BE(12);
  const compressedSize = buf.readUInt32BE(20);
  let at = 48;
  let offset = 0;
  let name = null;
  for (let i = 0; i < count; i += 1) {
    const flags = buf[at];
    if (flags === undefined) return null;
    at += 1;
    let tag = WOFF2_KNOWN_TAGS[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = buf.toString('latin1', at, at + 4); at += 4; }
    const original = readBase128(buf, at);
    if (!original) return null;
    at = original.next;
    // glyf/loca are transformed when the version is 0; every other table when it is not.
    const transformed = tag === 'glyf' || tag === 'loca' ? (flags >> 6) === 0 : (flags >> 6) !== 0;
    let stored = original.value;
    if (transformed) {
      const transform = readBase128(buf, at);
      if (!transform) return null;
      at = transform.next;
      stored = transform.value;
    }
    if (tag === 'name') name = { offset, length: stored };
    offset += stored;
  }
  if (!name) return null;
  const inflated = brotliDecompressSync(buf.subarray(at, at + compressedSize));
  return inflated.subarray(name.offset, name.offset + name.length);
}

/** The font's family name, or null when the file is not a font this can read or names none. */
export function fontFamilyName(buf) {
  const container = fontContainer(buf);
  if (!container) return null;
  // An uploaded file is untrusted: a truncated or corrupt one reads as "no family", never a throw.
  try {
    const table = container === 'woff2' ? woff2NameTable(buf) : sfntNameTable(buf);
    return table ? familyFromNameTable(table) : null;
  } catch {
    return null;
  }
}
