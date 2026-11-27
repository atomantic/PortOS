import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFingerprintMap, fingerprintsEqual } from './checksumFingerprints.js';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('readFingerprintMap directory stats', () => {
  it('moves when a file is published into the directory and ignores the files themselves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'checksum-dir-stat-'));
    roots.push(root);
    const receipts = join(root, 'receipts');
    await mkdir(receipts);
    await writeFile(join(receipts, 'a.json'), '{}');
    // An old directory mtime, so the later publish moves it whatever the clock granularity.
    await utimes(receipts, new Date(0), new Date(0));
    const sources = { checksumPaths: [], checksumDirStats: [receipts, join(root, 'missing')] };

    const first = await readFingerprintMap(sources);
    // One stat per directory: no per-file walk, which is what made a large store costly.
    expect(first[receipts]).not.toContain('a.json');
    expect(first[join(root, 'missing')]).toBeNull();
    expect(fingerprintsEqual(first, await readFingerprintMap(sources))).toBe(true);

    await writeFile(join(receipts, 'b.json'), '{}');
    expect(fingerprintsEqual(first, await readFingerprintMap(sources))).toBe(false);
  });
});
