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
import { createReadStream } from 'fs';
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
    },
    destroy(err, cb) {
      // On abort (a consumer calls `parser.destroy()` to stop ingestion mid-ZIP),
      // the entry currently streaming would otherwise be stranded: its
      // `passThrough` is never fed again and never `.end()`-ed, so anything
      // piping it (e.g. a write-to-disk or collect consumer awaiting the entry's
      // completion) hangs forever. End it so EOF flows downstream and those
      // consumers settle. `end()` (not `destroy(err)`) avoids an unhandled error
      // on the passThrough, since `.pipe()` doesn't forward errors.
      if (currentEntry?.passThrough && !currentEntry.passThrough.writableEnded) {
        currentEntry.passThrough.end();
      }
      cb(err);
    }
  });

  sink.on('error', err => emitter.emit('error', err));

  let state = 'HEADER'; // HEADER | ENTRY | SKIP_CENTRAL
  let currentEntry = null;
  let entryBytesRemaining = 0; // compressed size remaining; only used when !dataDescriptor

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

        const rawName = buf.slice(30, 30 + nameLen).toString('utf-8');
        // Sanitize: normalize path separators and reject directory traversal
        const name = rawName.replace(/\\/g, '/').split('/').filter(s => s !== '..' && s !== '.').join('/');
        const dataDescriptor = (flags & 0x0008) !== 0; // bit 3: sizes in data descriptor

        buf = buf.slice(headerSize);

        const passThrough = new PassThrough();
        let piped = false;

        const entry = {
          path: name,
          pipe(dest) {
            piped = true;
            if (method === 8) {
              const inflate = createInflateRaw();
              // Forward inflate failures (corrupt deflate stream) to dest so a
              // consumer awaiting completion rejects/errors instead of hanging.
              inflate.on('error', (err) => dest.destroy(err));
              passThrough.pipe(inflate).pipe(dest);
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
          currentEntry = { passThrough, method, name, dataDescriptor: true };
        } else {
          currentEntry = { passThrough, method, name, dataDescriptor: false };
          entryBytesRemaining = compSize;
        }
        state = 'ENTRY';
      }

      if (state === 'ENTRY') {
        if (!currentEntry) { state = 'HEADER'; continue; }

        if (currentEntry.dataDescriptor) {
          // Unknown compressed size — scan for data descriptor or next local/central header
          let found = -1;
          let descLen = 0;
          for (let i = 0; i <= buf.length - 4; i++) {
            if (buf.readUInt32LE(i) === DATA_DESC_SIG) {
              found = i; descLen = 16; break;
            }
            // Some ZIPs omit the descriptor signature — boundary is next local/central header
            if (i > 0 && (buf.readUInt32LE(i) === LOCAL_SIG || buf.readUInt32LE(i) === CENTRAL_SIG || buf.readUInt32LE(i) === EOCD_SIG)) {
              found = i; descLen = 0; break;
            }
          }

          if (found === -1) {
            // Flush safe bytes (keep last 16 for boundary overlap)
            const safe = buf.length - 16;
            if (safe > 0) {
              currentEntry.passThrough.write(buf.slice(0, safe));
              buf = buf.slice(safe);
            }
            return;
          }

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

  // Delegate EventEmitter interface to emitter so .pipe() syntax works
  for (const m of ['on', 'once', 'off', 'emit', 'addListener', 'removeListener', 'removeAllListeners', 'listenerCount']) {
    sink[m] = emitter[m].bind(emitter);
  }

  return sink;
}

/**
 * Collect a single `parseZip()` entry's decompressed bytes into one Buffer.
 *
 * `parseZip()` entries are NOT readable streams — they expose only `.pipe(dest)`
 * / `.autodrain()`, so the EventEmitter idiom `entry.on('data'/'end')` throws
 * `entry.on is not a function`. Pipe the entry into a collecting Writable and
 * resolve with the concatenated buffer instead. When `maxBytes` is finite the
 * collect rejects once the member exceeds it, rather than buffering an unbounded
 * amount into memory.
 *
 * Call this synchronously inside the `entry` handler (entries auto-drain on the
 * next tick if nothing attaches a pipe/drain), and gather the returned promises
 * so the parser's `close` handler can `Promise.all` them before settling.
 */
export function collectZipEntry(entry, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const sink = new Writable({
      write(chunk, _enc, cb) {
        size += chunk.length;
        if (size > maxBytes) { cb(new Error(`ZIP member exceeds ${maxBytes} byte limit`)); return; }
        chunks.push(chunk);
        cb();
      }
    });
    sink.on('finish', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    entry.pipe(sink);
  });
}

/**
 * Extract the first entry whose path satisfies `match` (a predicate or a
 * substring) from a zip on disk, resolving to its decompressed Buffer (or null
 * if nothing matched). Convenience over parseZip() for the random-single-member
 * case — e.g. cracking one `*_adapter.safetensors` out of a training
 * checkpoint zip long after the trainer process is gone (loraTraining).
 * Entries before the match are drained without inflation, so reaching a late
 * member costs a sequential disk read but no needless decompression.
 */
export function extractZipEntryToBuffer(zipPath, match) {
  const test = typeof match === 'function' ? match : (name) => name.includes(match);
  return new Promise((resolve, reject) => {
    let settled = false;
    let matched = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const src = createReadStream(zipPath);
    src.on('error', (err) => done(reject, err));
    const parser = parseZip();
    parser.on('error', (err) => done(reject, err));
    parser.on('entry', (entry) => {
      if (matched || !test(entry.path)) { entry.autodrain(); return; }
      matched = true;
      const chunks = [];
      const sink = new Writable({
        write(chunk, _enc, cb) { chunks.push(chunk); cb(); },
      });
      // The match's inflate→sink pipeline finishes asynchronously, so the
      // parser's 'close' (source EOF) can fire first — only let 'close'
      // resolve when nothing matched; otherwise the sink 'finish' resolves.
      sink.on('finish', () => done(resolve, Buffer.concat(chunks)));
      sink.on('error', (err) => done(reject, err));
      entry.pipe(sink);
    });
    parser.on('close', () => { if (!matched) done(resolve, null); });
    src.pipe(parser);
  });
}
