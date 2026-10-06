/**
 * Tiny font files for tests (#10345): a `name` table wrapped in a bare sfnt or
 * WOFF2 container. Enough for the family-name reader and the upload path; they
 * carry no glyphs, so nothing renders from them (the suites fake the renderer).
 */
import { brotliCompressSync } from 'zlib';

// A `name` table with the given [platformID, nameID, text] records (UTF-16BE on platform 3, latin1 on 1).
function nameTable(records) {
  const strings = records.map(([platform, , text]) => (platform === 3 ? Buffer.from(text, 'utf16le').swap16() : Buffer.from(text, 'latin1')));
  const header = Buffer.alloc(6 + records.length * 12);
  header.writeUInt16BE(records.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  records.forEach(([platform, nameId], i) => {
    const at = 6 + i * 12;
    header.writeUInt16BE(platform, at);
    header.writeUInt16BE(nameId, at + 6);
    header.writeUInt16BE(strings[i].length, at + 8);
    header.writeUInt16BE(offset, at + 10);
    offset += strings[i].length;
  });
  return Buffer.concat([header, ...strings]);
}

function sfnt(name) {
  const dir = Buffer.alloc(12 + 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(1, 4);
  dir.write('name', 12, 'latin1');
  dir.writeUInt32BE(28, 20);
  dir.writeUInt32BE(name.length, 24);
  return Buffer.concat([dir, name]);
}

function woff2(name, { flavor = 0x00010000 } = {}) {
  const compressed = brotliCompressSync(name);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(flavor, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(compressed.length, 20);
  // One table: registered tag index 5 ('name'), no transform, length as UIntBase128 (< 128 here).
  return Buffer.concat([header, Buffer.from([5, name.length]), compressed]);
}

/** A minimal TrueType file whose family is `family`. */
export const sfntFont = (family) => sfnt(nameTable([[3, 1, family]]));
/** The same name records ([platformID, nameID, text]) as a bare sfnt, and inside a WOFF2 container. */
export const sfntWithNames = (records) => sfnt(nameTable(records));
export const woff2WithNames = (records) => woff2(nameTable(records));
