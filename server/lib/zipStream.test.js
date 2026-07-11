import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable, Writable } from 'stream';
import { deflateRawSync } from 'zlib';
import { writeFile, rm, mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseZip, extractZipEntryToBuffer, collectZipEntry, isZipUpload, collectZipEntries } from './zipStream.js';

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

  it('rejects (does not hang) when a deflated member is corrupt', async () => {
    // method:8 declares deflate, but the payload is not a valid raw-deflate
    // stream — the inflate pipeline must error and reject the collect, not hang.
    const garbage = Buffer.from('not a valid deflate stream at all');
    const zip = Buffer.concat([buildEntry('clinical_records/bad.json', garbage, { method: 8 }), buildEocd()]);
    const collected = new Promise((resolve, reject) => {
      const parser = parseZip();
      let read;
      parser.on('entry', (entry) => { read = collectZipEntry(entry); });
      parser.on('close', () => read.then(resolve, reject));
      parser.on('error', reject);
      Readable.from([zip]).pipe(parser);
    });
    await expect(collected).rejects.toThrow();
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

describe('isZipUpload', () => {
  it('accepts application/zip mimetype', () => {
    expect(isZipUpload({ mimetype: 'application/zip' })).toBe(true);
  });

  it('accepts the Windows x-zip-compressed mimetype', () => {
    expect(isZipUpload({ mimetype: 'application/x-zip-compressed' })).toBe(true);
  });

  it('accepts a .zip filename regardless of mimetype (case-insensitive)', () => {
    expect(isZipUpload({ mimetype: 'application/octet-stream', originalname: 'export.ZIP' })).toBe(true);
    expect(isZipUpload({ originalname: 'takeout.zip' })).toBe(true);
  });

  it('rejects a non-zip upload', () => {
    expect(isZipUpload({ mimetype: 'application/json', originalname: 'history.json' })).toBe(false);
    expect(isZipUpload({ originalname: '_chat.txt' })).toBe(false);
  });

  it('is nullish-safe (missing file / fields do not throw)', () => {
    expect(isZipUpload(null)).toBe(false);
    expect(isZipUpload(undefined)).toBe(false);
    expect(isZipUpload({})).toBe(false);
  });
});

describe('collectZipEntries', () => {
  let dir;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'zipentries-')); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function writeZip(name, buf) {
    const p = join(dir, name);
    await writeFile(p, buf);
    return p;
  }

  it('hands each matching member to onMatch and drains the rest', async () => {
    const zip = Buffer.concat([
      buildEntry('data/keep-a.json', Buffer.from('{"a":1}')),
      buildEntry('data/skip.bin', Buffer.alloc(32, 9)),
      buildEntry('data/keep-b.json', deflateRawSync(Buffer.from('{"b":2}')), { method: 8 }),
      buildEocd(),
    ]);
    const zipPath = await writeZip('mixed.zip', zip);
    const collected = [];
    await collectZipEntries(zipPath, {
      match: (p) => p.endsWith('.json'),
      onMatch: (buf, p) => { collected.push(`${p}:${buf.toString('utf-8')}`); },
    });
    expect(collected.sort()).toEqual(['data/keep-a.json:{"a":1}', 'data/keep-b.json:{"b":2}']);
  });

  it('awaits async onMatch work before resolving (close does not beat the reads)', async () => {
    const zip = Buffer.concat([
      buildEntry('a.json', Buffer.from('1')),
      buildEntry('b.json', Buffer.from('2')),
      buildEocd(),
    ]);
    const zipPath = await writeZip('async.zip', zip);
    const seen = [];
    await collectZipEntries(zipPath, {
      match: '.json',
      onMatch: async (buf) => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(buf.toString('utf-8'));
      },
    });
    expect(seen.sort()).toEqual(['1', '2']);
  });

  it('supports a match closure over caller state (whatsapp first-fallback pattern)', async () => {
    const zip = Buffer.concat([
      buildEntry('WhatsApp Chat with Bob.txt', Buffer.from('fallback body')),
      buildEntry('extra.txt', Buffer.from('second txt')),
      buildEocd(),
    ]);
    const zipPath = await writeZip('whatsapp.zip', zip);
    let preferred = null;
    let fallback = null;
    await collectZipEntries(zipPath, {
      match: (p) => /_chat\.txt$/i.test(p) || (/\.txt$/i.test(p) && fallback === null),
      onMatch: (buf, p) => {
        if (/_chat\.txt$/i.test(p)) preferred = buf.toString('utf-8');
        else if (fallback === null) fallback = buf.toString('utf-8');
      },
    });
    expect(preferred).toBeNull();
    expect(fallback).toBe('fallback body');
  });

  it('rejects (does not hang) when a matching member fails to parse in onMatch', async () => {
    const zip = Buffer.concat([
      buildEntry('good.json', Buffer.from('{"ok":true}')),
      buildEntry('bad.json', Buffer.from('{not valid json')),
      buildEocd(),
    ]);
    const zipPath = await writeZip('badmember.zip', zip);
    await expect(
      collectZipEntries(zipPath, {
        match: '.json',
        onMatch: (buf) => { JSON.parse(buf.toString('utf-8')); },
      }),
    ).rejects.toThrow();
  });

  it('rejects (does not hang) when a matching deflated member is corrupt', async () => {
    // method:8 declares deflate but the payload is garbage — the inflate pipeline
    // errors; the collector must reject rather than hang awaiting the entry.
    const zip = Buffer.concat([
      buildEntry('corrupt.json', Buffer.from('definitely not a deflate stream'), { method: 8 }),
      buildEocd(),
    ]);
    const zipPath = await writeZip('corrupt.zip', zip);
    await expect(
      collectZipEntries(zipPath, { match: '.json', onMatch: () => {} }),
    ).rejects.toThrow();
  });

  it('rejects (does not hang) when a matching member exceeds maxBytes', async () => {
    const zip = Buffer.concat([
      buildEntry('big.json', Buffer.alloc(64, 0x41)),
      buildEocd(),
    ]);
    const zipPath = await writeZip('oversize.zip', zip);
    await expect(
      collectZipEntries(zipPath, { match: '.json', onMatch: () => {}, maxBytes: 16 }),
    ).rejects.toThrow(/exceeds 16 byte limit/);
  });

  it('rejects when the source file is missing', async () => {
    await expect(
      collectZipEntries(join(dir, 'does-not-exist.zip'), { match: '.json', onMatch: () => {} }),
    ).rejects.toThrow();
  });

  it('resolves with no matches on a truncated archive whose central directory is cut off', async () => {
    // A truncated ZIP (upload interrupted): a complete stored entry followed by a
    // sliced-off second header and no EOCD. The parser reads the whole first entry
    // and simply reaches stream end — no hang, no throw, matches processed.
    const full = Buffer.concat([
      buildEntry('first.json', Buffer.from('{"n":1}')),
      buildEntry('second.json', Buffer.from('{"n":2}')),
    ]);
    // Cut mid-way through the second entry's header so it never completes.
    const truncated = full.subarray(0, full.length - 20);
    const zipPath = await writeZip('truncated.zip', truncated);
    const collected = [];
    await collectZipEntries(zipPath, {
      match: '.json',
      onMatch: (buf, p) => { collected.push(p); },
    });
    // The first entry is intact and processed; the second is never fully emitted.
    expect(collected).toContain('first.json');
    expect(collected).not.toContain('second.json');
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
