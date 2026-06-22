import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable, Writable } from 'stream';
import { deflateRawSync } from 'zlib';
import { writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseZip, extractZipEntryToBuffer, collectZipEntry } from './zipStream.js';

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

  it('ends the in-flight entry stream when the parser is destroyed mid-entry (no hang)', async () => {
    // A consumer that aborts ingestion (parser.destroy()) while an entry is
    // still streaming must not strand that entry's stream: anything piping it
    // and awaiting completion would otherwise hang forever. Feed a stored entry
    // whose declared size (1000) exceeds the bytes we actually supply (100), so
    // the entry is emitted and piped but left mid-stream when we abort.
    const payload = Buffer.alloc(1000, 0x41);
    const fullEntry = buildEntry('big.dat', payload);
    const headerLen = fullEntry.length - payload.length;
    const partial = fullEntry.subarray(0, headerLen + 100);

    const parser = parseZip();
    const sinkFinished = new Promise((resolve) => {
      parser.on('entry', (entry) => {
        const chunks = [];
        const sink = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
        // Resolves only if the entry stream is allowed to finish — i.e. the
        // parser's teardown ended it rather than abandoning it mid-flight.
        sink.on('finish', () => resolve(Buffer.concat(chunks)));
        entry.pipe(sink);
      });
    });

    // Await the write callback so processBuffer has emitted+piped the entry and
    // buffered its 100 bytes before we abort.
    await new Promise((res) => parser.write(partial, res));
    parser.destroy();

    // Without the destroy→end teardown this never resolves and the test times out.
    const data = await sinkFinished;
    expect(data.length).toBe(100);
  });
});

describe('collectZipEntry', () => {
  it('collects a stored entry into one Buffer', async () => {
    const data = Buffer.from('clinical record json payload');
    const zip = Buffer.concat([buildEntry('clinical_records/a.json', data), buildEocd()]);
    const out = await new Promise((resolve, reject) => {
      const parser = parseZip();
      let read;
      parser.on('entry', (entry) => { read = collectZipEntry(entry); });
      parser.on('close', () => read.then(resolve, reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
    expect(out.toString()).toBe('clinical record json payload');
  });

  it('round-trips a deflated entry', async () => {
    const original = Buffer.from('{"resourceType":"Observation","value":42}');
    const zip = Buffer.concat([
      buildEntry('clinical_records/obs.json', deflateRawSync(original), { method: 8 }),
      buildEocd(),
    ]);
    const out = await new Promise((resolve, reject) => {
      const parser = parseZip();
      let read;
      parser.on('entry', (entry) => { read = collectZipEntry(entry); });
      parser.on('close', () => read.then(resolve, reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
    expect(out.toString()).toBe(original.toString());
  });

  it('rejects when the member exceeds maxBytes', async () => {
    const data = Buffer.alloc(64, 0x41);
    const zip = Buffer.concat([buildEntry('big.json', data), buildEocd()]);
    const collected = new Promise((resolve, reject) => {
      const parser = parseZip();
      let read;
      parser.on('entry', (entry) => { read = collectZipEntry(entry, 16); });
      parser.on('close', () => read.then(resolve, reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
    await expect(collected).rejects.toThrow(/exceeds 16 byte limit/);
  });

  it('collects multiple JSON members alongside a drained member (appleHealth pattern)', async () => {
    // Mirrors server/routes/appleHealth.js: drain export.xml, collect every
    // clinical_records/*.json into buffers, await them all on 'close'.
    const zip = Buffer.concat([
      buildEntry('apple_health_export/export.xml', Buffer.from('<HealthData/>')),
      buildEntry('clinical_records/r1.json', deflateRawSync(Buffer.from('{"id":1}')), { method: 8 }),
      buildEntry('clinical_records/r2.json', Buffer.from('{"id":2}')),
      buildEocd(),
    ]);
    const jsons = await new Promise((resolve, reject) => {
      const reads = [];
      const collected = [];
      const parser = parseZip();
      parser.on('entry', (entry) => {
        if (entry.path.includes('clinical_records/') && entry.path.endsWith('.json')) {
          reads.push(collectZipEntry(entry).then((buf) => collected.push(buf.toString('utf-8'))));
        } else {
          entry.autodrain();
        }
      });
      parser.on('close', () => Promise.all(reads).then(() => resolve(collected), reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
    expect(jsons.sort()).toEqual(['{"id":1}', '{"id":2}']);
  });
});

describe('extractZipEntryToBuffer', () => {
  let dir;
  let zipPath;
  // A two-entry zip mirroring an mflux checkpoint: a big stored "optimizer"
  // FIRST (must be skipped without inflation), then a deflated "adapter".
  const adapterPayload = Buffer.from('adapter weights — round-trip me cleanly');

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zipextract-'));
    zipPath = join(dir, 'ckpt.zip');
    const optimizer = buildEntry('0001_optimizer.safetensors', Buffer.alloc(4096, 7));
    const adapter = buildEntry('0001_adapter.safetensors', deflateRawSync(adapterPayload), { method: 8 });
    await writeFile(zipPath, Buffer.concat([optimizer, adapter, buildEocd()]));
  });

  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('extracts a later deflated entry past an earlier one via predicate', async () => {
    const out = await extractZipEntryToBuffer(
      zipPath,
      (name) => name.endsWith('_adapter.safetensors') && !name.includes('optimizer'),
    );
    expect(out).not.toBeNull();
    expect(out.toString()).toBe(adapterPayload.toString());
  });

  it('matches by substring shorthand', async () => {
    const out = await extractZipEntryToBuffer(zipPath, '_adapter.safetensors');
    expect(out.toString()).toBe(adapterPayload.toString());
  });

  it('resolves null when nothing matches', async () => {
    expect(await extractZipEntryToBuffer(zipPath, 'no-such-member.bin')).toBeNull();
  });

  it('rejects on a missing file', async () => {
    await expect(extractZipEntryToBuffer(join(dir, 'nope.zip'), 'x')).rejects.toThrow();
  });
});
