/**
 * Buffer-backed ZIP reader driven by the central directory.
 *
 * `zipStream.js` streams local headers and silently strips `..` segments, which
 * suits imports that match members by name. An import that unpacks a whole
 * tree needs the opposite: the authoritative names and the Unix mode bits the
 * central directory carries, so it can REFUSE a traversal name or a symlink
 * member instead of quietly rewriting it. Stored (0) and deflate (8) members;
 * ZIP64 and encrypted archives are refused.
 *
 *   const entries = readZipArchive(buffer);         // [{ name, isDirectory, isSymlink, size, read() }]
 *   const problem = unsafeZipEntryName(entries[0].name); // null when the name is a plain relative path
 */

import { inflateRawSync } from 'zlib';
import { crc32 } from './zipWriter.js';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const ZIP64_MARK = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const UNIX_HOST = 3;

function findEndOfCentralDirectory(buffer) {
  // The EOCD record is 22 bytes plus a comment of up to 65535 bytes.
  const floor = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Why `name` is not a plain relative member path, or null when it is.
 * Refuses absolute paths, drive letters, backslashes, NUL, and any empty,
 * `.` or `..` segment (a trailing `/` marks a directory and is allowed).
 */
export function unsafeZipEntryName(name) {
  if (typeof name !== 'string' || !name) return 'empty name';
  if (name.includes('\0')) return 'NUL in name';
  if (name.includes('\\')) return 'backslash in name';
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return 'absolute path';
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => part === '..')) return 'parent-directory segment';
  if (parts.some((part) => part === '.' || part === '')) return 'empty or dot segment';
  return null;
}

/**
 * Parse `buffer`'s central directory. Each entry exposes the raw member name,
 * `isDirectory`, `isSymlink` (Unix mode S_IFLNK), sizes, and a lazy `read()`
 * that inflates and CRC-checks the member. Throws on a malformed archive, a
 * ZIP64/encrypted member, or more than `maxEntries` members.
 */
export function readZipArchive(buffer, { maxEntries = 4096 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('Not a ZIP archive');
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end of central directory)');
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK) throw new Error('ZIP64 archives are not supported');
  if (count > maxEntries) throw new Error(`ZIP has more than ${maxEntries} members`);
  if (cdOffset + cdSize > eocd) throw new Error('Malformed ZIP central directory');
  const entries = [];
  let at = cdOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIG) throw new Error('Malformed ZIP central directory');
    const madeBy = buffer.readUInt16LE(at + 4) >> 8;
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLen = buffer.readUInt16LE(at + 28);
    const extraLen = buffer.readUInt16LE(at + 30);
    const commentLen = buffer.readUInt16LE(at + 32);
    const externalAttrs = buffer.readUInt32LE(at + 38);
    const localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (compressedSize === ZIP64_MARK || size === ZIP64_MARK || localOffset === ZIP64_MARK) throw new Error('ZIP64 archives are not supported');
    if (flags & 0x1) throw new Error('Encrypted ZIP members are not supported');
    const mode = madeBy === UNIX_HOST ? (externalAttrs >>> 16) & S_IFMT : 0;
    const isDirectory = name.endsWith('/') || mode === S_IFDIR || (externalAttrs & 0x10) === 0x10;
    entries.push({
      name,
      isDirectory,
      isSymlink: mode === S_IFLNK,
      size,
      compressedSize,
      method,
      read() {
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Malformed ZIP member ${name}`);
        const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        const raw = buffer.subarray(start, start + compressedSize);
        if (raw.length !== compressedSize) throw new Error(`Truncated ZIP member ${name}`);
        let data;
        if (method === 0) data = raw;
        else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
        else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
        if (data.length !== size || crc32(data) !== crc) throw new Error(`ZIP member ${name} failed its checksum`);
        return data;
      },
    });
  }
  return entries;
}
