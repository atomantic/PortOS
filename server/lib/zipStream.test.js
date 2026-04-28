import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import { deflateRawSync } from 'zlib';
import { parseZip } from './zipStream.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;

// Build a minimal local file header for one entry — 30-byte fixed prefix + name + data.
function buildEntry(name, payload, { method = 0 } = {}) {
  const nameBuf = Buffer.from(name, 'utf-8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_SIG, 0);
  header.writeUInt16LE(20, 4);          // version needed
  header.writeUInt16LE(0, 6);           // flags (no data descriptor)
  header.writeUInt16LE(method, 8);      // 0 = stored, 8 = deflate
  header.writeUInt16LE(0, 10);          // mod time
  header.writeUInt16LE(0, 12);          // mod date
  header.writeUInt32LE(0, 14);          // crc32 (unused by reader)
  header.writeUInt32LE(payload.length, 18); // compressed size
  header.writeUInt32LE(payload.length, 22); // uncompressed size
  header.writeUInt16LE(nameBuf.length, 26);
  header.writeUInt16LE(0, 28);          // extra length
  return Buffer.concat([header, nameBuf, payload]);
}

function buildEocd() {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(CENTRAL_SIG, 0);
  return buf;
}

function collectEntries(zipBuf) {
  return new Promise((resolve, reject) => {
    const entryPromises = [];
    const parser = parseZip();
    parser.on('entry', (entry) => {
      entryPromises.push(new Promise((res) => {
        const chunks = [];
        const sink = new Writable({
          write(chunk, _, cb) { chunks.push(chunk); cb(); }
        });
        sink.on('finish', () => res({ path: entry.path, data: Buffer.concat(chunks) }));
        entry.pipe(sink);
      }));
    });
    parser.on('close', () => Promise.all(entryPromises).then(resolve, reject));
    parser.on('error', reject);
    Readable.from([zipBuf]).pipe(parser);
  });
}

describe('parseZip', () => {
  it('parses a single stored entry', async () => {
    const data = Buffer.from('hello world');
    const zip = Buffer.concat([buildEntry('hello.txt', data), buildEocd()]);
    const entries = await collectEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('hello.txt');
    expect(entries[0].data.toString()).toBe('hello world');
  });

  it('parses a deflated entry by decompressing the stream', async () => {
    const original = Buffer.from('Compressed payload that should round-trip cleanly');
    const compressed = deflateRawSync(original);
    const zip = Buffer.concat([buildEntry('comp.txt', compressed, { method: 8 }), buildEocd()]);
    const entries = await collectEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].data.toString()).toBe(original.toString());
  });

  it('parses multiple entries in order', async () => {
    const a = buildEntry('a.txt', Buffer.from('A'));
    const b = buildEntry('b.txt', Buffer.from('BB'));
    const c = buildEntry('c.txt', Buffer.from('CCC'));
    const zip = Buffer.concat([a, b, c, buildEocd()]);
    const entries = await collectEntries(zip);
    expect(entries.map(e => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(entries[2].data.toString()).toBe('CCC');
  });

  it('sanitizes path traversal segments in entry names', async () => {
    const data = Buffer.from('payload');
    const zip = Buffer.concat([buildEntry('../../etc/passwd', data), buildEocd()]);
    const entries = await collectEntries(zip);
    expect(entries[0].path).toBe('etc/passwd');
  });

  it('normalizes Windows-style backslash separators to forward slashes', async () => {
    const data = Buffer.from('x');
    const zip = Buffer.concat([buildEntry('dir\\sub\\file.txt', data), buildEocd()]);
    const entries = await collectEntries(zip);
    expect(entries[0].path).toBe('dir/sub/file.txt');
  });

  it('autodrains entries whose consumer never pipes', async () => {
    const data = Buffer.from('ignored');
    const zip = Buffer.concat([
      buildEntry('skip.txt', data),
      buildEntry('keep.txt', Buffer.from('kept')),
      buildEocd()
    ]);

    return new Promise((resolve, reject) => {
      const entryPromises = [];
      const parser = parseZip();
      parser.on('entry', (entry) => {
        if (entry.path === 'skip.txt') return;
        entryPromises.push(new Promise((res) => {
          const chunks = [];
          const sink = new Writable({
            write(c, _, cb) { chunks.push(c); cb(); }
          });
          sink.on('finish', () => res({ path: entry.path, data: Buffer.concat(chunks) }));
          entry.pipe(sink);
        }));
      });
      parser.on('close', () => Promise.all(entryPromises).then((out) => {
        try {
          expect(out).toHaveLength(1);
          expect(out[0].path).toBe('keep.txt');
          expect(out[0].data.toString()).toBe('kept');
          resolve();
        } catch (err) { reject(err); }
      }, reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
  });

  it('handles multi-chunk arrival of the input buffer', async () => {
    const data = Buffer.from('split across chunks');
    const zip = Buffer.concat([buildEntry('chunked.txt', data), buildEocd()]);
    const pieces = [];
    for (let i = 0; i < zip.length; i += 5) {
      pieces.push(zip.slice(i, Math.min(i + 5, zip.length)));
    }
    const entries = await collectEntries(Buffer.concat(pieces));
    expect(entries[0].data.toString()).toBe(data.toString());
  });
});
