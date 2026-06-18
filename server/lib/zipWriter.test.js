import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'stream';
import { execFileSync } from 'child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createZip, crc32 } from './zipWriter.js';
import { parseZip } from './zipStream.js';

// Read a zip Buffer back through the production parser — proves the writer's
// output is consumable by PortOS's own reader.
function collectEntries(zipBuf) {
  return new Promise((resolve, reject) => {
    const entryPromises = [];
    const parser = parseZip();
    parser.on('entry', (entry) => {
      entryPromises.push(new Promise((res) => {
        const chunks = [];
        const sink = new Writable({ write(chunk, _, cb) { chunks.push(chunk); cb(); } });
        sink.on('finish', () => res({ path: entry.path, data: Buffer.concat(chunks) }));
        entry.pipe(sink);
      }));
    });
    parser.on('close', () => Promise.all(entryPromises).then(resolve, reject));
    parser.on('error', reject);
    Readable.from([zipBuf]).pipe(parser);
  });
}

describe('crc32', () => {
  it('matches the known CRC-32 of "123456789"', () => {
    // Canonical IEEE 802.3 check value.
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('createZip', () => {
  it('round-trips a single entry through parseZip', async () => {
    const zip = createZip([{ name: 'hello.txt', data: 'hello world' }]);
    const entries = await collectEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe('hello.txt');
    expect(entries[0].data.toString()).toBe('hello world');
  });

  it('round-trips multiple entries with nested paths in order', async () => {
    const zip = createZip([
      { name: 'README.md', data: '# Front door' },
      { name: 'identity/prompt.md', data: 'twin prompt' },
      { name: 'data/manifest.json', data: Buffer.from('{"kind":"x"}') },
    ]);
    const entries = await collectEntries(zip);
    expect(entries.map(e => e.path)).toEqual(['README.md', 'identity/prompt.md', 'data/manifest.json']);
    expect(entries[1].data.toString()).toBe('twin prompt');
    expect(JSON.parse(entries[2].data.toString())).toEqual({ kind: 'x' });
  });

  it('preserves binary payloads byte-for-byte', async () => {
    const bin = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f, 0x00, 0xab]);
    const zip = createZip([{ name: 'blob.bin', data: bin }]);
    const entries = await collectEntries(zip);
    expect(Buffer.compare(entries[0].data, bin)).toBe(0);
  });

  it('handles an empty-data entry', async () => {
    const zip = createZip([{ name: 'empty.txt', data: '' }]);
    const entries = await collectEntries(zip);
    expect(entries[0].data.length).toBe(0);
  });

  it('is deterministic across calls', () => {
    const a = createZip([{ name: 'a.txt', data: 'same' }]);
    const b = createZip([{ name: 'a.txt', data: 'same' }]);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it('rejects duplicate entry names', () => {
    expect(() => createZip([
      { name: 'dup.txt', data: 'one' },
      { name: 'dup.txt', data: 'two' },
    ])).toThrow(/duplicate/i);
  });

  it('rejects entries without a name', () => {
    expect(() => createZip([{ data: 'no name' }])).toThrow(/name/i);
  });

  it('rejects a non-array argument', () => {
    expect(() => createZip('nope')).toThrow(/array/i);
  });

  it('produces an archive the system unzip tool can extract', () => {
    // Guards against subtle header-field mistakes that parseZip (which ignores
    // the central directory) would tolerate but a real tool would reject.
    let unzipPath;
    try {
      unzipPath = execFileSync('which', ['unzip']).toString().trim();
    } catch {
      return; // no unzip on this host — skip rather than fail
    }
    if (!unzipPath) return;
    const dir = mkdtempSync(join(tmpdir(), 'zipwriter-'));
    try {
      const zipPath = join(dir, 'bundle.zip');
      writeFileSync(zipPath, createZip([
        { name: 'README.md', data: '# Legacy' },
        { name: 'data/manifest.json', data: '{"kind":"portos-legacy-export"}' },
      ]));
      // -t tests integrity against the central directory + CRCs.
      const out = execFileSync(unzipPath, ['-t', zipPath]).toString();
      expect(out).toMatch(/No errors detected/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
