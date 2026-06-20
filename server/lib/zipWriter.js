/**
 * Minimal ZIP writer — the counterpart to the parser in `zipStream.js`.
 *
 * Writes **stored (method 0)** entries by default, with an opt-in **deflate
 * (method 8)** path (`createZip(entries, { compress: true })`). Local file
 * headers, a central directory, and the EOCD record. The only compression
 * dependency is Node's built-in `zlib` — CRC-32 stays a small in-file table
 * (Node's `zlib.crc32` only landed in v22, so we don't rely on it). Output is
 * deterministic (fixed DOS timestamp + `zlib`'s deterministic raw-deflate) so
 * round-trip tests and manifest hashes are stable.
 *
 * Usage:
 *   const buf = createZip([
 *     { name: 'README.md', data: '# Hello' },
 *     { name: 'data/manifest.json', data: Buffer.from('{}') },
 *   ]);                                   // stored entries
 *   const small = createZip(entries, { compress: true });  // deflate where it helps
 *   // both round-trip through parseZip() in zipStream.js (it reads methods 0 and 8)
 *
 * Compression is **per-entry and only kept when it actually shrinks the entry**:
 * deflate is computed, and the stored form is used instead whenever the deflated
 * payload isn't smaller (tiny or already-compressed files like PDFs/PNGs). So a
 * compressed archive is never larger than the stored one, entry for entry.
 * Stored remains the default because it is the simplest correct format every
 * tool reads; deflate is for when bundle size matters (issue #901 open Q5).
 */

import { deflateRawSync } from 'zlib';

// CRC-32 lookup table (IEEE 802.3 polynomial 0xEDB88320), built once at load.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 of a Buffer, returned as an unsigned 32-bit integer. */
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS date/time (1980-01-01 00:00:00) for deterministic output.
const DOS_TIME = 0;
const DOS_DATE = 0x21; // (1980-1980)<<9 | 1<<5 | 1 = 0b0000000_0001_00001

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const VERSION = 20; // 2.0 — minimum that supports the fields we write
const UTF8_FLAG = 0x0800; // language-encoding (EFS) bit: names are UTF-8

function toBuffer(data) {
  return Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
}

/**
 * Build a ZIP archive (as a single Buffer) from a list of `{ name, data }`
 * entries. `name` is the in-archive path (forward slashes); `data` is a Buffer
 * or string. Duplicate or empty names throw — a malformed bundle is worse than
 * a loud failure.
 *
 * `opts.compress` (default false) deflates each entry, keeping the deflated form
 * only when it is strictly smaller than the stored bytes; otherwise the entry is
 * stored. The CRC-32 and the uncompressed size are always of the ORIGINAL data,
 * per the ZIP spec, so a deflated entry round-trips identically through a reader.
 */
export function createZip(entries, { compress = false } = {}) {
  if (!Array.isArray(entries)) throw new Error('createZip: entries must be an array');

  const seen = new Set();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = entry?.name;
    if (!name || typeof name !== 'string') throw new Error('createZip: every entry needs a non-empty string name');
    const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (seen.has(normalized)) throw new Error(`createZip: duplicate entry name "${normalized}"`);
    seen.add(normalized);

    const nameBuf = Buffer.from(normalized, 'utf-8');
    const dataBuf = toBuffer(entry.data ?? '');
    const crc = crc32(dataBuf);
    const size = dataBuf.length; // uncompressed size (always the original)

    // Per-entry deflate, kept only when it actually shrinks the payload. Empty
    // entries are always stored (deflate of 0 bytes is non-empty overhead).
    let method = 0;
    let payload = dataBuf;
    if (compress && size > 0) {
      const deflated = deflateRawSync(dataBuf, { level: 9 });
      if (deflated.length < size) {
        method = 8;
        payload = deflated;
      }
    }
    const compSize = payload.length; // compressed size (== size when stored)

    // Local file header (30 bytes fixed + name).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8); // 0 stored / 8 deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compSize, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, nameBuf, payload);

    // Central directory header (46 bytes fixed + name).
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE(VERSION, 4); // version made by
    cd.writeUInt16LE(VERSION, 6); // version needed
    cd.writeUInt16LE(UTF8_FLAG, 8);
    cd.writeUInt16LE(method, 10); // method
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central dir size
  eocd.writeUInt32LE(centralOffset, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, eocd]);
}
