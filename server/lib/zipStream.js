/**
 * Streaming ZIP parser — unzipper.Parse replacement.
 *
 * Usage (mirrors unzipper):
 *   createReadStream(path).pipe(parseZip())
 *     .on('entry', entry => { entry.path; entry.pipe(ws); entry.autodrain(); })
 *     .on('close', () => {})
 *     .on('error', err => {})
 *
 * Supports DEFLATE (method 8) and stored (method 0) entries.
 * Central directory is not used — entries are read sequentially from the stream.
 */

import { createInflateRaw } from 'zlib';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';

// Local file header signature: PK\x03\x04
const LOCAL_SIG = 0x04034b50;
// Data descriptor signature: PK\x07\x08
const DATA_DESC_SIG = 0x08074b50;
// Central directory signature: PK\x01\x02
const CENTRAL_SIG = 0x02014b50;
// End of central directory: PK\x05\x06
const EOCD_SIG = 0x06054b50;

const LOCAL_HEADER_SIZE = 30; // fixed portion (before variable-length name + extra)

export function parseZip() {
  const emitter = new EventEmitter();
  const chunks = [];
  let buf = Buffer.alloc(0);
  let closed = false;

  const sink = new Writable({
    write(chunk, _, cb) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      processBuffer();
      cb();
    },
    final(cb) {
      if (!closed) { closed = true; emitter.emit('close'); }
      cb();
    }
  });

  sink.on('error', err => emitter.emit('error', err));

  let state = 'HEADER'; // HEADER | ENTRY | SKIP_CENTRAL
  let currentEntry = null;
  let entryBytesRemaining = 0; // compressed size remaining to push to entry stream

  function processBuffer() {
    while (true) {
      if (state === 'SKIP_CENTRAL') return; // done with entries

      if (state === 'HEADER') {
        if (buf.length < 4) return;
        const sig = buf.readUInt32LE(0);

        if (sig === CENTRAL_SIG || sig === EOCD_SIG) {
          state = 'SKIP_CENTRAL';
          return;
        }

        if (sig !== LOCAL_SIG) {
          // Skip one byte and retry (handles padding)
          buf = buf.slice(1);
          continue;
        }

        if (buf.length < LOCAL_HEADER_SIZE) return; // wait for more data

        const flags       = buf.readUInt16LE(6);
        const method      = buf.readUInt16LE(8);
        const compSize    = buf.readUInt32LE(18);
        const nameLen     = buf.readUInt16LE(26);
        const extraLen    = buf.readUInt16LE(28);
        const headerSize  = LOCAL_HEADER_SIZE + nameLen + extraLen;

        if (buf.length < headerSize) return;

        const name = buf.slice(30, 30 + nameLen).toString('utf-8');
        const dataDescriptor = (flags & 0x0008) !== 0; // bit 3: sizes in data descriptor

        buf = buf.slice(headerSize);

        const passThrough = new PassThrough();
        const entryEmitter = new EventEmitter();
        let piped = false;

        const entry = {
          path: name,
          pipe(dest) {
            piped = true;
            if (method === 8) {
              passThrough.pipe(createInflateRaw()).pipe(dest);
            } else {
              passThrough.pipe(dest);
            }
            return dest;
          },
          autodrain() {
            piped = true;
            passThrough.resume(); // discard
          }
        };

        // Give consumer a tick to attach pipe/autodrain
        process.nextTick(() => {
          if (!piped) entry.autodrain();
        });

        emitter.emit('entry', entry);

        if (dataDescriptor) {
          // Unknown compressed size — read until data descriptor signature
          currentEntry = { passThrough, method, name, dataDescriptor: true, compSize: 0 };
          entryBytesRemaining = -1; // signal: scan mode
        } else {
          currentEntry = { passThrough, method, name, dataDescriptor: false, compSize };
          entryBytesRemaining = compSize;
        }
        state = 'ENTRY';
      }

      if (state === 'ENTRY') {
        if (!currentEntry) { state = 'HEADER'; continue; }

        if (currentEntry.dataDescriptor) {
          // Scan for data descriptor: PK\x07\x08 or PK\x07\x08 without sig
          // Data descriptor is 12 or 16 bytes (with/without sig)
          // Strategy: find end of compressed data by looking for next local header or descriptor
          const descSig = Buffer.from([0x50, 0x4b, 0x07, 0x08]);
          const localSig = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
          const centralSig = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

          let found = -1;
          let descLen = 0;
          for (let i = 0; i <= buf.length - 4; i++) {
            if (buf.readUInt32LE(i) === DATA_DESC_SIG) {
              found = i; descLen = 16; break;
            }
            // Some ZIPs omit the descriptor signature — look for next local/central
            if (i > 0 && (buf.readUInt32LE(i) === LOCAL_SIG || buf.readUInt32LE(i) === CENTRAL_SIG || buf.readUInt32LE(i) === EOCD_SIG)) {
              found = i; descLen = 0; break;
            }
          }

          if (found === -1) {
            // Flush safe bytes to entry stream (keep last 16 bytes for boundary detection)
            const safe = buf.length - 16;
            if (safe > 0) {
              currentEntry.passThrough.write(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
            return;
          }

          // Push all bytes up to the descriptor to the entry
          currentEntry.passThrough.write(buf.slice(0, found));
          currentEntry.passThrough.end();
          buf = buf.slice(found + descLen);
          currentEntry = null;
          state = 'HEADER';

        } else {
          if (buf.length === 0) return;
          const take = Math.min(entryBytesRemaining, buf.length);
          currentEntry.passThrough.write(buf.slice(0, take));
          buf = buf.slice(take);
          entryBytesRemaining -= take;

          if (entryBytesRemaining === 0) {
            currentEntry.passThrough.end();
            currentEntry = null;
            state = 'HEADER';
          } else {
            return; // need more data
          }
        }
      }
    }
  }

  // Allow .pipe() syntax: readStream.pipe(parseZip())
  sink.on = emitter.on.bind(emitter);
  sink.once = emitter.once.bind(emitter);
  sink.emit = emitter.emit.bind(emitter);
  sink.removeListener = emitter.removeListener.bind(emitter);

  return sink;
}
